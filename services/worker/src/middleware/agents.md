# services/worker/src/middleware/

Express middleware for the worker API. Handles auth, rate limiting, feature gating, payment verification, idempotency, and error sanitization.

## 2026-08-23 DI-736 / SCRUM-3475 — `flagRegistry` is live-refreshable; `getFlag()` is a snapshot, not a resolver

**Do not gate a code path on `flagRegistry.getFlag()`.** It returns whatever `init()` read at
worker startup and nothing ever changed it: `refreshDbFlag()` had ZERO callers, so flipping
`switchboard_flags.ENABLE_BATCH_ANCHORING` (the nightly 3am drain — the money path) or
`ENABLE_EXPIRY_ALERTS` did nothing until the worker restarted. Those two were the registry's only
real consumers; every other entry is startup logging. A kill switch that needs a redeploy to take
effect is not a kill switch.

**`getFlagLive(name)` is the resolver.** DB-backed flags are re-read from `switchboard_flags`
through `refreshDbFlag()` once the cached value is older than 60s — the same TTL cadence as
`featureGate.ts` and `aiFeatureGate.ts` — and the refreshed value is written back into the
snapshot so `getAllFlags()`/startup diagnostics stop reporting a stale boot value. Env-backed
flags short-circuit to the snapshot: `config.ts` parses them once at boot and a running Cloud Run
revision cannot change them, so there is nothing to re-read and no DB round trip is issued.
Unknown flags fail closed.

