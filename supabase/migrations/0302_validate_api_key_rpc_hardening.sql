-- 0302_validate_api_key_rpc_hardening.sql
-- Jira: SCRUM-1793 follow-up (CodeRabbit PR #741 review)
-- Applied to prod (vzwyaatejekddvltxyye) + staging (ujtlwnoqfhtitcmsnrpq) on 2026-05-08 via Supabase MCP.
--
-- Purpose: defense-in-depth on the validate_api_key plumbing.
--   1. Enable + force RLS on private.api_key_settings with an explicit
--      service_role policy so access is intentional and auditable
--      (CLAUDE.md §1.4 mandate even though the table is in `private`).
--   2. Tighten the SECURITY DEFINER function's search_path to public + pg_temp
--      only so any unqualified table reference would fail loud rather than
--      resolving to a shadowed table on the caller's path.

-- ROLLBACK:
-- DROP POLICY IF EXISTS api_key_settings_service_role_policy ON private.api_key_settings;
-- ALTER TABLE private.api_key_settings DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE private.api_key_settings NO FORCE ROW LEVEL SECURITY;
-- (function search_path revert is in 0299; replay that file to revert)

ALTER TABLE private.api_key_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.api_key_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_settings_service_role_policy ON private.api_key_settings;
CREATE POLICY api_key_settings_service_role_policy
  ON private.api_key_settings
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Re-deploy validate_api_key with tightened search_path (public + pg_temp only).
-- All refs to private.* are explicit schema-qualified, so dropping
-- `private` from search_path doesn't break anything; it does prevent any
-- future unqualified reference from accidentally resolving to a shadowed
-- table.
CREATE OR REPLACE FUNCTION public.validate_api_key(p_api_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_secret text;
  v_hash text;
  v_row record;
BEGIN
  IF p_api_key IS NULL OR length(p_api_key) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT hmac_secret INTO v_secret FROM private.api_key_settings WHERE id = true;
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  v_hash := encode(extensions.hmac(p_api_key::bytea, v_secret::bytea, 'sha256'), 'hex');

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

  RETURN jsonb_build_object(
    'user_id', v_row.user_id,
    'tier', v_row.tier,
    'api_key_id', v_row.api_key_id,
    'scopes', v_row.scopes
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
