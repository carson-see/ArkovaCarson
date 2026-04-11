-- Migration: 0186_data_subject_requests.sql
-- Description: Data subject rights request log (REG-11 / SCRUM-572)
--              Durable audit record of every access/correction/erasure/restriction
--              request under GDPR Art. 15/16/17/18, Kenya DPA s. 31, Australia APP 12,
--              South Africa POPIA s. 23, Nigeria NDPA.
--              Required by GDPR Art. 30 (records of processing activities) and the
--              equivalent Kenya DPA Part VI recordkeeping obligation.
-- Rollback: DROP TABLE IF EXISTS data_subject_requests; DROP FUNCTION IF EXISTS can_export_user_data(uuid);

-- ═══════════════════════════════════════════════════════════════════
-- Table: data_subject_requests
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Requester — references profiles, cascade on delete so erasure requests
  -- also remove the record of the request itself (the user's right to be
  -- forgotten extends to the metadata of their forgotten-ness request).
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- What kind of right is being exercised
  request_type text NOT NULL,

  -- Workflow state
  status text NOT NULL DEFAULT 'processing',

  -- Timestamps
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,

  -- Opaque detail payload (e.g. requested field for correction, rejection reason)
  details jsonb NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT data_subject_requests_type_valid CHECK (
    request_type IN ('export', 'correction', 'erasure', 'restriction', 'portability')
  ),
  CONSTRAINT data_subject_requests_status_valid CHECK (
    status IN ('processing', 'completed', 'rejected', 'failed')
  ),
  CONSTRAINT data_subject_requests_completed_when_done CHECK (
    (status IN ('processing') AND completed_at IS NULL) OR
    (status IN ('completed', 'rejected', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_data_subject_requests_user_id ON data_subject_requests(user_id);
CREATE INDEX idx_data_subject_requests_type ON data_subject_requests(request_type);
CREATE INDEX idx_data_subject_requests_requested_at ON data_subject_requests(requested_at DESC);
-- Critical for the 24h rate-limit query: latest completed export per user
CREATE INDEX idx_data_subject_requests_export_recent ON data_subject_requests(user_id, completed_at DESC)
  WHERE request_type = 'export' AND status = 'completed';

COMMENT ON TABLE data_subject_requests IS 'REG-11: audit log of every data subject rights request (GDPR Art. 15-18, Kenya DPA s. 31)';
COMMENT ON COLUMN data_subject_requests.request_type IS 'Type of right exercised: export, correction, erasure, restriction, portability';
COMMENT ON COLUMN data_subject_requests.status IS 'Workflow state: processing, completed, rejected, failed';
COMMENT ON COLUMN data_subject_requests.details IS 'Opaque JSONB — may contain requested field, rejection reason, export row counts, etc.';

-- ═══════════════════════════════════════════════════════════════════
-- RLS: users can SELECT and INSERT their own rows only
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY data_subject_requests_select_own
  ON data_subject_requests
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY data_subject_requests_insert_own
  ON data_subject_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE is worker-only (service_role bypasses RLS) — authenticated users
-- cannot rewrite request state. No explicit policy = deny.
-- DELETE is prevented entirely (RLS + no policy). Cascade from profiles
-- handles the erasure case via the FK on user_id.

-- ═══════════════════════════════════════════════════════════════════
-- Function: can_export_user_data(p_user_id)
-- Enforces the REG-11 acceptance criterion "rate limited to 1 export per
-- 24 hours". Returns true if no completed export exists for this user
-- within the past 24h, false otherwise.
-- Called by the worker before allowing a new export.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION can_export_user_data(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM data_subject_requests
    WHERE user_id = p_user_id
      AND request_type = 'export'
      AND status = 'completed'
      AND completed_at > now() - interval '24 hours'
  );
$$;

COMMENT ON FUNCTION can_export_user_data(uuid) IS 'REG-11: returns false if user has already exported within the last 24 hours';

-- Service role only — called by worker middleware, not by the authenticated client
REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION can_export_user_data(uuid) TO service_role;
