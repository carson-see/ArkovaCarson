# services/worker/src/middleware/__tests__/

Tests for middleware modules that use a shared test directory rather than co-located test files.

## Files

- **webhookIdempotency.test.ts** — Tests for webhook-specific idempotency middleware.
- **x402PaymentGate.test.ts** — Tests for x402 payment gate: 402 response format, on-chain TX validation, replay prevention.
- **x402PayerRateLimit.test.ts** — Tests for x402 payer rate limiting.
- **x402PaymentLogger.test.ts** — Tests for x402 payment settlement logging.
- **x402LaunchScope.test.ts** — Tests for x402 launch scope restrictions.

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
