# services/worker/src/tests/

Cross-cutting integration and chaos engineering test suites. These test the worker as a whole rather than individual modules.

## Files

- **api-e2e.test.ts** — End-to-end API tests via supertest. Exercises the real middleware chain (feature gate, API key auth, rate limiting, CORS) against mocked Supabase. Covers `/health`, `/api/v1/verify/*`, `/api/v1/attestations/*`, and auth rejection.
- **chaos-db-outage.test.ts** — Supabase outage simulation. Validates DB circuit breaker: consecutive failures open the circuit (`/health` reports unhealthy), recovery transitions through half-open to closed.
- **chaos-embedding-pressure.test.ts** — Embedding pipeline pressure test. Validates backpressure and rate-limit handling under load.
- **chaos-mempool-unavail.test.ts** — Mempool API unavailability simulation. Validates fallback behavior when Bitcoin mempool endpoints are down.
- **chaos-webhook-idempotency.test.ts** — Webhook idempotency under concurrent duplicate delivery.

## Rules

- All external services (Supabase, Stripe, Bitcoin, mempool) must be mocked.
- Chaos tests validate graceful degradation — the worker must never crash on transient failures.
