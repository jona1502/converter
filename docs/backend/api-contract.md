# API-Vertrag v1 – Serververarbeitung

Stand: B01 (24.10.2026). Verbindlicher Vertrag zwischen Frontend (`src/lib/api/`), API (`backend/app/api`), Worker (`backend/app/worker`, `backend/app/processing`) und Betrieb. Grundlage ist [../fastapi-backend-plan.md](../fastapi-backend-plan.md); Machbarkeit und Bibliotheken: [feasibility/README.md](feasibility/README.md).

Änderungen an diesem Dokument nur abgestimmt über den Hauptagenten. Maßgeblich für Felder und Typen ist das OpenAPI-Schema `api/openapi.json` (bis G12 aus FastAPI exportiert und gegen das Go-Backend geprüft, danach sprachunabhängig gepflegt); die TypeScript-Typen in `src/lib/api/schema.d.ts` werden daraus generiert, CI prüft Drift. Dieses Dokument beschreibt Bedeutung, Regeln und Grenzfälle, die ein Schema nicht ausdrückt.

## 1. Umfang

- Fünf Werkzeuge: `image-convert`, `image-compress`, `image-resize`, `pdf-compress`, `audio-convert`.
- Ein Bild = ein Auftrag mit genau einem Ergebnis. Eine PDF = ein Auftrag mit bis zu drei sequenziell erzeugten Ergebnissen (`high`, `balanced`, `small`). Eine Audiodatei = ein Auftrag mit genau einem Ergebnis.
- Nicht im Umfang: Konten, Abos, Office/Video, M4A/AAC, OCR, ZIP-Downloads, Moduswahlschalter Browser/Server, automatische Rückfälle zwischen Server und Browser.

## 2. Allgemeines

- Basis-Pfad `/api/v1`, gleicher Origin wie die Website (Reverse Proxy). Keine CORS-Freigabe.
- JSON mit `camelCase`-Feldern, UTF-8. Zeitstempel ISO 8601 in UTC (`2026-10-24T12:00:00Z`). IDs sind UUIDv4-Strings.
- Jede Antwort trägt `X-Request-Id` (vom Proxy übernommen, falls gültig, sonst erzeugt). Die ID erscheint in Logs, nie Dateiinhalte, Originalnamen, Cookies oder Tokens.
- Alle API-Antworten: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Konfiguration über Umgebungsvariablen mit Präfix `CONVERTER_` (z. B. `CONVERTER_SECRET_KEY`, `CONVERTER_ALLOWED_ORIGINS`, `CONVERTER_TRUSTED_PROXIES`, `CONVERTER_SESSION_COOKIE_SECURE`); Namen in diesem Dokument ohne Präfix.
- Logs: Ausnahmen aus Upload, Storage und Verarbeitung (Pillow, pikepdf, soundfile, Dateisystem) können Pfade oder Originalnamen enthalten. Sie werden nur mit Ausnahmetyp, Auftrags-ID und internem Fehlercode geloggt, nicht mit ihrem Text; eigene Ausnahmen enthalten nie Dateinamen, Inhalte, Tokens oder Pfade.

### Fehlerformat

```json
{
  "error": {
    "code": "file-too-large",
    "message": "Datei überschreitet 52428800 Bytes.",
    "retryAfterSeconds": 12,
    "fields": [{ "path": "options.quality", "code": "out-of-range" }]
  },
  "requestId": "6f0c…"
}
```

- `code` ist maschinenlesbar und stabil (Tabelle unten). `message` ist ein kurzer technischer Text ohne Pfade, Tracebacks, Dateinamen oder Interna; Nutzertexte erzeugt das Frontend auf Deutsch anhand von `code`.
- `retryAfterSeconds` nur bei `429`/`503`, zusätzlich als `Retry-After`-Header.
- `fields` nur bei Validierungsfehlern; enthält Pfade und Fehlerarten, keine Eingabewerte.

| Code | HTTP | Bedeutung |
| --- | --- | --- |
| `invalid-request` | 400/422 | Anfrage formal ungültig (Multipart kaputt, JSON unlesbar, unbekannte Felder) |
| `invalid-options` | 422 | Optionen semantisch ungültig (z. B. ICO mit Resize, Prozent > 100 ohne Vergrößerung) |
| `missing-file` | 422 | Kein oder mehr als ein Dateiteil |
| `unsupported-type` | 415 | Bytes passen zu keinem unterstützten Eingabeformat des Werkzeugs (Audio: MP3, WAV, FLAC, OGG per Signatur) |
| `not-pdf` | 415 | Keine `%PDF-`-Signatur in den ersten 1024 Bytes |
| `file-too-large` | 413 | Eingabelimit überschritten (auch ohne/mit falschem `Content-Length`) |
| `dimensions-too-large` | 422 | Eingabe- oder Zielabmessungen über Limit |
| `animated-unsupported` | 422 | Animiertes GIF/PNG/WebP/AVIF |
| `original-format-unsupported` | 422 | `format: "original"`, aber Eingabeformat ist nicht erzeugbar (GIF, AVIF) |
| `invalid-idempotency-key` | 422 | `Idempotency-Key` hat falsches Format |
| `idempotency-conflict` | 409 | Gleicher Schlüssel mit anderer Payload in derselben Sitzung |
| `session-required` | 401 | Sitzungscookie fehlt, ist ungültig oder abgelaufen |
| `csrf-failed` | 403 | CSRF-Token fehlt/falsch oder Origin nicht erlaubt |
| `job-not-found` | 404 | Auftrag existiert nicht, gehört einer anderen Sitzung oder wurde gelöscht (einheitlich) |
| `result-not-found` | 404 | Ergebnis existiert nicht oder ist (noch) nicht veröffentlicht |
| `job-expired` | 410 | Eigener Auftrag abgelaufen; Ergebnisse nicht mehr abrufbar |
| `rate-limited` | 429 | Zu viele Erstellungen pro Minute (Sitzung oder IP) |
| `session-job-limit` | 429 | Zu viele aktive Aufträge dieser Sitzung |
| `server-busy` | 503 | Globale Annahmegrenze aktiver Aufträge erreicht |
| `storage-full` | 503 | Speicherbudget/freier Platz reicht nicht für Reservierung |
| `service-unavailable` | 503 | Benötigte Abhängigkeit (DB) nicht erreichbar |
| `internal-error` | 500 | Unerwarteter Fehler; nur `requestId` zur Diagnose |

