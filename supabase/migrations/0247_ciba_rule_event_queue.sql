-- Migration 0247: CIBA — durable rule event queue + claim RPCs
--
-- PURPOSE
-- -------
-- Unblocks ARK-106 / ARK-107 by providing the queue and RPCs expected by
-- services/worker/src/jobs/rules-engine.ts. Custom rules need a generic
-- trigger-event substrate; connector-specific stories can enqueue into this
-- table without changing the rules engine.
--
-- JIRA: SCRUM-1018, SCRUM-1019, SCRUM-1134
-- EPIC: SCRUM-1010 CIBA
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS release_claimed_rule_events(UUID[], TEXT);
--   DROP FUNCTION IF EXISTS complete_claimed_rule_events(UUID[]);
--   DROP FUNCTION IF EXISTS claim_pending_rule_events(INTEGER);
--   DROP FUNCTION IF EXISTS enqueue_rule_event(UUID, org_rule_trigger_type, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
--   DROP TABLE IF EXISTS organization_rule_events;
--   DROP TYPE IF EXISTS org_rule_event_status;

-- =============================================================================
-- 1. Event status enum
-- =============================================================================

CREATE TYPE org_rule_event_status AS ENUM (
  'PENDING',
  'CLAIMED',
  'PROCESSED',
  'FAILED'
);

-- =============================================================================
-- 2. organization_rule_events table
-- =============================================================================

CREATE TABLE organization_rule_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  trigger_type        org_rule_trigger_type NOT NULL,
  vendor              TEXT,
  external_file_id    TEXT,
  filename            TEXT,
  folder_path         TEXT,
  sender_email        TEXT,
  subject             TEXT,

  -- Sanitized routing metadata only. Raw document bodies / raw webhook
  -- payloads stay out of this table.
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,

  status              org_rule_event_status NOT NULL DEFAULT 'PENDING',
  claim_id            UUID,
  claimed_at          TIMESTAMPTZ,
  processed_at        TIMESTAMPTZ,
  attempt_count       SMALLINT NOT NULL DEFAULT 0,
  error               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT organization_rule_events_vendor_length
    CHECK (vendor IS NULL OR char_length(vendor) BETWEEN 1 AND 50),
  CONSTRAINT organization_rule_events_external_file_id_length
    CHECK (external_file_id IS NULL OR char_length(external_file_id) BETWEEN 1 AND 500),
  CONSTRAINT organization_rule_events_filename_length
    CHECK (filename IS NULL OR char_length(filename) <= 500),
  CONSTRAINT organization_rule_events_folder_path_length
    CHECK (folder_path IS NULL OR char_length(folder_path) <= 2000),
  CONSTRAINT organization_rule_events_sender_email_length
    CHECK (sender_email IS NULL OR char_length(sender_email) <= 320),
  CONSTRAINT organization_rule_events_subject_length
    CHECK (subject IS NULL OR char_length(subject) <= 500),
  CONSTRAINT organization_rule_events_payload_size
    CHECK (pg_column_size(payload) <= 16384),
  CONSTRAINT organization_rule_events_error_length
    CHECK (error IS NULL OR char_length(error) <= 4000),
  CONSTRAINT organization_rule_events_claim_consistency
    CHECK (
      (status = 'CLAIMED' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL) OR
      (status <> 'CLAIMED')
    )
);

CREATE INDEX idx_organization_rule_events_pending
  ON organization_rule_events(status, created_at)
  WHERE status IN ('PENDING', 'CLAIMED');

CREATE INDEX idx_organization_rule_events_org_trigger_created
  ON organization_rule_events(org_id, trigger_type, created_at DESC);

CREATE INDEX idx_organization_rule_events_external_file
  ON organization_rule_events(org_id, external_file_id, created_at DESC)
  WHERE external_file_id IS NOT NULL;

COMMENT ON TABLE organization_rule_events IS
  'Durable sanitized trigger-event queue for org-defined custom rules. Claimed by ARK-106 rules-engine worker.';

ALTER TABLE organization_rule_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_rule_events FORCE ROW LEVEL SECURITY;

GRANT SELECT ON organization_rule_events TO authenticated;
GRANT ALL ON organization_rule_events TO service_role;

CREATE POLICY organization_rule_events_select ON organization_rule_events
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Inserts / updates are service-role only. Public connector routes must go
-- through the worker so HMAC, replay, and vendor gates run before enqueue.

-- =============================================================================
-- 3. enqueue_rule_event(...) — service-role enqueue helper
-- =============================================================================

