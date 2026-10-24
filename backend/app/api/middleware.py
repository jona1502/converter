"""Request-Middleware: Request-ID, Sicherheitsheader, Zugriffslog, 500-Fallback.

Bewusst als reine ASGI-Middleware statt ``BaseHTTPMiddleware``: Sie puffert
keine Antworten, funktioniert also auch mit späteren Streaming-Downloads.

Reihenfolge bei FastAPI/Starlette (außen → innen)::

    ServerErrorMiddleware → RequestContextMiddleware → ExceptionMiddleware → Router

Die Exception-Handler aus ``errors.py`` laufen in der ``ExceptionMiddleware``.
Eine dort nicht behandelte Ausnahme erreicht diese Middleware; sie loggt sie
(ohne Body) und antwortet mit ``500 internal-error`` im Vertragsformat.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Final

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api import API_PREFIX
from app.api.errors import internal_error_response
from app.core.logs import request_id_var

logger = logging.getLogger("app.request")

# Vom Proxy übernommene IDs werden nur in diesem Format akzeptiert, damit
# keine Steuerzeichen oder beliebig langen Werte in Logs landen.
REQUEST_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9-]{8,64}")
HEALTH_PREFIX: Final = f"{API_PREFIX}/health/"


def accept_or_generate_request_id(value: str | None) -> str:
    if value is not None and REQUEST_ID_PATTERN.fullmatch(value):
        return value
    return str(uuid.uuid4())


def _route_template(scope: Scope) -> str:
    # FastAPI legt die getroffene Route in den Scope. Geloggt wird die
    # Vorlage (z. B. "/api/v1/jobs/{id}"), nicht der rohe Pfad: unbekannte
    # Pfade könnten beliebige Nutzereingaben enthalten.
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "unmatched"


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = accept_or_generate_request_id(Headers(scope=scope).get("x-request-id"))
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_code = 500
        response_started = False

        async def send_with_headers(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-Id"] = request_id
                headers["X-Content-Type-Options"] = "nosniff"
                # Downloads setzen später "private, no-store" selbst.
                if "cache-control" not in headers:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        except Exception:
            # Nur Typ und Traceback loggen – keine Header, Cookies oder Body.
            logger.exception("Unbehandelte Ausnahme", extra={"requestId": request_id})
            if response_started:
                # Antwort läuft bereits; Starlette/uvicorn brechen sie ab.
                raise
            await internal_error_response()(scope, receive, send_with_headers)
        finally:
            route = _route_template(scope)
            # Erfolgreiche Health-Abfragen (Container-Healthcheck alle paar
            # Sekunden) nur auf DEBUG, damit sie das Log nicht fluten.
            quiet = route.startswith(HEALTH_PREFIX) and status_code < 400
            logger.log(
                logging.DEBUG if quiet else logging.INFO,
                "request",
                extra={
                    "requestId": request_id,
                    "method": scope["method"],
                    "route": route,
                    "status": status_code,
                    "durationMs": round((time.perf_counter() - started) * 1000, 1),
                },
            )
            request_id_var.reset(token)
