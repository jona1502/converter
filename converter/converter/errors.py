"""Stabile Fehlercodes ohne Pfade, Dateinamen oder Bibliothekstexte."""

from __future__ import annotations


class ProcessingError(Exception):
    """Fachlicher Verarbeitungsfehler; ``code`` ist ein Vertragscode."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


class ProtocolError(Exception):
    """Ungültige Anfrage des Go-Workers (Hülle oder Optionen)."""

    def __init__(self, code: str, reason: str) -> None:
        self.code = code
        # Nur feste, interne Begründungen ohne Eingabewerte (für Tests).
        self.reason = reason
        super().__init__(reason)
