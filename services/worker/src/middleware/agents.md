# services/worker/src/middleware/

Express middleware for the worker API. Handles auth, rate limiting, feature gating, payment verification, idempotency, and error sanitization.

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
- **flagRegistry.ts** — Centralized feature flag registry combining env-based and DB-backed flags. Call `init()` once at startup.
- **errorSanitizer.ts** — Strips provider names, API versions, and stack details from error responses before they reach clients (CISO THREAT-4).
- **idempotency.ts** — Idempotency-Key header middleware (Stripe pattern). In-memory or Upstash Redis store.
- **upstashIdempotency.ts** — Upstash Redis-backed idempotency store for horizontal scaling.
- **webhookIdempotency.ts** — Webhook-specific idempotency middleware.
- **perOrgRateLimit.ts** — Per-org-per-day tier-based quota enforcement. Atomic check-then-increment via `increment_org_usage` RPC.
- **webhookHmac.ts** — Inbound connector webhook HMAC verification with 5-minute replay window.
- **paymentTierRouter.ts** — Routes requests based on payment tier.
- **requirePaymentCurrent.ts** — Rejects requests from orgs with lapsed payments.
- **requireOrgId.ts** — Ensures `org_id` is present on authenticated requests.
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
