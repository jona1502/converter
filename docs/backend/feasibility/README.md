# B01 – Machbarkeitsnachweis Bild-/PDF-Verarbeitung

**Zweck:** Wegwerfbarer Nachweis, dass Pillow und pikepdf im ausgelieferten Container-Typ die Anforderungen aus `docs/fastapi-backend-plan.md` (Abschnitt 5) tragen. **Kein Produktcode** – B05–B08 implementieren neu und testen eigenständig. Alle Zahlen unten stammen aus dem tatsächlichen Lauf am 2026-10-24 (Exit-Code 0); nicht Ausgeführtes ist als solches gekennzeichnet.

## Inhalt

| Datei | Aufgabe |
| --- | --- |
| `versions.py` | PyPI-Abfrage: aktuelle Version, Lizenz, `requires_python`, Linux-Wheel für CPython 3.13 (läuft auf dem Host, braucht Netzwerk) |
| `candidates.in` | Kandidaten-Pinset für B02; Auflösbarkeit mit `uv pip compile` geprüft |
| `requirements.in` / `requirements.txt` | PoC-Abhängigkeiten, mit Hashes gesperrt (`uv pip compile --generate-hashes`) |
| `Dockerfile` | `python:3.13-slim-trixie` per Digest, Wheels-only, `--require-hashes`, Non-Root (UID 10001) |
| `env_info.py` | Versionen im Container, Prüfung „kein Netzwerk“ |
| `images_poc.py` | Pillow-Formate, Rundreisen, EXIF, Alpha, ICO, Animation, Pixelbomben |
| `pdf_poc.py` | Fixture-PDF erzeugen, Platzierungs-/DPI-Analyse, drei Stufen neu kodieren, Erhalt prüfen, Fehlerfälle |
| `run.sh` | Bauen (mit Netzwerk), Ausführen (`--network none`) und Gegenproben `POC_SWAP=cm` und `POC_SWAP=form` (müssen jeweils scheitern) |
| `out/` | Ausgaben (Fixture- und Ergebnis-PDFs, `run.log`, `poc-output.txt`), per `.gitignore` ausgeschlossen |

## Ausführung

```sh
# Versionen/Lizenzen (Host, Netzwerk nötig)
PYTHONUTF8=1 python docs/backend/feasibility/versions.py
uv pip compile docs/backend/feasibility/candidates.in --python-version 3.13 --python-platform x86_64-manylinux_2_28
# PoC (Build mit Netzwerk, Lauf ohne Netzwerk)
sh docs/backend/feasibility/run.sh
```

`run.sh` startet: `docker run --rm --network none --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 -v <out>:/out converter-b01-poc:local`. Danach folgen die Gegenproben `POC_SWAP=cm` und `POC_SWAP=form`, die jeweils scheitern **müssen** (siehe unten). Jede verletzte Erwartung ist ein `assert` → Exit ≠ 0. Letzter Lauf von `sh run.sh`: Exit 0, inklusive „GEGENPROBE cm: OK“ und „GEGENPROBE form: OK“.

## Umgebung (gemessen im Container)

| Komponente | Version |
| --- | --- |
| Basisimage | `python:3.13-slim-trixie@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39` (Debian 13 trixie, x86_64) |
| Python | 3.13.17, UID/GID 10001 |
| Pillow | 13.0.0 (libjpeg-turbo 3.2.0, zlib 1.3.1, libwebp 1.6.0, libavif 1.4.2, lcms2 2.19, libtiff 4.7.2; libimagequant nicht enthalten) |
| pikepdf / qpdf | 10.17.0 / 12.4.2 (gebündelt) |
| pypdfium2 / PDFium | 5.14.0 / 156.0.8076.0 (nur Testrenderer) |
| Netzwerk im Lauf | `socket.create_connection("pypi.org")` → `gaierror` (nicht erreichbar) |

## Versionen und Lizenzen (PyPI, Stand 2026-10-24)