Auftrags- und Ergebnisfehler (`job.error.code`, `result.error.code`) verwenden zusätzlich:

| Code | Bedeutung |
| --- | --- |
| `decode-failed` | Datei beschädigt oder nicht dekodierbar |
| `encode-failed` | Ergebnis konnte nicht erzeugt werden |
| `encrypted` | PDF verschlüsselt (auch mit leerem Benutzerpasswort) |
| `parse-failed` | PDF beschädigt oder nicht lesbar |
| `result-too-large` | Bildergebnis > 104.857.600 Bytes, PDF-Ergebnisbudget 300.000.000 Bytes bzw. Audioergebnis > 419.430.400 Bytes überschritten |
| `duration-too-long` | Audiodauer über der Grenze (1800 s); geprüft laut Header und erneut beim Dekodieren |
| `unsupported-audio` | Audio lesbar, aber nicht verarbeitbar: Kanäle (> 8) oder Abtastrate (> 192.000 Hz) über der Grenze, Ogg ohne Vorbis/Opus, oder vom Zielformat ohne Resampling nicht darstellbar (MP3: nur LAME-Raten 8–48 kHz und höchstens zwei Kanäle; Abhilfe bei Kanälen: Mono) |
| `timeout` | Prozesszeitlimit überschritten (120 s Bild, 300 s PDF gesamt, 300 s Audio) |
| `memory-limit` | Kindprozess durch Speichermangel beendet |
| `worker-failed` | Verarbeitung nach begrenzten Versuchen abgebrochen (z. B. wiederholter Absturz) |
| `storage-full` | Ergebnis konnte wegen Speicherbudget nicht geschrieben werden |
| `dimensions-too-large`, `animated-unsupported`, `unsupported-type` | wie oben, im Worker erneut geprüft |

## 3. Anonyme Sitzung, CSRF und Origin

- `GET /api/v1/session` legt bei fehlender/ungültiger Sitzung eine neue an und antwortet mit `200`:
  `{ "csrfToken": "…", "expiresAt": "…", "created": true|false }`. Neuanlagen sind je Client-IP begrenzt (Standard 30/min, `429 rate-limited`); abgelaufene Sitzungen ohne Aufträge entfernt der Cleanup.
- Sitzungstoken: 32 zufällige Bytes (`secrets.token_urlsafe(32)`), nur im Cookie. In der DB steht ausschließlich `SHA-256(token)`.
- Cookie `__Host-converter_session` (Produktion: `Secure; HttpOnly; SameSite=Strict; Path=/`). Für lokales HTTP explizit per Konfiguration `SESSION_COOKIE_SECURE=false` → Cookiename `converter_session` ohne `__Host-`-Präfix. Standard ist `true`.
- Sitzungsdauer 24 Stunden, gleitend bei Nutzung verlängert, mindestens Auftragsgültigkeit. Abgelaufene Sitzungen verlieren den Zugriff auf ihre Aufträge; diese laufen per TTL ab.
- `csrfToken = base64url(HMAC-SHA256(SECRET_KEY, "csrf:" + token_hash))`. Das Frontend hält es nur im Arbeitsspeicher (kein Web Storage).
- Schreibende Anfragen (`POST`, `DELETE`) verlangen:
  1. gültige Sitzung (sonst `401 session-required`),
  2. Header `X-CSRF-Token` gleich dem erwarteten Wert (konstantzeitiger Vergleich, sonst `403 csrf-failed`),
  3. `Origin` (falls gesendet) in `ALLOWED_ORIGINS`; ohne `Origin` darf `Sec-Fetch-Site` nicht `cross-site` sein (sonst `403 csrf-failed`).
- Lesende Anfragen auf Aufträge/Ergebnisse verlangen eine gültige Sitzung und prüfen den Besitzer. Downloads funktionieren mit normalen Links (Cookie wird mitgesendet, SameSite=Strict genügt bei gleichem Origin).
- Eine Auftrags-UUID ist keine Autorisierung. Fremde, nicht vorhandene und gelöschte Aufträge: identisch `404 job-not-found` (gleiche Antwortform).

## 4. Endpunkte

### `GET /api/v1/capabilities`

Ohne Sitzung abrufbar. Liefert, was das ausgelieferte Image tatsächlich kann (beim Start per echter Rundreise kleiner Beispieldateien ermittelt, nicht hart codiert):

