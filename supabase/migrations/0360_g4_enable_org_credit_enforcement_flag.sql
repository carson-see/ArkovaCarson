BEGIN;

-- =============================================================================
-- 0360 — Seed ENABLE_ORG_CREDIT_ENFORCEMENT switchboard flag, default OFF
--        (G4, PI-0.5 24h slice; pairs with the merged #1570 / SCRUM-2970
--        credit gate — stable reference_id on org_credit_deductions)
--
-- WHY:
--   Org-credit enforcement (`deductOrgCredit` in
--   services/worker/src/utils/orgCredits.ts, gated today by the env-backed
--   `config.enableOrgCreditEnforcement`, Zod default false) is launch-gated.
--   This migration gives operators a single visible switchboard row for the
--   rollout. It seeds OFF and MUST NOT be flipped ON before HakiChain's
--   credit balance is funded (G3, founder-owned) — flipping it early would
--   402-block partner anchor submissions at zero balance.
--
-- SEMANTICS (verified against existing code, 2026-07-21):
--   - `get_flag('ENABLE_ORG_CREDIT_ENFORCEMENT')` returns p_default=false for
--     an absent row, so "row missing" ≡ "row enabled=false" ≡ enforcement OFF:
--     the worker short-circuits {allowed:true, reason:'feature_disabled'} and
--     non-credit orgs anchor unaffected. Seeding the row changes NOTHING at
--     runtime — it only makes the OFF state explicit and auditable.
--   - Fail-closed is scoped to the ENFORCED path: with enforcement ON, a
--     credit-RPC failure returns 503 credit_check_unavailable per request
--     (no silent free anchoring); it never dark-ships a hard-block of the
--     whole anchor path.
--
-- IDEMPOTENCY / OPERATOR SAFETY:
--   ON CONFLICT (flag_key) DO NOTHING — NOT DO UPDATE. If an operator has
--   already created the row (or, post-G3, enabled it), re-applying this
--   migration must never stomp that value in either direction.
--
--   The AFTER UPDATE trigger `switchboard_flag_change_trigger` only fires on
--   enabled-value CHANGES, so this INSERT emits no spurious audit rows.
--
-- Row-shape note: no schema change — no database.types.ts regeneration.
-- =============================================================================

INSERT INTO public.switchboard_flags (flag_key, enabled, description)
VALUES (
  'ENABLE_ORG_CREDIT_ENFORCEMENT',
  false,
  'Launch-gated org credit-ledger enforcement for instant anchors (G4). Do NOT enable before HakiChain balance is funded (G3).'
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;

-- ROLLBACK:
--   Remove the seeded row ONLY if it is still in its seeded (disabled) state;
--   an operator-enabled row is post-G3 launch state and must be handled by an
--   explicit operator decision, not a blanket rollback.
--     DELETE FROM public.switchboard_flags
--     WHERE flag_key = 'ENABLE_ORG_CREDIT_ENFORCEMENT'
--       AND enabled = false;
