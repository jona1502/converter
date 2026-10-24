"""Shared Redis sliding windows and trusted client address handling."""

from __future__ import annotations

import hashlib
import ipaddress
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from functools import lru_cache

import redis
from fastapi import Request

from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings

WINDOW_SCRIPT = """
local now = redis.call('TIME')
local ms = now[1]*1000 + math.floor(now[2]/1000)
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE',key,'-inf',ms-60000)
  if redis.call('ZCARD',key) >= tonumber(ARGV[i+1]) then return 0 end
end
for i,key in ipairs(KEYS) do
  redis.call('ZADD',key,ms,ARGV[1])
  redis.call('PEXPIRE',key,61000)
end
return 1
"""
UNLOCK_SCRIPT = (
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0"
)


@lru_cache(maxsize=8)
def _client(url: str) -> redis.Redis:
    return redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)


def _broker(settings: Settings) -> redis.Redis | None:
    if settings.redis_url is not None:
        return _client(settings.redis_url.get_secret_value())
    if settings.environment == "test":
        return None
    raise ApiError(ApiErrorCode.SERVER_BUSY, 503, "Broker nicht verfügbar.", retry_after=5)


def client_ip(request: Request, settings: Settings) -> str:
    peer = request.client.host if request.client else "unknown"
    try:
        address = ipaddress.ip_address(peer)
    except ValueError:
        return peer

    def trusted(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        return any(addr in network for network in settings.trusted_proxies)

    if not trusted(address):
        return str(address)
    # Walk from the trusted immediate proxy towards the client. Never trust
    # the attacker-controlled leftmost entry behind an untrusted intermediary.
    chain = request.headers.get("x-forwarded-for", "").split(",")
    for value in reversed(chain):
        try:
            candidate = ipaddress.ip_address(value.strip())
        except ValueError:
            break
        address = candidate
        if not trusted(address):
            break
    return str(address)


def _key(kind: str, identity: str) -> str:
    return "converter:rate:" + kind + ":" + hashlib.sha256(identity.encode()).hexdigest()


def check_limits(settings: Settings, limits: list[tuple[str, str, int]]) -> None:
    client = _broker(settings)
    if client is None:
        return
    try:
        accepted = client.eval(
            WINDOW_SCRIPT,
            len(limits),
            *[_key(kind, identity) for kind, identity, _ in limits],
            uuid.uuid4().hex,
            *[str(limit) for _, _, limit in limits],
        )
    except redis.RedisError as exc:
        raise ApiError(
            ApiErrorCode.SERVER_BUSY, 503, "Annahme derzeit nicht verfügbar.", retry_after=5
        ) from exc
    if not accepted:
        raise ApiError(ApiErrorCode.RATE_LIMITED, 429, "Zu viele Anfragen.", retry_after=60)


@contextmanager
def replay_guard(settings: Settings, session_id: uuid.UUID) -> Iterator[None]:
    check_limits(settings, [("replay", str(session_id), settings.session_replays_per_minute)])
    with submission_guard(settings, "replay-lock", str(session_id)):
        yield


@contextmanager
def submission_guard(settings: Settings, kind: str, identity: str) -> Iterator[None]:
    client = _broker(settings)
    if client is None:
        yield
        return
    key, token = _key(kind, identity), uuid.uuid4().hex
    try:
        acquired = client.set(key, token, nx=True, ex=settings.upload_max_seconds + 10)
    except redis.RedisError as exc:
        raise ApiError(
            ApiErrorCode.SERVER_BUSY, 503, "Annahme derzeit nicht verfügbar.", retry_after=5
        ) from exc
    if not acquired:
        raise ApiError(ApiErrorCode.RATE_LIMITED, 429, "Wiederholung läuft bereits.", retry_after=1)
    try:
        yield
    finally:
        # finite Redis TTL also releases a lock after API crash
        with suppress(redis.RedisError):
            client.eval(UNLOCK_SCRIPT, 1, key, token)
