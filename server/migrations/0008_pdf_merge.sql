-- Add pdf-merge without changing existing jobs, results or format values.
-- Merge inputs are stored as one bundle with input_format 'pdf', so only the
-- tool constraint grows.
-- The list is cumulative: it keeps pdf-rotate (0006) and pdf-split (0007).
ALTER TABLE jobs DROP CONSTRAINT ck_jobs_tool;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_tool
 CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert', 'markdown-pdf', 'pdf-rotate', 'pdf-split', 'pdf-merge'));
