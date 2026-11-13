# Audio konvertieren – Design

**Stand:** 13.11.2026. **Branch:** `feature/audio-convert` (von `origin/main` `0d35657`, nicht gestapelt auf PR #1). **Worktree:** `../converter-audio`.

## Ziel

Neues Werkzeug „Audio konvertieren“ unter `/audio/konvertieren`. Es läuft wie die Bildwerkzeuge: Datei(en) wählen, Zielformat wählen, ausdrücklich starten, Serververarbeitung, befristeter Download. Alle Codecs bleiben in Python (Entscheidung des Nutzers). Go orchestriert.

## Umfang v1

- Eingabe: **MP3, WAV, FLAC, OGG (Vorbis/Opus)**.
- Ausgabe: **MP3, WAV, FLAC, OGG (Vorbis)**.
- Optionen:
  - `format`: `mp3 | wav | flac | ogg`
  - `quality`: nur MP3/OGG; 0–1 wie bei Bildern, auf die soundfile-`compression_level` abgebildet (wirkungslose Optionen werden in der UI nicht angezeigt)
  - `channels`: `original | mono` (Downmix per Mittelwert)
  - Abtastrate bleibt erhalten; kein Resampling in v1
- WAV-Ausgabe: PCM 16 Bit; bei 24/32-Bit-Quellen das passende Subtype, wenn soundfile es unterstützt, sonst 16 Bit.
- Batch wie bei Bildern: ein Auftrag je Datei, ein Ergebnis je Auftrag.

## Nicht-Ziele v1

- **Kein M4A/AAC, kein Video, kein ffmpeg/PyAV.** libsndfile kann kein AAC. Das kommt später als eigener Schritt mit eigener Sicherheitsbewertung.
- Kein Schneiden, kein Resampling, keine Normalisierung, keine Metadaten-/Cover-Übernahme (Tags gehen verloren; das wird in der UI und auf der Infoseite gesagt).

## Bibliothek

`soundfile` (gepinnt; Wheel bringt libsndfile ≥ 1.1 mit MP3-Lesen/-Schreiben mit) plus `numpy`. Keine Systempakete. Versionen in `converter/pyproject.toml` und `uv.lock` exakt pinnen. Die MP3-Unterstützung des Wheels wird per Test (Rundreise) nachgewiesen, nicht angenommen.

## Grenzen (Startwerte, konfigurierbar in `server/internal/config/config.go`)

| Grenze | Wert |
| --- | --- |
| `AUDIO_MAX_INPUT_BYTES` | 104.857.600 (100 MiB) |
| `AUDIO_MAX_DURATION_SECONDS` | 1800 (30 min) |
| `AUDIO_MAX_CHANNELS` | 8 |
| `AUDIO_MAX_SAMPLE_RATE` | 192000 |
| `AUDIO_MAX_OUTPUT_BYTES` | 419.430.400 (400 MiB; 30 min WAV Stereo 48 kHz 16 Bit ≈ 330 MB) |
| Prozesszeitlimit | 300 s |

Die Dauer wird vor dem Dekodieren aus dem Header geprüft (`soundfile.info`) und während des Dekodierens blockweise abgesichert, weil Header lügen können. Verarbeitung blockweise (Streaming), nicht die ganze Datei in den Speicher laden, damit das bestehende RLIMIT_AS (1 GiB) reicht.

## Betroffene Teile

1. **Vertrag:** `docs/backend/api-contract.md` und `api/openapi.json`: Tool `audio-convert`, Optionen, `capabilities.audio` (Ein-/Ausgabeformate, Grenzen), Ergebnis-`details` (`durationSeconds`, `sampleRate`, `channels`), neue Fehlercodes z. B. `duration-too-long`, `unsupported-audio`. Danach `npm run api:types`.
2. **DB:** neue Migration, die `ck_jobs_input_format` um `mp3, wav, flac, ogg` erweitert; Phase `encode` wiederverwenden. Bestehende Migrationen nicht ändern.
3. **Go:**
   - Formaterkennung per Magic Bytes:
     - MP3: `ID3` oder Frame-Sync `0xFFE0`-Maske mit gültigem Header
     - WAV: `RIFF....WAVE`
     - FLAC: `fLaC`
     - OGG: `OggS`
   - Optionsvalidierung (strict, wie bei Bildern), Limits, Capabilities, Protokoll-Limits an den Konverter, Download-Namen/MIME (`audio/mpeg`, `audio/wav`, `audio/flac`, `audio/ogg`), Ratelimits und Speicherbudget wie bestehend.
4. **Python (`converter/`):**
   - `options.py`, `limits.py`, `protocol.py` (neue Limitfelder, Pflichtfelder bleiben strikt), `probe.py`
   - neu `processing/audio/pipeline.py`
   - Fehler ohne Pfade oder Ausnahmetexte in Ereignissen
   - Sandbox-Regeln unverändert
5. **Worker-Image:** `converter/Dockerfile` braucht nur die neuen Python-Abhängigkeiten. Prüfen, dass libsndfile im Wheel enthalten ist und unter der Sandbox (ohne Netz, RLIMIT) lädt.
6. **Frontend:**
   - `src/data/tools.ts` (Katalog)
   - Seite `src/pages/audio/konvertieren.astro`
   - Komponente `src/components/tools/AudioConverter.tsx` nach dem Muster von `ImageConverter.tsx`/`useImageBatch.ts`; gemeinsame Teile wiederverwenden statt kopieren, wo es ohne Umbau geht
   - Hinweise (Upload erst nach Start, temporäre Speicherung, Tags gehen verloren)
   - Infoseite `lokale-verarbeitung.astro` um einen Audio-Absatz ergänzen

## Tests

- **Python:** Rundreisen für alle 4×4 Kombinationen mit kleinen generierten Testdateien (Sinus, wenige hundert ms), Mono-Downmix, Dauer-/Kanal-/Ratengrenzen, kaputte und gefälschte Header, lügende Dauer, Ausgabegrenze, Ereignisse ohne Pfade.
- **Go:**
  - Signaturerkennung (positive/negative Fälle)
  - Optionsvalidierung
  - Contract-/Golden-Tests erweitert
  - Migration gegen den isolierten Teststack
- **Frontend:**
  - vitest für Optionslogik
  - Playwright mit API-Doubles wie bei den bestehenden Werkzeugen: Auswahl, Start, Ergebnis, Fehler, Axe
- **Fullstack:** Ein echter Durchlauf MP3 → WAV und WAV → MP3 gegen einen **isolierten** Stack, wenn möglich. Ergebnis per `soundfile.info` prüfen.

## Arbeitsregeln

- Go-Tests ausschließlich im isolierten Compose-Projekt: `MSYS_NO_PATHCONV=1 docker compose -f server/compose.test.yaml run --rm go <cmd>` (Datenbank/Valkey vorher mit `docker compose -f server/compose.test.yaml up -d --wait db valkey`).
- Das Compose-Projekt `mi-converter` (Volumes `mi-converter_db-data`, `mi-converter_files`) enthält Nutzdaten: nie `down -v`, keine Volumes löschen, nicht stoppen.
- Python: `uv sync --frozen --project converter` bzw. nach Abhängigkeitsänderung `uv lock`; Linux-spezifische Sandbox-Tests laufen nur unter Linux. Windows-Skips nicht als Linux-Erfolg werten.
- Commits: gezielt gestagt, Conventional-Commit-Titel, deutscher Body mit Inhalt und tatsächlichen Prüfergebnissen, letzte Zeile `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Kein Push.
- Ehrlich berichten: nicht ausgeführte oder fehlgeschlagene Prüfungen benennen.