```json
{
  "apiVersion": "1",
  "tools": ["image-convert", "image-compress", "image-resize", "pdf-compress", "audio-convert"],
  "image": {
    "inputFormats": ["jpeg", "png", "webp", "gif", "bmp", "ico", "avif"],
    "outputFormats": ["jpeg", "png", "webp", "bmp", "ico"],
    "qualityFormats": ["jpeg", "webp"],
    "icoSizes": [16, 32, 48, 64, 128, 256],
    "defaultIcoSizes": [16, 32, 48, 256],
    "maxFileBytes": 52428800,
    "maxPixels": 40000000,
    "maxEdge": 16384,
    "maxOutputBytes": 104857600
  },
  "pdf": {
    "maxFileBytes": 100000000,
    "maxResultBytesTotal": 300000000,
    "maxImagePixels": 40000000,
    "levels": [
      { "level": "high", "targetDpi": 300, "maxImageEdge": 3600, "quality": 0.85, "minDownscaleFactor": 0.9 },
      { "level": "balanced", "targetDpi": 150, "maxImageEdge": 2000, "quality": 0.72, "minDownscaleFactor": 0.9 },
      { "level": "small", "targetDpi": 100, "maxImageEdge": 1300, "quality": 0.55, "minDownscaleFactor": 0.9 }
    ]
  },
  "audio": {
    "inputFormats": ["mp3", "wav", "flac", "ogg"],
    "outputFormats": ["mp3", "wav", "flac", "ogg"],
    "qualityFormats": ["mp3", "ogg"],
    "defaultQuality": 0.8,
    "maxFileBytes": 104857600,
    "maxDurationSeconds": 1800,
    "maxChannels": 8,
    "maxSampleRate": 192000,
    "maxOutputBytes": 419430400
  },
  "jobs": { "ttlSeconds": 3600, "maxActivePerSession": 3, "maxBatchFiles": 30, "createPerMinute": 10 }
}
```

Fehlt im Container ein Pflichtformat (Plan Abschnitt 5; für Audio alle vier Ein- und Ausgabeformate), ist das ein Abnahmefehler; `/ready` meldet dann `capabilities: fail`. `audio.inputFormats`/`outputFormats` stammen aus der Probe (echte Rundreise mit soundfile), die übrigen Audiofelder aus der Konfiguration. Schema: Komponente `AudioCapabilities`.

### `POST /api/v1/jobs`

`multipart/form-data` mit genau zwei Teilen in dieser Reihenfolge:

1. `options`: JSON-String (Schema unten), höchstens 8 KiB.
2. `file`: die Datei. Der Originalname wird bereinigt (wie `src/lib/image/filename.ts`, max. 100 Zeichen Stamm) nur zur Anzeige und für Downloadnamen gespeichert.

Header: `X-CSRF-Token` (Pflicht), `Idempotency-Key` (optional, 16–128 Zeichen `[A-Za-z0-9_-]`; das Frontend sendet ihn immer).

Ablauf in der API (Reihenfolge ist Teil des Vertrags):

1. Sitzung, CSRF/Origin prüfen.
2. Existiert für `(Sitzung, Idempotency-Key)` bereits ein Auftrag, ist es eine Wiederholung:
   - gelöschter Auftrag → sofort `404 job-not-found`, abgelaufener → sofort `410 job-expired`, ohne den Body zu lesen;
   - sonst entfallen Erstellungsrate und Reservierung, es gilt aber ein eigenes Wiederholungslimit (Standard 30/min je Sitzung, `429 rate-limited`) und höchstens **ein** gleichzeitiger Wiederholungs-Upload je Sitzung (sonst `429 rate-limited`);
   - der Body wird nur streamend gehasht und gezählt (Größenlimit wie Schritt 6), **nicht** gespoolt, und danach der Fingerabdruck verglichen.
3. Annahmekontrolle **vor** dem Lesen des Bodys:
   - Erstellungsrate je Sitzung und je Client-IP in Redis (prozessübergreifend, `429 rate-limited`).
   - Atomare **Upload-Reservierung** in PostgreSQL unter einer kurzen Transaktionssperre (`pg_advisory_xact_lock`): gezählt werden aktive Aufträge **plus** laufende Reservierungen, je Sitzung (`429 session-job-limit`) und global (`503 server-busy`); zusätzlich wird die maximale Eingabegröße des Werkzeugs im Speicherbudget reserviert (`503 storage-full`). Gleichzeitige Uploads können die Grenzen dadurch nicht gemeinsam überschreiten.
   - Die Reservierung hat eine Ablaufzeit (`UPLOAD_MAX_SECONDS`, Standard 600). Sie wird bei Fehler/Abbruch sofort freigegeben, sonst vom Cleanup samt Spool-Datei entfernt.
4. Body mit dem Streaming-Parser von `python-multipart` direkt aus `Request.stream()` lesen; FastAPIs `Form`/`UploadFile` werden für diesen Endpunkt **nicht** verwendet, weil sie den Body vor jeder Prüfung vollständig einlesen bzw. ohne Größenlimit spoolen. Der erste Teil muss `options` sein, sonst `422 invalid-request`.
5. Optionen streng validieren (unbekannte Felder → `422 invalid-request`).
6. Datei streamend in eine private Spool-Datei schreiben, dabei Bytes zählen und SHA-256 berechnen; Limit überschritten → Abbruch `413 file-too-large`, Spool-Datei sofort löschen. `Content-Length` wird nicht vertraut. Gesamtdauer begrenzt durch `UPLOAD_MAX_SECONDS`; Mindestrate/Leerlauf zusätzlich am Proxy (`client_body_timeout`).
7. Bytes-Signatur prüfen (`415`), bei Bildern Header-Probe ohne Dekodieren (Abmessungen, Animation soweit aus dem Header erkennbar), `original-format-unsupported`. Audio-Signaturen: MP3 = `ID3`-Tag (Version 2–4) oder MPEG-Frame-Sync mit gültigem Kopf (Version, Layer, Bitrate, Abtastrate) am Dateianfang; WAV = `RIFF....WAVE`; FLAC = `fLaC`; OGG = `OggS` (Version 0). Dauer, Kanäle und Abtastrate prüft erst der Worker.
8. In **einer** DB-Transaktion: Reservierung in den Auftrag überführen (Reservierung auf tatsächliche Größe plus Ergebnisbudget anpassen), Auftrag (`queued`), Ergebniszeilen (`pending`), Outbox-Eintrag; Spool-Datei atomar an den finalen privaten Ort verschieben. Erst nach erfolgreichem Commit `202`. Scheitert der Commit, werden Datei und Reservierung entfernt.

