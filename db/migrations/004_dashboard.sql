-- OpsBrain 004: tables for the Open Brain REST API and dashboard (server/rest.ts, dashboard/).
-- Adds tables only; `thoughts` is unchanged.

-- Reflections: structured thinking attached to a record (trigger, options, factors, conclusion).
-- Writes are attributed here and logged in ops_record_events as a comment on the record.
CREATE TABLE IF NOT EXISTS ops_reflections (
  id bigserial PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  trigger_context text NOT NULL DEFAULT '' CHECK (length(trigger_context) <= 4000),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  conclusion text NOT NULL DEFAULT '' CHECK (length(conclusion) <= 20000),
  confidence real NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1),
  reflection_type text NOT NULL DEFAULT 'reflection' CHECK (length(reflection_type) <= 60),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES ops_principals(id),
  authenticated_as uuid NOT NULL REFERENCES ops_principals(id),
  on_behalf_of uuid REFERENCES ops_principals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_reflections_record ON ops_reflections (record_id, created_at DESC);
ALTER TABLE ops_reflections ENABLE ROW LEVEL SECURITY;

-- Ingest jobs: longer text split into candidate thoughts, previewed (dry run) and then saved as notes.
-- Each saved note is a normal attributed record; the job only keeps the preview and the outcome.
CREATE TABLE IF NOT EXISTS ops_ingest_jobs (
  id bigserial PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES ops_principals(id) ON DELETE CASCADE,
  source_label text NOT NULL DEFAULT 'dashboard',
  status text NOT NULL CHECK (status IN ('dry_run_complete', 'complete', 'failed')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  extracted_count int NOT NULL DEFAULT 0,
  added_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ops_ingest_jobs_principal ON ops_ingest_jobs (principal_id, created_at DESC);
ALTER TABLE ops_ingest_jobs ENABLE ROW LEVEL SECURITY;

