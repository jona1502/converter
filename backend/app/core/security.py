"""Sitzungstoken und CSRF-Token (Vertrag §3).

- Sitzungstoken: 32 Zufallsbytes, URL-sicher kodiert; nur im Cookie.
- In der Datenbank steht ausschließlich ``SHA-256(token)``.
- ``csrfToken = base64url(HMAC-SHA256(SECRET_KEY, "csrf:" + hex(token_hash)))``
  ohne ``=``-Auffüllung. Es ist aus der Sitzung ableitbar und muss daher
  nicht gespeichert werden.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from typing import Final

SESSION_TOKEN_BYTES: Final = 32
# token_urlsafe(32) ergibt 43 Zeichen; alles andere ist sicher ungültig.
_TOKEN_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{43}")


def new_session_token() -> str:
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def is_plausible_token(token: str) -> bool:
    return bool(_TOKEN_PATTERN.fullmatch(token))


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii")).digest()


def csrf_token(secret_key: str, token_hash: bytes) -> str:
    message = b"csrf:" + token_hash.hex().encode("ascii")
    digest = hmac.new(secret_key.encode(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def csrf_matches(expected: str, given: str | None) -> bool:
    if given is None:
        return False
    # Konstantzeitiger Vergleich gegen Timing-Angriffe.
    return hmac.compare_digest(expected.encode(), given.encode("utf-8", "replace"))