| Paket | aktuell | Lizenz | Python 3.13 | Hinweis |
| --- | --- | --- | --- | --- |
| fastapi | 0.162.0 | MIT | ja (reines Wheel) | zieht starlette 1.9.0 |
| pydantic | 2.14.1 | MIT | ja | pydantic-core 2.50.1 (cp313-Wheel) |
| sqlalchemy | 2.1.6 | MIT | ja | |
| alembic | 1.20.1 | MIT | ja | |
| psycopg / psycopg-binary | 3.3.6 | LGPL-3.0-only | ja (cp313 manylinux) | dynamisch gelinkte Bibliothek, unveränderte Nutzung unkritisch; Lizenztext mitliefern |
| celery | 5.6.3 | BSD-3-Clause | ja | |
| kombu | 5.6.2 | BSD-3-Clause | ja | **`kombu[redis]` verlangt `redis<6.5`** |
| redis (redis-py) | 8.1.0 aktuell, **6.4.0 verwendbar** | MIT | ja | 8.1.0 mit celery[redis] nicht auflösbar (uv-Ausgabe: „requirements are unsatisfiable“) |
| pillow | 13.0.0 (vom 2026-10-16) | MIT-CMU | ja (cp313 manylinux) | Wheel bündelt u. a. libjpeg-turbo (IJG/BSD-3/Zlib), libwebp (BSD-3), libavif (BSD-2) mit AOM (BSD-2 + AOM-Patentlizenz) und dav1d (BSD-2), libpng, libtiff, lcms2 (MIT), openjpeg (BSD-2), FreeType (FTL), HarfBuzz (Old MIT), brotli/zstd/xz sowie libxcb und libXau (MIT/X11, in `pillow.libs/` vorhanden). Texte in `pillow-13.0.0.dist-info/licenses/LICENSE` |
| pikepdf | 10.17.0 | MPL-2.0 | ja (cp313 manylinux) | Das Linux-Wheel bündelt in `pikepdf.libs/` nur libqpdf (Apache-2.0) und libjpeg-turbo (IJG/BSD-3/Zlib). `libstdc++`/`libgcc_s` kommen laut `ldd` aus dem Debian-Basisimage, nicht aus dem Wheel. Die Texte GPL-3.0 + GCC Runtime Library Exception liegen nur bei (für andere Plattform-Wheels). MPL-2.0: dateiweises Copyleft nur bei Änderung von pikepdf-Dateien |
| uvicorn | 0.54.0 | BSD-3-Clause | ja | |
| python-multipart | 0.0.32 | Apache-2.0 | ja | |
| pytest | 9.1.1 | MIT | ja | Testabhängigkeit |
| ruff | 0.17.2 | MIT | ja (Binär-Wheel) | Dev |
| mypy | 2.4.0 | MIT | ja | Dev |
| pypdfium2 | 5.14.0 | BSD-3-Clause / Apache-2.0 (+ PDFium BSD-3 und Abhängigkeiten) | ja | **nur Testabhängigkeit**, nicht ins Produktimage |

Der vollständige Satz `candidates.in` (inkl. `redis==6.4.0`) löst mit uv für Linux/3.13 auf (51 Pakete). **Nicht eingeführt:** Ghostscript (AGPL-3.0 oder kommerziell, Artifex) und MuPDF/PyMuPDF (AGPL-3.0 oder kommerziell, Artifex). Unter AGPL müsste ein netzwerkzugänglicher Dienst den Quellcode des Gesamtwerks bereitstellen. Für die Anforderungen dieses Plans nicht nötig.

## Ergebnis Bilder (Pillow 13.0.0)

`features.check` für `jpg`, `zlib`, `webp`, `avif`, `libtiff`, `littlecms2` = `True`; `registered_extensions()` enthält `.jpg .png .webp .gif .bmp .ico .avif`.

| Format | Lesen | Schreiben | Hinweis (gemessen) |
| --- | --- | --- | --- |
| JPEG | ja | ja | Ausgabe RGB 120x80, `quality=82, optimize=True` |
| PNG | ja | ja | `optimize=True`, RGBA erhalten (assert wie WebP) |
| WebP | ja | ja | verlustbehaftet und `lossless=True`, RGBA erhalten (assert: transparente Ecke α=0, deckende Fläche α=255) |
| GIF | ja (Modus P) | nicht gefordert | |
| BMP | ja | ja | nur RGB nach Hintergrundfüllung (s. u.) |
| ICO | ja | ja | 7 Einträge 16–256 geschrieben, beim Öffnen kommt der größte (256x256); RGBA mit transparenter Polsterung (assert) |
| AVIF | ja (RGBA) | nicht gefordert | Encoder vorhanden (für Fixtures genutzt) |
| GIF/APNG/WebP/AVIF animiert | erkannt | – | jeweils `n_frames=3`, `is_animated=True`; statische Variante `is_animated` False/fehlt → ablehnen möglich |

