-- Ausgangsschema: Sitzungen, Aufträge, Ergebnisse, Outbox, Reservierungen.
-- Portierung von backend/migrations/versions/0001_initial_schema.py; Namen,
-- Typen und Defaults entsprechen exakt dem Alembic-Stand (siehe
-- testdata/alembic_0003_schema.txt). DEFAULT '0' statt 0 ist Absicht: so
-- speichert PostgreSQL bei bigint-Spalten denselben Ausdruck wie Alembic.

CREATE TABLE sessions (
    id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT pk_sessions PRIMARY KEY (id),
    CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash)
);
CREATE INDEX ix_sessions_expires_at ON sessions (expires_at);

-- smallserial wie bei SQLAlchemy (autoincrement auf smallint-Primärschlüssel).
CREATE TABLE storage_usage (
    id smallserial NOT NULL,
    reserved_bytes bigint DEFAULT '0' NOT NULL,
    CONSTRAINT ck_storage_usage_single_row CHECK (id = 1),
    CONSTRAINT ck_storage_usage_reserved_bytes CHECK (reserved_bytes >= 0),
    CONSTRAINT pk_storage_usage PRIMARY KEY (id)
);
-- Genau eine Zeile; Reservieren/Freigeben sind bedingte Updates darauf.
INSERT INTO storage_usage (id, reserved_bytes) VALUES (1, 0);

CREATE TABLE jobs (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    tool text NOT NULL,
    state text DEFAULT 'queued' NOT NULL,
    phase text,
    options jsonb NOT NULL,
    input_name text NOT NULL,
    input_size bigint NOT NULL,
    input_format text NOT NULL,
    input_sha256 bytea NOT NULL,
    input_storage_key text NOT NULL,
    input_width integer,
    input_height integer,
    idempotency_key text,
    fingerprint bytea,
    version integer DEFAULT '0' NOT NULL,
    attempts integer DEFAULT '0' NOT NULL,
    max_attempts integer NOT NULL,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    error_code text,
    progress jsonb,
    analysis jsonb,
    reserved_bytes bigint DEFAULT '0' NOT NULL,
    working_bytes bigint DEFAULT '0' NOT NULL,
    CONSTRAINT ck_jobs_input_format
        CHECK (input_format IN ('jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif', 'pdf')),
    CONSTRAINT ck_jobs_phase
        CHECK (phase IS NULL OR (phase IN ('analyze', 'variant', 'encode', 'save'))),
    CONSTRAINT ck_jobs_phase_only_running CHECK (phase IS NULL OR state = 'running'),
    CONSTRAINT ck_jobs_failed_error CHECK (state <> 'failed' OR error_code IS NOT NULL),
    CONSTRAINT ck_jobs_running_lease CHECK (state <> 'running' OR lease_token IS NOT NULL),
    CONSTRAINT ck_jobs_state
        CHECK (state IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'expired')),
    CONSTRAINT ck_jobs_tool
        CHECK (tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress')),
    CONSTRAINT ck_jobs_idempotency_pair CHECK ((idempotency_key IS NULL) = (fingerprint IS NULL)),
    CONSTRAINT ck_jobs_attempts
        CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts),
    CONSTRAINT ck_jobs_input_size CHECK (input_size >= 0),
    CONSTRAINT ck_jobs_input_sha256_length CHECK (octet_length(input_sha256) = 32),
    CONSTRAINT ck_jobs_bytes CHECK (reserved_bytes >= 0 AND working_bytes >= 0),
    CONSTRAINT ck_jobs_version CHECK (version >= 0),
    CONSTRAINT fk_jobs_session_id_sessions FOREIGN KEY (session_id) REFERENCES sessions (id),
    CONSTRAINT pk_jobs PRIMARY KEY (id),
    CONSTRAINT uq_jobs_session_id_idempotency_key UNIQUE (session_id, idempotency_key)
);
CREATE INDEX ix_jobs_active_session ON jobs (session_id)
    WHERE state IN ('queued', 'running') AND deleted_at IS NULL;
CREATE INDEX ix_jobs_deleted_at ON jobs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX ix_jobs_expires_at ON jobs (expires_at);
CREATE INDEX ix_jobs_lease_expires_at_running ON jobs (lease_expires_at) WHERE state = 'running';

CREATE TABLE upload_reservations (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    bytes bigint NOT NULL,
    spool_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_upload_reservations_bytes CHECK (bytes > 0),
    CONSTRAINT fk_upload_reservations_session_id_sessions
        FOREIGN KEY (session_id) REFERENCES sessions (id),
    CONSTRAINT pk_upload_reservations PRIMARY KEY (id),
    CONSTRAINT uq_upload_reservations_spool_key UNIQUE (spool_key)
);
CREATE INDEX ix_upload_reservations_expires_at ON upload_reservations (expires_at);
CREATE INDEX ix_upload_reservations_session_id ON upload_reservations (session_id);

CREATE TABLE job_results (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    ordinal smallint NOT NULL,
    level text,
    state text DEFAULT 'pending' NOT NULL,
    storage_key text,
    size bigint,
    mime text NOT NULL,
    download_name text NOT NULL,
    details jsonb,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_job_results_level
        CHECK (level IS NULL OR (level IN ('high', 'balanced', 'small'))),
    CONSTRAINT ck_job_results_succeeded_has_file
        CHECK (state <> 'succeeded' OR (storage_key IS NOT NULL AND size IS NOT NULL)),
    CONSTRAINT ck_job_results_state
        CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT ck_job_results_ordinal CHECK (ordinal >= 0),
    CONSTRAINT ck_job_results_size CHECK (size IS NULL OR size >= 0),
    CONSTRAINT fk_job_results_job_id_jobs
        FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
    CONSTRAINT pk_job_results PRIMARY KEY (id),
    CONSTRAINT uq_job_results_job_id_ordinal UNIQUE (job_id, ordinal)
);

CREATE TABLE outbox (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    kind text NOT NULL,
    job_id uuid NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT '0' NOT NULL,
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_outbox_kind CHECK (kind IN ('dispatch', 'delete')),
    CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
    CONSTRAINT fk_outbox_job_id_jobs FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
    CONSTRAINT pk_outbox PRIMARY KEY (id)
);
CREATE INDEX ix_outbox_job_id ON outbox (job_id);
CREATE INDEX ix_outbox_pending ON outbox (available_at) WHERE published_at IS NULL;
