-- Werkzeug pdf-to-image zulassen (docs/superpowers/specs/2026-11-18-pdf-to-image-design.md).
-- Nur Erweiterung der Werkzeugliste; das Eingabeformat pdf ist bereits erlaubt und
-- vorhandene Zeilen bleiben gültig.
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf', 'pdf-to-image'));
