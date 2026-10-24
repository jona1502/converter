"""Black-box acceptance through the real proxy, API, broker and worker."""

from __future__ import annotations

import argparse
import http.cookiejar
import io
import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

import pikepdf
from PIL import Image


def main(base: str) -> None:
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    def request(
        path: str,
        method: str = "GET",
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[bytes, Any]:
        req = urllib.request.Request(  # noqa: S310 - local stack URL explicitly chosen by operator
            base + path, data=body, method=method, headers=headers or {}
        )
        with opener.open(req, timeout=20) as response:
            return response.read(), response.headers

    session = json.loads(request("/api/v1/session")[0])
    write_headers = {"X-CSRF-Token": session["csrfToken"], "Origin": base}
    image = io.BytesIO()
    Image.new("RGBA", (160, 96), (30, 100, 200, 128)).save(image, "PNG")
    pdf_buffer = io.BytesIO()
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(pdf_buffer)
    cases: list[tuple[dict[str, Any], bytes, str]] = [
        ({"tool": "image-convert", "format": "webp"}, image.getvalue(), "probe.png"),
        (
            {"tool": "image-compress", "format": "jpeg", "quality": 0.6},
            image.getvalue(),
            "probe.png",
        ),
        (
            {
                "tool": "image-resize",
                "format": "png",
                "resize": {"mode": "percent", "percent": 50, "allowUpscale": False},
            },
            image.getvalue(),
            "probe.png",
        ),
        ({"tool": "pdf-compress"}, pdf_buffer.getvalue(), "probe.pdf"),
    ]
    for options, data, name in cases:
        boundary = uuid.uuid4().hex
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n'
                + json.dumps(options)
                + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                + f'filename="{name}"\r\n'
                + "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{boundary}--\r\n".encode()
        )
        headers = {
            **write_headers,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Idempotency-Key": uuid.uuid4().hex,
        }
        job = json.loads(request("/api/v1/jobs", "POST", body, headers)[0])
        job_path = "/api/v1/jobs/" + job["id"]
        try:
            deadline = time.monotonic() + 45
            while job["state"] in {"queued", "running"} and time.monotonic() < deadline:
                time.sleep(0.25)
                job = json.loads(request(job_path)[0])
            if job["state"] != "succeeded":
                raise RuntimeError(f"{options['tool']}: {job['state']}, {job.get('error')}")
            for result in job["results"]:
                output, response_headers = request(result["downloadUrl"])
                if (
                    len(output) != result["size"]
                    or "attachment" not in response_headers["Content-Disposition"]
                ):
                    raise RuntimeError("Invalid download metadata")
                if options["tool"] == "pdf-compress":
                    with pikepdf.Pdf.open(io.BytesIO(output)) as parsed:
                        if len(parsed.pages) != 1:
                            raise RuntimeError("Invalid PDF output")
                else:
                    with Image.open(io.BytesIO(output)) as parsed_image:
                        parsed_image.load()
                        if options["tool"] == "image-resize" and parsed_image.size != (80, 48):
                            raise RuntimeError("Invalid resized dimensions")
            print(f"{options['tool']}: OK ({len(job['results'])} result(s))")
        finally:
            request(job_path, "DELETE", headers=write_headers)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8080")
    main(parser.parse_args().base_url.rstrip("/"))
