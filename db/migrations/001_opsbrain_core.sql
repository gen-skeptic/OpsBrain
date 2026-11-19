-- OpsBrain core schema: a multi-user, multi-agent company record system.
--
-- Builds on the Open Brain `thoughts` table. It only ADDS columns to `thoughts`
-- (never alters or removes existing ones), so an existing Open Brain database
-- can be upgraded in place. {{EMBEDDING_DIM}} is replaced by db/migrate.ts.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- The Open Brain core table (created only when this is a fresh database)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thoughts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  embedding vector({{EMBEDDING_DIM}}),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON thoughts (content_fingerprint) WHERE content_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata ON thoughts USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC);

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- Principals: every person, agent and service that reads or writes records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'agent', 'auditor')),
  can_approve boolean NOT NULL DEFAULT false,
  responsible_human_id uuid REFERENCES ops_principals(id),
  email text,
  job_title text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'human' OR NOT can_approve)
);
DROP TRIGGER IF EXISTS ops_principals_updated_at ON ops_principals;
CREATE TRIGGER ops_principals_updated_at
  BEFORE UPDATE ON ops_principals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Keys: only SHA-256 hashes are stored. Raw keys are shown once by the admin CLI.
CREATE TABLE IF NOT EXISTS ops_principal_keys (
  key_hash text PRIMARY KEY CHECK (length(key_hash) = 64 AND key_hash = lower(key_hash)),
  principal_id uuid NOT NULL REFERENCES ops_principals(id) ON DELETE CASCADE,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR active = false)
);
CREATE INDEX IF NOT EXISTS idx_ops_keys_principal ON ops_principal_keys (principal_id);

-- Delegation: an authenticated principal (a person or a runtime service key)
-- may act as these agents. Attribution then records both.
CREATE TABLE IF NOT EXISTS ops_delegations (
  principal_id uuid NOT NULL REFERENCES ops_principals(id) ON DELETE CASCADE,
  may_act_as uuid NOT NULL REFERENCES ops_principals(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, may_act_as),
  CHECK (principal_id <> may_act_as)
);