Weitere Befunde:

- **EXIF:** JPEG 60x40 mit Orientation=6 → `ImageOps.exif_transpose` liefert 40x60, Marke korrekt oben rechts, Orientation-Tag entfernt.
- **Alpha:** `RGBA` → JPEG wirft `OSError: cannot write mode RGBA as JPEG`. RGBA → BMP wirft **keinen** Fehler, beim Wiederöffnen ist der Modus RGB (per assert belegt) (Alpha geht stillschweigend verloren) → immer explizit auf Hintergrund compositen (`Image.new("RGB", size, bg).paste(im, mask=im.getchannel("A"))`); geprüft: transparente Ecke = Füllfarbe.
- **ICO:** `save(..., sizes=[(16,16)…(256,256)])` nach `ImageOps.pad` auf Quadrat; gezielte Eintragswahl über `im.size = (32, 32)` vor `load()`.
- **Pixelbomben:** `Image.open` ist lazy – ein 66-Byte-PNG-Header mit 8000x6000 liefert `size` in 0,07 ms ohne Dekodierung. `MAX_IMAGE_PIXELS` Standard 89 478 485: darüber `DecompressionBombWarning`, über dem Doppelten `DecompressionBombError` (in `open()`). Mit `MAX_IMAGE_PIXELS=40_000_000` wirft erst > 80 MP → **eigene Prüfung `w*h <= 40 MP` und Kante ≤ 16 384 nach `open()`, vor `load()`** zusätzlich nötig; Warnung als Fehler konfigurieren.
- **Typprüfung:** `Image.open(f, formats=[...])` beschränkt die Decoder; PNG-Bytes mit `formats=["JPEG"]` → `UnidentifiedImageError`.

## Ergebnis PDF (pikepdf 10.17.0 + Pillow)

Fixture (per Skript, 3 Seiten, 9 654 555 B; deterministisch: Rauschen aus `random.Random(1)`, ICC-Datum genullt, `deterministic_id=True` – Fixture und alle drei Ergebnisse in zwei aufeinanderfolgenden Läufen MD5-gleich): Helvetica-Text, Vektorrechteck, Link-Annotation (`/URI`), Outline (2 Einträge), AcroForm-Textfeld und folgende Bilder:

- ImA: DCT RGB 1200x800, zweimal platziert.
- ImB: Flate RGB 1000x1000 in einem Form-XObject mit `/Matrix` 0,5 und um 90° gedrehtem `cm`.
- ImJ: Flate RGB 800x200 in einem Form-XObject mit **ungleichmäßiger** `/Matrix [2 0 0 0.5 0 0]` unter einem um ≈36,87° gedrehten `cm [0.8 0.6 -0.6 0.8 330 480]`.
- ImL: Flate RGB 400x100 mit **zwei nicht kommutierenden `cm` im selben Stream**: `q 0.8 0.6 -0.6 0.8 72 60 cm 200 0 0 50 0 0 cm /ImL Do Q`.
- ImM: Flate RGB 620x620 bei 310 DPI; in high wäre der Faktor 0,968 → Pixelgröße bleibt (Regel `minDownscaleFactor`).
- ImC: Flate Gray.
- ImD: mit `/SMask`.
- ImE: Indexed.
- ImF: ICCBased.
- ImG: Flate mit PNG-Prädiktor 15, Zeilenfilter 0–4 gemischt.
- ImK: Flate mit TIFF-Prädiktor 2.
- ImI: JPEG q30, wird nicht verkleinert.
- ImH: 4000x400, nur über 15-fach verschachtelte Forms erreichbar.

Dazu ein zyklisches Form-XObject, ein Inline-Image und Seite 3 im A4-Format mit `/Rotate 90`.

**Analyse:** Die CTM wird über `q/Q/cm` verfolgt, Form-XObjects rekursiv über `Do` + `/Matrix`. Die neue CTM ist `M × CTM` (PDF-Zeilenvektor-Konvention). Die Rekursionstiefe ist auf 10 begrenzt, Zyklen werden über einen `objgen`-Stapel erkannt. Die Größe einer Platzierung ist die Länge der transformierten Einheitsvektoren. Bei mehrfach platzierten Bildern zählt die größte Platzierung. DPI = min(px_w·72/w_pt, px_h·72/h_pt). Alle Werte sind per `assert` gegen die Konstruktion geprüft (rel. Toleranz 1e-6):

