-- Migration 0280: SCRUM-1275 (R3-2) — RLS policy backfill for 5 worker-only tables
--
-- Background. Tables with ENABLE + FORCE ROW LEVEL SECURITY but NO policy
-- silently deny-all to non-service_role callers. This is correct behavior
-- when the table really is worker-only, but it's invisible to readers and
-- one missed policy on a future table can lock out a legitimate browser
-- read path with no audit trail. Migration 0275 (AUDIT-07 / SCRUM-1188)
-- handled the empty-policy tables flagged by the Supabase advisor at the
-- time; this migration handles the remaining 5 surfaced by SCRUM-1275's
-- bare-RLS audit (`scripts/ci/check-rls-policy-coverage.ts`).
--
-- Tables remediated here:
--   webhook_idempotency          — Stripe / external webhook dedup keys
--   activation_tokens            — invite-flow token store
--   kyb_webhook_nonces           — Persona / KYB webhook nonces
--   drive_folder_path_cache      — Google Drive folder→path map
--   parent_split_tokens          — billing-rollover token store
--
-- Each is worker-only — written by service_role from cron / API handlers,
-- never directly read by the browser. Pattern matches 0275: explicit
-- deny-all-for-users policy. service_role bypasses RLS regardless, so
-- worker code is unaffected. The policies trip the
-- `rls_enabled_no_policy` advisor finding from ERROR to clean.
--
-- IF EXISTS guards keep this migration idempotent across environments
-- where these tables may have been replaced or dropped (e.g. the
-- 0236-style queue-cleanup pattern that 0275 had to defend against).
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS webhook_idempotency_no_user_access ON public.webhook_idempotency;
--   DROP POLICY IF EXISTS activation_tokens_no_user_access ON public.activation_tokens;
--   DROP POLICY IF EXISTS kyb_webhook_nonces_no_user_access ON public.kyb_webhook_nonces;
--   DROP POLICY IF EXISTS drive_folder_path_cache_no_user_access ON public.drive_folder_path_cache;
--   DROP POLICY IF EXISTS parent_split_tokens_no_user_access ON public.parent_split_tokens;

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'webhook_idempotency') THEN
    EXECUTE $POL$
      CREATE POLICY webhook_idempotency_no_user_access
        ON public.webhook_idempotency
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'activation_tokens') THEN
    EXECUTE $POL$
      CREATE POLICY activation_tokens_no_user_access
        ON public.activation_tokens
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'kyb_webhook_nonces') THEN
    EXECUTE $POL$
      CREATE POLICY kyb_webhook_nonces_no_user_access
        ON public.kyb_webhook_nonces
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'drive_folder_path_cache') THEN
    EXECUTE $POL$
      CREATE POLICY drive_folder_path_cache_no_user_access
        ON public.drive_folder_path_cache
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'parent_split_tokens') THEN
    EXECUTE $POL$
      CREATE POLICY parent_split_tokens_no_user_access
        ON public.parent_split_tokens
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
