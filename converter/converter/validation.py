"""Kleine strikte Prüfhelfer für dekodiertes JSON (ohne pydantic).

Typen werden nie umgewandelt: ``true`` ist keine Zahl, ``50.0`` keine
Ganzzahl, ``"0.5"`` keine Zahl. Fehler tragen nur feste Begründungen.
"""

from __future__ import annotations

import math
from collections.abc import Collection
from typing import Any

from converter.errors import ProtocolError


def fail(code: str, reason: str) -> ProtocolError:
    return ProtocolError(code, reason)


def obj(
    value: object,
    *,
    required: Collection[str],
    optional: Collection[str] = (),
    code: str,
    where: str,
) -> dict[str, Any]:
    if type(value) is not dict:
        raise fail(code, f"{where}: object expected")
    keys = set(value)
    if not keys <= set(required) | set(optional):
        raise fail(code, f"{where}: unknown field")
    if not set(required) <= keys:
        raise fail(code, f"{where}: missing field")
    return value


def boolean(value: object, *, code: str, where: str) -> bool:
    if type(value) is not bool:
        raise fail(code, f"{where}: boolean expected")
    return value


def integer(value: object, *, code: str, where: str, minimum: int, maximum: int) -> int:
    # type() statt isinstance(): bool ist in Python eine int-Unterklasse.
    if type(value) is not int:
        raise fail(code, f"{where}: integer expected")
    if not minimum <= value <= maximum:
        raise fail(code, f"{where}: out of range")
    return value


def number(value: object, *, code: str, where: str) -> float:
    if type(value) is not int and type(value) is not float:
        raise fail(code, f"{where}: number expected")
    result = float(value)
    if not math.isfinite(result):
        raise fail(code, f"{where}: finite number expected")
    return result


def string(value: object, *, code: str, where: str, max_length: int) -> str:
    if type(value) is not str:
        raise fail(code, f"{where}: string expected")
    if len(value) > max_length:
        raise fail(code, f"{where}: too long")
    return value


def array(value: object, *, code: str, where: str, max_items: int) -> list[Any]:
    if type(value) is not list:
        raise fail(code, f"{where}: array expected")
    if len(value) > max_items:
        raise fail(code, f"{where}: too many items")
    return value
