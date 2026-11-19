-- OpsBrain CRM: companies, contacts, a deal pipeline and activities, inside the system of record.
--
-- Activities (calls, emails, meetings) are ordinary OpsBrain records of type 'activity', so they get
-- attribution, history, search and the PARA mirror for free. Any record (proposal, contract, invoice,
-- meeting note, task card) can point at a company, contact or deal.
--
-- Rules enforced here, whatever client writes the data:
--   * Only an active person with approval rights can clear or decline an employer-boundary screen.
--   * A deal cannot enter a screened stage while its company's screen is pending or declined.
--   * Only an active person with approval rights can mark a deal won.

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  domain text CHECK (domain IS NULL OR domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  website text,
  industry text,
  size_band text CHECK (size_band IS NULL OR size_band IN ('1-9', '10-49', '50-99', '100-249', '250-999', '1000+')),
  phone text,
  city text,
  region text,
  country text,
  lifecycle text NOT NULL DEFAULT 'prospect'
    CHECK (lifecycle IN ('prospect', 'lead', 'opportunity', 'client', 'former_client', 'partner', 'vendor', 'disqualified')),
  source text,
  screen_status text NOT NULL DEFAULT 'not_needed' CHECK (screen_status IN ('not_needed', 'pending', 'cleared', 'declined')),
  screen_note text,
  screened_by uuid REFERENCES ops_principals(id),
  screened_at timestamptz,
  owner_id uuid REFERENCES ops_principals(id),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at timestamptz,
  created_by uuid REFERENCES ops_principals(id),
  updated_by uuid REFERENCES ops_principals(id),
  authenticated_as uuid REFERENCES ops_principals(id),
  on_behalf_of uuid REFERENCES ops_principals(id),
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_companies_domain_key ON crm_companies (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_companies_name_idx ON crm_companies (lower(name));
CREATE INDEX IF NOT EXISTS crm_companies_lifecycle_idx ON crm_companies (lifecycle) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Contacts (business contacts only; candidates belong in restricted hiring records)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES crm_companies(id) ON DELETE SET NULL,
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  job_title text,
  email text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  linkedin_url text,
  consent text NOT NULL DEFAULT 'unknown' CHECK (consent IN ('unknown', 'opted_in', 'opted_out')),
  consent_at timestamptz,
  consent_source text,
  do_not_contact boolean NOT NULL DEFAULT false,
  owner_id uuid REFERENCES ops_principals(id),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at timestamptz,
  created_by uuid REFERENCES ops_principals(id),
  updated_by uuid REFERENCES ops_principals(id),
  authenticated_as uuid REFERENCES ops_principals(id),
  on_behalf_of uuid REFERENCES ops_principals(id),
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_email_key ON crm_contacts (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_contacts_company_idx ON crm_contacts (company_id);
CREATE INDEX IF NOT EXISTS crm_contacts_name_idx ON crm_contacts (lower(full_name));

-- ---------------------------------------------------------------------------
-- Pipeline stages (rename or replace them with a seed file)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  probability integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  is_won boolean NOT NULL DEFAULT false,
  is_lost boolean NOT NULL DEFAULT false,
  gate_screen boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  description text,
  CHECK (NOT (is_won AND is_lost))
);

INSERT INTO crm_pipeline_stages (slug, name, sort_order, probability, is_won, is_lost, gate_screen, description) VALUES
  ('lead',        'Lead',        10,  10, false, false, false, 'A possible buyer, not yet qualified'),
  ('qualified',   'Qualified',   20,  25, false, false, false, 'Need, budget, authority and timing confirmed'),
  ('meeting',     'Meeting',     30,  40, false, false, true,  'Discovery or scoping under way'),
  ('proposal',    'Proposal',    40,  60, false, false, true,  'Proposal sent'),
  ('negotiation', 'Negotiation', 50,  75, false, false, true,  'Terms being agreed'),
  ('won',         'Won',         90, 100, true,  false, true,  'Signed'),
  ('lost',        'Lost',        95,   0, false, true,  false, 'Closed without a sale')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  company_id uuid NOT NULL REFERENCES crm_companies(id),
  primary_contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  stage text NOT NULL REFERENCES crm_pipeline_stages(slug),
  service_line text,
  amount numeric(12, 2) CHECK (amount IS NULL OR amount >= 0),
  recurring_monthly numeric(12, 2) CHECK (recurring_monthly IS NULL OR recurring_monthly >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  probability integer CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  expected_close date,
  source text,
  next_step text,
  next_step_due date,
  lost_reason text,
  project_id text REFERENCES ops_projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  owner_id uuid REFERENCES ops_principals(id),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  last_activity_at timestamptz,
  created_by uuid REFERENCES ops_principals(id),
  updated_by uuid REFERENCES ops_principals(id),
  authenticated_as uuid REFERENCES ops_principals(id),
  on_behalf_of uuid REFERENCES ops_principals(id),
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_deals_company_idx ON crm_deals (company_id);
CREATE INDEX IF NOT EXISTS crm_deals_stage_idx ON crm_deals (stage) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_deals_owner_idx ON crm_deals (owner_id);

-- ---------------------------------------------------------------------------
-- History of every CRM change (records keep theirs in ops_record_events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_events (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('company', 'contact', 'deal')),
  entity_id uuid NOT NULL,
  actor_id uuid REFERENCES ops_principals(id),
  authenticated_as uuid REFERENCES ops_principals(id),
  action text NOT NULL CHECK (action IN ('create', 'update', 'stage', 'screen', 'archive', 'unarchive', 'comment')),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_events_entity_idx ON crm_events (entity_type, entity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Links from records and projects
-- ---------------------------------------------------------------------------
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS crm_company_id uuid REFERENCES crm_companies(id) ON DELETE SET NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS crm_contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS crm_deal_id uuid REFERENCES crm_deals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS thoughts_crm_company_idx ON thoughts (crm_company_id) WHERE crm_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thoughts_crm_contact_idx ON thoughts (crm_contact_id) WHERE crm_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thoughts_crm_deal_idx ON thoughts (crm_deal_id) WHERE crm_deal_id IS NOT NULL;

ALTER TABLE ops_projects ADD COLUMN IF NOT EXISTS crm_company_id uuid REFERENCES crm_companies(id) ON DELETE SET NULL;

INSERT INTO ops_record_types (slug, name, folder, para_default, terminal_statuses, description) VALUES
  ('activity', 'Activity', 'Activities', 'area', '{}', 'A call, email, meeting or note with a CRM contact: a summary, never full email bodies')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_touch()
RETURNS TRIGGER AS $$
BEGIN
  -- Logging an activity only moves last_activity_at; that must not bump the version people edit against.
  IF (to_jsonb(NEW) - ARRAY['last_activity_at', 'updated_at', 'version'])
     = (to_jsonb(OLD) - ARRAY['last_activity_at', 'updated_at', 'version']) THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_companies_touch ON crm_companies;
CREATE TRIGGER crm_companies_touch BEFORE UPDATE ON crm_companies FOR EACH ROW EXECUTE FUNCTION crm_touch();
DROP TRIGGER IF EXISTS crm_contacts_touch ON crm_contacts;
CREATE TRIGGER crm_contacts_touch BEFORE UPDATE ON crm_contacts FOR EACH ROW EXECUTE FUNCTION crm_touch();
DROP TRIGGER IF EXISTS crm_deals_touch ON crm_deals;
CREATE TRIGGER crm_deals_touch BEFORE UPDATE ON crm_deals FOR EACH ROW EXECUTE FUNCTION crm_touch();

CREATE OR REPLACE FUNCTION crm_is_approver(p uuid)
RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM ops_principals WHERE id = p AND active AND can_approve AND kind = 'human');
$$ LANGUAGE sql STABLE;

-- Employer-boundary and other screens: anyone may flag a company (pending); only an approver decides.
CREATE OR REPLACE FUNCTION crm_enforce_screen()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.screen_status IN ('cleared', 'declined')
     AND (TG_OP = 'INSERT' OR OLD.screen_status IS DISTINCT FROM NEW.screen_status) THEN
    IF NOT crm_is_approver(NEW.screened_by) THEN
      RAISE EXCEPTION 'Only an active person with approval rights can clear or decline a screen'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.screened_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_companies_screen ON crm_companies;
CREATE TRIGGER crm_companies_screen BEFORE INSERT OR UPDATE ON crm_companies FOR EACH ROW EXECUTE FUNCTION crm_enforce_screen();

CREATE OR REPLACE FUNCTION crm_enforce_deal_stage()
RETURNS TRIGGER AS $$
DECLARE
  st crm_pipeline_stages%ROWTYPE;
  screen text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.stage IS NOT DISTINCT FROM NEW.stage AND OLD.company_id IS NOT DISTINCT FROM NEW.company_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO st FROM crm_pipeline_stages WHERE slug = NEW.stage;
  SELECT screen_status INTO screen FROM crm_companies WHERE id = NEW.company_id;
  IF st.gate_screen AND screen IN ('pending', 'declined') THEN
    RAISE EXCEPTION 'This company''s screen is %; it must be cleared before the deal can move to %', screen, st.name
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR OLD.stage IS DISTINCT FROM NEW.stage THEN
    IF st.is_won AND NOT crm_is_approver(NEW.updated_by) THEN
      RAISE EXCEPTION 'Only an active person with approval rights can mark a deal won'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.stage_changed_at := now();
    NEW.closed_at := CASE WHEN st.is_won OR st.is_lost THEN now() ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_deals_stage ON crm_deals;
CREATE TRIGGER crm_deals_stage BEFORE INSERT OR UPDATE ON crm_deals FOR EACH ROW EXECUTE FUNCTION crm_enforce_deal_stage();

-- ---------------------------------------------------------------------------
-- Readable views
-- ---------------------------------------------------------------------------
-- The records view gains the CRM links (recreated because its column list changes).
DROP VIEW IF EXISTS ops_records;
CREATE VIEW ops_records AS
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
       au.handle AS authenticated_as, obo.handle AS on_behalf_of, apr.handle AS approved_by,
       t.crm_company_id, cc.name AS crm_company_name, t.crm_contact_id, ct.full_name AS crm_contact_name,
       t.crm_deal_id, dl.name AS crm_deal_name
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
  LEFT JOIN ops_principals apr ON apr.id = t.approved_by
  LEFT JOIN crm_companies cc ON cc.id = t.crm_company_id
  LEFT JOIN crm_contacts ct ON ct.id = t.crm_contact_id
  LEFT JOIN crm_deals dl ON dl.id = t.crm_deal_id;

CREATE OR REPLACE VIEW crm_deals_view AS
SELECT d.id, d.name, d.company_id, c.name AS company_name, c.screen_status AS company_screen_status,
       d.primary_contact_id, ct.full_name AS primary_contact_name, d.stage, s.name AS stage_name,
       s.sort_order AS stage_order, s.is_won, s.is_lost, coalesce(d.probability, s.probability) AS probability,
       d.probability AS probability_override,
       d.service_line, d.amount, d.recurring_monthly, d.currency, d.expected_close, d.source, d.next_step,
       d.next_step_due, d.lost_reason, d.project_id, d.owner_id, o.handle AS owner, d.tags, d.notes, d.fields,
       d.stage_changed_at, d.closed_at, d.last_activity_at, cb.handle AS created_by, ub.handle AS updated_by,
       d.version, d.archived_at, d.created_at, d.updated_at
  FROM crm_deals d
  JOIN crm_companies c ON c.id = d.company_id
  JOIN crm_pipeline_stages s ON s.slug = d.stage
  LEFT JOIN crm_contacts ct ON ct.id = d.primary_contact_id
  LEFT JOIN ops_principals o ON o.id = d.owner_id
  LEFT JOIN ops_principals cb ON cb.id = d.created_by
  LEFT JOIN ops_principals ub ON ub.id = d.updated_by;

-- ---------------------------------------------------------------------------
-- Browser sessions for the web UI (raw session ids are never stored)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_ui_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  principal_id uuid NOT NULL REFERENCES ops_principals(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
CREATE INDEX IF NOT EXISTS ops_ui_sessions_expiry_idx ON ops_ui_sessions (expires_at);
ALTER TABLE ops_ui_sessions ENABLE ROW LEVEL SECURITY;