Idempotenz: Fingerabdruck = SHA-256 über `tool`, kanonisches Options-JSON, Datei-SHA-256 und -Größe. Schlüssel ist an die Sitzung gebunden.

- Gleicher Schlüssel + gleicher Fingerabdruck → `200` mit dem vorhandenen Auftrag und Header `Idempotent-Replayed: true` (keine zweite Konvertierung; die neue Upload-Kopie wird verworfen, keine Rate-Tokens verbraucht). Gilt auch bei gleichzeitig laufenden Wiederholungen (eindeutiger Index `(session_id, idempotency_key)`; der Verlierer des Inserts gibt seine Reservierung frei und vergleicht dann den Fingerabdruck).
- Gleicher Schlüssel + anderer Fingerabdruck → `409 idempotency-conflict`.
- Gehört der Schlüssel zu einem gelöschten Auftrag → `404 job-not-found`; zu einem abgelaufenen → `410 job-expired`. Erst nach der Metadatenbereinigung ist der Schlüssel wieder frei.

Antwort `202` (bzw. `200` bei Replay): `Job` (Abschnitt 5) und `Location: /api/v1/jobs/{id}`.

#### Optionen Bild

```json
{
  "tool": "image-convert",
  "format": "webp",
  "quality": 0.85,
  "background": "#ffffff",
  "resize": { "mode": "none" },
  "icoSizes": [16, 32, 48, 256]
}
```

- `tool`: `image-convert` | `image-compress` | `image-resize`.
- `format`: `jpeg` | `png` | `webp` | `bmp` | `ico` | `original`. `original` = Eingabeformat, sofern es ein Ausgabeformat ist, sonst `422 original-format-unsupported`. Kein stiller Ersatz.
- `quality`: Zahl 0..1, Standard 0,85. Wirkt nur bei JPEG/WebP (Pillow `quality = round(q × 100)`, auf 1..95 begrenzt; Begründung im Machbarkeitsbericht). Bei PNG/BMP/ICO zulässig, aber ohne Wirkung; das Ergebnis meldet `qualityApplied: false`. PNG wird immer verlustfrei optimiert (`optimize=True`), nie scheinbar „qualitätsreduziert“.
- `background`: optional, Standard `#ffffff`; wenn angegeben, genau `#rrggbb`. Füllt Transparenz bei JPEG und BMP.
- `resize`: exakt die Regeln von `ResizeOptions` in `src/lib/image/types.ts` (`none` | `percent` | `dimensions` | `maxEdge`; Rundung `round`, Mindestens 1 px, Vergrößerung nur mit `allowUpscale`). Bei `ico` nur `none`.
- `icoSizes`: nur bei `ico`; Teilmenge von 16/32/48/64/128/256 ohne Duplikate, mindestens ein Wert. Einpassen (contain), zentriert, transparenter Rand; kleinere Quellen werden vergrößert und als `upscaled` gemeldet.
- EXIF-Orientierung wird angewendet; Abmessungen und Resize beziehen sich auf die orientierungskorrigierte Größe. Metadaten (EXIF, ICC außer sRGB-Konvertierung) werden nicht übernommen.

#### Optionen Audio

```json
{ "tool": "audio-convert", "format": "mp3", "quality": 0.8, "channels": "original" }
```

- `format`: `mp3` | `wav` | `flac` | `ogg` (Ogg Vorbis). Kein `original`.
- `quality`: Zahl 0..1, Standard 0,8. Wirkt nur bei MP3 (LAME VBR) und OGG (Vorbis): `compression_level = 1 − quality` (MP3 höchstens 0,99). Bei WAV/FLAC zulässig, aber ohne Wirkung; das Ergebnis meldet `qualityApplied: false`. Die Oberfläche zeigt die Option dort nicht an.
- `channels`: `original` (Standard) | `mono` (Downmix als Mittelwert aller Kanäle).
- Die Abtastrate bleibt erhalten (kein Resampling). WAV-Ausgabe PCM 16 Bit, bei 24-/32-Bit- bzw. Float-Quellen `PCM_24`/`PCM_32`/`FLOAT`; FLAC 16 Bit, ab 24-Bit-Quellen 24 Bit. Werte über ±1 (z. B. aus MP3) werden begrenzt.
- Tags, Cover und sonstige Metadaten werden nicht übernommen.
- Eingabe: MP3, WAV, FLAC, OGG (Vorbis oder Opus).

#### Optionen PDF

```json
{ "tool": "pdf-compress", "levels": ["high", "balanced", "small"] }
```

