-- 0378_sec_recon_revoke_deferred_security_definer_grants.sql
-- SEC-RECON emergency follow-up to 0377 (#1652) — revokes anon/authenticated
--   EXECUTE from the remainder of the unguarded/worker-only SECURITY DEFINER
--   RPC surface that 0377 explicitly deferred (see 0377's "ADDITIONAL
--   UNGUARDED SECURITY DEFINER FUNCTIONS FOUND THIS SESSION" section).
--
-- TRIGGER: live confirmation that an unauthenticated POST /rpc/bulk_promote_confirmed
--   returned HTTP 200 against a prod-mirror soak rig. Verified against LIVE
--   PROD (vzwyaatejekddvltxyye) this session via pg_proc/pg_get_functiondef +
--   ACL introspection (aclexplode) and pg_trigger cross-checks, and against
--   the current worker/frontend source tree via targeted grep for every
--   candidate function name (rpc('<name>' call sites in src/ and
--   services/worker/src/, plus a broader unquoted sweep to catch indirect
--   references). Every REVOKE below was confirmed to have NO authenticated
--   browser call site; every KEPT authenticated grant has either a confirmed
--   src/ call site or a self-guarding auth.uid()+RAISE EXCEPTION body with no
--   caller-supplied identity-bypass argument.
--
-- CLASSIFICATION SUMMARY (full table in PR description):
--   REVOKE  -> service_role only  : 50 functions (worker-only queue/claim
--     internals, chain-state mutators with no auth check, credit/billing
--     mutators with arbitrary org/user targets, audit/orphan destructive ops)
--   LEAVE   -> trigger functions   : 19 functions (invoked by the trigger
--     system, not by callers; EXECUTE grants on these are not attacker-
--     reachable via PostgREST RPC in a way that matters — confirmed via
--     pg_trigger.tgfoid cross-reference)
--   KEEP    -> public by design    : 27 functions on the explicit public
--     verification/registry/RLS-helper allowlist (unchanged)
--   KEEP    -> authenticated, real caller or self-guard : ~25 functions
--     (confirmed src/ call site with auth.uid()-gated body, or fully
--     self-scoped with no arbitrary-identity argument)
--
-- NOT REVOKED, NOTED FOR FOLLOW-UP (out of scope for this emergency grant
--   fix — revoking would break the live dashboard with no soak time to
--   validate a body-level fix in the same change):
--   get_org_anchor_stats(uuid) / get_user_anchor_stats(uuid) — real frontend
--     caller (src/lib/dashboardStats.ts) but the function body does not
--     visibly gate the caller-supplied p_org_id/p_user_id against auth.uid().
--     Recommend a follow-up ticket to add an ownership check in the function
--     body (defense in depth) rather than touching the grant here.
--
-- ---------------------------------------------------------------------------
-- Two overloaded pairs below split cleanly along the 0367
-- (worker_rpc_caller_identity_supersede_queue_resolve) pattern: a
-- self-guarding auth.uid()-checked overload for a real/future authenticated
-- caller (kept), and a p_caller_user_id overload added for the worker's
-- service_role client, where auth.uid() is always NULL (revoked to
-- service_role — worker already has service_role, needs no anon/authenticated
-- grant on the explicit-identity overload):
--   resolve_anchor_queue_by_public_id(text,text,text) KEPT / (text,text,text,uuid) REVOKED
--   supersede_anchor(uuid,text,text) KEPT / (uuid,text,text,uuid) REVOKED
-- drain_submitted_to_secured_for_tx has no self-guarding overload at all
-- (neither the 4-arg nor 7-arg form checks auth.uid()) — both REVOKED.
-- ---------------------------------------------------------------------------
--
-- ROLLBACK:
--   -- Restore anon,authenticated EXECUTE on every function REVOKEd below.
--   -- (Full restoration statements — grouped by function for reviewability.)
--   GRANT EXECUTE ON FUNCTION public.archive_old_audit_events(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.link_recipient_on_signup(uuid, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_anchors() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.check_orphaned_anchors() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer, integer, integer, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.bulk_promote_confirmed(text[]) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.link_public_records_to_anchors(jsonb) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.refresh_stats_cache() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.refresh_stats_materialized_views() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.refresh_cache_anchor_tx_stats() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.verify_anchors_rls_enabled() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_next_job(text, timestamptz) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_due_org_queue_runs(timestamptz, text, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_pending_rule_events(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.complete_claimed_rule_events(uuid[]) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.release_claimed_rule_events(uuid[], text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.enqueue_rule_event(uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.record_msgraph_nonce_and_enqueue(text, text, text, text, uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.increment_org_usage(uuid, text, bigint) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.clear_payment_grace(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.start_payment_grace(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.expire_payment_grace_if_due() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.suspend_suborg(uuid, uuid, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.unsuspend_suborg(uuid, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.start_kyb_verification(uuid, text, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_treasury_stats() TO anon, authenticated; -- anon rechecked/added after rig-test drift found (rig had anon=X where prod only had authenticated=X; revoke is symmetric across both to be robust to environment drift)
--   GRANT EXECUTE ON FUNCTION public.get_recent_cron_failures(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_table_bloat_stats(text[]) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_unembedded_public_records(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_pending_user_anchors(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.list_pending_resolution_anchors(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.list_pending_resolution_anchors_v2(integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.supersede_anchor(uuid, text, text, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.search_credential_embeddings(uuid, vector, double precision, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_anchor_status_counts_fast() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_edgar_shard_counts() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_extraction_accuracy(text, uuid, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_anchor_backlog_stats() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_org_credit_summary(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.check_ai_credits(uuid, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.check_unified_credits(uuid, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.check_anchor_quota() TO anon, authenticated;
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CRITICAL: chain-state forgery / destruction (no auth.uid() check in any of these)
REVOKE ALL ON FUNCTION public.archive_old_audit_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_audit_events(integer) TO service_role;

REVOKE ALL ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.link_recipient_on_signup(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_recipient_on_signup(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_orphaned_anchors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_anchors() TO service_role;

REVOKE ALL ON FUNCTION public.check_orphaned_anchors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_orphaned_anchors() TO service_role;

REVOKE ALL ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, integer, timestamptz, integer, integer, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.bulk_promote_confirmed(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_promote_confirmed(text[]) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.link_public_records_to_anchors(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_public_records_to_anchors(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_stats_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_stats_cache() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_stats_materialized_views() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_stats_materialized_views() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_cache_anchor_tx_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_anchor_tx_stats() TO service_role;

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO service_role;

REVOKE ALL ON FUNCTION public.verify_anchors_rls_enabled() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_anchors_rls_enabled() TO service_role;

-- Worker-only queue/claim internals
REVOKE ALL ON FUNCTION public.claim_next_job(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_due_org_queue_runs(timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_org_queue_runs(timestamptz, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_rule_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_rule_events(integer) TO service_role;

REVOKE ALL ON FUNCTION public.complete_claimed_rule_events(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_claimed_rule_events(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.release_claimed_rule_events(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_claimed_rule_events(uuid[], text) TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_rule_event(uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_rule_event(uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.record_msgraph_nonce_and_enqueue(text, text, text, text, uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_msgraph_nonce_and_enqueue(text, text, text, text, uuid, org_rule_trigger_type, text, text, text, text, text, text, jsonb) TO service_role;

-- Credit / billing / org-lifecycle mutators with arbitrary org/user targets and no ownership check
REVOKE ALL ON FUNCTION public.increment_org_usage(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_org_usage(uuid, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.clear_payment_grace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_payment_grace(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.start_payment_grace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_payment_grace(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.expire_payment_grace_if_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_payment_grace_if_due() TO service_role;

REVOKE ALL ON FUNCTION public.suspend_suborg(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_suborg(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.unsuspend_suborg(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsuspend_suborg(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.start_kyb_verification(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_kyb_verification(uuid, text, text) TO service_role;

-- Sensitive / internal read-only stats and admin surfaces, worker-only callers
REVOKE ALL ON FUNCTION public.get_treasury_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_treasury_stats() TO service_role;

REVOKE ALL ON FUNCTION public.get_recent_cron_failures(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_recent_cron_failures(integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_table_bloat_stats(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_table_bloat_stats(text[]) TO service_role;

REVOKE ALL ON FUNCTION public.get_unembedded_public_records(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unembedded_public_records(integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_pending_user_anchors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_user_anchors(integer) TO service_role;

REVOKE ALL ON FUNCTION public.list_pending_resolution_anchors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_pending_resolution_anchors(integer) TO service_role;

REVOKE ALL ON FUNCTION public.list_pending_resolution_anchors_v2(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_pending_resolution_anchors_v2(integer) TO service_role;

-- Worker-identity (p_caller_user_id) overloads only — sibling self-guarding
-- overloads (3-arg) are untouched, see header note.
REVOKE ALL ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.supersede_anchor(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_anchor(uuid, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.search_credential_embeddings(uuid, vector, double precision, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_credential_embeddings(uuid, vector, double precision, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_anchor_status_counts_fast() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_anchor_status_counts_fast() TO service_role;

REVOKE ALL ON FUNCTION public.get_edgar_shard_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_edgar_shard_counts() TO service_role;

REVOKE ALL ON FUNCTION public.get_extraction_accuracy(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_extraction_accuracy(text, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_anchor_backlog_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_anchor_backlog_stats() TO service_role;

REVOKE ALL ON FUNCTION public.get_org_credit_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_credit_summary(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_parent_credit_rollup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_ai_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_ai_credits(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_unified_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_unified_credits(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_anchor_quota() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_anchor_quota() TO service_role;

-- Reload PostgREST schema cache so revoked grants take effect on the API
-- surface immediately (grants + function catalog are cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
