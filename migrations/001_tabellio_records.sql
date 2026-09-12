BEGIN;

CREATE TABLE IF NOT EXISTS tabellio_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tabellio_records (
  record_id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  project_key text,
  repository_id text,
  run_id text,
  commit_sha text,
  checkpoint_id text,
  pull_request_number integer,
  validation_id text,
  source text NOT NULL,
  source_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'missing', 'stale', 'conflicting', 'inferred', 'blocked', 'failed', 'passed')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'private')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tabellio_records_source_id_key UNIQUE (source, source_id),
  CONSTRAINT tabellio_records_commit_sha_check CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT tabellio_records_checkpoint_id_check CHECK (checkpoint_id IS NULL OR checkpoint_id ~ '^([0-9a-f]{12}|[0-7][0-9A-HJKMNP-TV-Z]{25})$'),
  CONSTRAINT tabellio_records_pull_request_number_check CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  CONSTRAINT tabellio_records_checkpoint_sensitivity_check CHECK (checkpoint_id IS NULL OR sensitivity = 'private')
);

CREATE INDEX IF NOT EXISTS tabellio_records_source_observed_at_idx
  ON tabellio_records (source, observed_at DESC);

CREATE INDEX IF NOT EXISTS tabellio_records_status_idx
  ON tabellio_records (status);

INSERT INTO tabellio_schema_migrations (version)
VALUES ('001_tabellio_records')
ON CONFLICT (version) DO NOTHING;

COMMIT;
