"""Keep an actual anonymous queued job across a local backend cutover.

Only synthetic PNG data; cookie/state files remain in ignored server/.data.
Run create with workers stopped, switch backend, then run finish.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import struct
import time
import urllib.request
import uuid
import zlib


def png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 24, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\x20\x80\xf0" * 32) * 24)) + chunk(b"IEND", b""))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["create", "finish"])
    parser.add_argument("--base-url", default="http://localhost:8080")
    parser.add_argument("--name", default="cutover")
    args = parser.parse_args()
    if not args.name.replace("-", "").isalnum():
        raise ValueError("simple probe name required")
    base = args.base_url.rstrip("/")
    root = Path(__file__).resolve().parent.parent / "server" / ".data" / "cutover"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path, cookie_path = root / (args.name + ".json"), root / (args.name + ".cookies")
    jar = http.cookiejar.MozillaCookieJar(str(cookie_path))
    if args.mode == "finish":
        jar.load(ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request(path: str, method: str = "GET", data: bytes | None = None,
                headers: dict[str, str] | None = None) -> tuple[bytes, int]:
        req = urllib.request.Request(base + path, data=data, headers=headers or {}, method=method)
        with opener.open(req, timeout=15) as response:
            return response.read(), response.status

    session = json.loads(request("/api/v1/session")[0])
    writes = {"X-CSRF-Token": session["csrfToken"], "Origin": base}
    if args.mode == "create":
        boundary = uuid.uuid4().hex
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n'
                '{"tool":"image-convert","format":"png"}'
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="cutover.png"'
                '\r\nContent-Type: image/png\r\n\r\n').encode() + png() + f"\r\n--{boundary}--\r\n".encode()
        body, status = request("/api/v1/jobs", "POST", data, {
            **writes, "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Idempotency-Key": uuid.uuid4().hex,
        })
        job = json.loads(body)
        if status != 202 or job["state"] != "queued":
            raise RuntimeError("worker must be stopped before creating cutover job")
        jar.save(ignore_discard=True, ignore_expires=True)
        state_path.write_text(json.dumps({"id": job["id"]}), encoding="utf-8")
        os.chmod(state_path, 0o600)
        os.chmod(cookie_path, 0o600)
        print("queued probe saved; no tokens printed")
        return
    if session["created"]:
        raise RuntimeError("existing anonymous session was lost")
    job_id = json.loads(state_path.read_text(encoding="utf-8"))["id"]
    path = "/api/v1/jobs/" + job_id
    deadline = time.monotonic() + 45
    while True:
        job = json.loads(request(path)[0])
        if job["state"] not in {"queued", "running"}:
            break
        if time.monotonic() > deadline:
            raise RuntimeError("queue handover did not finish")
        time.sleep(0.3)
    if job["state"] != "succeeded":
        raise RuntimeError("handed-over job failed")
    output, status = request(job["results"][0]["downloadUrl"])
    if status != 200 or not output.startswith(b"\x89PNG\r\n\x1a\n") or len(output) != job["results"][0]["size"]:
        raise RuntimeError("invalid handed-over download")
    if request(path, "DELETE", headers=writes)[1] != 204:
        raise RuntimeError("handed-over job could not be deleted")
    print("session + queued job + valid download + delete survived cutover")


if __name__ == "__main__":
    main()
