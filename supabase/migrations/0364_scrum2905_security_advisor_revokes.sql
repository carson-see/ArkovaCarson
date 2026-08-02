-- 0364_scrum2905_security_advisor_revokes.sql
-- SCRUM-2905 / SCRUM-2918 — Security-advisor triage: revoke anon/authenticated
--   EXECUTE from internal SECURITY DEFINER billing mutators.
--
-- =============================================================================
-- STATUS: PROD-APPLIED 2026-07-27 (~13:26-13:32Z, part of the 0359-0364 batch).
--   This file is the source-of-record landing on main AFTER the fact; the
--   executable SQL below is byte-for-byte what was applied. Do NOT edit the
--   statements — write a compensating migration instead (CLAUDE.md §1.2).
--   Re-verified live against prod `vzwyaatejekddvltxyye` on 2026-08-01 via
--   has_function_privilege(): both functions report anon=false,
--   authenticated=false, service_role=true — i.e. the revokes below are the
--   grant state currently in production, and re-applying this file is a no-op
--   (REVOKE/GRANT are idempotent).
--
--   NOTE (superseded header): this block previously read "FILE-ONLY / PRE-SOAK /
--   NEVER-APPLIED". That was true when authored (2026-07-22) and became false at
--   the 2026-07-27 batch apply. Corrected 2026-08-01 rather than left to mislead
--   a reviewer into thinking the hole is still open (CLAUDE.md §1.5).
--
--   NO OVERLAP with the later SEC-RECON migrations: neither
--   0377_sec_recon_revoke_unguarded_rpc_family.sql nor
--   0378_sec_recon_revoke_deferred_security_definer_grants.sql names
--   deduct_org_credit or deduct_credit, so nothing here is duplicated.
--
--   Numeric prefix 0364 is below the current ledger head — it is a historical
--   prefix being reconciled onto main, NOT a new claim. Next author claims the
--   next free prefix per supabase/migrations/agents.md, not 0365.
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
--   * public.get_public_records_page(...) — public-records browse, read-only.
--     CORRECTED 2026-08-01: this line previously read "(authenticated +
--     service_role, read-only)". That understated the real grant state. There
--     are TWO overloads (a 5-arg and a 6-arg `p_search` variant) and BOTH are
--     granted to `anon` as well — 0305 only ADDED `authenticated, service_role`,
--     and a GRANT does not revoke a pre-existing anon grant. Verified live on
--     prod 2026-08-01 via has_function_privilege: anon=true, authenticated=true
--     on both. Still intended (it is the public browse surface, per
--     memory/feedback_public_endpoints_are_by_design) and still NOT revoked —
--     but the file should not assert a "verified" grant state that isn't the
--     real one (§1.5).
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
