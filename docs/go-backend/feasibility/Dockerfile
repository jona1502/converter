# G01-Machbarkeitslauf. Ausführen im Projektverzeichnis:
#   docker build -f docs/go-backend/feasibility/Dockerfile -t mi-converter-g01 docs/go-backend/feasibility
#   docker run --rm --init --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true mi-converter-g01
# Setzt das lokal gebaute Backendimage (compose: mi-converter-backend:local) voraus.
FROM golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4 AS build
WORKDIR /src
COPY main.go .
RUN go mod init g01 && CGO_ENABLED=0 go build -trimpath -o /g01 .

FROM mi-converter-backend:local
COPY --from=build /g01 /usr/local/bin/g01
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/g01"]