`levels`: nicht leer, ohne Duplikate, Reihenfolge = Verarbeitungsreihenfolge; Standard alle drei.

### `GET /api/v1/jobs/{id}`

`200 Job` oder `404 job-not-found`. Abgelaufene eigene Aufträge liefern `200` mit `state: "expired"` und ohne Download-URLs, bis die Metadaten bereinigt sind; danach `404`.

### `POST /api/v1/jobs/{id}/cancel`

Idempotent. Antwort `200`:

```json
{ "cancellation": "completed", "job": { … } }
```

- `completed`: Auftrag ist jetzt (oder war bereits) `cancelled`. Wartende Aufträge werden sofort abgebrochen.
- `requested`: Auftrag läuft; Abbruch ist vermerkt, der Worker beendet den Kindprozess und setzt `cancelled`. Bereits veröffentlichte PDF-Varianten bleiben abrufbar.
- `not-applicable`: Auftrag ist bereits in einem anderen Endzustand (`succeeded`, `partially_succeeded`, `failed`, `expired`).

### `DELETE /api/v1/jobs/{id}`

`204`. Sperrt Zugriff sofort (`deleted_at`), fordert ggf. Abbruch an und plant die physische Löschung von Eingabe und Ergebnissen (Outbox/Cleanup, wiederholbar). Wiederholung oder fremder Auftrag → `404 job-not-found` (die Antwort verrät nicht, ob schon gelöscht wurde); das Frontend wertet `404` auf `DELETE` als „erledigt“. Ein Worker darf nach Löschung kein Ergebnis mehr veröffentlichen.

### `GET /api/v1/jobs/{id}/results/{resultId}`

Download eines veröffentlichten Ergebnisses (`result.state = "succeeded"`).

- `200`, `Content-Type` = Ergebnis-MIME, `Content-Length`, `Content-Disposition: attachment; filename="<ASCII-Ersatz ohne " \ und Steuerzeichen>"; filename*=UTF-8''<prozentkodiert>`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`.
- `404 job-not-found` / `404 result-not-found` / `410 job-expired`.
- Neue Downloads nach Ablauf gesperrt. Laufende Downloads dürfen höchstens `DOWNLOAD_MAX_SECONDS` (Standard 300) weiterlaufen; der Cleanup löscht erst danach physisch.

### `GET /api/v1/health/live` und `GET /api/v1/health/ready`

- `live`: `200 {"status":"ok"}`, solange der Prozess antwortet; keine Abhängigkeiten.
- `ready`: `200` oder `503` mit `{"status":"ok"|"unavailable","checks":{"database":"ok"|"fail","redis":"ok"|"fail","storage":"ok"|"fail","capabilities":"ok"|"fail"}}`. Keine Hostnamen, Versionen, Fehlertexte.

## 5. Datenmodell der Antworten

```json
{
  "id": "…",
  "tool": "pdf-compress",
  "state": "running",
  "phase": "variant",
  "createdAt": "…",
  "updatedAt": "…",
  "expiresAt": "…",
  "input": { "name": "Bericht.pdf", "size": 1234567, "format": "pdf", "width": null, "height": null },
  "progress": { "step": "variant", "level": "balanced", "current": 3, "total": 12 },
  "analysis": { … PdfAnalysis … },
  "results": [
    {
      "id": "…",
      "level": "high",
      "state": "succeeded",
      "size": 1000000,
      "mime": "application/pdf",
      "downloadName": "Bericht-high.pdf",
      "downloadUrl": "/api/v1/jobs/…/results/…",
      "details": { … },
      "error": null
    }
  ],
  "error": null,
  "cancelRequested": false
}
```

### Auftragszustände

```text
           ┌──────────── cancel ────────────┐
queued ──claim──▶ running ──▶ succeeded | partially_succeeded | failed
  │                  │  ▲
  │ cancel           │  └─ lease abgelaufen, Versuche übrig → queued
  ▼                  ▼
