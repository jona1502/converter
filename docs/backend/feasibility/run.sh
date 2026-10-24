#!/usr/bin/env sh
# B01-PoC ausführen: Bauen mit Netzwerk, Verarbeitung ohne Netzwerk.
set -eu
cd "$(dirname "$0")"
mkdir -p out
# Git Bash unter Windows: Pfadumschreibung abschalten, Windows-Pfad für den Bind-Mount verwenden.
export MSYS_NO_PATHCONV=1
HOST_OUT="$( (pwd -W 2>/dev/null || pwd) | tr -d '\r')/out"
docker build -t converter-b01-poc:local .
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=256m \
  --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 \
  -v "$HOST_OUT:/out" converter-b01-poc:local

# Gegenproben: vertauschte Matrixreihenfolge nur bei cm bzw. nur bei Form-/Matrix muss jeweils scheitern.
for mode in cm form; do
  echo "== Gegenprobe POC_SWAP=$mode (Fehlschlag erwartet)"
  if docker run --rm --network none --read-only --tmpfs /tmp:rw,size=256m     --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2     -e POC_SWAP=$mode -e POC_OUT=/tmp/swap converter-b01-poc:local python -I pdf_poc.py; then
    echo "GEGENPROBE $mode FEHLGESCHLAGEN: vertauschte Reihenfolge blieb unentdeckt" >&2
    exit 1
  fi
  echo "GEGENPROBE $mode: OK (vertauschte Reihenfolge erkannt)"
done
