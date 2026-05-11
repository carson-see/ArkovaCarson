-- 0299_validate_api_key_rpc.sql
-- Jira: SCRUM-1793 (MCP edge endpoint /mcp returns 401 because validate_api_key RPC missing)
-- Applied to prod (vzwyaatejekddvltxyye) + staging (ujtlwnoqfhtitcmsnrpq) on 2026-05-08 via Supabase MCP.
--
-- Purpose: Implements the validate_api_key(p_api_key text) RPC that the
--          edge MCP server (services/edge/src/mcp-server.ts) calls to
--          authenticate X-API-Key headers. Edge sends raw key; RPC HMACs
--          it with the API_KEY_HMAC_SECRET (read from a private settings
--          row), looks up the matching api_keys row, and returns the
--          shape the edge expects: user_id, tier, api_key_id, scopes.
--
--          Failure mode: any path that can't compute the HMAC (missing
--          secret) returns NULL (auth fails closed). Service_role is
--          the only role that can EXECUTE this function; PostgREST
--          exposes it via /rpc/validate_api_key only when called with
--          the service-role key (which is what the edge worker sends).
--
-- Spec: https://arkova.atlassian.net/browse/SCRUM-1793

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS public.validate_api_key(text);
-- DROP TABLE IF EXISTS private.api_key_settings;
-- DROP SCHEMA IF EXISTS private;

-- Private schema for operator-only secrets. RLS isn't enough here — we
-- want the table itself to be invisible to anon + authenticated roles.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

-- Single-row settings table holding the API_KEY_HMAC_SECRET. The edge
-- worker has the same secret in arkova1 GCP Secret Manager; this row
-- is what the SECURITY DEFINER RPC reads when it computes HMACs.
CREATE TABLE IF NOT EXISTS private.api_key_settings (
  id boolean PRIMARY KEY DEFAULT true,
  hmac_secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_key_settings_singleton CHECK (id = true)
);
REVOKE ALL ON TABLE private.api_key_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE private.api_key_settings TO service_role;

-- The RPC. SECURITY DEFINER so callers don't need to read private.*.
-- search_path is locked to public + private + pg_temp so a malicious
-- caller can't shadow tables (CLAUDE.md §1.4 mandate).
CREATE OR REPLACE FUNCTION public.validate_api_key(p_api_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
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

  -- Compute HMAC-SHA256 to match the worker's hash format
  -- (services/worker/src/utils/apiKeys.ts and the prod data already in
  -- api_keys.key_hash).
  v_hash := encode(extensions.hmac(p_api_key::bytea, v_secret::bytea, 'sha256'), 'hex');

  -- Look up the active key.
  SELECT
    ak.id AS api_key_id,
    ak.created_by AS user_id,
    ak.rate_limit_tier AS tier,
    ak.scopes AS scopes
  INTO v_row
  FROM api_keys ak
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

REVOKE ALL ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;

COMMENT ON FUNCTION public.validate_api_key(text) IS
  'SCRUM-1793: edge MCP auth. HMACs the raw key with private.api_key_settings.hmac_secret '
  'and returns {user_id, tier, api_key_id, scopes} for the matching active api_keys row, '
  'or NULL if no match / missing secret / inactive key. Service-role only.';

NOTIFY pgrst, 'reload schema';
