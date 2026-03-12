# agents.md — services/worker
_Last updated: 2026-03-12_

## What This Folder Contains

Express-based worker service handling privileged server-side operations: anchor processing (PENDING → SECURED), Stripe webhook verification, outbound webhook delivery, and cron job scheduling. Uses Supabase service_role key — never the anon key.

## Recent Changes

| Date | Sprint | Change |
|------|--------|--------|
| 2026-03-10 ~12 PM | HARDENING-1 | 27 unit tests for `processAnchor()` + `processPendingAnchors()` (100% coverage on `anchor.ts`). Fixed silent audit event failure (BUG-H1-01). Deleted dead `anchorWithClaim.ts` (BUG-H1-02, BUG-H1-03). |
| 2026-03-10 ~2 PM | HARDENING-2 | 32 new tests: MockChainClient contract (18), getChainClient factory (5), job claim/completion flow (9). Total: 59 worker tests. 100% coverage on `anchor.ts`, `chain/mock.ts`, `chain/client.ts`. |
| 2026-03-10 ~4 PM | HARDENING-3 | 55 new tests: webhook delivery (30), Stripe client (7), Stripe handlers (18). Total: 114 worker tests. HMAC signature verification confirmed against `crypto.createHmac`. |
| 2026-03-10 ~5:20 PM | HARDENING-4 | 18 new tests: lifecycle integration (8), webhook dispatch wiring (10). Wired `dispatchWebhookEvent()` into `processAnchor()`. Added `processWebhookRetries` cron. Total: 132 worker tests. P7-TS-10 COMPLETE. |
| 2026-03-10 ~8 PM | HARDENING-5 | 96 new tests across 7 new test files: config (9), index (17), stripe/mock (9), jobs/report (19), jobs/webhook (12), utils/correlationId (12), utils/rateLimit (18). 80% thresholds on all. Total: 228 worker tests. Sprint COMPLETE. |
| 2026-03-10 ~11:30 PM | TYPE-FIX | Fixed pre-existing TS errors: `delivery.ts` (Json type cast for payload insert), `logger.ts` (pino CJS/ESM interop), `delivery.test.ts` (mock tuple/undefined casts), `client.test.ts` (missing afterEach import), `index.test.ts` (express importActual type). Synced `database.types.ts` from frontend. Zero TS errors across all source + test files. |
| 2026-03-11 | SONARQUBE | SonarQube remediation: S2068 credential fixes across test files, S6437 ReDoS regex replacements, S8215 Express disclosure fix, S2004 deeply nested mock flattening in load tests, security hotspot reviews (pseudorandom, CORS, CSRF, regex anchoring). All worker type errors resolved. |
| 2026-03-11 | P7-TS-11 | Wallet utilities: `chain/wallet.ts` (generateSignetKeypair, addressFromWif, isValidSignetWif), CLI scripts, 13 tests. |
| 2026-03-12 | P7-TS-12 | UTXO provider abstraction: `chain/utxo-provider.ts` (RpcUtxoProvider + MempoolUtxoProvider + factory), 35 tests. Broadcast tests added to signet.test.ts (3) and utxo-provider.test.ts (3). Integrated into SignetChainClient + getChainClient(). 363 total worker tests. |

## Test Coverage Status (Final — HARDENING-5)

**363 worker tests across 17 test files. All pass 80%+ per-file thresholds.**

| File | Test File | Tests | Coverage | Sprint |
|------|-----------|-------|----------|--------|
| `src/jobs/anchor.ts` | `anchor.test.ts` | 46 | 100% | H1+H2+H4 |
| `src/chain/mock.ts` | `mock.test.ts` | 18 | 100% | H2 |
| `src/chain/client.ts` | `client.test.ts` | 5 | 100% | H2 |
| `src/webhooks/delivery.ts` | `delivery.test.ts` | 30 | 99% stmts | H3 |
| `src/stripe/client.ts` | `client.test.ts` | 7 | 100% | H3 |
| `src/stripe/handlers.ts` | `handlers.test.ts` | 18 | 98% | H3 |
| `src/jobs/anchor-lifecycle` | `anchor-lifecycle.test.ts` | 8 | integration | H4 |
| `src/config.ts` | `config.test.ts` | 9 | 80%+ | H5 |
| `src/index.ts` | `index.test.ts` | 17 | 80%+ | H5 |
| `src/stripe/mock.ts` | `mock.test.ts` | 9 | 80%+ | H5 |
| `src/jobs/report.ts` | `report.test.ts` | 19 | 80%+ | H5 |
| `src/jobs/webhook.ts` | `webhook.test.ts` | 12 | 80%+ | H5 |
| `src/utils/correlationId.ts` | `correlationId.test.ts` | 12 | 80%+ | H5 |
| `src/utils/rateLimit.ts` | `rateLimit.test.ts` | 18 | 80%+ | H5 |
| `src/chain/signet.ts` | `signet.test.ts` | 33 | 80%+ | P7-TS-05+12 |
| `src/chain/utxo-provider.ts` | `utxo-provider.test.ts` | 29 | 80%+ | P7-TS-12 |
| `src/chain/wallet.ts` | `wallet.test.ts` | 13 | 80%+ | P7-TS-11 |

## Do / Don't Rules

- **DO** use `vi.hoisted()` for mutable mock state shared between `vi.mock()` factories and test code (avoids `ReferenceError: Cannot access before initialization`)
- **DO** mock `../config.js` and `../utils/logger.js` in every test file — they import from env vars that don't exist in test
- **DO** use `vi.fn()` chains (`.mockReturnThis()`, `.mockResolvedValueOnce()`) for Supabase client mocks
- **DON'T** call real Stripe or Bitcoin APIs — use mock interfaces
- **DON'T** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
- **DON'T** import `generateFingerprint` — fingerprinting is client-side only (Constitution 1.6)
- **DON'T** modify existing migration files — write compensating migrations

## Dependencies

- `bitcoinjs-lib`, `ecpair`, `tiny-secp256k1` — Bitcoin transaction construction + signing
- `pino` / `pino-pretty` — structured logging
- `stripe` — payment webhook verification
- `zod` — config validation
- `node-cron` — job scheduling
- `express` — HTTP server
- Supabase JS client (`@supabase/supabase-js`) — database operations

## MVP Launch Gap Context
- **MVP-01 (Worker Production Deployment):** CRITICAL — deploy this service to Railway/Fly.io/Render. Needs: Dockerfile or platform config, `.github/workflows/deploy-worker.yml`, env var secrets, health check. No code changes needed — deployment config only.
- **MVP-11 (Stripe Plan Change/Downgrade):** `stripe/handlers.ts` needs `customer.subscription.updated` and `customer.subscription.deleted` handlers. `useBilling` hook needs plan change mutations.

## Key Patterns

**Supabase `{data, error}` pattern:** Supabase never throws on query failures. Always destructure and check `error`:
```typescript
const { data, error } = await db.from('table').select();
if (error) { logger.error({ error }, 'Failed'); return; }
```

**Mock hoisting pattern (Vitest):**
```typescript
const { mutableState } = vi.hoisted(() => {
  const mutableState = { value: 'default' };
  return { mutableState };
});
vi.mock('../config.js', () => ({
  get config() { return mutableState; }  // reads from hoisted ref
}));
```
