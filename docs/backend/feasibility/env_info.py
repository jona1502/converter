"""B01-PoC: Umgebung im Container ausgeben."""

import os
import platform
import socket
import sys

import PIL
import pikepdf
import pypdfium2
import pypdfium2.version
from PIL import features

print("## Umgebung")
with open("/etc/os-release", encoding="utf-8") as fh:
    print("os:", next(line for line in fh if line.startswith("PRETTY_NAME")).strip())
print("python:", sys.version.split()[0], platform.machine())
print("uid/gid:", os.getuid(), os.getgid())
print("Pillow:", PIL.__version__)
for f in ("libjpeg_turbo", "zlib", "libpng", "webp", "avif", "freetype2", "littlecms2", "libimagequant", "libtiff", "raqm"):
    print(f"  {f}: {features.version(f)}")
print("pikepdf:", pikepdf.__version__, "qpdf:", pikepdf.__libqpdf_version__)
print("pypdfium2:", pypdfium2.version.PYPDFIUM_INFO, "pdfium:", pypdfium2.version.PDFIUM_INFO)
try:
    socket.create_connection(("pypi.org", 443), timeout=3).close()
    print("netzwerk: ERREICHBAR (unerwartet)")
    sys.exit(1)
except OSError as exc:
    print("netzwerk: nicht erreichbar wie erwartet ->", type(exc).__name__)
