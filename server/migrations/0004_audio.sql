-- Werkzeug audio-convert und Audio-Eingabeformate zulassen
-- (docs/superpowers/specs/2026-11-13-audio-convert-design.md).
-- Nur Erweiterungen bestehender Wertelisten; vorhandene Zeilen bleiben
-- gültig. Die Phase encode wird für Audio wiederverwendet.

ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
    CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert'));

ALTER TABLE jobs DROP CONSTRAINT ck_jobs_input_format;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_input_format
    CHECK (input_format IN ('jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif', 'pdf',
                            'mp3', 'wav', 'flac', 'ogg'));