CREATE OR REPLACE FUNCTION enqueue_rule_event(
  p_org_id UUID,
  p_trigger_type org_rule_trigger_type,
  p_vendor TEXT DEFAULT NULL,
  p_external_file_id TEXT DEFAULT NULL,
  p_filename TEXT DEFAULT NULL,
  p_folder_path TEXT DEFAULT NULL,
  p_sender_email TEXT DEFAULT NULL,
  p_subject TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO organization_rule_events (
    org_id, trigger_type, vendor, external_file_id, filename, folder_path,
    sender_email, subject, payload
  ) VALUES (
    p_org_id, p_trigger_type, NULLIF(trim(p_vendor), ''),
    NULLIF(trim(p_external_file_id), ''), NULLIF(trim(p_filename), ''),
    NULLIF(trim(p_folder_path), ''),
    CASE
      WHEN p_sender_email IS NULL THEN NULL
      ELSE NULLIF(lower(trim(p_sender_email)), '')
    END,
    NULLIF(trim(p_subject), ''),
    COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION enqueue_rule_event(UUID, org_rule_trigger_type, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_rule_event(UUID, org_rule_trigger_type, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_rule_event(UUID, org_rule_trigger_type, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;

-- =============================================================================
-- 4. claim_pending_rule_events(limit)
-- =============================================================================

CREATE OR REPLACE FUNCTION claim_pending_rule_events(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  trigger_type org_rule_trigger_type,
  vendor TEXT,
  external_file_id TEXT,
  filename TEXT,
  folder_path TEXT,
  sender_email TEXT,
  subject TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  -- Recover worker crashes / deploy interruptions. Attempt count is preserved
  -- so repeatedly failing events eventually park in FAILED by release RPC.
  UPDATE organization_rule_events e
  SET status = 'PENDING'::org_rule_event_status,
      claim_id = NULL,
      claimed_at = NULL,
      error = COALESCE(e.error, 'Recovered stale CLAIMED event')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count < 5;

  UPDATE organization_rule_events e
  SET status = 'FAILED'::org_rule_event_status,
      claim_id = NULL,
      error = COALESCE(e.error, 'Rule event exceeded max claim attempts')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count >= 5;

  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM organization_rule_events q
    WHERE q.status = 'PENDING'
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE organization_rule_events q
    SET status = 'CLAIMED'::org_rule_event_status,
        claim_id = gen_random_uuid(),
        claimed_at = now(),
        attempt_count = q.attempt_count + 1,
        error = NULL
    FROM picked
    WHERE q.id = picked.id
    RETURNING
      q.id, q.org_id, q.trigger_type, q.vendor, q.external_file_id,
      q.filename, q.folder_path, q.sender_email, q.subject
  )
  SELECT
    claimed.id, claimed.org_id, claimed.trigger_type, claimed.vendor,
    claimed.external_file_id, claimed.filename, claimed.folder_path,
    claimed.sender_email, claimed.subject
  FROM claimed
  ORDER BY claimed.id;
END;
$$;

REVOKE ALL ON FUNCTION claim_pending_rule_events(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_rule_events(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_pending_rule_events(INTEGER) TO service_role;

-- =============================================================================
-- 5. complete / release helpers
-- =============================================================================

CREATE OR REPLACE FUNCTION complete_claimed_rule_events(p_event_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE organization_rule_events q
  SET status = 'PROCESSED'::org_rule_event_status,
      processed_at = now(),
      claim_id = NULL,
      error = NULL
  WHERE q.id = ANY(COALESCE(p_event_ids, ARRAY[]::UUID[]))
    AND q.status = 'CLAIMED';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_claimed_rule_events(
  p_event_ids UUID[],
  p_error TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE organization_rule_events q
  SET status = CASE
        WHEN q.attempt_count >= 5 THEN 'FAILED'::org_rule_event_status
        ELSE 'PENDING'::org_rule_event_status
      END,
      claim_id = NULL,
      claimed_at = NULL,
      error = LEFT(COALESCE(p_error, 'Released after rules-engine failure'), 4000)
  WHERE q.id = ANY(COALESCE(p_event_ids, ARRAY[]::UUID[]))
    AND q.status = 'CLAIMED';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION complete_claimed_rule_events(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_claimed_rule_events(UUID[]) FROM authenticated;
REVOKE ALL ON FUNCTION release_claimed_rule_events(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_claimed_rule_events(UUID[], TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_claimed_rule_events(UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION release_claimed_rule_events(UUID[], TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
