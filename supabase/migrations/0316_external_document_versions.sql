-- SCRUM-1969: External Document Versions + Version Reviews
-- Part of SCRUM-1126 (Version Control & Conflict Detection)
--
-- PURPOSE
-- -------
-- Tracks document versions detected from external integrations (Google Drive,
-- DocuSign, Microsoft 365, local uploads). When a rule engine match detects a
-- new fingerprint for a previously-anchored external_file_id, a version row is
-- created with status 'pending_review' instead of automatically anchoring.
-- Org admins then approve/skip/flag the version via version_reviews.
--
-- ROLLBACK: DROP TABLE version_reviews; DROP TABLE external_document_versions;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ══════════════════════════════════════════════════════════════════════════════
-- Table: external_document_versions
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.external_document_versions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  external_file_id text NOT NULL,
  source text NOT NULL,  -- 'google_drive', 'docusign', 'microsoft_365', 'local'
  fingerprint text NOT NULL,
  version_number integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending_review',
  anchor_id uuid REFERENCES public.anchors(id),
  metadata jsonb DEFAULT '{}'::jsonb,
  detected_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT external_document_versions_status_check
    CHECK (status IN ('pending_review', 'approved', 'skipped', 'flagged')),
  CONSTRAINT external_document_versions_unique_version
    UNIQUE (org_id, external_file_id, fingerprint)
);

ALTER TABLE public.external_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_document_versions FORCE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════════
-- Table: version_reviews
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.version_reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES public.external_document_versions(id),
  reviewer_id uuid NOT NULL REFERENCES auth.users(id),
  decision text NOT NULL,
  notes text,
  reviewed_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT version_reviews_decision_check
    CHECK (decision IN ('approve', 'skip', 'flag'))
);

ALTER TABLE public.version_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.version_reviews FORCE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_edv_org_status
  ON public.external_document_versions(org_id, status);

CREATE INDEX IF NOT EXISTS idx_edv_external_file
  ON public.external_document_versions(org_id, external_file_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS Policies: external_document_versions
-- ══════════════════════════════════════════════════════════════════════════════

-- Service role: full access (worker writes version rows)
DROP POLICY IF EXISTS edv_service_all ON public.external_document_versions;
CREATE POLICY edv_service_all ON public.external_document_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Org members: SELECT their org's version records
DROP POLICY IF EXISTS edv_org_select ON public.external_document_versions;
CREATE POLICY edv_org_select ON public.external_document_versions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = external_document_versions.org_id
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS Policies: version_reviews
-- ══════════════════════════════════════════════════════════════════════════════

-- Service role: full access
DROP POLICY IF EXISTS vr_service_all ON public.version_reviews;
CREATE POLICY vr_service_all ON public.version_reviews
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Org members: SELECT reviews for versions in their org
DROP POLICY IF EXISTS vr_org_select ON public.version_reviews;
CREATE POLICY vr_org_select ON public.version_reviews
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.external_document_versions edv
      JOIN org_members om ON om.org_id = edv.org_id
      WHERE edv.id = version_reviews.version_id
        AND om.user_id = (SELECT auth.uid())
    )
  );

-- Org members: INSERT reviews for versions in their org
DROP POLICY IF EXISTS vr_org_insert ON public.version_reviews;
CREATE POLICY vr_org_insert ON public.version_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.external_document_versions edv
      JOIN org_members om ON om.org_id = edv.org_id
      WHERE edv.id = version_reviews.version_id
        AND om.user_id = (SELECT auth.uid())
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- Grants
-- ══════════════════════════════════════════════════════════════════════════════

GRANT ALL ON public.external_document_versions TO service_role;
GRANT ALL ON public.version_reviews TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
