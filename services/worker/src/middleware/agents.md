# services/worker/src/middleware/

Express middleware for the worker API. Handles auth, rate limiting, feature gating, payment verification, idempotency, and error sanitization.

## 2026-08-01 SILENT-WRITE CLASS — `void <supabase builder>` never executes (PR #1808)

**Do not reintroduce:** supabase-js query builders are **lazy PromiseLikes**. `PostgrestBuilder.then()` is where the HTTP request is issued — nothing happens until something calls `then` (via `await`, `.then(...)`, or `Promise.all`). So

```ts
void db.from('t').update({ ... }).eq('id', id);   // NO-OP. Never sent.
```

evaluates the builder, discards it, and writes nothing — no error, no effect, no signal. `apiKeyAuth.ts` shipped this pattern for `api_keys.last_used_at`, and every row in prod read `last_used_at IS NULL` regardless of actual key use, including keys that had authenticated hours earlier. Any dormant-credential audit or key-rotation runbook keyed on that column got a wrong answer 100% of the time.

**Correct fire-and-forget** (see `touchApiKeyLastUsed` in `apiKeyAuth.ts`, used by both `apiKeyAuth.ts` and `api/v2/auth.ts`): keep `void` for the floating-promise lint, but attach `.then(onFulfilled, onRejected)` — the `.then` is what issues the request, and the handlers make failures visible instead of silent.

**Tests must model the laziness.** A mock whose `.eq()` returns a resolved Promise, or `mockReturnThis()`, passes even when the production code never sends anything. Both `apiKeyAuth.test.ts` and `api/v2/auth.test.ts` now use a `lazyUpdateBuilder` that records a write **only when `.then()` is called**.

Sibling audit (2026-08-01): 9 other `void db.…` callsites still carry this bug — `api/v1/verify.ts`, `api/v1/keys.ts`, `api/v1/oracle.ts`, `api/v1/key-inventory.ts`, and 4 in `api/v1/agents.ts`, all discarding `audit_events` inserts. Out of scope for PR #1808; tracked separately. `signatures/compliance/complianceEvents.ts` is already correct (it ends in `.then(() => {}, () => {})`).

## 2026-07-28 SECURITY — requireOrgId cross-tenant bypass (fix) + new requireOrgAdmin

**VULNERABILITY CLASS — do not reintroduce:** `requireOrgId.ts` previously read `req.headers['x-org-id']` **verbatim** and attached it to `req.orgId` with **no check** that the authenticated caller belonged to that org. Any authenticated Arkova user (any valid JWT, any org) could impersonate any other org on every route mounted behind it, just by sending an arbitrary header — a full cross-tenant read/write bypass on the FERPA disclosure log, directory opt-out, HIPAA audit trail, and HIPAA emergency-access grants. Because `utils/db.ts`'s `db` client is **service_role and bypasses RLS by design**, RLS provided zero protection here — the header WAS the entire tenant boundary.

**Fix:**
- `requireOrgId.ts` is now `async` and validates the header against real membership via `isUserMemberOfOrgResult` (`../api/_org-auth.ts` — the same canonical seam `org-cpe-log-export.ts`/`version-resolution.ts` already used correctly). A caller identity is resolved from `req.authUserId ?? req.userId` (set by a real JWT `requireAuth` upstream — never by this header). No membership → 403. A DB/operational error during the lookup → 500 (never a masked 403, matching the `*Result` fail-closed-but-observable pattern used throughout `_org-auth.ts`).
- **`requireOrgAdmin.ts` (NEW)** — chain AFTER `requireOrgId` for routes that need ORG_ADMIN, not merely membership (e.g. reading a HIPAA audit trail, approving emergency access). Delegates to `isCallerOrgAdminResult`.
- **Pattern for any new org-scoped route:** never read `x-org-id` (or any client-controlled org identifier) directly and trust it. Mount `requireOrgId` (+ `requireOrgAdmin` if the route needs admin) upstream of the handler; read `req.orgId` afterward. If the org id instead comes from a route param (not a header), call `isUserMemberOfOrgResult`/`isCallerOrgAdminResult` directly in the handler before touching the DB — see `api/v1/org-kyb.ts` for that pattern.
- Full route-by-route detail (which routes were affected, the privilege level chosen per route, and why) is documented in `api/v1/agents.md`'s "2026-07-28 SECURITY" entry.
## 2026-07-22 PR #1555 (SCRUM-2703/2705) rebase note — exact row-count callsite reviewed, not changed

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

