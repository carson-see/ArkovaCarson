BEGIN;

-- =============================================================================
-- 0363 — Seed ENABLE_ORG_CREDIT_ENFORCEMENT switchboard row, AUDIT MIRROR ONLY,
--        default OFF (G4, PI-0.5 24h slice; pairs with the merged #1570 /
--        SCRUM-2970 credit gate — stable reference_id on org_credit_deductions)
--
-- WHAT THIS ROW IS — AND IS NOT (review-corrected 2026-07-21):
--   This row is an AUDIT MIRROR of the launch-gated org-credit-enforcement
--   rollout state. It is NOT the control. The worker NEVER reads this row:
--   the runtime gate is the ENABLE_ORG_CREDIT_ENFORCEMENT env var set (or,
--   today, omitted) in deploy-worker.yml, read as
--   `config.enableOrgCreditEnforcement` (Zod boolFlag(false) in
--   services/worker/src/config.ts) and classified under ENV_FLAG_GETTERS —
--   not DB_FLAGS — in services/worker/src/middleware/flagRegistry.ts. The
--   row is also NOT rendered by the admin UI (PlatformControlsPage.tsx
--   FLAG_CATEGORIES / src/lib/switchboard.ts FLAGS do not include this key).
--   An operator flipping this row ON changes NOTHING at runtime; the
--   description below says so explicitly to prevent exactly that mistake
--   (the switchboard_flag_change_trigger would otherwise write an audit row
--   asserting enforcement was enabled while the worker keeps NOT enforcing —
--   a silent free-anchoring hazard post-G3).
--
-- WHY SEED IT AT ALL:
--   So the rollout state has one auditable DB record whose description
--   points operators at the REAL control, and so post-G3 activation can
--   flip env + row together without a schema change.
--
-- ENFORCEMENT OF THE G3 COUPLING (the real teeth):
--   The R-5 config-drift manifest pins ENABLE_ORG_CREDIT_ENFORCEMENT=false
--   (scripts/ci/config-drift/expected-prod-config.json + prod-config-
--   snapshot.json). Because the flag is env-backed (not DB-backed), any
--   pre-G3 `ENABLE_ORG_CREDIT_ENFORCEMENT=true` added to deploy-worker.yml
--   fails CI with flag-SPOF `env-flag-on-no-db-guard`.
--
-- SEMANTICS (verified against existing code, 2026-07-21):
--   - Enforcement OFF (env unset/false — today's state): `deductOrgCredit`
--     (services/worker/src/utils/orgCredits.ts) short-circuits
--     {allowed:true, reason:'feature_disabled'} and non-credit orgs anchor
--     unaffected. DB `get_flag()` returns p_default=false for an absent row,
--     so "row missing" and "row enabled=false" describe the same OFF state.
--   - Fail-closed is scoped to the ENFORCED path: with enforcement ON, a
--     credit-RPC failure returns 503 credit_check_unavailable per request
--     (no silent free anchoring); it never dark-ships a hard-block of the
--     whole anchor path.
--
-- IDEMPOTENCY / OPERATOR SAFETY:
--   ON CONFLICT (flag_key) DO NOTHING — NOT DO UPDATE. If the row already
--   exists (or post-G3 activation has updated it), re-applying this
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
  'AUDIT MIRROR ONLY — this row does NOT gate enforcement and the worker never reads it. The runtime gate is the ENABLE_ORG_CREDIT_ENFORCEMENT env var in deploy-worker.yml (env-backed via config.ts; CI drift gate pins it false). Launch-gated org credit-ledger enforcement (G4); keep false, and keep the env var unset, until HakiChain balance is funded (G3).'
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;

-- ROLLBACK:
--   Remove the seeded row ONLY if it is still in its seeded (disabled) state;
--   an operator-updated row is post-G3 launch state and must be handled by an
--   explicit operator decision, not a blanket rollback.
--     DELETE FROM public.switchboard_flags
--     WHERE flag_key = 'ENABLE_ORG_CREDIT_ENFORCEMENT'
--       AND enabled = false;
