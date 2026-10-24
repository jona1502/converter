"""Gemeinsame Basis für API-Modelle: Python nutzt snake_case, JSON camelCase."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, PlainSerializer
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        extra="forbid",
    )


def _format_utc(value: datetime) -> str:
    # Vertrag §2: ISO 8601 in UTC mit "Z" (z. B. 2026-10-24T12:00:00.000Z).
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


UtcDatetime = Annotated[
    AwareDatetime, PlainSerializer(_format_utc, return_type=str, when_used="json")
]
