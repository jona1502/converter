# syntax=docker/dockerfile:1
# Build context: repository root. Pure Go services use the runtime target;
# only the worker target contains the private Python codec runtime.
ARG GO_IMAGE=golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105

FROM ${GO_IMAGE} AS build
WORKDIR /src/server
ENV GOTOOLCHAIN=local
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/cleanup ./cmd/cleanup \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/health ./cmd/health \
    && mkdir -p /empty && chmod 0700 /empty

FROM scratch AS runtime
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/api /app/api
COPY --from=build /out/cleanup /app/cleanup
COPY --from=build /out/migrate /app/migrate
COPY --from=build /out/health /app/health
COPY --from=build --chown=10001:10001 /empty /data/storage
USER 10001:10001
EXPOSE 8000
ENTRYPOINT ["/app/api"]

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS codec-build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY converter/pyproject.toml converter/uv.lock converter/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project

FROM ${PYTHON_IMAGE} AS worker
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH
RUN groupadd --system --gid 10001 converter \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin converter \
    && install -d -o 10001 -g 10001 -m 0700 /data/storage
COPY --from=codec-build /opt/venv /opt/venv
COPY converter/converter /opt/venv/lib/python3.13/site-packages/converter
COPY --from=build /out/worker /app/worker
# libsndfile stammt aus dem soundfile-Wheel (keine Systempakete); MP3 muss
# beim Bauen nachweislich enthalten sein (die Rundreise prüft die Probe).
RUN chmod -R a-x,u=rwX,go=rX /opt/venv/lib/python3.13/site-packages/converter \
    && python -I -c "import converter.cli" \
    && python -I -c "import soundfile as sf; assert {'MP3','WAV','FLAC','OGG'} <= set(sf.available_formats()), sf.__libsndfile_version__" \
    && python -I -c "import pypdfium2 as p; print(p.version.PYPDFIUM_INFO, p.version.PDFIUM_INFO)"
USER 10001:10001
WORKDIR /
ENTRYPOINT ["/app/worker"]
