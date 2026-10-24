"""Überwacht einen isolierten Kindprozess und veröffentlicht nur mit gültiger Lease."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from typing import Any

from app.core.config import Settings
from app.db.engine import Database
from app.jobs import runtime
from app.storage.local import LocalStorage, result_key


def run_job(job_id: str, settings: Settings | None = None) -> None:
    settings = settings or Settings()
    if settings.database_url is None:
        raise RuntimeError("database required")
    database = Database(settings.database_url.get_secret_value(), pool_size=2)
    storage = LocalStorage(settings.storage_dir)
    task = runtime.claim(database, uuid.UUID(job_id), settings)
    if task is None:
        database.dispose()
        return
    process: subprocess.Popen[str] | None = None
    files: dict[str, str] = {}
    published: set[str] = set()
    error: str | None = None
    stop_reader = threading.Event()
    reader: threading.Thread | None = None
    try:
        results = []
        for result_id, level in task.results:
            key = result_key(task.id, result_id, task.token)
            # Storage erzeugt exklusive private Datei/Verzeichnisse; Parser überschreibt nur diese.
            storage.create(key).close()
            files[str(result_id)] = key
            results.append(
                {"id": str(result_id), "level": level, "path": str(storage.path_for(key).resolve())}
            )
        timeout = (
            settings.pdf_timeout_seconds
            if task.tool == "pdf-compress"
            else settings.image_timeout_seconds
        )
        limits = {
            name: getattr(settings, name)
            for name in (
                "image_max_input_bytes",
                "image_max_pixels",
                "image_max_edge",
                "image_max_output_bytes",
                "pdf_max_input_bytes",
                "pdf_max_results_total_bytes",
                "pdf_image_max_pixels",
            )
        }
        request = {
            "source": str(storage.path_for(task.input_key).resolve()),
            "options": task.options,
            "results": results,
            "limits": limits,
            "memory": 1_073_741_824,
            "timeout": timeout,
            "outputLimit": settings.pdf_max_results_total_bytes
            if task.tool == "pdf-compress"
            else settings.image_max_output_bytes,
        }
        # Keine geerbten DB-/Broker-Secrets, kein Proxy oder PYTHONPATH aus der Umgebung.
        environment = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"}
        }
        process = subprocess.Popen(
            [sys.executable, "-m", "app.worker.child"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            env=environment,
        )
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("child pipes unavailable")
        process.stdin.write(json.dumps(request))
        process.stdin.close()
        events: queue.Queue[str | None] = queue.Queue(maxsize=64)

        def read() -> None:
            if process is None or process.stdout is None:
                return
            while not stop_reader.is_set():
                line = process.stdout.readline(64 * 1024)
                value = line if line else None
                while not stop_reader.is_set():
                    try:
                        events.put(value, timeout=0.1)
                        break
                    except queue.Full:
                        continue
                if not line:
                    break

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        started, last_heartbeat = time.monotonic(), 0.0
        reached_eof = False
        while True:
            now = time.monotonic()
            if now - started > timeout:
                error = "timeout"
                break
            if now - last_heartbeat >= 2:
                if not runtime.heartbeat(database, task):
                    break
                last_heartbeat = now
            try:
                line = events.get(timeout=0.25)
            except queue.Empty:
                continue
            if line is None:
                reached_eof = True
                break
            payload: dict[str, Any] = json.loads(line)
            if payload["kind"] == "fatal":
                error = payload["code"]
                break
            if payload["kind"] == "result":
                result_id = payload["id"]
                key = files[result_id]
                # Vertrauensgrenze: nicht die Größenbehauptung des Parsers übernehmen.
                payload["key"] = key
                payload["size"] = storage.path_for(key).stat().st_size
                storage.sync(key)
                if runtime.event(database, task, payload):
                    published.add(result_id)
                else:
                    storage.delete(key)
            elif not runtime.event(database, task, payload):
                break
        if process.poll() is None and not reached_eof:
            process.terminate()
        try:
            return_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return_code = process.wait(timeout=5)
        if return_code != 0 and error is None:
            error = "memory-limit" if return_code in {-9, -11} else "worker-failed"
    except Exception:
        error = "worker-failed"
    finally:
        stop_reader.set()
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if reader is not None:
                reader.join(timeout=2)
            if process.stdout is not None:
                process.stdout.close()
        for file_id, key in files.items():
            if file_id not in published:
                storage.delete(key)
        runtime.finish(database, task, error)
        database.dispose()
