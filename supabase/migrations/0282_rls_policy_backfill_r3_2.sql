-- Migration 0282: SCRUM-1275 (R3-2) — RLS policy backfill (service_role explicit)
--
-- The original SCRUM-1275 ticket flagged 24 tables with `ENABLE + FORCE RLS`
-- and zero policies. After 2026-04-21 → 2026-04-28 RLS work, only three
-- remain in that state (verified via `pg_class` join `pg_policies` MCP query
-- 2026-04-29):
--
--     drive_folder_path_cache  (0251 / SCRUM-1169 — Drive folder path cache)
--     kyb_webhook_nonces       (0250 / SCRUM-1162 — Middesk replay protection)
--     parent_split_tokens      (0252 / SCRUM-1167 — sub-org rollover tokens)
--
-- Why they work today: `service_role` has `BYPASSRLS = true`, so FORCE RLS
-- without a policy still permits service_role I/O. That is a fragile coupling
-- — if the role attribute were ever rotated or revoked (Supabase sometimes
-- adjusts these), every worker write to these tables would silently fail.
-- The Supabase advisor `policy_exists_rls_disabled` and the SCRUM-1208
-- ultrareview both flag this as defense-in-depth gap.
--
-- Fix: add an explicit `FOR ALL TO service_role USING (true) WITH CHECK (true)`
-- policy on each. Frontend reads remain blocked (no authenticated/anon
-- policy added — these tables are worker-only by design).
--
-- ROLLBACK:
--   DROP POLICY drive_folder_path_cache_service_role ON drive_folder_path_cache;
--   DROP POLICY kyb_webhook_nonces_service_role ON kyb_webhook_nonces;
--   DROP POLICY parent_split_tokens_service_role ON parent_split_tokens;
--   (Reverts to BYPASSRLS-only access — same runtime behavior, fragile coupling restored.)

CREATE POLICY drive_folder_path_cache_service_role
  ON drive_folder_path_cache
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON POLICY drive_folder_path_cache_service_role ON drive_folder_path_cache IS
  'SCRUM-1275 (R3-2): explicit service_role policy. Frontend never reads this cache; '
  'callers go through services/worker resolveDriveFolderPath which uses service_role.';

CREATE POLICY kyb_webhook_nonces_service_role
  ON kyb_webhook_nonces
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON POLICY kyb_webhook_nonces_service_role ON kyb_webhook_nonces IS
  'SCRUM-1275 (R3-2): explicit service_role policy. Worker-only writes from '
  'middesk + docusign webhook handlers for replay-protection nonce storage.';

CREATE POLICY parent_split_tokens_service_role
  ON parent_split_tokens
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON POLICY parent_split_tokens_service_role ON parent_split_tokens IS
  'SCRUM-1275 (R3-2): explicit service_role policy. Tokens looked up by hash '
  'via service_role only in the Phase 3b sub-org rollover flow.';

-- Defensive verification: zero tables in public schema may have FORCE RLS without
-- at least one policy after this migration.
DO $$
DECLARE
  bad_count int;
  bad_list text;
BEGIN
  WITH rls_no_policy AS (
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
  )
  SELECT count(*), string_agg(relname, ', ' ORDER BY relname)
    INTO bad_count, bad_list
  FROM rls_no_policy;

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'SCRUM-1275: % tables still RLS-enabled without policy: %', bad_count, bad_list;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