`perOrgRateLimit.ts::getCapacityCount` requests an exact row-count from PostgREST (the R0-8 baseline check flags it: +1 non-test callsite). Reviewed and left as-is: both `CAPACITY_TABLES` targets (`organization_rules`, `webhook_endpoints`) are queried with `.eq('org_id', orgId)` against an indexed `org_id` btree (`idx_organization_rules_org_trigger`, `idx_webhook_endpoints_org_id`), and per-org cardinality is bounded by the tier caps themselves (≤100 rules, ≤10 connectors) — not the unindexed multi-million-row `anchors`-table scan pattern R0-8 targets. Capacity enforcement also needs an accurate row-count (compared against small integer tier limits); an estimated count or `pg_class.reltuples` would give an inaccurate, whole-table (not org-scoped) figure and risk incorrect quota allow/deny. This PR carries the `count-exact-allowed` label to cover that single reviewed callsite (RTE/CTO may later special-case it in the baseline script instead). Prose here deliberately avoids the literal grep token so this note does not itself inflate the R0-8 baseline count.

## 2026-07-15 SCRUM-2703/2705 quota invariants

_Restored 2026-07-28 — same union-merge-driver incident as above._

- `perOrgRateLimit.ts` accepts organization ids only from authenticated caller
  context. Daily cardinality is atomically incremented; capacity counts query
  only code-owned table mappings and fail closed on lookup uncertainty.
- `x402PaymentGate.ts` derives payer identity only from the verified on-chain
  USDC Transfer sender and places only its HMAC in `req.x402PayerContext`.
- `x402PayerRateLimit.ts` is bounded process-local memory. Full-store or missing
  identity conditions return 503; do not evict or silently bypass.
- Canonical org/payer quota 429s must emit an integer `Retry-After`.

## 2026-07-21 Partner Provisioning Gate (SCRUM-2990)

