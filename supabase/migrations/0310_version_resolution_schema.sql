-- SCRUM-1969: Version resolution data model for document re-anchoring.
--
-- When a connector-sourced document changes (new fingerprint for same external_file_id),
-- the system creates a version record and routes to admin review before anchoring.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS version_reviews;
--   DROP TABLE IF EXISTS external_document_versions;
--   DROP TYPE IF EXISTS version_resolution_status;

-- Extend notification_type enum for version resolution notifications
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'document.version_conflict';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'document.auto_queued';

-- Status enum for version tracking
CREATE TYPE version_resolution_status AS ENUM (
  'pending_review',
  'approved',
  'skipped',
  'flagged'
);

-- Tracks each version of a connector-sourced document within an org
CREATE TABLE IF NOT EXISTS public.external_document_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  external_file_id text NOT NULL,
  fingerprint character(64) NOT NULL,
  source text NOT NULL,
  version_number integer NOT NULL DEFAULT 1,
  filename text,
  status version_resolution_status NOT NULL DEFAULT 'pending_review',
  detected_at timestamptz NOT NULL DEFAULT now(),
  trigger_event_id uuid,
  anchor_id uuid REFERENCES public.anchors(id) ON DELETE SET NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT edv_external_file_id_length CHECK (char_length(external_file_id) >= 1 AND char_length(external_file_id) <= 500),
  CONSTRAINT edv_fingerprint_format CHECK (fingerprint ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT edv_source_length CHECK (char_length(source) >= 1 AND char_length(source) <= 50),
  CONSTRAINT edv_filename_length CHECK (filename IS NULL OR char_length(filename) <= 500),
  CONSTRAINT edv_version_positive CHECK (version_number >= 1),
  CONSTRAINT edv_metadata_is_object CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object')
);

-- Unique constraint: same org + file + fingerprint = same version (no duplicates)
CREATE UNIQUE INDEX idx_edv_org_file_fingerprint
  ON public.external_document_versions (org_id, external_file_id, fingerprint);

-- Fast lookup: pending reviews per org
CREATE INDEX idx_edv_org_pending
  ON public.external_document_versions (org_id, status, created_at DESC)
  WHERE status = 'pending_review';

-- Fast lookup: all versions of a specific file within an org
CREATE INDEX idx_edv_org_file_versions
  ON public.external_document_versions (org_id, external_file_id, version_number DESC);

ALTER TABLE ONLY public.external_document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_document_versions OWNER TO postgres;

COMMENT ON TABLE public.external_document_versions IS
  'Tracks versions of connector-sourced documents. Multiple versions of the same external_file_id route to admin review before anchoring.';

-- RLS: org members can read their org's versions
CREATE POLICY "edv_select_org_member"
  ON public.external_document_versions
  FOR SELECT TO authenticated
  USING (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
  ));

-- RLS: only admin/owner can insert (service_role bypasses for worker)
CREATE POLICY "edv_insert_admin"
  ON public.external_document_versions
  FOR INSERT TO authenticated
  WITH CHECK (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ));

-- RLS: only admin/owner can update status
CREATE POLICY "edv_update_admin"
  ON public.external_document_versions
  FOR UPDATE TO authenticated
  USING (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ))
  WITH CHECK (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ));

-- ============================================================================
-- version_reviews: admin decisions on version conflicts
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.version_reviews (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES public.external_document_versions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL,
  notes text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT vr_decision_valid CHECK (decision IN ('approve', 'skip', 'flag')),
  CONSTRAINT vr_notes_length CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

-- One review per version (last decision wins)
CREATE UNIQUE INDEX idx_vr_version_unique
  ON public.version_reviews (version_id);

-- Lookup by reviewer
CREATE INDEX idx_vr_reviewer
  ON public.version_reviews (reviewer_id, reviewed_at DESC);

-- Org-based lookups
CREATE INDEX idx_vr_org_reviewed
  ON public.version_reviews (org_id, reviewed_at DESC);

ALTER TABLE ONLY public.version_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.version_reviews OWNER TO postgres;

COMMENT ON TABLE public.version_reviews IS
  'Admin decisions on document version conflicts. Each version can have at most one review (latest decision wins).';

-- RLS: org members can read reviews in their org
CREATE POLICY "vr_select_org_member"
  ON public.version_reviews
  FOR SELECT TO authenticated
  USING (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
  ));

-- RLS: only admin/owner can insert reviews
CREATE POLICY "vr_insert_admin"
  ON public.version_reviews
  FOR INSERT TO authenticated
  WITH CHECK (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ));

-- RLS: only admin/owner can update (e.g., amend notes)
CREATE POLICY "vr_update_admin"
  ON public.version_reviews
  FOR UPDATE TO authenticated
  USING (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ))
  WITH CHECK (org_id IN (
    SELECT org_members.org_id FROM public.org_members
    WHERE org_members.user_id = (SELECT auth.uid())
    AND org_members.role = ANY(ARRAY['owner'::public.org_member_role, 'admin'::public.org_member_role])
  ));

-- updated_at trigger for external_document_versions
CREATE OR REPLACE FUNCTION update_edv_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_edv_updated_at
  BEFORE UPDATE ON public.external_document_versions
  FOR EACH ROW
  EXECUTE FUNCTION update_edv_updated_at();

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