cancelled ◀── cancel ─┘        jeder Zustand ──TTL──▶ expired
```

| Zustand | Bedeutung | Endzustand |
| --- | --- | --- |
| `queued` | dauerhaft angenommen, wartet auf Worker | nein |
| `running` | von genau einem Worker mit gültiger Lease beansprucht | nein |
| `succeeded` | alle angeforderten Ergebnisse veröffentlicht | ja |
| `partially_succeeded` | mindestens ein PDF-Ergebnis veröffentlicht, mindestens eines fehlgeschlagen | ja |
| `failed` | kein Ergebnis veröffentlicht; `error.code` gesetzt | ja |
| `cancelled` | auf Wunsch abgebrochen; bereits veröffentlichte Ergebnisse bleiben bis Ablauf abrufbar | ja |
| `expired` | Gültigkeit abgelaufen, keine Downloads mehr | ja |

- „Hochladen“ ist ein reiner Frontendzustand; ein Auftrag existiert erst nach `202`.
- Jeder Übergang ist ein bedingtes Update (`WHERE state = … AND version = …` bzw. passende Lease). Endzustände werden nie verlassen (außer zu `expired`). Ein verspäteter oder doppelter Worker kann `cancelled`, gelöschte oder abgelaufene Aufträge nicht wiederbeleben.
- `phase` (nur bei `running`): `analyze` | `variant` | `encode` (Bild, Audio) | `save`; sonst `null`.
- `progress` enthält nur echte Zähler: bei PDF `step`, `level`, `current`/`total` = bearbeitete/alle Bilder der aktuellen Variante; bei Bildern und Audio `null`. Keine erfundenen Prozentwerte.

### Ergebniszustände

`pending` → `running` → `succeeded` | `failed` | `cancelled`. Je PDF-Stufe separat; fertige Varianten sind sofort abrufbar, während weitere laufen. Spätere Fehler löschen keine früheren gültigen Varianten.

### `details`

- Bild: `{ "format", "width", "height", "sourceWidth", "sourceHeight", "upscaled", "transparencyFlattened", "qualityApplied" }`.
- Audio: `{ "format", "durationSeconds", "sampleRate", "channels", "qualityApplied" }` (Komponente `AudioDetails`). `durationSeconds` ist die tatsächlich dekodierte Dauer (auf Millisekunden gerundet), `channels` die Kanalzahl des Ergebnisses. `input.width`/`input.height` bleiben bei Audio `null`.
- PDF-Variante: wie `PdfVariantResult` in `src/lib/pdf/types.ts` ohne `blob`: `originalSize`, `imagesRecompressed`, `imagesResized`, `imagesSkipped`, `imagesNotSmaller`, `streamsCompressed`, `objectsRemoved`, `notes[]` (Codes wie dort). `size` kann größer als die Eingabe sein; das wird offen angezeigt.

### `analysis` (PDF)

Wie `PdfAnalysis` in `src/lib/pdf/types.ts` (`fileSize`, `pdfVersion`, `pageCount`, `images`, `fontBytes`, `limitations[]`). Zusätzlicher Limitationscode `image-size-unknown` wird gemeldet, wenn die Darstellungsgröße nicht sicher bestimmt werden konnte (dann nur Pixelkantengrenze, keine DPI-Behauptung).

### Downloadnamen

- Bild: `<stamm>-<suffix>.<ext>`; Suffix `konvertiert` (Konverter, nur wenn Zielformat = Eingabeformat, sonst ohne Suffix wie bisher), `komprimiert`, `skaliert`. Endungen `jpg`, `png`, `webp`, `bmp`, `ico`. Fallback-Stamm `bild`.
- PDF: `<stamm>-<level>.pdf`, Fallback-Stamm `dokument`.
- Audio: `<stamm>.<ext>`, Suffix `-konvertiert` nur, wenn Zielformat = Eingabeformat (wie beim Bildkonverter). Endungen `mp3`, `wav`, `flac`, `ogg`; MIME `audio/mpeg`, `audio/wav`, `audio/flac`, `audio/ogg`. Fallback-Stamm `audio`.
- Eindeutigkeit innerhalb eines Stapels (`a-2.webp`) stellt das Frontend über das `download`-Attribut her.

## 6. Grenzwerte (Startwerte, konfigurierbar)

| Wert | Start | Ort der Prüfung |
| --- | --- | --- |
| Bild-Eingabe | 52.428.800 Bytes | API (streamend) + Worker |
| Bild-Pixel / Kante | 40.000.000 / 16.384 | API (Header) + Worker (vor Dekodieren und Ziel) |
| Bild-Ausgabe | 104.857.600 Bytes | Worker während des Schreibens |
| PDF-Eingabe | 100.000.000 Bytes | API (streamend) + Worker |
| PDF-Ergebnisse gesamt | 300.000.000 Bytes | Worker |
| Pixel je neu kodiertem PDF-Bild | 40.000.000 | Worker |
| Audio-Eingabe | 104.857.600 Bytes | API (streamend) + Worker |
| Audio-Dauer | 1800 s | Worker (Header, dann beim Dekodieren gezählt) |
| Audio-Kanäle / Abtastrate | 8 / 192.000 Hz | Worker |
| Audio-Ausgabe | 419.430.400 Bytes | Worker während des Schreibens |
| Auftragsgültigkeit | 3600 s ab Annahme | API/Cleanup |
| Aktive Aufträge je Sitzung | 3 | API |
| Aktive Aufträge global | 50 | API |
| Erstellungen je Minute | 10 je Sitzung und 10 je IP | API (Redis, prozessübergreifend) |
| Prozesszeit | 120 s Bild, 300 s PDF gesamt, 300 s Audio | Worker (Kindprozess wird beendet) |
| Speicherbudget | 5 GB inkl. Reservierungen | API (Annahme) + Worker (Schreiben) |
| Cleanup-Intervall | 60 s | Cleanup-Dienst |
| Physische Löschung nach Ablauf/Löschung | spätestens 10 min (Cleanup-Fenster + Download-Grenze) | Cleanup |
| Uploadparallelität im Frontend | 2 | Frontend |

Folge der Startwerte: `UPLOAD_MAX_SECONDS` 600 setzt für eine 100-MB-PDF mindestens etwa 1,3 Mbit/s Uploadrate voraus; langsamere Verbindungen erhalten einen Abbruch und eine verständliche Meldung. Ein Stapel mit 30 Bildern braucht wegen 10 Erstellungen/Minute mindestens etwa drei Minuten. Das Frontend wartet sichtbar auf freie Plätze (`Retry-After`), statt alle Dateien gleichzeitig hochzuladen.

Client-IP: nur aus `X-Forwarded-For`, wenn die direkte Gegenstelle in `TRUSTED_PROXIES` liegt; sonst die Gegenstelle selbst. In Redis nur gehasht.

## 7. Interner Ablauf (Backend)

```text
POST /jobs ─▶ Reservierung ─▶ Spool ─▶ TX{ jobs(queued), job_results(pending), outbox(dispatch) } ─▶ 202
dispatcher: SELECT outbox FOR UPDATE SKIP LOCKED ─▶ celery send(job_id) ─▶ published_at
worker:     claim (bedingtes UPDATE, neues lease_token) ─▶ Kindprozess (Zeitlimit, ohne Netz)
            ─▶ eigene Datei results/<result_id>/<lease_token> ─▶ bedingtes UPDATE result = Veröffentlichung
            ─▶ Heartbeat verlängert Lease; Abbruch/Löschung beendet Kindprozess
