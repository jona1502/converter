-- Add pdf-rotate without changing existing jobs, results or format values.
-- Input is a PDF, so ck_jobs_input_format stays as it is.
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf', 'pdf-rotate'));
