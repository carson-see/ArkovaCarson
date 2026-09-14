# services/worker/src/middleware/__tests__/

Tests for middleware modules that use a shared test directory rather than co-located test files.

## Files

- **webhookIdempotency.test.ts** — Tests for webhook-specific idempotency middleware.
- **x402PaymentGate.test.ts** — Tests for x402 payment gate: 402 response format, on-chain TX validation, replay prevention.
- **x402PayerRateLimit.test.ts** — Tests for x402 payer rate limiting.
- **x402PaymentLogger.test.ts** — Tests for x402 payment settlement logging.
- **x402LaunchScope.test.ts** — Tests for x402 launch scope restrictions.
- **phiScopeMount.test.ts** — Structural ratchet (SCRUM-1272 / SCRUM-3514) over `api/v1/router.ts`: every PHI / student-PII mount (`/ferpa`, `/directory-opt-out`, `/hipaa/audit`, `/emergency-access`) must carry `requireScopeAnyAuth('compliance:read')` AFTER `requireAuth`, and must NOT be "guarded" by the API-key-only `requireScope`, which no-ops for a JWT caller. Source-level on purpose — a refactor that drops the guard fails here rather than silently in prod. SCRUM-3981 added a fourth case: `router.ts`'s own `requireAuth` rejects a caller whose Authorization header is missing or starts with `Bearer ak_`, and never reads `X-API-Key` — so an API key alone gets 401 on these four mounts before the scope guard runs. That is fail-closed, which is why the webhooks scope work deliberately left these mounts alone; it is pinned here so a future change to `requireAuth` that starts accepting API keys has to confront the PHI surface explicitly (the product decision is SCRUM-5070). Source-level, like the rest of the file: `requireAuth` is module-local to `router.ts` and is not exported, so this reads the guard rather than executing it.

## Rules

- No real Stripe or Bitcoin API calls — mock all external services.
- Tests exercise the real middleware chain with mock DB/chain backends.

## 2026-07-15 SCRUM-2703/2705 coverage

- Payer tests must prove spoofed header payer data is ignored, only verified
  Transfer senders become HMAC keys, bounded-store exhaustion fails closed,
  and bypass contexts consume no state.
- Organization quota tests cover exact bulk delta, canonical/compatibility
  headers, daily versus capacity backends, and DB-error/rejection fail-closed
  behavior. Never make external RPC or Supabase calls in these tests.
# 2026-09-14 — requireAuth source assertion boundary

`phiScopeMount.test.ts` locates the next top-level function declaration after
`requireAuth` before checking that JWT-only guard. Folder API authentication now
lives in the adjacent `requireFolderAuth`; widening the slice through that
separate API-key-aware helper creates a false PHI failure. The assertions still
inspect only `requireAuth` and still require its Bearer-key rejection and lack
of `req.apiKey`/`X-API-Key` access.