recovery:   TX{ running mit abgelaufener Lease ─▶ queued + neuer Outbox-Eintrag } (Versuch < max)
            bzw. failed(worker-failed); mit cancel_requested_at ─▶ cancelled,
            mit deleted_at ─▶ unverändert (Cleanup), mit abgelaufenem expires_at ─▶ expired
cleanup:    expired/deleted/Reservierungen/verwaist ─▶ Dateien löschen ─▶ Metadaten bereinigen
```

- Broker ist Valkey 9 (BSD-3-Clause), ein protokollkompatibler Redis-Fork. Grund: Redis ab 8.0 steht nur unter AGPL-3.0, RSALv2 oder SSPL; der Plan schließt neue Lizenzauflagen ohne Not aus. Client (`redis-py`), Celery-Transport (`redis://`) und alle Aussagen zu „Redis“ in Plan und Vertrag gelten unverändert für Valkey.
- Redis-Nachrichten enthalten nur die Auftrags-ID. PostgreSQL ist die einzige Wahrheit; doppelte Zustellung ist harmlos (Claim schlägt fehl). Celery-Neuzustellung ist kein Recovery-Mechanismus; Wiederaufnahme läuft ausschließlich über Recovery + Outbox.
- Claim: `UPDATE jobs SET state='running', lease_token=:neu, lease_expires_at=now()+LEASE, attempts=attempts+1, version=version+1 WHERE id=:id AND state='queued' AND deleted_at IS NULL AND cancel_requested_at IS NULL AND expires_at > now() AND attempts < max_attempts RETURNING …`.
- Jede Schreiboperation des Workers (Heartbeat, Fortschritt, Ergebnis, Endzustand) ist bedingt auf `state='running' AND lease_token=:eigenes AND deleted_at IS NULL`. Schlägt sie fehl, hat der Worker die Lease verloren: Kindprozess beenden, **nur eigene** Dateien löschen, nichts weiter schreiben.
- Veröffentlichung eines Ergebnisses ist ausschließlich das erfolgreiche bedingte Update der Ergebniszeile (`storage_key`, `size`, `state='succeeded'`), zusätzlich bedingt auf `cancel_requested_at IS NULL`. Die Datei liegt vorher unter einem Schlüssel je Lease (`jobs/<job_id>/results/<result_id>/<lease_token>`), sodass konkurrierende Worker sich nie überschreiben; der gültige Schlüssel steht in der Ergebniszeile.
- Abbruch gegen fertig werdenden Worker: Es gewinnt der zuerst committete Übergang. Ist der Endzustand (`succeeded` …) zuerst committet, liefert `cancel` `not-applicable`. Ist `cancel_requested_at` zuerst gesetzt, wird kein weiteres Ergebnis veröffentlicht; der Worker setzt `cancelled` (bereits veröffentlichte Ergebnisse bleiben).
- Löschen gegen Worker: `deleted_at` lässt alle weiteren Worker-Updates scheitern; der Cleanup löscht alle Dateien unter `jobs/<job_id>/`.
- Celery: `acks_late=True`, `task_reject_on_worker_lost=True`, `worker_prefetch_multiplier=1`, Concurrency 1, JSON-Serializer.
- Maximal 3 Versuche je Auftrag (`JOB_MAX_ATTEMPTS`). Fachliche Fehler (beschädigte Datei, Limits, Verschlüsselung) werden nicht wiederholt.
- Speicher: zufällige interne Schlüssel (`jobs/<job_id>/input`, `jobs/<job_id>/results/<result_id>/<lease_token>`, `spool/<reservation_id>`), Verzeichnisse `0700`, Dateien `0600`, atomare Veröffentlichung über Temp-Datei + `os.replace`. Kein Benutzerpfad im Storage.
- Speicherbudget (eine Tabelle `storage_usage` bzw. Summe über Reservierungen, Prüfung per bedingtem Update):
  - Annahme: Upload-Reservierung = maximale Eingabegröße des Werkzeugs, nach dem Upload auf die tatsächliche Größe gekürzt.
  - Laufender Auftrag: zusätzlich eine Arbeitsreserve für temporäre Ergebnisdateien (Bild 104.857.600, PDF 100.000.000 je gleichzeitig geschriebener Variante, Audio 419.430.400). Da nur wenige Aufträge gleichzeitig laufen (ein Kindprozess je Worker), blockiert das nicht die Annahme.
  - Veröffentlichung: Vor dem bedingten Update wird die tatsächliche Ergebnisgröße reserviert; reicht das Budget nicht → Ergebnis `storage-full`, eigene Datei löschen. Das PDF-Gesamtbudget 300.000.000 je Auftrag wird zusätzlich geprüft (`result-too-large`).
  - Freigabe bei physischer Löschung; Arbeitsreserve beim Endzustand.

## 8. Verarbeitungsregeln aus dem Machbarkeitsnachweis

Verbindliche Entscheidungen auf Grundlage von [feasibility/README.md](feasibility/README.md):