| Bild | Pixel | Platzierungen (pt) | DPI gemessen = erwartet | unsicher |
| --- | --- | --- | --- | --- |
| ImA | 1200x800 | (288,192), (144,96) | 300 | – |
| ImB | 1000x1000 | (200,200) | 360 | – |
| ImJ | 800x200 | (200,50) | 288 | – |
| ImL | 400x100 | (200,50) | 144 | – |
| ImM | 620x620 | (144,144) | 310 | – |
| ImC | 800x600 | (192,144) | 300 | – |
| ImD | 400x400 | (200,200) | 144 | – |
| ImE | 64x64 | (100,100) | 46,08 | – |
| ImF | 300x300 | (150,150) | 144 | – |
| ImG | 600x450 | (288,216) | 150 | – |
| ImI | 300x200 | (216,144) | 100 | – |
| ImK | 200x100 | (100,50) | 144 | – |
| ImH | 4000x400 | – | – | Tiefe > 10 → nur Pixelkantengrenze |

Der Zyklus `S3>/Cyc>/Self` und der Tiefenabbruch werden erkannt, ohne Absturz. Das Inline-Image wird gezählt, aber nicht bearbeitet.

**Gegenprobe Matrixreihenfolge** (Herleitung als Kommentar in `pdf_poc.py`; R = Drehung [0.8 0.6 −0.6 0.8]):

- ImL (Seiten-cm R, danach cm S2 = [200 0 0 50]):
  - Richtig: S2×R ergibt 200 × 50 pt, also 144 DPI.
  - Vertauscht: R×S2 = [[160, 30], [−120, 40]] ergibt 162,79 × 126,49 pt, also 56,9 DPI.
- ImJ (Seiten-cm R, Form-`/Matrix` F = [2 0 0 0.5], gleichmäßiges inneres cm S):
  - Richtig: S×F×R ergibt 200 × 50 pt, also 288 DPI.
  - Vertauscht bei der Form-Matrix: 113,8 DPI.

`run.sh` führt `pdf_poc.py` getrennt mit `POC_SWAP=cm` (nur `cm` vertauscht) und `POC_SWAP=form` (nur Form-`/Matrix` vertauscht) aus. Jeder Lauf muss Exit ≠ 0 liefern, sonst bricht `run.sh` ab. Tatsächliche Ausgaben:

- `POC_SWAP=cm`: `AssertionError: ('ImL', 56.92099788303083, 144.0)`, danach „GEGENPROBE cm: OK“.
- `POC_SWAP=form`: `AssertionError: ('ImJ', 113.84199576606166, 288.0)`, danach „GEGENPROBE form: OK“.

Ohne ImL wäre eine Vertauschung nur bei `cm` unentdeckt geblieben. Bei ImJ ist das innere `cm` gleichmäßig, bei allen übrigen Bildern sind die Matrizen gleichmäßig oder um 90° gedreht.

**Prädiktoren:** `pikepdf.PdfImage(obj).as_pil_image()` (qpdf) dekodiert PNG-Prädiktor 15 und TIFF-Prädiktor 2 pixelgleich mit den Ausgangspixeln (für ImG per `assert`, für ImK als Ausgabe `True`).

- Flate mit PNG-Prädiktor 10–15 gilt als neu kodierbar, wenn `/Colors` zur Komponentenzahl passt, `/BitsPerComponent` 8 ist, `/Columns` = `/Width` und keine weiteren Schlüssel vorhanden sind.
- TIFF-Prädiktor 2 bleibt konservativ unverändert, obwohl die Dekodierung im PoC korrekt war.

**Neukodierung (Algorithmus wie in `api-contract.md` §8):**

