-- 0303_validate_api_key_rpc_hardening.sql
-- Jira: SCRUM-1793 follow-up (CodeRabbit PR #741 review, comment 1 + 2)
--
-- Purpose: compensating migration for 0299_validate_api_key_rpc.sql.
--   1. Enable + force RLS on private.api_key_settings with a service_role-only
--      policy (idempotent — safe if 0302 already ran these).
--   2. Replace public.validate_api_key with search_path = public (no private,
--      no pg_temp) per CLAUDE.md §1.4 mandate. All private-schema references
--      are already fully qualified.

-- ROLLBACK:
-- DROP POLICY IF EXISTS api_key_settings_service_role_all ON private.api_key_settings;
-- ALTER TABLE private.api_key_settings DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE private.api_key_settings NO FORCE ROW LEVEL SECURITY;
-- -- To revert the function search_path, replay 0299.

-- ── 1. RLS on private.api_key_settings ──────────────────────────────────
ALTER TABLE private.api_key_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.api_key_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_settings_service_role_all ON private.api_key_settings;
CREATE POLICY api_key_settings_service_role_all
  ON private.api_key_settings
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 2. Tighten SECURITY DEFINER search_path to public only ─────────────
CREATE OR REPLACE FUNCTION public.validate_api_key(p_api_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
  v_hash text;
  v_row record;
BEGIN
  -- Fail-closed: empty/null key, no auth.
  IF p_api_key IS NULL OR length(p_api_key) = 0 THEN
    RETURN NULL;
  END IF;

  -- Read the secret. If the settings row is missing, we can't HMAC,
  -- so we return NULL (auth fails closed) rather than risk a wrong hash.
  SELECT hmac_secret INTO v_secret FROM private.api_key_settings WHERE id = true;
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  -- Compute HMAC-SHA256 to match the worker's hash format.
  v_hash := encode(extensions.hmac(p_api_key::bytea, v_secret::bytea, 'sha256'), 'hex');

  -- Look up the active key.
  SELECT
    ak.id AS api_key_id,
    ak.created_by AS user_id,
    ak.rate_limit_tier AS tier,
    ak.scopes AS scopes
  INTO v_row
  FROM public.api_keys ak
  WHERE ak.key_hash = v_hash AND ak.is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Shape the edge worker expects (mcp-server.ts validateApiKey()).
  RETURN jsonb_build_object(
    'user_id', v_row.user_id,
    'tier', v_row.tier,
    'api_key_id', v_row.api_key_id,
    'scopes', v_row.scopes
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
