"""Stable processing failures without parser paths or private metadata."""


class ProcessingError(Exception):
    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)
