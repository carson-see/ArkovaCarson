-- Migration 0188: FERPA Disclosure Log (REG-01 / SCRUM-561)
DO $$ BEGIN
  CREATE TYPE ferpa_party_type AS ENUM (
    'school_official','employer','government','accreditor','financial_aid',
    'research','health_safety','subpoena','directory_info','other'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ferpa_exception_category AS ENUM (
    '99.31(a)(1)','99.31(a)(2)','99.31(a)(3)','99.31(a)(4)','99.31(a)(5)',
    '99.31(a)(6)','99.31(a)(7)','99.31(a)(8)','99.31(a)(9)','99.31(a)(10)',
    '99.31(a)(11)','99.31(a)(12)','other'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS ferpa_disclosure_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requesting_party_name text NOT NULL,
  requesting_party_type ferpa_party_type NOT NULL DEFAULT 'other',
  requesting_party_org text,
  legitimate_interest text NOT NULL,
  disclosure_exception ferpa_exception_category NOT NULL DEFAULT 'other',
  education_record_ids text[] NOT NULL DEFAULT '{}',
  student_opt_out_checked boolean NOT NULL DEFAULT false,
  student_consent_obtained boolean NOT NULL DEFAULT false,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  verification_event_id uuid,
  disclosed_at timestamptz NOT NULL DEFAULT now(),
  disclosed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ferpa_disclosure_org ON ferpa_disclosure_log(org_id);
CREATE INDEX IF NOT EXISTS idx_ferpa_disclosure_party_type ON ferpa_disclosure_log(requesting_party_type);
CREATE INDEX IF NOT EXISTS idx_ferpa_disclosure_exception ON ferpa_disclosure_log(disclosure_exception);
CREATE INDEX IF NOT EXISTS idx_ferpa_disclosure_date ON ferpa_disclosure_log(disclosed_at);
CREATE INDEX IF NOT EXISTS idx_ferpa_disclosure_records ON ferpa_disclosure_log USING GIN(education_record_ids);

ALTER TABLE ferpa_disclosure_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ferpa_disclosure_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ferpa_disclosure_select ON ferpa_disclosure_log;
CREATE POLICY ferpa_disclosure_select ON ferpa_disclosure_log FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
      AND om.role IN ('owner', 'admin', 'compliance_officer')
  ));

DROP POLICY IF EXISTS ferpa_disclosure_insert ON ferpa_disclosure_log;
CREATE POLICY ferpa_disclosure_insert ON ferpa_disclosure_log FOR INSERT
  WITH CHECK (get_caller_role() = 'service_role');;
