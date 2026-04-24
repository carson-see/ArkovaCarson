-- Migration 0187: Data subject rights request log (REG-11 / SCRUM-572)
CREATE TABLE IF NOT EXISTS data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  request_type text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
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

CREATE INDEX IF NOT EXISTS idx_data_subject_requests_user_id ON data_subject_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_type ON data_subject_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_requested_at ON data_subject_requests(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_export_recent ON data_subject_requests(user_id, completed_at DESC)
  WHERE request_type = 'export' AND status = 'completed';

COMMENT ON TABLE data_subject_requests IS 'REG-11: audit log of every data subject rights request (GDPR Art. 15-18, Kenya DPA s. 31)';

ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_subject_requests_select_own ON data_subject_requests;
CREATE POLICY data_subject_requests_select_own
  ON data_subject_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS data_subject_requests_insert_own ON data_subject_requests;
CREATE POLICY data_subject_requests_insert_own
  ON data_subject_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION can_export_user_data(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM data_subject_requests
    WHERE user_id = p_user_id
      AND request_type = 'export'
      AND status = 'completed'
      AND completed_at > now() - interval '24 hours'
  );
$$;

REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION can_export_user_data(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION can_export_user_data(uuid) TO service_role;;
