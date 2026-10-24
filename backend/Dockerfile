# syntax=docker/dockerfile:1
#
# API-Image für das Converter-Backend (B02: minimale startbare Basis).
#   docker build -t converter-backend backend
#
# Basisimage und uv sind per Digest gepinnt; Abhängigkeiten kommen
# ausschließlich aus uv.lock (--frozen).

ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105

FROM ${UV_IMAGE} AS uv

# --- Build: virtuelle Umgebung aus der Lockdatei erzeugen ------------------
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

# --- Laufzeit: ohne uv, ohne Build-Werkzeuge, ohne root -------------------
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    CONVERTER_STORAGE_DIR=/data/storage

RUN groupadd --system --gid 10001 converter \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin converter \
    && install -d -o 10001 -g 10001 -m 0700 /data/storage

COPY --from=build /opt/venv /opt/venv
WORKDIR /app
# Code gehört root und ist für den Laufzeitnutzer nur lesbar.
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini

USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/live', timeout=4).status == 200 else 1)"]

# X-Forwarded-* nur von ausdrücklich konfigurierten Proxies übernehmen
# (CONVERTER_TRUSTED_PROXIES, kommagetrennt). Ohne Angabe: keinem vertrauen.
# uvicorns eigener Standard (127.0.0.1) wird damit bewusst überschrieben.
# Das Zugriffslog schreibt die App selbst (ohne Client-IP und Query).
CMD ["sh", "-c", "if [ -n \"${CONVERTER_TRUSTED_PROXIES:-}\" ]; then set -- --proxy-headers --forwarded-allow-ips \"$CONVERTER_TRUSTED_PROXIES\"; else set -- --no-proxy-headers; fi; exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log --no-server-header \"$@\""]
