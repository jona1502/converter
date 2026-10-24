"""Erzeugt golden.json für die Go-Auth-Tests aus dem echten Python-Backend.

Liest nur und schreibt JSON nach stdout; verändert nichts. Aufruf aus dem
Repo-Root:

    cd backend && uv run python ../server/internal/auth/testdata/gen_golden.py \
        > ../server/internal/auth/testdata/golden.json

Verwendet unverändert: app.core.security (Token, Hash, CSRF), app.api.auth
(Cookiename, Origin-Prüfung), app.core.rate_limits (Client-IP, Schlüssel) und
Starlettes Response.set_cookie bzw. Request.cookies wie in app.api.session.
"""

from __future__ import annotations

import json
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))

from pydantic import SecretStr  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import Response  # noqa: E402

from app.api.auth import cookie_name, origin_allowed  # noqa: E402
from app.core import security  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.core.rate_limits import _key, client_ip  # noqa: E402

SECRETS = [
    "test-secret-key-0123456789abcdefghijklmnop",
    "local-development-only-change-before-hosting-2026",
    "Schlüssel-mit-Ümlauten-und-€-Zeichen-0123456789",
]
TOKEN_BYTES = [
    bytes(range(32)),
    bytes([0xFF] * 32),
    bytes.fromhex("fb" * 16 + "ef" * 16),
]


def settings(**kwargs: object) -> Settings:
    return Settings(environment="test", secret_key=SecretStr(SECRETS[0]), **kwargs)


def request(headers: list[tuple[str, str]], peer: str | None = "203.0.113.9") -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "client": (peer, 1234) if peer is not None else None,
    }
    return Request(scope)


def tokens() -> list[dict[str, object]]:
    out = []
    original = secrets.token_bytes
    try:
        for raw in TOKEN_BYTES:
            secrets.token_bytes = lambda n, raw=raw: raw[:n]  # type: ignore[assignment]
            token = security.new_session_token()
            digest = security.hash_token(token)
            out.append(
                {
                    "randomHex": raw.hex(),
                    "token": token,
                    "hashHex": digest.hex(),
                    "csrf": {s: security.csrf_token(s, digest) for s in SECRETS},
                }
            )
    finally:
        secrets.token_bytes = original
    return out


def plausible() -> dict[str, bool]:
    cases = ["A" * 43, "a-_" * 14 + "x", "A" * 42, "A" * 44, "A" * 42 + "=", "A" * 42 + "+", "", "Ä" * 43]
    return {c: security.is_plausible_token(c) for c in cases}


def csrf_matches() -> list[dict[str, object]]:
    expected = security.csrf_token(SECRETS[0], security.hash_token("A" * 43))
    cases = [expected, expected[:-1], expected + "x", "", expected.upper(), None]
    return [{"expected": expected, "given": g, "match": security.csrf_matches(expected, g)} for g in cases]


def cookies() -> list[dict[str, object]]:
    out = []
    for secure in (True, False):
        for ttl in (86_400, 7200):
            s = settings(session_cookie_secure=secure, session_ttl_seconds=ttl)
            response = Response()
            # Gleiche Argumente wie app.api.session.get_session.
            response.set_cookie(
                cookie_name(s),
                "A" * 43,
                max_age=s.session_ttl_seconds,
                path="/",
                secure=s.session_cookie_secure,
                httponly=True,
                samesite="strict",
            )
            out.append(
                {
                    "secure": secure,
                    "ttlSeconds": ttl,
                    "name": cookie_name(s),
                    "setCookie": response.headers["set-cookie"],
                }
            )
    return out


def cookie_parsing() -> list[dict[str, object]]:
    name = "converter_session"
    tok, other = "A" * 43, "B" * 43
    headers = [
        f"{name}={tok}",
        f"a=b; {name}={tok}; c=d",
        f"{name}={tok}; {name}={other}",
        f'{name}="{tok}"',
        f"{name}= {tok} ",
        f"{name}=",
        f"__Host-{name}={tok}",
        "",
    ]
    out = []
    for h in headers:
        req = request([("cookie", h)] if h else [])
        out.append({"cookie": h, "name": name, "value": req.cookies.get(name)})
    return out