- Bilder: eigene Pixel-/Kantenprüfung nach `Image.open` und vor `load()` (`Image.MAX_IMAGE_PIXELS` allein greift erst ab doppeltem Wert); `DecompressionBombWarning` als Fehler behandeln. Alpha bei JPEG **und BMP** immer explizit auf `background` legen (Pillow schreibt RGBA-BMP sonst ohne Fehler, aber mit verlorenem Alpha). Capabilities per `features.check` plus echter Rundreise.
- PDF verschlüsselt: auch Dateien, die nur ein Besitzerpasswort haben (`is_encrypted` nach dem Öffnen), werden mit `encrypted` abgelehnt; sonst ginge die Rechteeinschränkung stillschweigend verloren.
- PDF beschädigt: geöffnet wird mit `pikepdf.open(..., attempt_recovery=False)`. Dateien, die qpdf nur per Reparatur (Wiederherstellung von xref/Trailer) öffnen könnte, werden mit `parse-failed` abgelehnt. Eine gekürzte Datei würde sonst als „erfolgreich komprimiert“ mit fehlenden Inhalten ausgegeben. pikepdf-Fehlertexte enthalten interne Pfade und erscheinen nie in API-Antworten.
- PDF-Neukodierung: JPEG-Quellen (`DCTDecode`) werden nur neu kodiert, wenn ihre Pixelgröße tatsächlich verkleinert wird; ohne Verkleinerung bleibt der Stream unverändert (kein zusätzlicher Generationsverlust). Flate-Quellen werden auch ohne Verkleinerung als JPEG kodiert, sofern die 3-%-Regel erfüllt ist. Dies weicht bewusst von der lokalen Browser-Engine ab. Verkleinert wird nur, wenn der Faktor höchstens `minDownscaleFactor` (0,9) beträgt; bei größerem Faktor bleibt die Pixelgröße (wie `src/lib/pdf/presets.ts`).
- Flate mit PNG-Predictor (10–15) wird wie in der lokalen Engine neu kodiert, wenn `/Colors` zum Farbraum passt, `/BitsPerComponent` 8 und `/Columns` = `/Width` ist und `DecodeParms` keine weiteren Schlüssel enthält (Dekodierung über pikepdf im Machbarkeitsnachweis pixelgleich belegt). TIFF-Predictor 2 bleibt unverändert.
- Pillow-Qualität: `round(q × 100)`, begrenzt auf 1..95 (high 85, balanced 72, small 55).
- Jede PDF-Stufe wird aus dem Original erzeugt, nicht aus der vorherigen Stufe.
- Bilder ohne sicher bestimmbare Platzierung (keine Platzierung gefunden, Zyklus, Tiefe > 10, Pattern/Type3/Appearance-Streams) gelten als „unsicher“: nur Pixelkantengrenze und Limitation `image-size-unknown`.

## 9. Frontend-Regeln

- Upload erst nach Klick auf „Konvertieren“/„Komprimieren“/„Skalieren“; PDF-Auswahl löst keinen Upload aus.
- Polling etwa 1 s, exponentieller Backoff bei Fehlern (bis 10 s), Ende bei Endzustand oder Verlassen des Werkzeugs (`AbortController`).
- Entfernen/Reset: laufenden Upload abbrechen, angenommene Aufträge per `DELETE` löschen. Beim Verlassen der Seite keine Löschzusage; TTL ist die Rückfallebene.
- Keine automatische Neuübertragung nach Netzwerkfehlern; der Nutzer startet neu. Warten auf freie Plätze (`429 session-job-limit`, `429 rate-limited`, `503 server-busy` mit `Retry-After`) innerhalb des gestarteten Laufs ist Scheduling, keine Neuübertragung; es sendet dieselbe Datei mit demselben `Idempotency-Key`.
- Keine Dateien, Namen oder Tokens in Web Storage, IndexedDB oder URLs.
- CSP des Serverbuilds: `connect-src 'self'`; übrige Direktiven unverändert. Proxy-Header und Meta-CSP stimmen überein.
- Der Adapter in `src/lib/api/` bildet Servercodes auf die bestehende Oberfläche ab: Bildfehler auf `ImageErrorCode` (z. B. `decode-failed` → `decode-failed`, `result-too-large`/`timeout`/`memory-limit`/`worker-failed` → `encode-failed` mit eigenem Hinweistext, `cancelled` → `aborted`), PDF-Fehler auf `PdfErrorCode` (`result-too-large`/`storage-full` → `memory-limit`, Netzwerk-/Serverfehler mit eigenen Servertexten statt `unsupported-browser`). Phasen: `analyze` ↔ `loading`, `variant` mit Zählern ↔ `images`, `save` ↔ `saving`. Neue Servercodes (`rate-limited`, `session-job-limit`, `server-busy`, `job-expired`, `session-required`, Netzwerk) erhalten eigene deutsche Texte.

## 10. Zuordnung zu Arbeitspunkten

| Thema | Arbeitspunkt |
| --- | --- |
| Health, Fehlerformat, Konfiguration | B02 |
| Sitzung, CSRF, Upload, Idempotenz, Outbox, Storage | B03 |
| Dispatcher, Worker, Leases, Abbruch, Recovery | B04 |
| Bildkonvertierung, Capabilities, Download | B05 |
| Bildkomprimierung/-skalierung | B06 |
| PDF-Analyse und Optimierungskern | B07 |
| Drei PDF-Varianten im Auftrag | B08 |
| Quoten, Reservierungen, Cleanup, Ablauf | B09 |
| Frontend Bilder / PDF | B10 / B11 |
| Compose, Proxy, CI | B12 |
