BEGIN;
CREATE TABLE IF NOT EXISTS tabellio_lineages (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^[0-9a-f]{64}$'),
  project_key text NOT NULL,
  repository_id text NOT NULL,
  base_commit text NOT NULL,
  head_commit text NOT NULL,
  merge_base text NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tabellio_lineages_candidate_idx ON tabellio_lineages (project_key, repository_id, candidate_id);
CREATE TABLE IF NOT EXISTS tabellio_observations (
  lineage_digest text NOT NULL REFERENCES tabellio_lineages(digest) ON DELETE CASCADE,
  observation_id text NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  candidate_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (lineage_digest, observation_id)
);
CREATE INDEX IF NOT EXISTS tabellio_observations_source_idx ON tabellio_observations (source, source_id, observed_at);
CREATE TABLE IF NOT EXISTS tabellio_evidence_links (
  lineage_digest text NOT NULL,
  observation_id text NOT NULL,
  relation text NOT NULL,
  target_source text NOT NULL,
  target_source_id text NOT NULL,
  basis text NOT NULL CHECK (basis IN ('explicit', 'inferred')),
  PRIMARY KEY (lineage_digest, observation_id, relation, target_source, target_source_id, basis),
  FOREIGN KEY (lineage_digest, observation_id) REFERENCES tabellio_observations(lineage_digest, observation_id) ON DELETE CASCADE
);
INSERT INTO tabellio_schema_migrations (version) VALUES ('002_tabellio_lineages') ON CONFLICT DO NOTHING;
COMMIT;