**Fail direction on a failed refresh** (SCRUM-2247's contract, applied here): last-known-good DB
value read this process lifetime → boot snapshot → `false`. The env var is deliberately NOT
consulted, so a row that was read as `false` can never be re-opened by `ENABLE_X=true` in Cloud
Run during a blip; symmetrically, a blip cannot halt a running drain either. A failed refresh is
cached for the same TTL so an outage does not turn every gate check into a DB round trip.

Note the deliberate asymmetry with `init()`, which falls back to the env var when a row is ABSENT:
a *live* refresh that stops finding its row holds last-known-good instead. A deleted or unreadable
row must not hand control back to an env var.

`_expireLiveCache()` expires the TTL without clearing values (transient-blip tests); `_reset()`
clears the snapshot AND last-known-good. Contract pinned by `flagRegistry.live-refresh.test.ts`,
including the 60s boundary itself under fake timers (still cached at 59s, re-read at 61s) so the
"a flip takes effect within 60s" claim is a ratchet rather than a comment, the absent-row case
(no row at boot AND none on refresh keeps the env-derived boot value — an env-configured rig's
drain must not go dark), and a refresh that THROWS rather than returning an error field.
The two consumers' wiring is pinned behaviourally in `jobs/batch-anchor.intent.test.ts` and
`routes/cron.test.ts`, whose mocks supply `getFlag` and `getFlagLive` separately so a regression
back to the snapshot fails a test rather than reading stale state.

**Known and accepted:** `getFlagLive` has no in-flight de-duplication, so N callers racing an
expired TTL each issue one `.single()` read (e.g. the `DISPATCH_CONCURRENCY=8` fan-out in
`rule-action-dispatcher.ts` reaches `processBatchAnchors` concurrently). Bounded at one burst per
flag per TTL, and `featureGate.ts` / `aiFeatureGate.ts` do not de-duplicate either — not worth
extra mutable state on the money path. The wider item is that this repo now carries THREE
near-identical TTL + last-known-good switchboard resolvers; unifying them is its own change, not
a rider on a kill-switch fix.

**Still open (NOT fixed here):** `init()`'s env fallback on a DB error still applies to all
`DB_FLAGS` including `MAINTENANCE_MODE`, so the BOOT snapshot can be fail-OPEN on a startup DB
blip. A live refresh now self-heals that within a TTL once the DB recovers, but the boot window
itself is unchanged — tracked separately as DI-737.
## 2026-09-02 — `parkedAttestationVerify.ts`: the parked attestation-verification route

Answers `GET /api/v1/verify/attestation/:attestationId` upstream of the real handler, which cannot
succeed: `legally_binding_attestations` has no INSERT path anywhere in the tree (0 prod rows,
verified 2026-08-31). Status contract is unchanged — 400 malformed / 404 well-formed; only the 404's
`error` string changed, to stop asserting a corpus was searched. Deliberately **not** a 501: the
enabled CRITICAL policy `PAGE — arkova-worker 5xx burst` fires on any 5xx at >5/300s with no path
dimension to exclude on.

**Its mount position in `router.ts` is load-bearing in both directions**, and `src/tests/api-e2e.test.ts`
pins both halves:

- **BELOW `apiKeyAuth` + the rate limiters.** This is a PUBLIC endpoint and §1.10 ("headers on every
  response") applies. Mounted above them the route loses its budget entirely — `publicVerifyAnonLimiter`
  (`apiIpShadowGuard.ts`) skips on `hasApiKeyCredential`, a SYNTAX-only header check, and
  `apiIpShadowGuard` skips the whole `/api/v1/verify` prefix, so any caller sending a made-up
  `X-API-Key: ak_…` is unthrottled and gets no `X-RateLimit-*`. It also turns the 401 a bad key had
  always received into a 404.
- **ABOVE `idempotency` + `usageTracking`.** The feature has no writer, so charging a caller's monthly
  quota for a response that can never succeed is waste, and `usageTracking` has no refund path.

It imports `ATTESTATION_ID_PATTERN` and `INVALID_ATTESTATION_ID_ERROR` from
`api/v1/verify/attestation.ts` rather than copying them, so the park's 400 cannot drift from the
handler's when the unpark path widens either. The unpark checklist lives in the module header.

## 2026-08-23 — `apiIpShadowGuard.ts`: the broad `/api` IP guard and its two §1.10 carve-outs

New module. `index.ts` used to build this limiter inline, which made its skip predicate impossible to
test without booting the server; it now lives here with the predicate split out, the same shape
`routes/admin-paths.ts` uses to split `isAdminRouterPath` out of `adminRouter`.

**What it is.** A blunt 60/min-per-IP backstop for anonymous `/api/*` traffic. It is NOT the limiter
that implements any Constitution §1.10 tier — every tier has its own correctly-keyed limiter further
down the chain. Treat it as defense-in-depth, and when it starts binding a documented tier, that is
the bug.

**It is MOUNTED twice, and charged once.** `index.ts` mounts the same instance at `/api` (ahead of
badgeRouter) and prefix-less (ahead of didWebRouter + proofKeysRouter, which serve `/.well-known/*`
and `/orgs/*`). Both mounts are load-bearing; `rateLimit()` charges a request at most once per
limiter INSTANCE (`utils/rateLimit.ts`, COUNTED_LIMITERS, RC #2269), which is what makes that safe.
Do not delete a mount, and do not add a third.

**Carve-out 1 — keyed `/api/v1/*` (F-2).** Requests presenting `Bearer ak_…` / `X-API-Key: ak_…` skip
it; `apiV1Router`'s keyedRateLimiter (1,000/min/key) owns them.

**Carve-out 2 — anonymous public verification (SCRUM-2603).** §1.10 gives anonymous callers 100
req/min/IP on the public verification API. They were getting ~30: this guard bound first, and before
SCRUM-3418 it wrote the same bare-per-IP bucket as `apiV1Router`'s 100/min `anonRateLimiter`, so one
verify request charged that entry twice and the 60-cap guard refused at request #31.
`/api/v1/verify` now skips it and is capped by `publicVerifyAnonLimiter` (`v1-verify-anon`, 100/min,
keyed callers skipped) instead. Measured on the real limiter in `apiIpShadowGuard.test.ts`.

**Why `publicVerifyAnonLimiter` is mounted in `index.ts` and not left to `apiV1Router`'s
`anonRateLimiter`** — which enforces the same 100/min: the v1 router runs `verificationApiGate()`
BEFORE its rate limiting, so with `ENABLE_VERIFICATION_API` off a verify request 503s without ever
reaching that limiter. Skipping the IP guard while relying on it would leave the dark-API path
uncapped. The two limiters cost one count each against separate buckets and share a cap, so anonymous
verify binds at 100/min whether the surface is lit or dark. A test pins the dark shape.

**If you widen `isPublicVerifyPath`, re-read that paragraph first.** The carve-out's safety rests on
the skipped path having its own limiter above the feature gate. It matches on the path with the query
string stripped and requires `/` or end-of-path after the prefix, so `/api/v1/verify-anchor` does not
inherit it.

## 2026-08-12 — `apiKeyAuth` refuses `revoked_at`-stamped keys (FD-P7 companion)

The middleware now selects `revoked_at` and returns 401 `api_key_revoked` when it is non-null even
if `is_active` is still true — mirroring migration 0382's `revoked_at IS NULL` predicate in
`validate_api_key` so the worker and edge paths agree. Rationale in 0382's header: a write path that
stamps `revoked_at` without flipping `is_active` must not leave a revoked key live. The PATCH
`/api/v1/keys/:keyId` revoke path stamps both together, but defense-in-depth means not relying on it.
## 2026-08-16 FD-RL-1 / FD-RL-2 — a 429 must not lie, and a denial must not consume quota

Two customer-facing defects on `POST /api/v1/anchor`, both found on the fullsoak-2026-08 rig. Evidence: `docs/staging/fullsoak-2026-08/FD-RL-quota-headers-and-counter.md`.

**FD-RL-2 — do not reintroduce: a rejected request must never consume the quota it was rejected by.** `perOrgRateLimit.ts` daily mode incremented `org_daily_usage` FIRST and evaluated the returned total, so every 429 also bumped the counter. On the rig, 98 real anchors plus 3,030 rejected retries recorded `count = 3132` — 32x overstated. The customer-visible failure is worse than the bad metric: a client with a naive retry-after-429 loop drives its own counter further past the cap with each retry and can never get back under it before the UTC reset, having created far fewer than its limit. Same signature seen twice before on other rigs (`HANDOFF.md` F-7 `current=102205` vs 32 anchors; `docs/staging/SOAK-FINDINGS-2026-08.md` `104,668`) and misread both times as a stale counter rather than a live increment-on-denial.

Daily mode now reads the recorded `org_daily_usage` row, evaluates `recorded + delta` against the tier cap, and **only reserves via `increment_org_usage` when the projection fits**. A compensating decrement is not an option: `increment_org_usage` applies `GREATEST(p_delta, 0)`, so a negative delta is clamped to zero and refunding would need DDL. Residual, deliberately accepted and bounded: a request that passes the pre-check but loses the atomic-increment race is denied with its unit already recorded — bounded by in-flight concurrency at the cap boundary, never by retry volume.

**Capacity mode never had this defect** and must stay that way: it derives from an authoritative `count(*)` over `CAPACITY_TABLES` and persists nothing, so a denial cannot drift from reality. A test pins that a capacity denial performs no `org_daily_usage` write.

**FD-RL-1 — whichever limiter issues the 429 owns the rate-limit headers on that response.** `utils/rateLimit.ts` (per-minute, per-API-key) runs first, ALLOWS, and sets `X-RateLimit-*` for its own bucket; the org quota then denied and left them alone, shipping `x-ratelimit-remaining: 987` on a refused request. An SDK that reads the headroom retries immediately against a quota that will not reset for hours. `denyOverQuota()` now overwrites `X-RateLimit-Limit` / `-Remaining` / `-Reset` with the denying quota's own numbers, consistent with `Retry-After`. An ALLOWED request still leaves the per-minute headers untouched — they are accurate there. The JSON body is unchanged (CLAUDE.md §1.8): same `ORG_QUOTA_EXCEEDED` code, same fields; a test pins the exact key set.

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
  **Amended 2026-08-23 (DI-736):** `refreshDbFlag` no longer falls back to the
  env var — it resolves last-known-good → boot snapshot → false, i.e. this
  fail-direction. `init()`'s boot-time env fallback is unchanged and is still
  the open item (DI-737).

**Ops note (out of code scope):** prod env vars (`ENABLE_SEMANTIC_SEARCH`,
`ENABLE_AI_FRAUD`, etc. ON in Cloud Run) and the `switchboard_flags` rows must
be re-synced so the intended state is the DB row, not a divergent env fallback.

## Files

- **apiKeyAuth.ts** — API key authentication via HMAC-SHA256 hash comparison. Raw keys never stored (Constitution 1.4).
- **featureGate.ts** — Gates `/api/v1/*` behind `ENABLE_VERIFICATION_API` switchboard flag. TTL-cached (60s). Fails closed on DB read errors.
- **computeidGate.ts** — (2026-09-07, SCRUM-4492) Mount-level 503 `vendor_gated` for the ComputeID AgentPassport integration, reading `config.enableComputeidIntegration` (typed config, never `process.env`). Mounted FIRST at both `/webhooks/computeid` (index.ts) and `/api/v1/agents/computeid` (router.ts) so a dark integration spends no body-parsing, limiter or profile-lookup work; the handlers keep their own check as defense in depth. Not `killSwitch()` — that reads raw `process.env` and has a closed `FlagName` union.
- **flagRegistry.ts** — Centralized feature flag registry combining env-based and DB-backed flags. Call `init()` once at startup. PROOF-03 (SCRUM-2336) registers the `ENABLE_CONFIRMATION_PROOF_BACKFILL` getter → `config.enableConfirmationProofBackfill` (default OFF) — gates the confirmation-proof backfill in-process schedule (`routes/scheduled.ts`) and the `POST /jobs/populate-confirmation-proofs` HTTP trigger. SCRUM-4492 (2026-09-07) registers `ENABLE_COMPUTEID_INTEGRATION` → `config.enableComputeidIntegration` (default OFF; env-only; the flag-inventory `unregistered-flag`/`stale-inventory-entry` ratchet requires this entry).
- **flagRegistry.ts** — Centralized feature flag registry combining env-based and DB-backed flags. Call `init()` once at startup. Gate code paths on `await getFlagLive(name)` (60s TTL switchboard re-read, fail-direction per the 2026-08-23 note above); `getFlag()` is the boot snapshot for logging/diagnostics only. PROOF-03 (SCRUM-2336) registers the `ENABLE_CONFIRMATION_PROOF_BACKFILL` getter → `config.enableConfirmationProofBackfill` (default OFF) — gates the confirmation-proof backfill in-process schedule (`routes/scheduled.ts`) and the `POST /jobs/populate-confirmation-proofs` HTTP trigger.
- **errorSanitizer.ts** — Strips provider names, API versions, and stack details from error responses before they reach clients (CISO THREAT-4).
- **idempotency.ts** — Idempotency-Key header middleware (Stripe pattern). In-memory or Upstash Redis store.
- **upstashIdempotency.ts** — Upstash Redis-backed idempotency store for horizontal scaling.
- **webhookIdempotency.ts** — Webhook-specific idempotency middleware.
- **perOrgRateLimit.ts** — Per-org-per-day tier-based quota enforcement. Atomic check-then-increment via `increment_org_usage` RPC.
- **webhookHmac.ts** — Inbound connector webhook HMAC verification with 5-minute replay window.
- **paymentTierRouter.ts** — Routes requests based on payment tier. Not yet mounted in `index.ts` (tested in isolation only). SCRUM-2971: the Tier-2 `tryStripeMetered` path now derives a request-scoped id (`Idempotency-Key` header → correlation id (`utils/correlationId.ts`) → random UUID fallback) and inserts the `billing_events` row with `idempotency_key = sha256(api_metered_usage:org_id:user_id:requestId)` (exported as `stripeMeteredIdempotencyKey`). A duplicate insert (23505, e.g. a client retry that resent the same `Idempotency-Key`) is swallowed as an idempotent no-op — the request still authorizes. See migration `0368`.
- **requirePaymentCurrent.ts** — Rejects requests from orgs with lapsed payments.
- **authContext.ts** — `getAuthenticatedUserId(req)`: the single source of truth for `req.authUserId ?? req.userId ?? null`. Two `requireAuth` implementations populate the caller identity under two different field names, so every guard must read both; `requireOrgId` / `requireOrgAdmin` / `requireScopeAnyAuth` all import it rather than keeping private copies that could drift.
- **requireOrgId.ts** — Resolves + VALIDATES `org_id` on authenticated requests (membership-checked against `x-org-id`, never trusted verbatim — see 2026-07-28 SECURITY note above).
- **requireOrgAdmin.ts** — Chains after `requireOrgId`; requires the caller be ORG_ADMIN of `req.orgId` (see 2026-07-28 SECURITY note above).
- **requireScopeAnyAuth.ts** — Dual-mode scope gate for routes that authenticate with a Supabase JWT rather than an API key. Unlike `apiKeyAuth.requireScope` it has **no pass-through branch** (see the 2026-08-23 note below).
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
- Never gate a code path on `flagRegistry.getFlag()` — it is a boot-time snapshot. Use `await flagRegistry.getFlagLive(name)` (DI-736).
- `errorSanitizer` must be registered BEFORE the global error handler.
- No raw API keys in logs or DB — HMAC-SHA256 only.
- `paymentTierRouter.ts` `tryCredits()` **fails CLOSED** (SCRUM-3502, was fail OPEN). `deduct_unified_credits` returns BOOLEAN, and its two failure shapes need OPPOSITE handling — conflating them is what leaked:
  - **RPC error** — the debit is in an UNKNOWN state and may have committed. `tryCredits` returns `{ tier: 'credits', authorized: false }`, which the middleware turns into a `503 credit_system_unavailable` with `Retry-After`. It does NOT try the next tier: falling through to Stripe metered would bill a customer whose already-purchased credit may have just been spent. Alerts `captureCreditRpcFailureAlert({ failMode: 'closed', ... })`.
  - **returns `false`** — the RPC ran and definitively did NOT debit (no `unified_credits` row, or the balance drained between the check and the deduct). No credit was consumed, so this correctly falls through to the next PAID tier and the customer is billed for what they used. `logger.warn` only; a page here would be noise.
  The previous code destructured **only** `error`, so a `false` return fell straight into the authorized return: the request was served, no credit was consumed, and nobody was billed. For an org with no `unified_credits` row — exactly the org `check_unified_credits` was handing a phantom 50 to (SCRUM-2538, migration `0420`) — that repeated on every call. **Rule: never destructure only `error` from a credit RPC that returns a boolean.** The same rule was applied to the third site of the class in the same PR, `api/v1/credits.ts`'s dev-grant.
- **The fail-closed return must not depend on alerting** (review finding, same PR). `tryCredits` wraps its whole body in `try { ... } catch { return null; }`, and `null` IS the fall-through-to-Stripe the fix removes — so a throw out of `logger.error` or `captureCreditRpcFailureAlert` (which `JSON.stringify`s a non-`Error` `error`, `utils/sentry.ts`) would be caught out there and silently reopen the leak. The reporting calls in that branch are therefore wrapped in their own `try`/`catch`: losing the page is bad, losing the fail-closed is a double-charge. Pinned by `paymentTierRouter.test.ts` → "still fails CLOSED when the Sentry alert itself throws". **Generalise: any blanket `catch` above a deliberate fail-closed return can undo it — check what the enclosing handler returns before trusting the branch.**
- **Never mount `apiKeyAuth.requireScope` on a JWT-authenticated route** — it calls `next()` the moment `req.apiKey` is unset, so it enforces nothing and reads as if it does. Use `requireScopeAnyAuth` there (2026-08-23 note below).
- `paymentTierRouter.ts` `tryCredits()`: a `deduct_unified_credits` RPC failure falls through to Stripe metered billing (fail OPEN — the org gets charged instead of a credit it already paid for being consumed) and now calls `captureCreditRpcFailureAlert({ failMode: 'open', ... })` from `utils/sentry.ts` — previously only a `logger.warn`, no alert. Fail-open behavior itself is unchanged (product decision); this only adds observability.

## 2026-08-11 BUG-2026-08-11 — x402 anchor pricing billed MAINNET fees on non-mainnet (fixed)

`x402PaymentGate`'s dynamic anchor pricing derives `estimatedFeeUsd` from a live sat/vB reading.
It constructed `MempoolFeeEstimator` directly with no base, and the constructor defaulted to the
MAINNET explorer — so a non-mainnet deployment priced requests off mainnet congestion.

Concretely on signet: `satPerVbyte` came back as mainnet's rate rather than 1, and at
`estimatedVbytes = 250` the caller was charged for a fee the network in use does not charge. This
gate is wired into 6+ `/api/v1` routes, so it was live, not theoretical.

Now passes `network: config.bitcoinNetwork`. Rule: **never construct `MempoolFeeEstimator` without
`network`** — see `../chain/agents.md`. Note the neighbouring `btcPriceUsd = 60000` hardcode is a
separate pre-existing approximation (its own comment flags it), untouched here.

## 2026-08-11 SCRUM-3128 — x402 anchor pricing used a hardcoded BTC/USD constant (fixed)

`getDynamicPrice` computed the USD fee component from `const btcPriceUsd = 60000`, so the charge was
mis-scaled by exactly the BTC/USD ratio: ~40% undercharge at $100k, 2x overcharge at $30k. The 20%
margin on the next line is noise against an error that size. The comment above it
("in production, fetch from price oracle") had been there since the block was written.

It now reads `getCachedBtcPriceUsd()` from `../utils/btc-price.ts`, which serves the quote the
treasury-cache cron already persists to `treasury_cache.btc_price_usd`.

**Rule: never fetch a price from this gate.** It is mounted on 6+ `/api/v1` routes; a per-request
call to `mempool.space/api/v1/prices` puts a third-party round trip in front of every gated request.
The reader is DB-backed and memoized — it must stay that way.

**Rule: every fallback in `getDynamicPrice` logs.** For an anchor endpoint the fee component IS the
price ($0.01 base against a fee that runs to dollars), so falling back to `basePrice` is close to a
100% revenue loss on that call. It used to be a bare `catch { return { price: basePrice }; }` — in
prod that is indistinguishable from correct pricing. Two distinct `reason` codes are emitted
(`no_usable_btc_price`, `fee_estimation_failed`) so the two causes are separable in logs.

**Only the coarse error class is logged** (`errorName`, not the error), matching `validateOnChain`
directly below: fee-estimator and DB errors can carry the configured upstream URL, and an
operator-set `MEMPOOL_API_URL` may embed a credential. A test greps the logged output for it.

**Not currently reachable through `api/v1/router.ts`.** `ANCHOR_ENDPOINTS` holds only
`/api/v1/anchor`, and that route mounts `anchorAnonAllow` / `requireScope('anchor:write')` — not
this gate. The defect was latent, and it arms itself the moment an anchor route is added to the
gate. Fixed ahead of that, not after.

## 2026-08-15 — BUG-018 / D-8 follow-up: the idempotency keyspace carries an environment namespace

`upstashIdempotency.ts` keys are now `idem:<env>:<caller key>`, from
`resolveEnvironmentNamespace()` in `../utils/environmentNamespace.ts` (introduced by #2231, which
namespaced the three rate-limit keyspaces and deliberately left this one out).

**Why this is the worst of the three collisions.** Prod, shared staging and the connector side-rig
all bind ONE Upstash database through the same un-suffixed `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` secrets. A rate-limit collision spends the wrong budget. An idempotency
collision **cancels real work**: this store exists to SUPPRESS a duplicate write, so an
`Idempotency-Key` first seen on a rig returned the rig's cached response to a production caller for
the whole 2h TTL and the production write never happened — with a 2xx and a response body handed
back, so nothing surfaced as an error anywhere. The routes carrying idempotency keys are the
anchor-creating ones.

**Rule: the env segment must PRECEDE the caller's bytes.** The `Idempotency-Key` header is fully
caller-controlled. `idem:<env>:<key>` means a staging caller crafting `prod:<key>` lands on
`idem:<staging>:prod:<key>` and cannot reach production's segment. Reversing the order
(`idem:<key>:<env>`) or interpolating the caller's value anywhere before `<env>` re-opens that as a
forgery path. There is a test for it.

**Rule: never derive this namespace from anything instance-local** — `K_REVISION`, hostname, pid, a
random id. Deduping ACROSS instances of one service is the entire reason IDEM-3 replaced the
in-memory `Map`; an instance-local namespace re-opens that bug while looking like a fix and while
every single-store test stays green. `upstashIdempotency.namespace.test.ts` asserts both halves at
once: different environments must NOT see each other's entries, and two instances of the SAME
service MUST.

**The factory is the only construction path `index.ts` uses.** `createUpstashIdempotencyStore()` is
covered by its own test — a namespace wired into the constructor alone would ship inert. `index.ts`
logs the derived namespace at startup so the deployed keyspace is readable from Cloud Run logs
without querying Redis.
## 2026-08-15 BUG-008/027 — `nessieCapabilityGate.ts`: a disabled capability must not answer 200

Nessie is permanently disabled by standing founder directive, yet `/api/v1/nessie/query` was mounted
**unconditionally** and returned **HTTP 200** with a success shape — `{"results":[],"count":0}`, and in
context mode a fluent `{"answer":"No relevant verified documents were found…","confidence":0}`. A
caller could not tell "off" from "found nothing". CTO ruling R-1 STRENGTHENED, 2026-08-12.

Three properties this gate holds, none of them incidental:

- **The flag is ENV, not `switchboard_flags`.** `ENABLE_NESSIE_QUERY` defaults false in `config.ts`.
  A capability disabled by founder directive must not be re-enablable by a DB write; turning it on
  requires a deploy, which is reviewable. Do not "improve" this by moving it to the switchboard.
- **The route's pre-existing `ENABLE_PUBLIC_RECORD_EMBEDDINGS` check is NOT this gate.** That flag
  governs the public-record embedding index, is legitimately ON, and passing it is exactly how a
  permanently-disabled capability came to answer 200. Two flags, two questions.
- **The disabled body carries NO success-shape key** — no `results`, `count`, `answer`, `confidence`,
  or `citations`, plus an explicit `enabled: false` and `code: 'nessie_disabled'`. The absence is half
  the contract and is pinned by test; an agent that only reads `total` would otherwise still conclude
  "0 results". `nessieDisabledBody()` returns a fresh object per call so no caller can mutate the
  shared envelope into a success shape.

Mounted **ahead of `x402PaymentGate`** in `api/v1/router.ts` (order pinned by
`api/v1/quota-wiring.test.ts`, `scripts/ci/check-429-limiter-map.test.ts`, and
`middleware/__tests__/x402LaunchScope.test.ts`): a disabled capability must not take a caller's money
on the way to telling them it is disabled. The check is repeated inside `api/v1/nessie-query.ts` so
the router cannot be mounted dark by a later refactor.

503, not 404 (the `partnerProvisioningGate` shape): `/nessie/query` is a **published** surface — it
was listed and priced on `/developers` — so callers who already integrated get told, not hidden from.

## 2026-08-23 SECURITY — `requireScope` is API-key-only; `requireScopeAnyAuth` is the JWT path (SCRUM-1272 / SCRUM-3514)

**VULNERABILITY CLASS — do not reintroduce: a guard that silently does nothing.** `apiKeyAuth.ts`'s
`requireScope` opens with

```ts
if (!req.apiKey) { next(); return; }
```

so on a route authenticated by a Supabase JWT it enforces **nothing**, with no log, no error, and a
mount line that reads exactly like enforcement. That is why SCRUM-1272 shipped the scope vocabulary
(`api/apiScopes.ts`) and then closed Done with its central acceptance criterion unmet: the routes it
named — `/ferpa`, `/directory-opt-out`, `/hipaa/audit`, `/emergency-access`, all carrying student PII
or PHI — had no scope layer, and adding the obvious one would not have given them one. The comment at
the top of `api/apiScopes.ts` had said so in prose since the vocabulary landed.

**`requireScopeAnyAuth.ts` (NEW)** resolves a grant for whichever auth mode is in play and has no
pass-through branch — every path ends in `next()`, 401, 403 or 500:

- **API key** → the key's `scopes`, through the same `scopeSatisfies` vocabulary and the same
  `insufficient_scope` / `required` / `granted` 403 body as `requireScope` (only the human `message`
  string differs — the machine-readable contract is unchanged, §1.8).
- **JWT** (`req.authUserId ?? req.userId`, set by a real `requireAuth` upstream) → the caller's org
  role from `api/_org-auth.ts`'s new `getCallerProfileResult`, **intersected** with any `scopes` /
  `scope` claim on the presented token.
- **Neither** → 401. This is the branch that makes the guard impossible to mount as a no-op.

Four properties, none incidental:

- **These are not exclusive branches — EVERY credential presented must satisfy the scope.** `apiKeyAuth`
  is mounted router-wide and also reads `X-API-Key`, and the PHI mounts run `requireAuth` first, so
  "API key AND verified JWT on the same request" is trivially constructible there. Checking the key
  first and returning would let a credential the route never authenticated with decide the capability
  outright — a JWT caller who would be denied alone (the no-profile-row case below) was admitted by
  attaching any org's key holding the scope, without the profile ever being read. Evaluating both is
  strictly fail-closed: it never grants where checking one alone would have denied.

- **Claims can only NARROW, never widen.** The claims are read by *decoding* the bearer token, not by
  re-verifying it — safe, because this middleware only runs after a `requireAuth` that verified that
  same token, and the decoded `sub` is cross-checked against the verified caller id. Intersection means
  even a mis-wiring of that ordering cannot turn an unverified claim into a privilege grant. Do not
  change the intersection to a union.
- **A profile-lookup DB error is 500, never a masked 403** — same fail-closed-but-observable rule as
  `requireOrgId` / `requireOrgAdmin`, which is why `_org-auth.ts` grew the `*Result` sibling
  `getCallerProfileResult` rather than reusing the error-collapsing `getCallerProfile`.
- **The role mapping is deliberately coarse** — `compliance:read` for ANY caller with a `profiles` row
  (including one whose `org_id` is null), `compliance:write` for `profiles.role = 'ORG_ADMIN'` or
  `is_platform_admin` — NOT for the `org_members.role in ('owner','admin')` signal that
  `isCallerOrgAdminResult` checks first (inert today: no mount requires `compliance:write`). Read literally:
  for a JWT caller the read grant is close to a liveness check, and that is intended. This is a
  capability gate, not the tenant boundary and not the per-route privilege check — `requireOrgId` and
  `requireOrgAdmin` still own those and are what actually authorize a caller against a specific org's
  PHI. It is not narrowed to `org_id != null` on purpose: `org_members.user_id` FKs to `auth.users`, so
  a real member whose `profiles.org_id` is null is schema-permissible and narrowing would 403 them.

Residual, deliberately accepted: a verified `auth.users` identity with **no `profiles` row** now gets an
empty grant and a 403 on these four routes. `org_members.user_id` FKs to `auth.users`, not `profiles`,
so such a caller is schema-permissible and `requireOrgId` would have admitted them. Granting on the
*absence* of the record we authorize from is the fail-open pattern this directory has been bitten by
before (see the 2026-06-05 AI flag fail-direction note); the denial is logged at `warn` so a real
occurrence is diagnosable instead of an unexplained 403.

Mount order is the contract and is pinned by `__tests__/phiScopeMount.test.ts`: `requireAuth` →
`requireScopeAnyAuth` → rate limiter → router.


## 2026-09-12 — `requireScopeAnyAuth` gained an `orgs:manage` ⊇ `read:orgs` case (SCRUM-3971)

No change to the middleware itself — the implication lives in
`api/apiScopes.ts`'s `scopeSatisfies`, which this guard already delegates to.
The test was added here because the sub-organization mount requires `read:orgs`
router-wide and `orgs:manage` on each mutating route: without the implication a
key granted only the write scope would be 401'd at the router-wide gate before
reaching the route it is entitled to.

Worth re-reading before mounting this guard on a NEW surface: the JWT branch
derives scopes from `ADMIN_JWT_SCOPES` / `MEMBER_JWT_SCOPES`, which contain only
`compliance:*`. A JWT caller therefore cannot satisfy `read:orgs` here — which is
why the sub-organization key mount runs no `requireAuth` and is API-key-only by
construction, and why its caller abstraction refuses a request carrying both
credentials rather than picking one.

## PR #2442 release review — 2026-09-05

PR #2442 review: only a literal boolean false debit result may fall through to another payment tier. Null, missing, string and object results return 503; the response does not claim a debit was absent when its outcome is unknown.

## 2026-09-12 SCRUM-4987 — `securityHeaders.ts`: browser-enforced headers on every worker response

Mounted in `index.ts` directly after `correlationIdMiddleware` and **before** `corsMiddleware`, so
OPTIONS preflights and every 401/404/429/500 carry the set too (same "on every response" contract
§1.10 imposes on the rate-limit headers). Lives in code, not at the edge, because the prod Cloud Run
origin answers publicly and bypasses Cloudflare (SCRUM-3888) — verified live 2026-09-12: the Vercel
hosts were fully hardened, the worker origin and `api.arkova.ai` returned only `x-ratelimit-*`.

Set: HSTS (same value as the Vercel hosts, so the preload entry stays coherent), `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy`, and a CSP.
The CSP is route-aware: `default-src 'none'` everywhere except under `/api/docs`, where
swagger-ui-express needs `'self'` + `'unsafe-inline'` (script and style); both policies
carry `frame-ancestors 'none'`. Nothing served by the worker is designed to be framed — the embed
widget iframes `app.arkova.ai/embed/verify/…` (Vercel), and the badge is consumed as an `<img>`,
which X-Frame-Options does not touch. `securityHeaders.test.ts` pins the header set on JSON, SVG and
404 responses and the docs-only CSP; `index.test.ts` pins the mount on `/health` and an unmatched
route. If you add an HTML surface, extend `isDocsPath` deliberately rather than loosening `API_CSP`.

**Review follow-ups (PR #2838, 2026-09-12).** (1) `isDocsPath` is case-insensitive: Express routing is
case-insensitive by default, so `/API/docs` serves the real swagger HTML and must get `DOCS_CSP`, not
`default-src 'none'`. (2) `DOCS_CSP` `img-src` allows `https://app.arkova.ai` because `docs.ts`
sets `customfavIcon` to `https://app.arkova.ai/favicon.svg` (the old `arkova-26.vercel.app/favicon.ico`
was a 404) — change both together, and it is the ONLY third-party origin in `DOCS_CSP` (a test pins
that). The earlier `fonts.googleapis.com` / `fonts.gstatic.com` allowances were removed: swagger-ui-dist
ships CSS, JS and images same-origin (images as `data:` URIs) and `nordicVaultCss` only names font
families with system fallbacks, so nothing ever loaded a webfont. (3) The values that deliberately differ
from `vercel.json`: `Referrer-Policy: no-referrer` (Vercel: `strict-origin-when-cross-origin`),
`X-Frame-Options: DENY` (Vercel: `SAMEORIGIN` — no worker route is framed; the embed widget iframes
`app.arkova.ai`, not the worker), and `Permissions-Policy` adds `payment=()` and `usb=()`. HSTS is
byte-identical on purpose (preload coherence). (4) The `nosemgrep` annotations in `ai/gemini.ts` and
`utils/gcp-auth.ts` sit on the line IMMEDIATELY above the `fetch(` call — Semgrep ignores the
annotation anywhere else in a comment block; rule id verified against the Sekura `sast_findings.json`
(`typescript.react.security.react-insecure-request.react-insecure-request`) — grep for `nosemgrep:`
in `ai/gemini.ts` and `utils/gcp-auth.ts` rather than trusting a line number, which the Sekura report
pinned at gemini.ts:1042 / gcp-auth.ts:77 and which moves with every edit above the call.
(5) This is defense-in-depth, not a substitute: SCRUM-3888 (close the public Cloud
Run origin) stays open — `requireCloudflareOrigin.ts` (below) now exists but ships flag-OFF, so
this remains the only *active* mitigation on the bare run.app host until that guard is rolled to
`enforce`; `edge.arkova.ai` gets the same set under SCRUM-5040 once an edge deploy
pipeline exists; the R-5 config-drift scaffold (`scripts/ci/check-config-drift.ts`) only snapshots
the `vercel.json` CSP, so a worker-CSP change has no drift gate today — keep this file and the
middleware in step by hand.

## 2026-09-13 SCRUM-3888 — `requireCloudflareOrigin.ts`: origin guard for the public Cloud Run origin

Mounted in `index.ts` immediately after `securityHeaders` and before `corsMiddleware` — ahead of
every route — so every path gets one consistent answer regardless of which router would eventually
have served it. Flag-gated at `CLOUDFLARE_ORIGIN_GUARD_MODE` (`off` default / `observe` / `enforce`),
read PER REQUEST from `config.ts` (never captured once at import time) so a mode change on a live
Cloud Run revision is an env-var update, not a redeploy — see
`docs/reference/CLOUDFLARE_ORIGIN_GUARD.md` for the full rollout/rollback procedure and the
allowlist inventory with per-path evidence.

Checks `X-Arkova-Origin-Auth` (a header a Cloudflare Transform Rule injects on every request
proxied through `api.`/`edge.`/`docs.arkova.ai`) against `CLOUDFLARE_ORIGIN_SECRET` via
`crypto.timingSafeEqual` on equal-length buffers, length-checked first — same shape as
`routes/health.ts`'s `isDetailedHealthAuthorized`. `off` is a pure no-op; `observe` never blocks
but counts `origin_guard_would_block` per route family (read via `GET /health?detailed=true`
`info.originGuard`); `enforce` 403s `origin_not_allowed` with a bounded body. Neither logging path
nor the 403 body ever includes the header value or the configured secret — only `routeFamily`, a
boolean `headerPresent`, and a keyed IP hash (`lib/ip-hash.ts`).

**Allowlist is evidence-driven, not assumed.** `/health`, `/api/health`, `/jobs/*` (Cloud
Scheduler — already CRON_SECRET/OIDC authenticated), every `/webhooks/*` receiver, and the two
provably partner-inbound sub-paths `/api/v1/webhooks/drive` + `/api/v1/webhooks/ats` bypass the
guard in every mode. **Not** the bare `/api/v1/webhooks` or `/api/v1/webhooks/self-service` —
those are the customer-facing webhook-management API (`api/v1/router.ts:495,515`), gated on
`webhooks:manage` scope or a dashboard JWT; an earlier draft of the allowlist swept them in by
prefix and a CTO review caught it before the flag ever left `off`. Three of the true receivers —
DocuSign, Adobe Sign, and
the Google Drive `changes.watch` webhook — are **provably** registered against the bare run.app
host: their registration URLs are built in code from `config.workerPublicUrl`
(`integrations/oauth/docusign.ts`, `integrations/oauth/adobe-sign.ts`,
`jobs/drive-subscription-renewal-deps.ts`), and `deploy-worker.yml` sets `WORKER_PUBLIC_URL` to
`https://arkova-worker-270018525501.us-central1.run.app`, not `api.arkova.ai`. The remaining
webhook paths (Middesk, Checkr, Stripe, Veremark, Microsoft Graph, ComputeID, ATS) have no
code-level registration-host proof — most are console-configured by an operator, outside this
repo's visibility — and are exempted conservatively rather than assumed safe to gate: exempting
costs nothing (each has its own signature/HMAC check per Constitution SEC-01), while gating one
that turns out to be registered against run.app would be a silent partner outage. Do not narrow
this allowlist without re-verifying the registration host for the path being removed.

**Deliberately NOT exempt, and why that is a real rollout risk, not an oversight:**
`docs/api/README.md` / `docs/api/webhooks.md` / `docs/api/openapi.yaml` currently document the
`/api/v1` and `/api/v2` REST base URL as the bare run.app host, not `api.arkova.ai`. Any partner or
SDK caller that copy-pasted that base URL is, today, hitting the unprotected origin directly and
would be blocked the moment `enforce` ships. That is exactly what `observe` mode exists to quantify
before anything blocks — see the runbook's rollout section. Updating those three docs to
`api.arkova.ai` is a release-session prerequisite this file flags but does not fix (out of lane for
a worker-code change).

`CLOUDFLARE_ORIGIN_GUARD_MODE` is a 3-state mode selector, not a boolean — deliberately **not**
registered in `flagRegistry.ts`'s `ENV_FLAG_GETTERS` (that map, and the flag-inventory CI gate's
`deploy-worker.yml` parser, are boolean-only: `ENABLE_*=true|false` / `MAINTENANCE_MODE=true|false`).
Same precedent as `bitcoinFeeStrategy`, which also lives outside that boolean surface — confirmed
this does not trip `scripts/ci/check-config-drift.ts`'s flag-inventory reconciliation.
`CLOUDFLARE_ORIGIN_SECRET` is likewise **not yet** in `deploy-worker.yml`'s `--set-secrets`: see the
comment block above the canary deploy step there for why (SCRUM-4495 preflight would fail every
subsequent deploy, not just this rollout, until the Secret Manager entry exists) and what the
release session must do in the same motion to add it.

Tests: `requireCloudflareOrigin.test.ts` (the mode × header × route-class matrix, the
constant-time compare, the allowlist boundary conditions, and that no log call anywhere carries the
header or secret value) and `index.test.ts`'s "origin guard mount" block (the real app, real mount
order, exemptions proven through the composed application rather than a hand-built one — same
reasoning as the BUG-024 proof-keys mount test above).

## 2026-09-19 — atomic anchor creation reuses quota response helpers

`setQuotaHeaders` and `denyOverQuota` are exported so canonical anchor creation preserves the
established daily-quota wire contract after reservation moves into PostgreSQL. They remain the
authority for both `X-Org-Quota-Anchors*` stems, the denying `X-RateLimit-*` override,
`Retry-After`, and the nested `ORG_QUOTA_EXCEEDED` body. Middleware behavior is unchanged.

## 2026-09-26 — generic agent lifecycle dual-auth gate (SCRUM-3980)

`agentLifecycleAuth.ts` is scoped to the generic `/api/v1/agents` mount. It
requires exactly one verified JWT or one active API key carrying
`agents:manage`, rejects valid dual credentials with 409, and fails closed on
any separately presented malformed/unresolved key header. API-key scope denial
occurs at the mount before request-body parsing or lifecycle database queries.
