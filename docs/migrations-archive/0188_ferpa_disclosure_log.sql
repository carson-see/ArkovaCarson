-- Migration: FERPA Disclosure Log (REG-01 / SCRUM-561)
-- Section 99.32 requires maintaining a record of each disclosure of education records.
-- Fields: requesting party identity, legitimate interest, linked education records.
-- Retention: as long as the education record exists (no automatic purge).

-- Requesting party types per FERPA Section 99.31 exceptions
CREATE TYPE ferpa_party_type AS ENUM (
  'school_official',
  'employer',
  'government',
  'accreditor',
  'financial_aid',
  'research',
  'health_safety',
  'subpoena',
  'directory_info',
  'other'
);

-- FERPA Section 99.31(a) disclosure exception categories
CREATE TYPE ferpa_exception_category AS ENUM (
  '99.31(a)(1)',   -- school officials with legitimate educational interest
  '99.31(a)(2)',   -- transfer to another school
  '99.31(a)(3)',   -- financial aid
  '99.31(a)(4)',   -- studies on behalf of institution
  '99.31(a)(5)',   -- accrediting organizations
  '99.31(a)(6)',   -- state/local officials (juvenile justice)
  '99.31(a)(7)',   -- health/safety emergency
  '99.31(a)(8)',   -- sex offender info
  '99.31(a)(9)',   -- subpoena or court order
  '99.31(a)(10)',  -- directory information
  '99.31(a)(11)',  -- parent of dependent student
  '99.31(a)(12)',  -- Solomon Amendment (military recruiting)
  'other'
);

CREATE TABLE ferpa_disclosure_log (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Requesting party details
  requesting_party_name   text NOT NULL,
  requesting_party_type   ferpa_party_type NOT NULL DEFAULT 'other',
  requesting_party_org    text,  -- organization the requester represents
  -- Disclosure details
  legitimate_interest     text NOT NULL,  -- description of legitimate educational interest
  disclosure_exception    ferpa_exception_category NOT NULL DEFAULT 'other',
  -- Linked education records (anchor public_ids)
  education_record_ids    text[] NOT NULL DEFAULT '{}',
  -- Student consent / opt-out
  student_opt_out_checked boolean NOT NULL DEFAULT false,
  student_consent_obtained boolean NOT NULL DEFAULT false,
  -- API / automation context
  api_key_id              uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  verification_event_id   uuid,  -- link to verification_events if triggered by API verify
  -- Metadata
  disclosed_at            timestamptz NOT NULL DEFAULT now(),
  disclosed_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_ferpa_disclosure_org ON ferpa_disclosure_log(org_id);
CREATE INDEX idx_ferpa_disclosure_party_type ON ferpa_disclosure_log(requesting_party_type);
CREATE INDEX idx_ferpa_disclosure_exception ON ferpa_disclosure_log(disclosure_exception);
CREATE INDEX idx_ferpa_disclosure_date ON ferpa_disclosure_log(disclosed_at);
CREATE INDEX idx_ferpa_disclosure_records ON ferpa_disclosure_log USING GIN(education_record_ids);

-- RLS
ALTER TABLE ferpa_disclosure_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ferpa_disclosure_log FORCE ROW LEVEL SECURITY;

-- Org members can read their org's disclosure logs
CREATE POLICY ferpa_disclosure_select ON ferpa_disclosure_log
  FOR SELECT
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid()
      AND om.role IN ('owner', 'admin', 'compliance_officer')
    )
  );

-- Only service_role can insert (worker-only, via API or automated pipeline)
CREATE POLICY ferpa_disclosure_insert ON ferpa_disclosure_log
  FOR INSERT
  WITH CHECK (
    get_caller_role() = 'service_role'
  );

-- No updates or deletes — append-only per FERPA Section 99.32 retention requirement
-- Disclosures must be retained as long as the education record exists

COMMENT ON TABLE ferpa_disclosure_log IS 'FERPA Section 99.32 disclosure log — append-only, retained as long as education records exist';
COMMENT ON COLUMN ferpa_disclosure_log.disclosure_exception IS 'Which FERPA Section 99.31(a) subsection justifies this disclosure';
COMMENT ON COLUMN ferpa_disclosure_log.education_record_ids IS 'Array of anchor public_ids for the education records disclosed';

-- ROLLBACK:
-- DROP TABLE IF EXISTS ferpa_disclosure_log CASCADE;
-- DROP TYPE IF EXISTS ferpa_exception_category;
-- DROP TYPE IF EXISTS ferpa_party_type;
