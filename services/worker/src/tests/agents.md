# services/worker/src/tests/

Cross-cutting integration and chaos engineering test suites. These test the worker as a whole rather than individual modules.

## Files

- **api-e2e.test.ts** — End-to-end API tests via supertest. Exercises the real middleware chain (feature gate, API key auth, rate limiting, CORS) against mocked Supabase. Covers `/health`, `/api/v1/verify/*`, `/api/v1/attestations/*`, and auth rejection. **2026-07-28 root-mount auth-leak regression** ("Root-mounted compliance middleware must not leak onto downstream public routes"): mounts the REAL `apiV1Router` and asserts `GET /api/v1/regulatory/alerts` and `GET /api/v1/compliance/rules` do NOT require auth, plus that `GET /api/v1/signatures/key-inventory` and `GET /api/v1/signatures/export` still DO — see `router.ts`'s `requireComplianceAuth`/`complianceAiRateLimiter` guards. Existing sub-router-only tests (e.g. `compliance-rules.test.ts`) mount their router in isolation and would never have caught this class of bug, since it only manifests when the buggy mount actually precedes the victim route in the full `router.ts` stack.
- **chaos-db-outage.test.ts** — Supabase outage simulation. Validates DB circuit breaker: consecutive failures open the circuit (`/health` reports unhealthy), recovery transitions through half-open to closed.
- **chaos-embedding-pressure.test.ts** — Embedding pipeline pressure test. Validates backpressure and rate-limit handling under load.
- **chaos-mempool-unavail.test.ts** — Mempool API unavailability simulation. Validates fallback behavior when Bitcoin mempool endpoints are down. NOTE (S3-C2, 2026-07-06): HTTP 429 is now classified as RETRYABLE (rate limit = transient; bounded backoff-with-jitter is the correct response) — the classifier pin here was updated accordingly.
- **chaos-webhook-idempotency.test.ts** — Webhook idempotency under concurrent duplicate delivery.
- **webhook-delivery-roundtrip.test.ts** — Full outbound webhook pipeline round-trip test (SCRUM-1729/SCRUM-1737). Verifies dispatchWebhookEvent → endpoint lookup → schema validation → HMAC signing → HTTP delivery → idempotency → retry → circuit breaker across all three anchor lifecycle events (secured, revoked, expired) plus SSRF protection and multi-endpoint fan-out.

## Rules

- All external services (Supabase, Stripe, Bitcoin, mempool) must be mocked.
- Chaos tests validate graceful degradation — the worker must never crash on transient failures.

## 2026-08-17 — `utf16-poison.ts` shared test helper (surrogate-split truncation class)

`poisonAt(cap)` builds a string whose `.slice(0, cap)` ends exactly on a split surrogate pair
(parity: prefix `(cap-1) % 2` single units, then astral pairs — self-checks or throws);
`isWellFormedUtf16(s)` / `illFormedStringPaths(payload)` assert nothing ill-formed reaches a
PostgREST body. Used by the poison suites in `utils/jobQueue.test.ts`,
`tests/webhook-delivery-roundtrip.test.ts`, `api/v1/{webhooks-test-ping,webhooks-self-service,
compliance-audit,credentials-ctdl-registry-anchor,nessie-query}.test.ts`, and
`lib/credential-source-import.test.ts`. Not a `.test.ts` itself — vitest include globs skip it.
