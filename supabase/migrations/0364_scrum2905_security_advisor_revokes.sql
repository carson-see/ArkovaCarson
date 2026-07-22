-- 0364_scrum2905_security_advisor_revokes.sql
-- SCRUM-2905 / SCRUM-2918 — Security-advisor triage: revoke anon/authenticated
--   EXECUTE from internal SECURITY DEFINER billing mutators.
--
-- =============================================================================
-- STATUS: FILE-ONLY / PRE-SOAK / NEVER-APPLIED — PI-0.5 T3 deferred work.
--   This migration is authored for review only. It is NOT applied to prod or any
--   rig in this window and does NOT close the ticket — it carries its own T3
--   (48h) soak because it touches privilege grants on billing functions.
--   Numeric prefix 0364 is the next free above main head 0357 and the reserved
--   0358-0363 band; see supabase/migrations/agents.md.
-- =============================================================================
--
-- WHAT IT REVOKES AND WHY:
--   `public.deduct_org_credit(uuid, integer, text, uuid)` and
--   `public.deduct_credit(uuid, integer, text, uuid)` are SECURITY DEFINER
--   functions that MUTATE billing state (they debit org / user credit balances
--   and write ledger rows). They were granted EXECUTE to `anon` and
--   `authenticated` in migrations 0326 and 0341. Because they run SECURITY
--   DEFINER (bypassing RLS) and take an arbitrary `p_org_id` / `p_user_id`
--   argument with NO caller-identity check (no auth.uid() gate), ANY
--   authenticated user — or an anonymous PostgREST caller — could deduct credits
--   from ANY org or user by passing that id. That is a cross-tenant billing-
--   integrity hole and a Supabase security-advisor "function accessible via API"
--   finding. Per CLAUDE.md §1.4, credit deduction is a worker-only, service_role
--   path; the sibling mutators in the SAME migration (`refund_org_credit`,
--   `debit_and_enqueue_anchor`, `org_credit_ledger_divergence`) are already
--   correctly service_role-only. This migration brings the two deduct functions
--   into line. service_role (the worker) retains EXECUTE — the legitimate caller
--   is unaffected.
--
-- DELIBERATELY LEFT PUBLIC (verified, NOT revoked):
--   * public.get_public_anchor_by_fingerprint(text) — public verification RPC
--     (anon + authenticated). Intentionally anon-callable; it returns only
--     public projection fields. Per memory feedback_public_endpoints_are_by_design.
--   * public.get_public_records_page(integer, integer, text, text, text, text) —
--     public-records browse (authenticated + service_role, read-only). Intended.
--   * suspend_suborg(uuid, uuid, text) / unsuspend_suborg(uuid, uuid) —
--     granted to `authenticated` but SELF-AUTHORIZE inside the body
--     (auth.uid() + org_members owner/admin role gate + platform-admin check,
--     with a service_role bypass). Revoking would break the parent-org admin
--     suspend UI flow. Left as-is by design.
--
-- MANUAL AUTH-DASHBOARD CONFIG (NOT SQL — see PR body, Carson-owned):
--   Two Supabase security-advisor items are Auth *dashboard* settings, not SQL,
--   and cannot be set from a migration:
--     (a) Enable "Leaked password protection" (HaveIBeenPwned) — Auth > Policies.
--     (b) Enforce MFA options (enable TOTP; require for privileged roles).
--   These are documented in the PR body as manual config for Carson. This file
--   deliberately does NOT fake them in SQL.
--
-- ROLLBACK:
--   -- Restore the pre-0364 (0341) grant state:
--   GRANT EXECUTE ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.deduct_credit(uuid, integer, text, uuid) TO anon, authenticated;
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Revoke anon/authenticated EXECUTE on the two SECURITY DEFINER credit mutators.
-- service_role keeps EXECUTE (the worker is the sole legitimate caller).
-- REVOKE FROM PUBLIC is defensive: it strips the implicit default-PUBLIC grant
-- so the function cannot be re-exposed via a role that inherits PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.deduct_credit(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credit(uuid, integer, text, uuid) TO service_role;

-- Reload the PostgREST schema cache so the revoked privileges take effect on the
-- API surface immediately (grants are cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
