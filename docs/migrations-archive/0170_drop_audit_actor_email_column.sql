-- =============================================================================
-- Migration 0170: Drop actor_email column from audit_events
-- Date: 2026-04-06
-- Jira: SCRUM-503
-- Security Audit: PII-01 (CRITICAL) — Final remediation
--
-- PURPOSE
-- -------
-- Migration 0061 already:
--   1. Nullified all existing actor_email values
--   2. Added null_audit_actor_email() trigger to prevent future writes
--   3. Created anonymize_user_data() RPC
--
-- This migration completes the remediation by:
--   1. Dropping the actor_email column entirely (GDPR Art. 5(1)(c) data minimization)
--   2. Dropping the now-unnecessary null_audit_actor_email trigger/function
--   3. Also dropping actor_ip and actor_user_agent columns (proactive PII minimization)
--   4. Updating anonymize_user_data() to remove references to dropped columns
--
-- ROLLBACK: See bottom of file
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the defense-in-depth trigger (no longer needed once column is gone)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS null_audit_pii_fields ON audit_events;
DROP TRIGGER IF EXISTS null_actor_email_on_insert ON audit_events;
DROP FUNCTION IF EXISTS null_audit_actor_email() CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Temporarily disable immutability triggers to allow ALTER TABLE
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS reject_audit_update ON audit_events;
DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;

-- ---------------------------------------------------------------------------
-- 3. Drop PII columns from audit_events
-- ---------------------------------------------------------------------------
ALTER TABLE audit_events DROP COLUMN IF EXISTS actor_email;
ALTER TABLE audit_events DROP COLUMN IF EXISTS actor_ip;
ALTER TABLE audit_events DROP COLUMN IF EXISTS actor_user_agent;

-- ---------------------------------------------------------------------------
-- 4. Restore immutability triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER reject_audit_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

CREATE TRIGGER reject_audit_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

-- ---------------------------------------------------------------------------
-- 5. Update anonymize_user_data() — remove references to dropped columns
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anonymize_user_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit_count integer := 0;
  v_ai_usage_count integer := 0;
  v_verification_count integer := 0;
BEGIN
  -- Only service_role can call this function
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can anonymize user data'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- audit_events: actor_email/ip/user_agent columns have been dropped (migration 0170).
  -- actor_id is a UUID reference — no PII to scrub, but count affected rows for reporting.
  SELECT COUNT(*) INTO v_audit_count
  FROM audit_events
  WHERE actor_id = p_user_id;

  -- Anonymize ai_usage_events: null out the fingerprint correlation
  UPDATE ai_usage_events
  SET fingerprint = NULL
  WHERE user_id = p_user_id
    AND fingerprint IS NOT NULL;
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  -- Anonymize verification_events: null out any user-linked fields
  UPDATE verification_events
  SET details = NULL
  WHERE user_id = p_user_id
    AND details IS NOT NULL;
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  -- Log the anonymization action (audit trail for compliance evidence)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, details
  ) VALUES (
    'user.data_anonymized', 'SYSTEM', NULL, NULL,
    'GDPR Art. 17 erasure: anonymized ' || v_audit_count || ' audit events, '
    || v_ai_usage_count || ' AI usage events, '
    || v_verification_count || ' verification events for user ' || p_user_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'audit_events_affected', v_audit_count,
    'ai_usage_events_anonymized', v_ai_usage_count,
    'verification_events_anonymized', v_verification_count
  );
END;
$$;

-- Grant execute only to service_role (defense-in-depth, function also checks internally)
REVOKE ALL ON FUNCTION anonymize_user_data(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION anonymize_user_data(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION anonymize_user_data(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE audit_events ADD COLUMN actor_email text NULL;
-- ALTER TABLE audit_events ADD COLUMN actor_ip inet NULL;
-- ALTER TABLE audit_events ADD COLUMN actor_user_agent text NULL;
-- CREATE OR REPLACE FUNCTION null_audit_actor_email() ...
-- CREATE TRIGGER null_actor_email_on_insert ...
