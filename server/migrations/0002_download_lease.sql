-- Zeitlich begrenzte Download-Lease schützt Dateien vor Cleanup
-- (backend/migrations/versions/0002_download_lease.py).

ALTER TABLE jobs ADD COLUMN download_until timestamp with time zone;
