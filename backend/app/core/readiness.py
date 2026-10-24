"""Register für Readiness-Prüfungen (``GET /api/v1/health/ready``).

Jeder Arbeitspunkt registriert die Abhängigkeiten, die er einführt
(B02: ``storage``; später ``database``, ``redis``, ``capabilities``). Eine
Prüfung ist eine einfache synchrone Funktion ohne Argumente:

- ``True`` → ``ok``
- ``False``, Ausnahme oder Zeitüberschreitung → ``fail``

Ausnahmedetails landen nur im Serverlog, nie in der Antwort.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Literal

import anyio
import anyio.to_thread

CheckFn = Callable[[], bool]
CheckStatus = Literal["ok", "fail"]

logger = logging.getLogger(__name__)


class ReadinessRegistry:
    def __init__(self, timeout_seconds: float) -> None:
        self._timeout_seconds = timeout_seconds
        self._checks: dict[str, CheckFn] = {}
        # Je Prüfung höchstens ein laufender Thread. Ein abgelaufener Thread
        # läuft im Hintergrund weiter (Threads lassen sich nicht abbrechen);
        # solange er hängt, schlägt die Prüfung sofort fehl, statt bei jedem
        # Healthcheck einen weiteren Thread zu belegen.
        self._in_flight: dict[str, threading.Lock] = {}

    def register(self, name: str, check: CheckFn) -> None:
        if name in self._checks:
            msg = f"Readiness-Prüfung {name!r} ist bereits registriert"
            raise ValueError(msg)
        self._checks[name] = check
        self._in_flight[name] = threading.Lock()

    @property
    def names(self) -> list[str]:
        return sorted(self._checks)

    async def run(self) -> dict[str, CheckStatus]:
        """Führt alle Prüfungen parallel aus, jede mit eigenem Zeitlimit."""
        results: dict[str, CheckStatus] = {}

        async def run_one(name: str, check: CheckFn) -> None:
            results[name] = await self._run_check(name, check)

        async with anyio.create_task_group() as tg:
            for name, check in self._checks.items():
                tg.start_soon(run_one, name, check)
        return dict(sorted(results.items()))

    async def _run_check(self, name: str, check: CheckFn) -> CheckStatus:
        in_flight = self._in_flight[name]
        if not in_flight.acquire(blocking=False):
            logger.warning("Readiness-Prüfung hängt noch", extra={"check": name})
            return "fail"

        # Wer "started" zuerst nimmt, gibt "in_flight" frei: der Thread nach
        # der Prüfung oder – falls der Thread nie startet – dieser Aufrufer.
        started = threading.Lock()

        def guarded() -> bool:
            if not started.acquire(blocking=False):
                return False
            try:
                return check()
            finally:
                in_flight.release()

        def release_if_never_started() -> None:
            if started.acquire(blocking=False):
                in_flight.release()

        try:
            # Prüfungen laufen in einem Thread, damit blockierende I/O die
            # Event-Loop nicht anhält. abandon_on_cancel gibt die Antwort bei
            # Zeitüberschreitung frei, ohne auf den Thread zu warten.
            with anyio.fail_after(self._timeout_seconds):
                ok = await anyio.to_thread.run_sync(guarded, abandon_on_cancel=True)
        except TimeoutError:
            logger.warning("Readiness-Prüfung überschritt Zeitlimit", extra={"check": name})
            return "fail"
        except Exception:
            logger.exception("Readiness-Prüfung fehlgeschlagen", extra={"check": name})
            return "fail"
        finally:
            # Auch bei Abbruch von außen (z. B. Client trennt die Verbindung).
            release_if_never_started()
        return "ok" if ok is True else "fail"