- Geeignet sind nur einzelne Filter `DCTDecode` oder `FlateDecode`.
- Keine `DecodeParms` außer den genannten PNG-Prädiktoren.
- Ohne `SMask/Mask/Decode/ImageMask`, 8 bit, `DeviceRGB`/`DeviceGray`, ≤ 40 MP. JPEG-Quellen müssen tatsächlich RGB oder L sein. Als Maske referenzierte Streams sind ausgeschlossen.
- Zielgröße: Skalierung = min(1, Ziel-DPI/DPI), danach Pixelkantengrenze. Bei unsicherer Platzierung gilt nur die Kantengrenze. **Liegt der Faktor über `minDownscaleFactor` 0,9, bleibt die Pixelgröße** (wie `presets.ts`: `scale > 0.9 ? 1 : scale`). Belegt durch ImM in high (Faktor 0,968 → 620x620 bleibt) und ImH in high (Faktor genau 0,9 → wird verkleinert). Folge: Eine Kante darf die Grenze um bis zu 11 % überschreiten (z. B. 3 990 px in high).
- **DCT-Quellen werden nur bei tatsächlicher Verkleinerung neu kodiert.** Flate-Quellen werden auch ohne Verkleinerung neu kodiert.
- Ablauf: `pikepdf.PdfImage(obj).as_pil_image()` → `resize(LANCZOS)` → `save("JPEG", quality=round(q*100), optimize=True)` (85/72/55, begrenzt auf 1..95) → `obj.write(jpeg, filter=Name.DCTDecode)`. Danach werden `Width/Height/ColorSpace/BitsPerComponent` gesetzt und `/DecodeParms` entfernt.
- Ersetzt wird nur, wenn der neue Stream ≤ 97 % des alten ist. Jedes Objekt wird genau einmal bearbeitet (Schlüssel `objgen`).
- Jede Stufe entsteht aus dem Original. Speichern mit `remove_unreferenced_resources()` + `save(compress_streams=True, object_stream_mode=ObjectStreamMode.generate)`, keine Rasterung.

Per `assert` gilt: Die Bilder unten mit Maßen haben `aktion == "ersetzt"` und genau diese Maße. Alle anderen sind unverändert und roh byte-identisch.

| Bild (alt) | high (300/3600/85) | balanced (150/2000/72) | small (100/1300/55) |
| --- | --- | --- | --- |
| ImA 415 436 B (DCT) | unverändert (JPEG ohne Verkleinerung) | 600x400, 13 390 B | 400x267, 3 171 B |
| ImB 2 398 529 B | 833x833, 105 070 B | 417x417, 9 162 B | 278x278, 2 463 B |
| ImJ 389 544 B | 800x200, 31 955 B | 417x104, 3 499 B | 278x69, 1 222 B |
| ImL 101 006 B | 400x100, 9 038 B | 400x100, 5 133 B | 278x69, 1 539 B |
| ImM 925 236 B | 620x620 (Faktor 0,968 → keine Verkleinerung), 74 186 B | 300x300, 5 784 B | 200x200, 1 694 B |
| ImC 365 002 B | 800x600, 82 664 B | 400x300, 5 628 B | 267x200, 1 291 B |
| ImG 556 081 B (PNG-Präd.) | 600x450, 52 967 B | 600x450, 27 484 B | 400x300, 5 135 B |
| ImH 3 809 721 B (unsicher) | 3600x360, 208 462 B | 2000x200, 22 852 B | 1300x130, 5 064 B |
| ImI 2 972 B (DCT) | unverändert (JPEG ohne Verkleinerung) | dto. | dto. |
| ImD / ImE / ImF / ImK | unverändert (SMask / Indexed / ICCBased / TIFF-Prädiktor 2) | dto. | dto. |

Die 3-%-Regel selbst wurde in einem früheren Lauf ausgelöst: ImI mit q85 = 2 861 B > 97 % von 2 946 B. Nach der Vertragsregel für DCT-Quellen greift dort jetzt die vorgelagerte Regel. Im aktuellen Fixture gibt es keinen Fall „nur 3-%-Regel“. B07 sollte dafür eine eigene Fixture anlegen.

**Erhalt (je Stufe per `assert`, alle OK):**

- Ergebnis unverschlüsselt (`not is_encrypted`).
- Seitenzahl, MediaBox und `/Rotate` gleich.
- Dekodierte Content-Streams der Seiten und beider Form-XObjects byte-gleich, Text `(...) Tj` unverändert, Form-`/Matrix` erhalten.
- Link mit URI, Outline-Titel und AcroForm-Feld (`/T`, `/V`, gleiche Widget-Referenz) vorhanden.
- Unveränderte Bilder roh byte-identisch, SMask eingeschlossen.
- Ersetzte Bilder öffnen als JPEG mit Maßen = `/Width`/`/Height` und haben kein `/DecodeParms`.
- PDFium extrahiert den Text weiterhin.

