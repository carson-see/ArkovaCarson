-- 0382_scrum2535_validate_api_key_expiry_and_revocation.sql
-- SCRUM-2535 — `validate_api_key` ignored `api_keys.expires_at`, so an EXPIRED
--   API key still authenticated on the edge MCP path.
--
-- =============================================================================
-- THE BUG, MEASURED AGAINST LIVE PROD (vzwyaatejekddvltxyye, 2026-08-01)
--
--   SELECT count(*) FILTER (WHERE is_active AND expires_at <= now()) FROM api_keys;
--   -> 11 of 18 active keys were ALREADY PAST their expires_at and still
--      authenticating. Earliest expiry 2026-04-27, i.e. keys that expired
--      three months ago were still valid credentials.
--
-- The pre-0382 body selected:
--     WHERE ak.key_hash = v_hash AND ak.is_active = true
-- `expires_at` and `revoked_at` were never consulted. Setting an expiry on a
-- key was therefore decorative on this path — the column was written by the
-- key-issuance flow and read by nobody.
--
-- WHY IT ONLY BIT THE EDGE PATH (asymmetry, verified in source this session):
--   * services/worker/src/middleware/apiKeyAuth.ts:189 does its own expiry
--     check in TypeScript (`if (apiKey.expires_at && new Date(...) < new Date())`)
--     and rejects correctly. The Cloud Run worker was never vulnerable.
--   * services/edge/src/mcp-server.ts:781 (`validateApiKey`) delegates
--     ENTIRELY to this RPC and performs no expiry check of its own — it treats
--     any non-null JSON result as a valid caller. edge.arkova.ai is a separate
--     Cloudflare Worker, so the worker's guard does not protect it.
--   The RPC is the single chokepoint both paths share, so fixing it here fixes
--   the edge without shipping a second, drift-prone copy of the rule.
--
-- FIX: add the two missing predicates, fail-closed:
--     AND (ak.expires_at IS NULL OR ak.expires_at > now())   -- NULL = no expiry
--     AND ak.revoked_at IS NULL                              -- defense in depth
--
--   `expires_at IS NULL` continues to mean "never expires" — that is the
--   existing issuance contract (7 of 18 prod keys rely on a future expiry, 3
--   have none at all), so this is not a behavior change for non-expiring keys.
--
--   `revoked_at IS NULL` is belt-and-braces. Today prod is consistent (the one
--   revoked key also has is_active = false), so this predicate changes nothing
--   right now; it exists so that a future code path which stamps `revoked_at`
--   without also clearing `is_active` cannot silently leave a revoked key live.
--
-- BLAST RADIUS, MEASURED (prod, 2026-08-01): 18 keys validate today; 7 still
--   validate after this change; 11 are newly rejected, all of them because they
--   are expired (0 are rejected purely by the new revoked_at predicate).
--
--   All 11 look like development artifacts by name — "test", "Testing Dev",
--   "Testing Dev #3", "SDK Test", "PR 1412", "PR 1413", "PR 1415", "PR 1443",
--   "1471", "fadf", "Arkova Key" — and all 11 have last_used_at IS NULL.
--
--   HONEST CAVEAT on that NULL: `last_used_at` is written ONLY by the worker
--   path (services/worker/src/middleware/apiKeyAuth.ts:210, fire-and-forget);
--   this RPC never writes it. So NULL proves the key was never used against the
--   Cloud Run worker — it does NOT prove it was never used against the edge MCP
--   path, which is precisely the vulnerable path. Treat "never used" as strong
--   circumstantial evidence (reinforced by the names), not proof.
--
--   Enumerate before applying, and re-run at apply time since expiry is
--   time-dependent and more keys may have lapsed since this was written:
--     SELECT id, key_prefix, name, org_id, expires_at, last_used_at
--     FROM api_keys
--     WHERE is_active AND revoked_at IS NULL AND expires_at <= now()
--     ORDER BY expires_at;
--
--   If any row in that list is a real integration at apply time, re-issue it or
--   clear its expires_at BEFORE applying. This migration is intentionally
--   apply-gated on that check rather than silently cutting live callers.
--
-- NOT CHANGED (deliberately): the returned JSON shape, the function signature,
--   SECURITY DEFINER, `SET search_path = public`, and the grants
--   (postgres + service_role only — verified via aclexplode this session; anon
--   and authenticated already hold no EXECUTE, so this function is not part of
--   the 0377/0378 revoke surface). `CREATE OR REPLACE` preserves all of it.
--
-- Tier: T3 (touches supabase/migrations/ and an authentication path).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.validate_api_key(p_api_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret text;
  v_hash text;
  v_row record;
BEGIN
  -- Fail-closed: empty/null key, no auth.
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
  WHERE ak.key_hash = v_hash
    AND ak.is_active = true
    -- SCRUM-2535: an expired key is not a credential. NULL expires_at keeps
    -- its existing meaning of "never expires".
    AND (ak.expires_at IS NULL OR ak.expires_at > now())
    -- Defense in depth: never authenticate a key stamped as revoked, even if
    -- some future write path forgets to also flip is_active.
    AND ak.revoked_at IS NULL
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
$function$;

-- Grants are preserved by CREATE OR REPLACE; restated here so the intended
-- end state is explicit and auditable rather than inherited implicitly.
REVOKE ALL ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;

-- PostgREST caches the function catalog; reload so the edge MCP path picks up
-- the new body immediately (CLAUDE.md "Common Mistakes").
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
--   Restores the exact pre-0382 body (no expiry / revocation predicates).
--   NOTE: rolling back re-opens SCRUM-2535 — expired keys authenticate again
--   on the edge MCP path. Only do this to unblock a production incident.
--
--   BEGIN;
--   CREATE OR REPLACE FUNCTION public.validate_api_key(p_api_key text)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE
--     v_secret text;
--     v_hash text;
--     v_row record;
--   BEGIN
--     IF p_api_key IS NULL OR length(p_api_key) = 0 THEN
--       RETURN NULL;
--     END IF;
--
--     SELECT hmac_secret INTO v_secret FROM private.api_key_settings WHERE id = true;
--     IF v_secret IS NULL THEN
--       RETURN NULL;
--     END IF;
--
--     v_hash := encode(extensions.hmac(p_api_key::bytea, v_secret::bytea, 'sha256'), 'hex');
--
--     SELECT
--       ak.id AS api_key_id,
--       ak.created_by AS user_id,
--       ak.rate_limit_tier AS tier,
--       ak.scopes AS scopes
--     INTO v_row
--     FROM public.api_keys ak
--     WHERE ak.key_hash = v_hash AND ak.is_active = true
--     LIMIT 1;
--
--     IF NOT FOUND THEN
--       RETURN NULL;
--     END IF;
--
--     RETURN jsonb_build_object(
--       'user_id', v_row.user_id,
--       'tier', v_row.tier,
--       'api_key_id', v_row.api_key_id,
--       'scopes', v_row.scopes
--     );
--   END;
--   $function$;
--   REVOKE ALL ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