def origins() -> list[dict[str, object]]:
    allowed = ["https://converter.example", "http://localhost:8080"]
    s = settings(allowed_origins=allowed)
    cases = [
        {"origin": "https://converter.example"},
        {"origin": "HTTPS://Converter.Example"},
        {"origin": "https://converter.example/"},
        {"origin": "https://evil.example"},
        {"origin": "null"},
        {"origin": ""},
        {"origin": "http://localhost:8080"},
        {"secFetchSite": "cross-site"},
        {"secFetchSite": "Cross-Site"},
        {"secFetchSite": "same-origin"},
        {"secFetchSite": "same-site"},
        {"secFetchSite": "none"},
        {},
        {"origin": "https://converter.example", "secFetchSite": "cross-site"},
    ]
    out = []
    for c in cases:
        headers = []
        if "origin" in c:
            headers.append(("origin", c["origin"]))
        if "secFetchSite" in c:
            headers.append(("sec-fetch-site", c["secFetchSite"]))
        out.append({**c, "allowedOrigins": allowed, "allowed": origin_allowed(request(headers), s)})
    return out


def client_ips() -> list[dict[str, object]]:
    trusted = ["172.30.218.10/32", "10.0.0.0/8", "::1"]
    cases: list[tuple[str | None, str | None]] = [
        ("203.0.113.9", None),
        ("203.0.113.9", "1.2.3.4"),  # gefälschtes XFF von nicht vertrauter Gegenstelle
        ("172.30.218.10", "198.51.100.7"),
        ("172.30.218.10", "6.6.6.6, 198.51.100.7"),  # nur der rechte Eintrag zählt
        ("172.30.218.10", "198.51.100.7, 10.1.2.3"),  # vertrauter Proxy in der Kette
        ("172.30.218.10", "198.51.100.7, 10.1.2.3, 10.9.9.9"),
        ("172.30.218.10", "garbage, 198.51.100.7"),
        ("172.30.218.10", "198.51.100.7, garbage"),
        ("172.30.218.10", ""),
        ("172.30.218.10", None),
        ("172.30.218.10", " 2001:DB8::1 "),
        ("172.30.218.10", "10.0.0.1, 10.0.0.2"),  # alles vertraut → linkester
        ("172.30.218.10", "::ffff:1.2.3.4"),
        ("::1", "198.51.100.8"),
        ("2001:db8:0:0::5", "1.1.1.1"),
        ("not-an-ip", "1.1.1.1"),
        (None, "1.1.1.1"),
    ]
    s = settings(trusted_proxies=trusted)
    out = []
    for peer, xff in cases:
        headers = [("x-forwarded-for", xff)] if xff is not None else []
        ip = client_ip(request(headers, peer), s)
        out.append({"peer": peer, "xff": xff, "trustedProxies": trusted, "clientIp": ip})
    return out


def rate_keys() -> list[dict[str, str]]:
    cases = [
        ("new-session", "203.0.113.9"),
        ("create-ip", "2001:db8::1"),
        ("create-session", "6f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f"),
        ("idempotency-lock", "6f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f:Schlüssel_ä-1234567"),
        ("replay", ""),
    ]
    return [{"kind": k, "identity": i, "key": _key(k, i)} for k, i in cases]


def main() -> None:
    golden = {
        "secrets": SECRETS,
        "tokens": tokens(),
        "plausible": plausible(),
        "csrfMatches": csrf_matches(),
        "cookies": cookies(),
        "cookieParsing": cookie_parsing(),
        "origins": origins(),
        "clientIps": client_ips(),
        "rateKeys": rate_keys(),
    }
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    print(json.dumps(golden, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
