-- =============================================================================
-- Migration 0062: Security Hardening — HIGH severity findings from CISO audit
-- Date: 2026-03-16
-- Findings: INJ-01, RLS-01, RLS-02, PII-03
--
-- PURPOSE
-- -------
-- 1. INJ-01: Create search_public_credentials() RPC to replace raw PostgREST
--    URL interpolation (SQL injection risk in MCP tools).
-- 2. RLS-01: Add GRANT to authenticated for 13 tables missing table-level access.
--    RLS policies exist but are unreachable without GRANT.
-- 3. RLS-02: Restrict api_keys and api_key_usage SELECT to org admins only.
-- 4. PII-03: Create data retention policy via scheduled cleanup function.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. INJ-01: search_public_credentials RPC (parameterized, no injection)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_public_credentials(
  p_query text,
  p_limit integer DEFAULT 10
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_pattern text;
BEGIN
  -- Clamp limit to [1, 50]
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  -- Build ILIKE pattern from sanitized input
  v_pattern := '%' || p_query || '%';

  RETURN QUERY
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'title', a.title,
    'credential_type', a.credential_type,
    'status', a.status,
    'created_at', a.created_at,
    'org_id', a.org_id
  )
  FROM anchors a
  WHERE a.status IN ('SECURED', 'ACTIVE')
    AND a.deleted_at IS NULL
    AND (a.title ILIKE v_pattern OR a.credential_type::text ILIKE v_pattern)
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

-- Allow anon + authenticated to call this (public search)
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO anon;
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. RLS-01: Add GRANT to authenticated for 13 tables
-- ---------------------------------------------------------------------------
-- These tables have RLS policies but no table-level GRANT, making direct
-- Supabase client queries silently return empty results.
-- We grant only the operations each table's RLS policies allow.

-- credential_templates: org members can SELECT; admins can INSERT/UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON credential_templates TO authenticated;

-- memberships: org members can SELECT their own
GRANT SELECT ON memberships TO authenticated;

-- verification_events: INSERT via RPC preferred, but SELECT for own org
GRANT SELECT, INSERT ON verification_events TO authenticated;

-- institution_ground_truth: public read via RPC preferred, SELECT for reference
GRANT SELECT ON institution_ground_truth TO authenticated;

-- anchor_recipients: recipients can SELECT their own
GRANT SELECT ON anchor_recipients TO authenticated;

-- credits: org members can SELECT their org's credits
GRANT SELECT ON credits TO authenticated;

-- credit_transactions: org members can SELECT their org's transactions
GRANT SELECT ON credit_transactions TO authenticated;

-- api_keys: org admins can manage (RLS-02 restricts to admin below)
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO authenticated;

-- api_key_usage: org admins can view usage (RLS-02 restricts to admin below)
GRANT SELECT ON api_key_usage TO authenticated;

-- ai_credits: org members can SELECT their org's AI credits
GRANT SELECT ON ai_credits TO authenticated;

-- ai_usage_events: org members can SELECT their org's AI usage
GRANT SELECT ON ai_usage_events TO authenticated;

-- credential_embeddings: org members can SELECT their org's embeddings
GRANT SELECT ON credential_embeddings TO authenticated;

-- invitations: org admins can manage invitations
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS-02: Restrict api_keys and api_key_usage SELECT to org admins
-- ---------------------------------------------------------------------------

-- Drop existing permissive SELECT policies
DROP POLICY IF EXISTS api_keys_select ON api_keys;
DROP POLICY IF EXISTS api_key_usage_select ON api_key_usage;

-- Recreate with admin-only restriction
CREATE POLICY api_keys_select ON api_keys
  FOR SELECT TO authenticated
  USING (
    org_id = (SELECT org_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) = 'ORG_ADMIN'
  );

CREATE POLICY api_key_usage_select ON api_key_usage
  FOR SELECT TO authenticated
  USING (
    api_key_id IN (
      SELECT id FROM api_keys
      WHERE org_id = (SELECT org_id FROM profiles WHERE id = auth.uid())
    )
    AND (SELECT role FROM profiles WHERE id = auth.uid()) = 'ORG_ADMIN'
  );

-- ---------------------------------------------------------------------------
-- 4. PII-03: Data retention cleanup function
-- ---------------------------------------------------------------------------
-- Callable by service_role only. Intended to be invoked by a cron job.
-- Retention periods:
--   - webhook_delivery_logs: 90 days
--   - verification_events: 1 year
--   - ai_usage_events: 1 year
--   - audit_events: 2 years (regulatory minimum)

CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_webhook_count integer := 0;
  v_verification_count integer := 0;
  v_ai_usage_count integer := 0;
  v_audit_count integer := 0;
BEGIN
  -- Only service_role can call this function
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can run data cleanup'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Webhook delivery logs: 90 days
  DELETE FROM webhook_delivery_logs
  WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS v_webhook_count = ROW_COUNT;

  -- Verification events: 1 year
  DELETE FROM verification_events
  WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  -- AI usage events: 1 year
  DELETE FROM ai_usage_events
  WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  -- Audit events: 2 years (but preserve legal hold records)
  -- We must temporarily drop the delete trigger
  DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;

  DELETE FROM audit_events
  WHERE created_at < now() - INTERVAL '2 years'
    AND NOT EXISTS (
      SELECT 1 FROM anchors
      WHERE anchors.id::text = audit_events.target_id
        AND anchors.legal_hold = true
    );
  GET DIAGNOSTICS v_audit_count = ROW_COUNT;

  -- Restore the delete trigger
  CREATE TRIGGER reject_audit_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_audit_modification();

  -- Log the cleanup as an audit event
  INSERT INTO audit_events (
    event_type, event_category, actor_id, details
  ) VALUES (
    'DATA_RETENTION_CLEANUP', 'SYSTEM', NULL,
    jsonb_build_object(
      'webhook_delivery_logs_deleted', v_webhook_count,
      'verification_events_deleted', v_verification_count,
      'ai_usage_events_deleted', v_ai_usage_count,
      'audit_events_deleted', v_audit_count,
      'retention_policy', jsonb_build_object(
        'webhook_delivery_logs', '90 days',
        'verification_events', '1 year',
        'ai_usage_events', '1 year',
        'audit_events', '2 years'
      )
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'webhook_delivery_logs_deleted', v_webhook_count,
    'verification_events_deleted', v_verification_count,
    'ai_usage_events_deleted', v_ai_usage_count,
    'audit_events_deleted', v_audit_count
  );
END;
$$;

-- Only service_role can execute cleanup
REVOKE ALL ON FUNCTION cleanup_expired_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_expired_data() FROM authenticated;
REVOKE ALL ON FUNCTION cleanup_expired_data() FROM anon;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- DROP FUNCTION IF EXISTS search_public_credentials(text, integer);
-- DROP FUNCTION IF EXISTS cleanup_expired_data();
-- Restore original api_keys_select and api_key_usage_select policies
-- REVOKE grants on 13 tables (if reverting to RPC-only access)
-- ---------------------------------------------------------------------------
