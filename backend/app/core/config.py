"""Zentrale Konfiguration über Umgebungsvariablen.

Alle Werte kommen aus Umgebungsvariablen mit dem Präfix ``CONVERTER_``
(z. B. ``CONVERTER_SECRET_KEY``). Die Grenzwerte entsprechen den Startwerten
aus ``docs/backend/api-contract.md`` Abschnitt 6.

Sicherheitsprinzip: Der Standard für ``environment`` ist ``production``. Wer
die Umgebung vergisst, bekommt also die strenge Validierung und keine
unsicheren Entwicklungs-Defaults.
"""

from __future__ import annotations

import ipaddress
import secrets
from functools import cached_property
from pathlib import Path
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]
IpNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

MIN_SECRET_KEY_LENGTH = 32

PositiveInt = Annotated[int, Field(gt=0)]


def _split_csv(value: object) -> object:
    """Erlaubt kommagetrennte Listen in Umgebungsvariablen (statt JSON)."""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CONVERTER_",
        extra="ignore",
        frozen=True,
        # Validierungsfehler enthalten sonst den Eingabewert – beim Modell-
        # validator das gesamte Env-Dict inklusive Secrets und DB-Passwort.
        hide_input_in_errors=True,
    )

    # --- Betrieb -------------------------------------------------------------
    environment: Environment = "production"
    log_level: LogLevel = "INFO"

    # Pflicht in Produktion. Außerhalb von Produktion wird ohne Angabe ein
    # zufälliger Schlüssel pro Prozess erzeugt (CSRF-Tokens überleben dann
    # keinen Neustart – für Entwicklung und Tests unkritisch).
    secret_key: SecretStr | None = None

    # Erlaubte Origins für schreibende Anfragen (CSRF/Origin-Prüfung, ab B03),
    # z. B. "https://converter.example". Kommagetrennt.
    allowed_origins: Annotated[list[str], NoDecode] = []
    # Reverse Proxies, deren X-Forwarded-For vertraut wird (IP oder CIDR).
    # Leer = keinem Proxy vertrauen; Client-IP ist dann die direkte Gegenstelle.
    trusted_proxies: Annotated[list[IpNetwork], NoDecode] = []

    session_cookie_secure: bool = True

    storage_dir: Path = Path("/data/storage")
    # PostgreSQL (ab B03, in production Pflicht) und Redis/Valkey (ab B04).
    # SecretStr, weil die URLs Passwörter enthalten können und so nie
    # versehentlich geloggt werden. "postgresql://" wird automatisch auf den
    # psycopg-3-Treiber abgebildet.
    database_url: SecretStr | None = None
    redis_url: SecretStr | None = None
    database_pool_size: Annotated[int, Field(ge=1, le=50)] = 5

    health_check_timeout_seconds: Annotated[float, Field(gt=0, le=30)] = 2.0

    # --- Grenzwerte (Vertrag Abschnitt 6) -----------------------------------
    image_max_input_bytes: PositiveInt = 52_428_800
    image_max_pixels: PositiveInt = 40_000_000
    image_max_edge: PositiveInt = 16_384
    image_max_output_bytes: PositiveInt = 104_857_600
    pdf_max_input_bytes: PositiveInt = 100_000_000
    pdf_max_results_total_bytes: PositiveInt = 300_000_000
    pdf_image_max_pixels: PositiveInt = 40_000_000

    job_ttl_seconds: PositiveInt = 3600
    job_max_attempts: PositiveInt = 3
    session_ttl_seconds: PositiveInt = 86_400
    session_max_active_jobs: PositiveInt = 3
    global_max_active_jobs: PositiveInt = 50
    session_creates_per_minute: PositiveInt = 10
    ip_creates_per_minute: PositiveInt = 10
    session_replays_per_minute: PositiveInt = 30
    session_new_per_minute: PositiveInt = 30

    image_timeout_seconds: PositiveInt = 120
    pdf_timeout_seconds: PositiveInt = 300

    storage_budget_bytes: PositiveInt = 5_000_000_000
    cleanup_interval_seconds: PositiveInt = 60
    download_max_seconds: PositiveInt = 300
    physical_delete_max_seconds: PositiveInt = 600

    # Wird dem Frontend über /capabilities mitgeteilt (ab B05).
    upload_concurrency: PositiveInt = 2

    # Upload (Vertrag §4 POST /jobs): Gesamtdauer eines Uploads und damit
    # auch Lebensdauer einer Upload-Reservierung.
    upload_max_seconds: PositiveInt = 600

    # --- Validierung ---------------------------------------------------------
    @field_validator("log_level", mode="before")
    @classmethod
    def _upper_log_level(cls, value: object) -> object:
        return value.upper() if isinstance(value, str) else value

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _parse_origins(cls, value: object) -> object:
        return _split_csv(value)

    @field_validator("allowed_origins")
    @classmethod
    def _check_origins(cls, origins: list[str]) -> list[str]:
        normalized: list[str] = []
        for origin in origins:
            parts = urlsplit(origin)
            is_origin = (
                parts.scheme in {"http", "https"}
                and bool(parts.netloc)
                and parts.path in {"", "/"}
                and not parts.query
                and not parts.fragment
                and "@" not in parts.netloc
            )
            if not is_origin:
                msg = "allowed_origins erwartet Origins wie 'https://host[:port]'"
                raise ValueError(msg)
            normalized.append(f"{parts.scheme}://{parts.netloc}".lower())
        return normalized

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def _parse_proxies(cls, value: object) -> object:
        value = _split_csv(value)
        if isinstance(value, list):
            return [ipaddress.ip_network(item, strict=False) for item in value]
        return value

    @model_validator(mode="after")
    def _check_production(self) -> Self:
        if self.session_ttl_seconds < self.job_ttl_seconds:
            raise ValueError("session_ttl_seconds must cover job_ttl_seconds")
        if (
            self.physical_delete_max_seconds
            < max(
                self.download_max_seconds,
                self.image_timeout_seconds + self.cleanup_interval_seconds,
                self.pdf_timeout_seconds + self.cleanup_interval_seconds,
            )
            + self.cleanup_interval_seconds
            + 10
        ):
            raise ValueError(
                "physical_delete_max_seconds must cover download, parser timeout and cleanup grace"
            )
        key = self.secret_key.get_secret_value() if self.secret_key else None
        if key is not None and len(key) < MIN_SECRET_KEY_LENGTH:
            msg = f"secret_key muss mindestens {MIN_SECRET_KEY_LENGTH} Zeichen lang sein"
            raise ValueError(msg)
        if self.environment != "production":
            return self
        if key is None:
            raise ValueError("secret_key ist in production Pflicht")
        if not self.session_cookie_secure:
            raise ValueError("session_cookie_secure darf in production nicht false sein")
        if not self.allowed_origins:
            raise ValueError("allowed_origins ist in production Pflicht")
        if self.database_url is None:
            raise ValueError("database_url ist in production Pflicht")
        return self

    # --- Abgeleitete Werte ---------------------------------------------------
    @property
    def effective_secret_key(self) -> str:
        """Konfigurierter Schlüssel oder (nur außerhalb production) ein Zufallswert."""
        if self.secret_key is not None:
            return self.secret_key.get_secret_value()
        return self._development_secret_key

    @cached_property
    def _development_secret_key(self) -> str:
        return secrets.token_urlsafe(MIN_SECRET_KEY_LENGTH)

    @property
    def max_upload_input_bytes(self) -> int:
        """Größte Eingabe über alle Werkzeuge (Reservierung vor dem Lesen)."""
        return max(self.image_max_input_bytes, self.pdf_max_input_bytes)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"
