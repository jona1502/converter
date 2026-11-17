-- Add Markdown without changing existing jobs, results or format values.
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf'));
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_input_format;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_input_format
 CHECK (input_format IN ('jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif', 'pdf', 'mp3', 'wav', 'flac', 'ogg', 'markdown'));
