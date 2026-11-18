-- Add image-pdf (Bild zu PDF) without changing existing jobs, results or format values.
-- The input is a ZIP bundle of images, hence the new input format 'zip'.
-- Both lists are cumulative: ck_jobs_tool keeps pdf-rotate (0006), pdf-split (0007) and
-- pdf-merge (0008); ck_jobs_input_format keeps every earlier format.
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf', 'pdf-rotate', 'pdf-split', 'pdf-merge', 'image-pdf'));
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_input_format;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_input_format
 CHECK (input_format IN ('jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif', 'pdf', 'mp3', 'wav', 'flac', 'ogg', 'markdown', 'zip'));
