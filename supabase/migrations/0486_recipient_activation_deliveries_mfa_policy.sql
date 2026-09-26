-- SCRUM-5265 follow-up / UAT-04 ratchet: reconcile the mandatory-MFA policy on
-- public.recipient_activation_deliveries, created by 0471 (UAT-23, PR #3034)
-- without one.
--
-- 0471 is immutable — it has already been applied to production (ledger row
-- 0471, numeric) — so this is a compensating migration per CLAUDE.md §1.2, not
-- an edit. Exactly the same class of omission, and the same remedy, as 0465 did
-- for anchor_private_tags / anchor_instant_intents / anchor_credit_purchases.
--
-- 0471 DOES seal the table conventionally (ENABLE + FORCE ROW LEVEL SECURITY,
-- REVOKE ALL FROM PUBLIC/anon/authenticated, GRANT ALL TO service_role), and
-- production confirms the table is deny-all today: 0 policies, and neither
-- `authenticated` nor `anon` holds SELECT. So this is NOT a live-reachable
-- bypass. It is the defense-in-depth backstop the UAT-04 ratchet exists to
-- guarantee: the ratchet intentionally requires the exact canonical policy on
-- every public RLS table, INCLUDING service-only tables, so that a later GRANT
-- cannot silently hand `authenticated` a table with no restrictive MFA
-- predicate behind it. Without this policy that GRANT would be a one-line,
-- reviewable-looking change with no backstop.
--
-- Two CI gates are red on every open PR because of the omission, which is how
-- it surfaced:
--   * tests/rls/uat04-mfa-enforcement.test.ts — the census asserting every
--     RLS-enabled public table carries `mfa_verified_authenticated`.
--   * scripts/ci/check-rls-policy-coverage.ts (SCRUM-1275 / R3-2).
-- Both are satisfied by the real policy. Neither should be satisfied by the
-- `rls-no-policy-intentional` override label, which is why that label was
-- applied and then removed rather than used here: the policy is not
-- intentionally absent, it was missed.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS mfa_verified_authenticated
--     ON public.recipient_activation_deliveries;

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE POLICY mfa_verified_authenticated ON public.recipient_activation_deliveries
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

NOTIFY pgrst, 'reload schema';

COMMIT;
