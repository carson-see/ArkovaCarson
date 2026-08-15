-- 0414_sec_replay_missing_anon_revokes.sql
-- FD-17 / BUG-2026-08-12-005 — replay the anon/authenticated EXECUTE revokes that
--   exist ONLY in docs/migrations-archive/ and therefore never reach a freshly
--   built environment. Restores rebuilt-environment parity with prod.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.activate_user(text, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.admin_change_user_role(uuid, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.admin_set_platform_admin(uuid, boolean) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.admin_set_user_org(uuid, uuid, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.anonymize_user_data(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.can_export_user_data(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_agents_for_user(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_anchor_lineage(text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_pipeline_stats() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_user_monthly_anchor_count(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.refresh_pipeline_dashboard_cache() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.release_advisory_lock(bigint) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.set_webhook_delivery_log_public_id() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.set_webhook_endpoint_public_id() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.try_advisory_lock(bigint) TO anon, authenticated;
--   (Rollback restores the PRE-0414 rebuilt-environment state, which is the
--    INSECURE one. It exists to satisfy the rollback-rehearsal gate, not because
--    reverting is ever desirable: prod already has all sixteen revoked.)
--
-- =============================================================================
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------------------------
-- The squashed baseline `00000000000000_baseline_at_main_HEAD.sql` emits 48
-- `REVOKE ... FROM PUBLIC` statements and ZERO `REVOKE ... FROM anon` /
-- `FROM authenticated`. On Supabase that is not a revoke at all for these two
-- roles: the baseline's own
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
--     GRANT ALL ON FUNCTIONS TO "anon";        -- and "authenticated"
--
-- grants them EXECUTE **directly** at CREATE time, and `REVOKE ... FROM PUBLIC`
-- never removes a direct role grant. The real revokes for the sixteen functions
-- below live in `docs/migrations-archive/` (0061, 0062, 0160, 0170, 0173, 0179,
-- 0187, 0220, 0221, 0269, 0283, 0284, 0286), which is an ARCHIVE — it is not on
-- the replay path and never executes again.
--
-- MEASURED CONSEQUENCE (2026-08 full soak, BUG-2026-08-12-005 / FD-17): a
-- freshly built rig carried 282 anon-executable functions against prod's 262,
-- with 20 SECURITY DEFINER functions anon-callable on the rig that are correctly
-- revoked in prod — including `admin_set_platform_admin` and
-- `anonymize_user_data`. PROD IS NOT AFFECTED; the archive migrations ran there
-- historically. Every environment built from the repo since the squash IS —
-- and that includes every future soak rig, which would otherwise produce
-- evidence against a WEAKER security posture than the prod it is standing in
-- for. That is the reason this is a P1 and not housekeeping.
--
-- PARITY TARGET, VERIFIED AGAINST LIVE PROD (vzwyaatejekddvltxyye, 2026-08-15)
-- -----------------------------------------------------------------------------
-- All sixteen were confirmed `has_function_privilege('anon', oid, 'EXECUTE') =
-- false` in prod, and every signature below was taken from prod's own
-- `pg_get_function_identity_arguments` rather than from an archive file, so the
-- REVOKEs bind to functions that actually exist with these exact arities.
-- Applying this migration makes a rebuilt environment MATCH prod. It is not a
-- new security decision; it is the replay of one already made.
--
-- DELIBERATELY EXCLUDED — the `http*` family (archive 0112_security_view_invoker_ssrf).
--   That archive file also revoked extensions.http / http_get / http_post /
--   http_put / http_delete / http_head from anon+authenticated. They are NOT
--   replayed here, because the same live-prod sweep shows prod itself has every
--   `http*` function anon-executable (`anon_exec = true`, schema `extensions`).
--   Replaying 0112 would therefore make a rebuilt environment DIVERGE from prod
--   rather than match it — the opposite of this migration's purpose. They are
--   also not SECURITY DEFINER and live outside the PostgREST-exposed `public`
--   schema. Whether prod SHOULD keep them anon-executable is a real question and
--   a separate ticket; it is not a replay-parity defect and is out of scope here.
--
-- NOT DUPLICATED. Functions already revoked by a NUMBERED (replayable)
-- migration are deliberately absent: `get_treasury_stats`, `get_anchor_tx_stats`,
-- both `drain_submitted_to_secured_for_tx` arities, `claim_pending_rule_events`,
-- `complete_claimed_rule_events`, `release_claimed_rule_events` and
-- `enqueue_rule_event` are covered by 0295/0377/0378 and need nothing here.
--
-- ORDERING. This file sorts after every migration that (re)defines any of these
-- functions — notably 0392 (`get_user_monthly_anchor_count`) and 0403
-- (`anonymize_user_data`), both of which `CREATE OR REPLACE` and thereby
-- re-trigger ALTER DEFAULT PRIVILEGES. Because `CREATE OR REPLACE` re-grants,
-- the revoke must come last in the replay order, which it does. Note 0403 emits
-- a `FROM PUBLIC`-only revoke for `anonymize_user_data`, which does not close the
-- direct anon grant — this file is what closes it.
--
-- SAFETY. Grant-only: no table, column, function body, RLS policy, trigger or
-- index changes. `database.types.ts` is unaffected (ACLs are not surfaced by
-- `gen types`), so no type regeneration. No `NOTIFY pgrst, 'reload schema'` is
-- needed — no function signature or column surface changes. Idempotent: REVOKE
-- of an absent privilege is a no-op, so re-running is safe.
--
-- CALLER SAFETY. Each function below is worker-only (service_role), trigger-
-- invoked, or admin-only; `service_role` is granted/retained explicitly for
-- every one. The corresponding archive migration already made and shipped this
-- exact call-site judgement, and prod has run without these grants ever since.
-- =============================================================================

-- --- Admin / identity mutators (archive 0160, 0061, 0170) --------------------
REVOKE ALL ON FUNCTION public.activate_user(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_user(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.admin_change_user_role(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_user_role(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_platform_admin(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_platform_admin(uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_user_org(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_org(uuid, uuid, text) TO service_role;

-- --- GDPR / data-subject surface (archive 0061, 0170, 0187) ------------------
REVOKE ALL ON FUNCTION public.anonymize_user_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_user_data(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.can_export_user_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_export_user_data(uuid) TO service_role;

-- --- Destructive / maintenance jobs (archive 0062) ---------------------------
REVOKE ALL ON FUNCTION public.cleanup_expired_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO service_role;

-- --- Identity-scoped readers (archive 0220, 0221, 0286) ----------------------
REVOKE ALL ON FUNCTION public.get_agents_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_agents_for_user(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_anchor_lineage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_anchor_lineage(text) TO service_role;

REVOKE ALL ON FUNCTION public.get_user_monthly_anchor_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_monthly_anchor_count(uuid) TO service_role;

-- --- Internal stats / cache refreshers (archive 0173, 0283) ------------------
REVOKE ALL ON FUNCTION public.get_pipeline_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pipeline_stats() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_pipeline_dashboard_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pipeline_dashboard_cache() TO service_role;

-- --- Advisory-lock primitives (archive 0179) ---------------------------------
REVOKE ALL ON FUNCTION public.try_advisory_lock(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_advisory_lock(bigint) TO service_role;

REVOKE ALL ON FUNCTION public.release_advisory_lock(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_advisory_lock(bigint) TO service_role;

-- --- Webhook public_id trigger functions (archive 0284) ----------------------
-- Trigger-invoked; the trigger system does not need a caller EXECUTE grant.
REVOKE ALL ON FUNCTION public.set_webhook_delivery_log_public_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_webhook_delivery_log_public_id() TO service_role;

REVOKE ALL ON FUNCTION public.set_webhook_endpoint_public_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_webhook_endpoint_public_id() TO service_role;