- `partnerProvisioningGate.ts` gates the entire `/api/partner-provisioning` surface behind the `ENABLE_PARTNER_PROVISIONING` switchboard flag. Mirrors `featureGate.ts` (ENABLE_VERIFICATION_API / §1.9) exactly: `get_flag` RPC, 60s TTL cache, FAIL CLOSED on absent/false/non-boolean/read-error, and the env var is deliberately NOT a runtime fallback (unseeded flag row = surface dark, the intended pre-launch default; seeding is DBA/release-ops-owned). Dark = **404** (not the verification gate's 503): the surface is unreleased and must not disclose its existence. Registered in `flagRegistry.ts` `DB_FLAGS`; listed inert in `scripts/ci/config-drift/expected-prod-config.json` `pendingLaunchFlags` per the WH-6 precedent (pin the effective value only once the prod row is seeded).

## 2026-05-20 Visual Fraud Gate Note

- `aiFeatureGate.ts` still exposes `ENABLE_VISUAL_FRAUD_DETECTION` for legacy route compatibility, but `/api/v1/ai/fraud/visual` now returns HTTP 410. Client-side worker fraud analysis is the only compliant forward path under SCRUM-1955.

## 2026-06-05 AI flag fail-direction (SCRUM-2247 / HARDEN-1-D)

`aiFeatureGate.ts` `readAIFlag` previously returned the env-var fallback on ANY
DB read error/null row. With env=true (Cloud Run) + DB=false (switchboard
kill-switch off), a transient Supabase blip silently re-enabled the killed
feature — fail-OPEN. SEV1.

Fixed: the DB row is source of truth. On a failed/empty read we resolve via:
1. **Last-known-good DB value** (recorded on the last successful read this
   process lifetime) — a transient blip holds the flag steady.
2. Else a **per-flag fail default**:
   - Kill-switchable flags (`ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD`,
     `ENABLE_AI_REPORTS`, `ENABLE_VISUAL_FRAUD_DETECTION`) → **false**. The env
     var is NOT a re-open path.
   - `ENABLE_AI_EXTRACTION` is launch-required (CLAUDE.md §1.6, default true in
     prod) → keeps its launch default (env value). An explicit DB=false still
     wins and becomes last-known-good.

`_resetAIFlagCache()` clears TTL + last-known-good (test isolation);
`_expireAIFlagCache()` expires only the TTL (transient-blip tests).

**Sibling-consumer audit:**
- `featureGate.ts` (`isVerificationApiEnabled`) — already fails CLOSED on DB
  error (returns false, no env fallback). No change needed.
- `flagRegistry.ts` (`init`/`refreshDbFlag`) — `init` DOES use the same
  env-var fallback on DB error for all `DB_FLAGS` (including the AI flags and
  kill-switches like `MAINTENANCE_MODE`), so the registry snapshot can be
  fail-OPEN on a startup DB blip. The runtime gates use `aiFeatureGate`/
  `featureGate` (now hardened), so this is a diagnostic/startup-log surface,
  not the request-path gate. Flagged as a follow-up (see HANDOFF.md / Jira) to
  apply the same fail-direction; out of scope for SCRUM-2247's request-gate fix.

**Ops note (out of code scope):** prod env vars (`ENABLE_SEMANTIC_SEARCH`,
`ENABLE_AI_FRAUD`, etc. ON in Cloud Run) and the `switchboard_flags` rows must
be re-synced so the intended state is the DB row, not a divergent env fallback.

## Files

- **apiKeyAuth.ts** — API key authentication via HMAC-SHA256 hash comparison. Raw keys never stored (Constitution 1.4).
- **featureGate.ts** — Gates `/api/v1/*` behind `ENABLE_VERIFICATION_API` switchboard flag. TTL-cached (60s). Fails closed on DB read errors.
- **flagRegistry.ts** — Centralized feature flag registry combining env-based and DB-backed flags. Call `init()` once at startup. PROOF-03 (SCRUM-2336) registers the `ENABLE_CONFIRMATION_PROOF_BACKFILL` getter → `config.enableConfirmationProofBackfill` (default OFF) — gates the confirmation-proof backfill in-process schedule (`routes/scheduled.ts`) and the `POST /jobs/populate-confirmation-proofs` HTTP trigger.
- **errorSanitizer.ts** — Strips provider names, API versions, and stack details from error responses before they reach clients (CISO THREAT-4).
- **idempotency.ts** — Idempotency-Key header middleware (Stripe pattern). In-memory or Upstash Redis store.
- **upstashIdempotency.ts** — Upstash Redis-backed idempotency store for horizontal scaling.
- **webhookIdempotency.ts** — Webhook-specific idempotency middleware.
- **perOrgRateLimit.ts** — Per-org-per-day tier-based quota enforcement. Atomic check-then-increment via `increment_org_usage` RPC.
- **webhookHmac.ts** — Inbound connector webhook HMAC verification with 5-minute replay window.
- **paymentTierRouter.ts** — Routes requests based on payment tier. Not yet mounted in `index.ts` (tested in isolation only). SCRUM-2971: the Tier-2 `tryStripeMetered` path now derives a request-scoped id (`Idempotency-Key` header → correlation id (`utils/correlationId.ts`) → random UUID fallback) and inserts the `billing_events` row with `idempotency_key = sha256(api_metered_usage:org_id:user_id:requestId)` (exported as `stripeMeteredIdempotencyKey`). A duplicate insert (23505, e.g. a client retry that resent the same `Idempotency-Key`) is swallowed as an idempotent no-op — the request still authorizes. See migration `0368`.
- **requirePaymentCurrent.ts** — Rejects requests from orgs with lapsed payments.
- **requireOrgId.ts** — Resolves + VALIDATES `org_id` on authenticated requests (membership-checked against `x-org-id`, never trusted verbatim — see 2026-07-28 SECURITY note above).
- **requireOrgAdmin.ts** — Chains after `requireOrgId`; requires the caller be ORG_ADMIN of `req.orgId` (see 2026-07-28 SECURITY note above).
- **usageTracking.ts** — Tracks API usage for billing/analytics.
- **adesFeatureGate.ts** — AdES (Advanced Electronic Signatures) feature gate.
- **aiFeatureGate.ts** — AI feature gate for Gemini/embedding endpoints. Per-flag fail-direction on DB read failure (SCRUM-2247): kill-switchable flags fail closed; `ENABLE_AI_EXTRACTION` keeps its launch default; last-known-good DB value preferred over both on a transient blip.
- **grcFeatureGate.ts** — GRC (Governance, Risk, Compliance) feature gate.
- **integrationKillSwitch.ts** — Emergency kill switch for third-party integrations.
- **ruleEventBackpressure.ts** — Backpressure middleware for rule event processing.
- **x402PaymentGate.ts** — Returns 402 with x402 payment requirements; validates on-chain payments.
- **x402PayerRateLimit.ts** — Rate limiting for x402 payers.
- **x402PaymentLogger.ts** — Logs x402 payment settlements.

## Rules

- Every inbound connector webhook MUST pass through `webhookHmac` middleware.
- Feature gates fail closed by default — if the DB read fails, kill-switchable gates return 503. Exception: `ENABLE_AI_EXTRACTION` is launch-required (§1.6) and keeps its launch default; last-known-good DB value wins over the fail default on a transient blip (SCRUM-2247).
- `errorSanitizer` must be registered BEFORE the global error handler.
- No raw API keys in logs or DB — HMAC-SHA256 only.
- `paymentTierRouter.ts` `tryCredits()`: a `deduct_unified_credits` RPC failure falls through to Stripe metered billing (fail OPEN — the org gets charged instead of a credit it already paid for being consumed) and now calls `captureCreditRpcFailureAlert({ failMode: 'open', ... })` from `utils/sentry.ts` — previously only a `logger.warn`, no alert. Fail-open behavior itself is unchanged (product decision); this only adds observability.
