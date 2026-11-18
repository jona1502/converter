# syntax=docker/dockerfile:1
#
# Laufzeitimage des privaten Konverters (Pillow/pikepdf/soundfile) für den Go-Worker.
#   docker build -t mi-converter-converter:local converter
# Tests im Linux-Container (inklusive Sandboxproben):
#   docker build --target test -t mi-converter-converter-test:local converter
#   docker run --rm --init --network none mi-converter-converter-test:local
# Probe im Laufzeitimage (Elternprozess ist später der Go-Worker; hier ein
# kurzer Python-Elternprozess, weil die Sandbox PID 1 als Elternteil ablehnt):
#   docker run --rm --init --network none --read-only --cap-drop ALL \
#     --security-opt no-new-privileges mi-converter-converter:local \
#     python -I -c "import subprocess,sys; sys.exit(subprocess.call([sys.executable,'-I','-m','converter.cli','probe']))"
#
# Basisimage und uv per Digest gepinnt, identisch zu backend/Dockerfile;
# Abhängigkeiten ausschließlich aus uv.lock (--frozen).

ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105

FROM ${UV_IMAGE} AS uv

# --- Build: Laufzeitumgebung ohne Dev-Abhängigkeiten -----------------------
FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# --- Build: Testumgebung mit Dev-Gruppe (pytest, pypdfium2, ruff, mypy) ----
FROM ${PYTHON_IMAGE} AS build-test
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# --- Test: alle Tests als Nutzer 10001 unter Linux -------------------------
FROM ${PYTHON_IMAGE} AS test
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH
RUN groupadd --system --gid 10001 converter \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin converter
COPY --from=build-test /opt/venv /opt/venv
WORKDIR /app
COPY pyproject.toml ./
COPY converter ./converter
COPY tests ./tests
USER 10001:10001
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider"]

# --- Laufzeit: ohne uv, ohne Dev-Werkzeuge, ohne root ----------------------
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH
RUN groupadd --system --gid 10001 converter \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin converter
COPY --from=build /opt/venv /opt/venv
# Paket root-eigen in site-packages: `python -I -m converter.cli` braucht
# weder Arbeitsverzeichnis noch PYTHONPATH (Go übergibt kaum Umgebung).
COPY converter /opt/venv/lib/python3.13/site-packages/converter
RUN chmod -R a-x,u=rwX,go=rX /opt/venv/lib/python3.13/site-packages/converter \
    && python -m compileall -q /opt/venv/lib/python3.13/site-packages/converter \
    && python -I -c "import converter.cli" \
    && python -I -c "import soundfile as sf; assert {'MP3','WAV','FLAC','OGG'} <= set(sf.available_formats()), sf.__libsndfile_version__" \
    && python -I -c "import pypdfium2 as p; print(p.version.PYPDFIUM_INFO, p.version.PDFIUM_INFO)"
USER 10001:10001
WORKDIR /
# Bewusst kein ENTRYPOINT/Server: der Go-Worker (G10) startet
# `python -I -m converter.cli run|probe` direkt als Kindprozess.
