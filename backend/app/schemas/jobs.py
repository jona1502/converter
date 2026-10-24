"""Antwortmodell ``Job`` (Vertrag §5)."""

from __future__ import annotations

import uuid
from typing import Any

from app.api.errors import ApiErrorCode, ProcessingErrorCode
from app.jobs.domain import InputFormat, JobPhase, JobState, PdfLevel, ResultState, Tool
from app.schemas.base import ApiModel, UtcDatetime


class JobError(ApiModel):
    code: ProcessingErrorCode | ApiErrorCode


class JobInput(ApiModel):
    name: str
    size: int
    format: InputFormat
    # Abmessungen aus der Header-Probe (ab B05); bei PDF immer null.
    width: int | None
    height: int | None


class JobResultView(ApiModel):
    id: uuid.UUID
    level: PdfLevel | None
    state: ResultState
    size: int | None
    mime: str
    download_name: str
    # Nur bei veröffentlichtem, nicht abgelaufenem Ergebnis.
    download_url: str | None
    # Bild- bzw. PDF-Details (ab B05/B08).
    details: dict[str, Any] | None
    error: JobError | None


class JobView(ApiModel):
    id: uuid.UUID
    tool: Tool
    state: JobState
    phase: JobPhase | None
    created_at: UtcDatetime
    updated_at: UtcDatetime
    expires_at: UtcDatetime
    input: JobInput
    # Echte Zähler (ab B08), sonst null.
    progress: dict[str, Any] | None
    # PdfAnalysis (ab B07), sonst null.
    analysis: dict[str, Any] | None
    results: list[JobResultView]
    error: JobError | None
    cancel_requested: bool
