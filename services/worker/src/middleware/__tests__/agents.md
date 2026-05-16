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
