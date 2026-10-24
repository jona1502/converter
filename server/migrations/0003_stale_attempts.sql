-- Reserve verlassener Versuche bis zur sicheren Bereinigung halten
-- (backend/migrations/versions/0003_stale_attempts.py).
-- Der doppelte Präfix im CHECK-Namen stammt aus der Namenskonvention der
-- Python-Modelle und wird für Schemagleichheit übernommen.

CREATE TABLE stale_attempts (
    lease_token uuid NOT NULL,
    job_id uuid NOT NULL,
    reserved_bytes bigint NOT NULL,
    reap_after timestamp with time zone NOT NULL,
    CONSTRAINT ck_stale_attempts_ck_stale_attempts_reserved_bytes CHECK (reserved_bytes >= 0),
    CONSTRAINT fk_stale_attempts_job_id_jobs FOREIGN KEY (job_id) REFERENCES jobs (id),
    CONSTRAINT pk_stale_attempts PRIMARY KEY (lease_token)
);
CREATE INDEX ix_stale_attempts_job_id ON stale_attempts (job_id);
CREATE INDEX ix_stale_attempts_reap_after ON stale_attempts (reap_after);