-- ---------------------------------------------------------------------------
-- Organization: areas of responsibility, processes and projects (PARA)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_areas (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  description text,
  owner_id uuid REFERENCES ops_principals(id),
  sort_order int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS ops_areas_updated_at ON ops_areas;
CREATE TRIGGER ops_areas_updated_at BEFORE UPDATE ON ops_areas FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS ops_processes (
  id text PRIMARY KEY CHECK (id ~ '^[A-Z][A-Z0-9-]{1,15}$'),
  name text NOT NULL,
  area_slug text REFERENCES ops_areas(slug) ON UPDATE CASCADE,
  owner_id uuid REFERENCES ops_principals(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS ops_processes_updated_at ON ops_processes;
CREATE TRIGGER ops_processes_updated_at BEFORE UPDATE ON ops_processes FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS ops_projects (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$'),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'internal' CHECK (kind IN ('client_engagement', 'internal')),
  client_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
  area_slug text REFERENCES ops_areas(slug) ON UPDATE CASCADE,
  owner_id uuid REFERENCES ops_principals(id),
  started_on date,
  due_on date,
  completed_on date,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES ops_principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS ops_projects_updated_at ON ops_projects;
CREATE TRIGGER ops_projects_updated_at BEFORE UPDATE ON ops_projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Record types: what kinds of company records exist, and how PARA files them.
CREATE TABLE IF NOT EXISTS ops_record_types (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL,
  folder text NOT NULL,
  para_default text NOT NULL DEFAULT 'area' CHECK (para_default IN ('project', 'area', 'resource')),
  terminal_statuses text[] NOT NULL DEFAULT '{}',
  description text
);

INSERT INTO ops_record_types (slug, name, folder, para_default, terminal_statuses, description) VALUES
  ('note',            'Note',             'Notes',             'area',     '{}',                                   'Free-form memory, including Open Brain thoughts'),
  ('task_card',       'Task card',        'Task cards',        'project',  '{done,cancelled}',                     'A unit of work handed between people and agents'),
  ('qa_record',       'QA record',        'QA records',        'project',  '{pass,pass_with_notes,fail}',          'A review verdict with itemized findings'),
  ('decision',        'Decision',         'Decisions',         'area',     '{decided,approved,rejected,superseded}','A decision record'),
  ('approval',        'Approval request', 'Approvals',         'area',     '{approved,rejected}',                  'Something that needs an approver'),
  ('kaizen_card',     'Kaizen card',      'Kaizen cards',      'area',     '{done,declined}',                      'An improvement idea'),
  ('meeting_note',    'Meeting note',     'Meeting notes',     'area',     '{}',                                   'Notes, decisions and actions from a meeting'),
  ('risk',            'Risk',             'Risks',             'area',     '{closed,accepted}',                    'A risk register entry'),
  ('incident',        'Incident',         'Incidents',         'project',  '{resolved,closed}',                    'An incident and its review'),
  ('change_record',   'Change record',    'Change records',    'project',  '{done,rolled_back,cancelled}',         'A change to a system'),
  ('support_request', 'Support request',  'Support requests',  'project',  '{closed}',                             'A client question or bug report'),
  ('lead',            'Lead',             'Pipeline',          'area',     '{won,lost,disqualified}',              'A sales lead or opportunity'),
  ('proposal',        'Proposal',         'Proposals',         'area',     '{won,lost,withdrawn}',                 'A proposal record (the document itself lives in the document store)'),
  ('invoice',         'Invoice record',   'Invoices',          'area',     '{paid,void,written_off}',              'An invoice record'),
  ('contract',        'Contract record',  'Contracts',         'area',     '{signed,expired,terminated}',          'A contract record'),
  ('hiring',          'Hiring record',    'Hiring',            'area',     '{hired,closed}',                       'A role, candidate or offer'),
  ('feedback',        'Feedback',         'Feedback',          'area',     '{closed}',                             'Client or team feedback'),
  ('report',          'Report',           'Reports',           'area',     '{final}',                              'A periodic report'),
  ('plan',            'Plan',             'Plans',             'area',     '{final,superseded}',                   'A plan or roadmap'),
  ('retrospective',   'Retrospective',    'Retrospectives',    'project',  '{final}',                              'Lessons from a project or incident'),
  ('playbook',        'Playbook',         'Playbooks',         'resource', '{superseded}',                         'How-to guidance'),
  ('sop',             'SOP',              'SOPs',              'resource', '{superseded}',                         'A standard operating procedure'),
  ('template',        'Template',         'Templates',         'resource', '{superseded}',                         'A reusable template'),
  ('research',        'Research',         'Research',          'resource', '{superseded}',                         'Research findings with sources'),
  ('reference',       'Reference',        'References',        'resource', '{superseded}',                         'Reference material'),
  ('policy',          'Policy',           'Policies',          'resource', '{superseded}',                         'A company policy')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Company record columns on `thoughts` (added, never altered)
-- ---------------------------------------------------------------------------
ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS record_type text NOT NULL DEFAULT 'note' REFERENCES ops_record_types(slug),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES ops_projects(id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS area_slug text REFERENCES ops_areas(slug) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS process_id text REFERENCES ops_processes(id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS process_step int CHECK (process_step IS NULL OR process_step > 0),
  ADD COLUMN IF NOT EXISTS para_override text CHECK (para_override IN ('project', 'area', 'resource', 'archive')),
  ADD COLUMN IF NOT EXISTS resource_topic text,
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS authenticated_as uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS on_behalf_of uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS priority text CHECK (priority IN ('high', 'normal', 'low')),
  ADD COLUMN IF NOT EXISTS due_on date,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'company' CHECK (visibility IN ('company', 'restricted')),
  ADD COLUMN IF NOT EXISTS allowed_principals uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS financial_or_ethical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approval_status text CHECK (approval_status IN ('pending', 'approved', 'rejected', 'changes_requested')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES ops_principals(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_thoughts_record_type ON thoughts (record_type);
CREATE INDEX IF NOT EXISTS idx_thoughts_project ON thoughts (project_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_area ON thoughts (area_slug);
CREATE INDEX IF NOT EXISTS idx_thoughts_process ON thoughts (process_id, process_step);
CREATE INDEX IF NOT EXISTS idx_thoughts_owner ON thoughts (owner_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_assignee ON thoughts (assignee_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_updated_at ON thoughts (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_approval ON thoughts (approval_status) WHERE requires_approval;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_external_ref ON thoughts (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_fts ON thoughts
  USING gin (to_tsvector('english', coalesce(title, '') || ' ' || content));

-- Version counter: every update bumps it, so writers can detect conflicts.
CREATE OR REPLACE FUNCTION ops_bump_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS thoughts_bump_version ON thoughts;
CREATE TRIGGER thoughts_bump_version BEFORE UPDATE ON thoughts FOR EACH ROW EXECUTE FUNCTION ops_bump_version();

-- Approvals are enforced in the database: only an active person with
-- approval rights can approve or reject. Financial or ethical records
-- always require approval.
CREATE OR REPLACE FUNCTION ops_enforce_approval()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.financial_or_ethical THEN
    NEW.requires_approval := true;
  END IF;
  IF NEW.requires_approval AND NEW.approval_status IS NULL THEN
    NEW.approval_status := 'pending';
  END IF;
  IF NEW.approval_status IN ('approved', 'rejected')
     AND (TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM NEW.approval_status) THEN
    IF NEW.approved_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops_principals p
       WHERE p.id = NEW.approved_by AND p.active AND p.can_approve AND p.kind = 'human'
    ) THEN
      RAISE EXCEPTION 'Only an active person with approval rights can approve or reject a record'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.approved_at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved'
     AND NEW.approval_status = 'approved' AND NEW.content IS DISTINCT FROM OLD.content THEN
    -- Changing approved content reopens the approval.
    NEW.approval_status := 'pending';
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS thoughts_enforce_approval ON thoughts;
CREATE TRIGGER thoughts_enforce_approval BEFORE INSERT OR UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ops_enforce_approval();

-- ---------------------------------------------------------------------------
-- History and links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_record_events (
  id bigserial PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES ops_principals(id),
  authenticated_as uuid REFERENCES ops_principals(id),
  action text NOT NULL CHECK (action IN ('create', 'update', 'comment', 'approve', 'reject', 'request_changes', 'archive', 'unarchive', 'link')),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_events_record ON ops_record_events (record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_record_links (
  from_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation ~ '^[a-z][a-z_]{1,39}$'),
  created_by uuid REFERENCES ops_principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation),
  CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_links_to ON ops_record_links (to_id);

-- ---------------------------------------------------------------------------
-- Access rules and lookups
-- ---------------------------------------------------------------------------
-- Company records are visible to every active principal. Restricted records
-- (HR, legal, finance, anything sensitive) are visible to owners and admins,
-- and to the record's owner, assignee, creator and allowed principals.
CREATE OR REPLACE FUNCTION ops_can_read(
  p_principal uuid, p_visibility text, p_owner uuid, p_assignee uuid, p_created_by uuid, p_allowed uuid[]
) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM ops_principals pr WHERE pr.id = p_principal AND pr.active)
     AND (
       p_visibility = 'company'
       OR EXISTS (SELECT 1 FROM ops_principals pr WHERE pr.id = p_principal AND pr.role IN ('owner', 'admin'))
       OR p_principal = p_owner OR p_principal = p_assignee OR p_principal = p_created_by
       OR p_principal = ANY (coalesce(p_allowed, '{}'))
     );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ops_lookup_key(p_key_hash text)
RETURNS TABLE (principal_id uuid, handle text, kind text, role text) AS $$
BEGIN
  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE ops_principal_keys k
     SET last_used_at = now()
    FROM ops_principals p
   WHERE k.principal_id = p.id
     AND k.key_hash = lower(p_key_hash)
     AND k.active AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND p.active
  RETURNING p.id, p.handle, p.kind, p.role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION ops_match_records(
  p_principal uuid,
  query_embedding vector,
  match_threshold float DEFAULT 0.4,
  match_count int DEFAULT 10,
  p_filters jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  id uuid, record_type text, title text, content text, status text,
  project_id text, area_slug text, process_id text, external_ref text,
  created_at timestamptz, updated_at timestamptz, similarity float
) AS $$
  SELECT t.id, t.record_type, t.title, t.content, t.status,
         t.project_id, t.area_slug, t.process_id, t.external_ref,
         t.created_at, t.updated_at,
         1 - (t.embedding <=> query_embedding) AS similarity
    FROM thoughts t
   WHERE t.embedding IS NOT NULL
     AND 1 - (t.embedding <=> query_embedding) > match_threshold
     AND ops_can_read(p_principal, t.visibility, t.owner_id, t.assignee_id, t.created_by, t.allowed_principals)
     AND (coalesce((p_filters->>'include_archived')::boolean, false) OR t.archived_at IS NULL)
     AND (p_filters->>'record_type' IS NULL OR t.record_type = p_filters->>'record_type')
     AND (p_filters->>'status' IS NULL OR t.status = p_filters->>'status')
     AND (p_filters->>'project_id' IS NULL OR t.project_id = p_filters->>'project_id')
     AND (p_filters->>'area_slug' IS NULL OR t.area_slug = p_filters->>'area_slug')
     AND (p_filters->>'process_id' IS NULL OR t.process_id = p_filters->>'process_id')
   ORDER BY t.embedding <=> query_embedding
   LIMIT match_count;
$$ LANGUAGE sql STABLE;

-- Readable view used by the server, the PARA export and dashboards.
CREATE OR REPLACE VIEW ops_records AS
SELECT t.id, t.record_type, rt.name AS record_type_name, rt.folder AS type_folder, rt.para_default,
       rt.terminal_statuses, t.title, t.content, t.status, t.external_ref,
       t.project_id, pj.name AS project_name, pj.kind AS project_kind, pj.status AS project_status,
       pj.client_name, coalesce(t.area_slug, pr.area_slug, pj.area_slug) AS area_slug,
       ar.name AS area_name, t.process_id, pr.name AS process_name, t.process_step,
       t.para_override, t.resource_topic, t.priority, t.due_on, t.tags, t.fields, t.metadata,
       t.visibility, t.allowed_principals, t.financial_or_ethical, t.requires_approval,
       t.approval_status, t.approved_at, t.version, t.archived_at, t.created_at, t.updated_at,
       t.owner_id, own.handle AS owner, t.assignee_id, asg.handle AS assignee,
       t.created_by AS created_by_id, cb.handle AS created_by, ub.handle AS updated_by,
       au.handle AS authenticated_as, obo.handle AS on_behalf_of, apr.handle AS approved_by
  FROM thoughts t
  JOIN ops_record_types rt ON rt.slug = t.record_type
  LEFT JOIN ops_projects pj ON pj.id = t.project_id
  LEFT JOIN ops_processes pr ON pr.id = t.process_id
  LEFT JOIN ops_areas ar ON ar.slug = coalesce(t.area_slug, pr.area_slug, pj.area_slug)
  LEFT JOIN ops_principals own ON own.id = t.owner_id
  LEFT JOIN ops_principals asg ON asg.id = t.assignee_id
  LEFT JOIN ops_principals cb ON cb.id = t.created_by
  LEFT JOIN ops_principals ub ON ub.id = t.updated_by
  LEFT JOIN ops_principals au ON au.id = t.authenticated_as
  LEFT JOIN ops_principals obo ON obo.id = t.on_behalf_of
  LEFT JOIN ops_principals apr ON apr.id = t.approved_by;

-- Keys and principals are never readable through PostgREST/anon roles when
-- this database also runs under Supabase.
ALTER TABLE ops_principal_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION ops_lookup_key(text) FROM PUBLIC;
