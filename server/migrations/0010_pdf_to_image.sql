-- Werkzeug pdf-to-image zulassen (docs/superpowers/specs/2026-11-18-pdf-to-image-design.md).
-- Nur Erweiterung der Werkzeugliste; das Eingabeformat pdf ist bereits erlaubt und
-- vorhandene Zeilen bleiben gültig.
-- Die Liste ist kumulativ: sie behält pdf-rotate (0006), pdf-split (0007), pdf-merge (0008)
-- und image-pdf (0009); ck_jobs_input_format (inkl. zip aus 0009) bleibt unverändert.
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf', 'pdf-rotate', 'pdf-split', 'pdf-merge', 'image-pdf', 'pdf-to-image'));
