"""Einstiegspunkt ``python -I -m converter.cli run|probe`` für den Go-Worker.

``run``: liest genau eine Anfrage (``protocol``) von stdin, isoliert sich und
schreibt JSONL-Ereignisse auf stdout. ``probe``: isoliert sich, prüft echte
Rundreisen aller Formate und schreibt genau ein JSON-Objekt.

Vor ``sandbox.isolate`` werden nur Standardbibliothek und reine
Python-Module dieses Pakets geladen; Pillow/pikepdf/soundfile/numpy erst danach.
"""

from __future__ import annotations

import contextlib
import os
import sys
from typing import IO, Final

from converter.errors import ProcessingError, ProtocolError
from converter.protocol import MAX_REQUEST_BYTES, EventWriter, encode_event, parse_request
from converter.sandbox import isolate

# Feste Grenzen der Probe: kleine Fixtures im Speicher, keine Ausgabedateien.
PROBE_MEMORY: Final = 1 << 30
PROBE_TIMEOUT: Final = 60
PROBE_OUTPUT: Final = 1 << 20


def claim_stdout() -> IO[bytes]:
    """Reserviert fd 1 für das Protokoll; alles andere landet auf stderr.

    Native Bibliotheken oder versehentliche ``print``-Aufrufe können so keine
    Protokollzeilen einschleusen oder zerstören.
    """
    sys.stdout.flush()
    protocol = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return protocol


def single_threaded() -> None:
    """Native Rechenbibliotheken (numpy/OpenBLAS) ohne Threadpools laden.

    Jeder Thread reserviert Adressraum; unter RLIMIT_AS könnten viele Kerne
    sonst schon den Import scheitern lassen. Vor dem Import aufrufen.
    """
    for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[name] = "1"


def _fatal(writer: EventWriter, code: str) -> int:
    # Ist stdout schon geschlossen (Go beendet), bleibt nur der Exit-Code.
    with contextlib.suppress(Exception):
        writer.fatal(code)
    return 1


def run(stdin: IO[bytes], stdout: IO[bytes]) -> int:
    writer = EventWriter(stdout)
    try:
        request = parse_request(stdin.read(MAX_REQUEST_BYTES + 1))
    except ProtocolError as exc:
        return _fatal(writer, exc.code)
    except Exception:
        return _fatal(writer, "protocol-error")
    try:
        isolate(request.memory, request.timeout, request.output_limit)
    except Exception:
        return _fatal(writer, "sandbox-failed")
    try:
        # Erst nach der Isolation native Parser importieren.
        single_threaded()
        from converter.execute import execute

        execute(request, writer)
    except ProcessingError as exc:
        return _fatal(writer, exc.code)
    except MemoryError:
        return _fatal(writer, "memory-limit")
    except Exception:
        return _fatal(writer, "worker-failed")
    return 0


def probe(stdout: IO[bytes]) -> int:
    try:
        isolate(PROBE_MEMORY, PROBE_TIMEOUT, PROBE_OUTPUT)
    except Exception:
        return _fatal(EventWriter(stdout), "sandbox-failed")
    try:
        single_threaded()
        from converter.probe import run_probe

        report = run_probe()
    except Exception:
        return _fatal(EventWriter(stdout), "worker-failed")
    stdout.write(encode_event(report))
    stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    stdout = claim_stdout()
    if args == ["run"]:
        return run(sys.stdin.buffer, stdout)
    if args == ["probe"]:
        return probe(stdout)
    sys.stderr.write("usage: python -m converter.cli run|probe\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
