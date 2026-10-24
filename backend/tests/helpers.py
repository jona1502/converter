"""Hilfen für API-Tests: Multipart von Hand, Sitzungen, rohe ASGI-Aufrufe."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Iterable, Mapping, MutableMapping
from dataclasses import dataclass
from typing import Any

import anyio
import httpx2
from fastapi import FastAPI
from fastapi.testclient import TestClient

ORIGIN = "http://testserver"
BOUNDARY = "testboundary7MA4YWxkTrZu0gW"

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
)
JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 64
GIF_BYTES = b"GIF89a" + b"\x00" * 64
PDF_BYTES = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n"

IMAGE_OPTIONS: dict[str, Any] = {"tool": "image-convert", "format": "webp"}
PDF_OPTIONS: dict[str, Any] = {"tool": "pdf-compress"}

Part = tuple[str, str | None, bytes]


def multipart(parts: Iterable[Part], boundary: str = BOUNDARY) -> bytes:
    """Baut einen multipart/form-data-Body in genau der gegebenen Reihenfolge."""
    body = bytearray()
    for name, filename, content in parts:
        disposition = f'form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        body += f"--{boundary}\r\nContent-Disposition: {disposition}\r\n".encode()
        if filename is not None:
            body += b"Content-Type: application/octet-stream\r\n"
        body += b"\r\n" + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body)


def job_body(
    options: Mapping[str, Any] | bytes, content: bytes, filename: str = "Bild.png"
) -> bytes:
    raw = options if isinstance(options, bytes) else json.dumps(options).encode()
    return multipart([("options", None, raw), ("file", filename, content)])


CONTENT_TYPE = f"multipart/form-data; boundary={BOUNDARY}"


@dataclass
class ApiClient:
    client: TestClient
    csrf: str | None = None

    def start_session(self) -> dict[str, Any]:
        response = self.client.get("/api/v1/session")
        assert response.status_code == 200
        body: dict[str, Any] = response.json()
        self.csrf = body["csrfToken"]
        return body

    def write_headers(self, **extra: str) -> dict[str, str]:
        headers = {"X-CSRF-Token": self.csrf or "", "Origin": ORIGIN}
        headers.update(extra)
        return headers

    def post_job(
        self,
        body: bytes,
        *,
        key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx2.Response:
        request_headers = self.write_headers(**{"Content-Type": CONTENT_TYPE})
        if key is not None:
            request_headers["Idempotency-Key"] = key
        request_headers.update(headers or {})
        return self.client.post("/api/v1/jobs", content=body, headers=request_headers)

    def create_job(
        self, options: Mapping[str, Any] | None = None, content: bytes = PNG_BYTES, **kw: Any
    ) -> dict[str, Any]:
        response = self.post_job(job_body(options or IMAGE_OPTIONS, content), **kw)
        assert response.status_code == 202, response.text
        job: dict[str, Any] = response.json()
        return job

    def get_job(self, job_id: str) -> httpx2.Response:
        return self.client.get(f"/api/v1/jobs/{job_id}")

    def delete_job(self, job_id: str) -> httpx2.Response:
        return self.client.delete(f"/api/v1/jobs/{job_id}", headers=self.write_headers())

    def session_cookie(self) -> str:
        value = self.client.cookies.get("converter_session")
        assert value
        return value


@dataclass
class RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


def raw_request(
    app: FastAPI,
    *,
    method: str,
    path: str,
    headers: Mapping[str, str],
    chunks: Iterable[bytes],
    disconnect: bool = False,
) -> RawResponse:
    """Ruft die ASGI-App direkt auf, um Body-Stücke genau zu steuern.

    ``disconnect=True`` meldet nach den Stücken ``http.disconnect`` – wie ein
    Client, der die Verbindung mitten im Upload trennt.
    """
    messages: list[dict[str, Any]] = [
        {"type": "http.request", "body": chunk, "more_body": True} for chunk in chunks
    ]
    if disconnect:
        messages.append({"type": "http.disconnect"})
    else:
        messages.append({"type": "http.request", "body": b"", "more_body": False})
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        await anyio.sleep_forever()
        raise AssertionError  # pragma: no cover

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(dict(message))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
        "state": {},
    }

    async def run() -> None:
        with anyio.fail_after(30):
            await app(scope, receive, send)

    anyio.run(run)
    start = next((m for m in sent if m["type"] == "http.response.start"), None)
    status = start["status"] if start else 0
    response_headers = {
        k.decode().lower(): v.decode() for k, v in (start["headers"] if start else [])
    }
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return RawResponse(status=status, headers=response_headers, body=body)


def new_key() -> str:
    return uuid.uuid4().hex