**Plausibilitätsrendering** (pypdfium2, 100 DPI, Original vs. Ergebnis; Schwelle MAE < 6, PSNR > 25 dB):

| Seite | high | balanced | small |
| --- | --- | --- | --- |
| 1 | MAE 0,12 / 54,6 dB | 0,51 / 45,4 dB | 0,68 / 43,0 dB |
| 2 | 0,24 / 50,4 dB | 0,35 / 47,5 dB | 0,52 / 44,3 dB |
| 3 | 0,05 / 59,0 dB | 0,13 / 51,6 dB | 0,17 / 49,1 dB |

**Dateigrößen:**

| Variante | Bytes | Anteil |
| --- | --- | --- |
| Original | 9 654 555 | 100 % |
| high | 1 672 146 | 17,3 % |
| balanced | 785 291 | 8,1 % |
| small | 713 931 | 7,4 % |

Die synthetischen Fixture-Bilder sind glatt und komprimieren besser als reale Fotos. Die Prozentwerte sind **nicht** auf echte Dokumente übertragbar.

**Fehlerfälle (per `assert`):**

- Benutzerpasswort → `pikepdf.PasswordError`.
- Nur Besitzerpasswort → öffnet ohne Passwort mit `is_encrypted=True` und muss per Regel abgelehnt werden. pikepdf speichert standardmäßig unverschlüsselt, die Rechteeinschränkung ginge sonst verloren.
- `%PDF-1.7` + Zufallsbytes sowie PNG-Bytes → `PdfError`, sowohl mit Standard-`open()` als auch mit `attempt_recovery=False`.
- **Auf 50 % gekürzte Datei:**
  - Standard-`open()`: qpdf repariert sie und öffnet sie (3 Seiten, 9 Syntaxmeldungen). So ist die Datei nicht verwendbar.
  - `Pdf.open(..., attempt_recovery=False)`: `PdfError` („can't find startxref“).
- Fixture und alle drei Ergebnisse öffnen mit `attempt_recovery=False`. Der PoC öffnet alle Verarbeitungs- und Prüfdateien so.
- **Exception-Texte von pikepdf/qpdf enthalten interne Pfade** (z. B. `/out/pdf/enc_user.pdf: invalid password`). Sie dürfen nur auf maschinenlesbare Fehlercodes abgebildet werden und nie an Nutzer oder in Standardlogs mit Dateinamen gelangen.
- Risiko: `attempt_recovery=False` lehnt auch Dateien ab, die nur eine leicht fehlerhafte xref-Tabelle haben und die viele Viewer noch öffnen. Mit realen Dokumenten **nicht geprüft**.

## Bewertung

**PDF-Abnahme mit pikepdf + Pillow: erfüllbar, mit Grenzen.** Folgendes funktioniert nachweislich auf konstruierten Fixtures:

- DPI-Bestimmung inkl. ungleichmäßiger Transformationen und Form-XObjects, mit getrennten Gegenproben der Matrixreihenfolge für `cm` und Form-`/Matrix`.
- Sichere Stream-Ersetzung inkl. PNG-Prädiktor, Dedupe, Vertragsregel für DCT und `minDownscaleFactor` 0,9.
- Kantengrenze bei unsicherer Platzierung.
- Strukturerhalt und Ablehnung verschlüsselter bzw. beschädigter Dateien.

Bilder: Alle Pflichtformate sind im Container vorhanden und geprüft.

Grenzen des Ansatzes (nicht bearbeitet bzw. nicht garantiert):

- Unverändert bleiben:
  - Inline-Images (`BI/ID/EI`)
  - CMYK-, Lab-, ICCBased-, Indexed-, Separation- und DeviceN-Bilder
  - 1- und 16-bit-Bilder
  - JPX (JPEG 2000), JBIG2, CCITT und Filterketten
  - TIFF-Prädiktor
  - Bilder mit SMask, Mask oder Decode

  Die Einsparung fällt entsprechend gering aus.
- Bilder in Annotation-Appearance-Streams, Tiling-Patterns, Type3-Fonts und Soft-Mask-Gruppen (ExtGState) werden nicht als Platzierung erfasst. Sie gelten als „unsicher“ und unterliegen nur der Pixelgrenze. Im PoC sind nur „gar nicht platziert“ und der Tiefenabbruch getestet; Fixtures für Pattern, Type3 und AP sind **nicht ausgeführt**.
- Clipping und BBox werden nicht berücksichtigt (konservativ: größere Darstellung angenommen). Scherung ist nur über die Längen der Einheitsvektoren abgebildet; eine eigene Scher-Fixture ist **nicht ausgeführt**.
- Kein Font-Subsetting und keine Font-Entfernung, keine Optimierung von Vektoren oder Content-Streams.
- Digitale Signaturen werden durch das Neuschreiben ungültig. PDF/A-Konformität ist nicht garantiert (nicht geprüft).
- **Nicht getestet:** signierte PDFs, PDF/A-Dateien, Tagged-PDF-Strukturbaum, inkrementelle Updates, Objektstreams im Eingang, reale Dokumente.
- Speicher und Laufzeit sind nur für kleine Fixtures gemessen (~0,3 s pro Stufe). 40-MP-Bilder und 100-MB-PDFs sind **nicht ausgeführt**.

## Empfehlungen für B05–B08

- **Versionen (B02):**
  - Maßgeblich für das Produkt ist die Sperre in `backend/uv.lock`. Sie wird mit 7 Tagen Lieferketten-Karenz gelockt (`exclude-newer`) und weicht daher von `candidates.in` ab (z. B. fastapi 0.143.3, starlette 1.8.0, ruff 0.17.1). `candidates.in` dokumentiert nur den PoC-Stand vom 2026-10-24.
  - Unabhängig davon gilt `redis` < 6.5 (`kombu[redis]`); im PoC-Stand `redis==6.4.0` statt 8.1.0.
  - Pillow 13.0.0 gibt es erst seit 2026-10-16. Im Lock behalten, bei Problemen auf die letzte 12.x zurückgehen.
  - Basisimage per Digest pinnen, Wheels-only + Hashes wie im PoC-Dockerfile.
  - pypdfium2 nur in die Testgruppe.
- **B05/B06 Bilder:**
  - Reihenfolge: `Image.open(fp, formats=ERLAUBT)` → Größe, Kante und MP prüfen → `is_animated`/`n_frames` prüfen → erst dann `load()`.
  - `warnings.simplefilter("error", Image.DecompressionBombWarning)` und `Image.MAX_IMAGE_PIXELS = 40_000_000` setzen.
  - `ImageOps.exif_transpose` immer vor der Skalierung anwenden.
  - Alpha für JPEG **und BMP** explizit flatten.
  - ICO: mit `ImageOps.pad` bzw. `contain` aufs Quadrat bringen, `sizes=` explizit angeben.
  - PNG nur mit `optimize=True` bzw. Skalierung, ohne Qualitätsoption.
  - Capabilities aus `features.check(...)` plus Rundreise ableiten.
- **B07 PDF:**
  - Analyse wie im PoC: `concat` = `M × CTM` und die ImJ- und ImL-Fixtures mit getrennten Gegenproben (cm/Form) übernehmen. Operator `"INLINE IMAGE"` zählen.
  - Ressourcen-Namen haben einen führenden `/`.
  - Eignung strikt wie oben. JPEG-Quellmodus mit Pillow prüfen (CMYK-JPEG mit falschem `/ColorSpace`).
  - Für JPEG-Quellen gilt die Vertragsregel „nur bei Verkleinerung“. Eine eigene Fixture für die 3-%-Regel (Flate-Quelle, deren JPEG nicht kleiner wird) ergänzen.
  - Öffnen immer mit `attempt_recovery=False`.
  - Verschlüsselte Dateien ablehnen, auch solche mit nur einem Besitzerpasswort.
  - Fehlertexte nie durchreichen.
  - Dekodierung und Kodierung im Kindprozess mit Speicher- und Zeitlimit (B04).
- **B08:**
  - Jede Stufe aus dem Original öffnen.
  - Größen messen und „keine Einsparung“ offen melden.
  - „Unsichere“ Bilder als `image-size-unknown` melden.
- **Tests:** Den Fixture-Generator aus diesem PoC als Ausgangspunkt für echte pytest-Fixtures nehmen. Ergänzen um:
  - Bilder in Pattern, Type3 und AP sowie Scherung
  - CMYK-JPEG und JPX
  - signierte und PDF/A-Dateien
  - ein reales Dokument
  - Dateien mit leicht defekter xref
