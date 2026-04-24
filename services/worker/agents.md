# agents.md — services/worker
_Last updated: 2026-04-24_

## What This Folder Contains

Express-based worker service handling privileged server-side operations: anchor processing (PENDING → SECURED), Stripe webhook verification, outbound webhook delivery, cron job scheduling, rules engine, and org tier/quota enforcement. Uses Supabase service_role key — never the anon key.

## CIBA hardening closeout (2026-04-23, PRs #479 / #480)

- **`api/treasury.ts`** ([SCRUM-1116](https://arkova.atlassian.net/browse/SCRUM-1116)): `handleTreasuryHealth` now returns HTTP 500 with a `source` field on `cacheResult.error` / `alertResult.error`. New exported `parseThresholdUsd()` rejects NaN/empty/whitespace/non-finite/zero/negative and falls back to `DEFAULT_TREASURY_THRESHOLD_USD`.
- **`api/rules-crud.ts`** ([SCRUM-1118](https://arkova.atlassian.net/browse/SCRUM-1118)): `handleUpdateRule` drops the manual `updated_at` stamp — the DB trigger `set_organization_rules_updated_at` (migration 0224) is authoritative.
- **`integrations/connectors/adapters.ts`** ([SCRUM-1118](https://arkova.atlassian.net/browse/SCRUM-1118)): Google Drive adapter now passes `folder_path: null` instead of fabricating `/id1/id2` paths from opaque Drive parent IDs. Admin `folder_path_starts_with` rules silently didn't match Drive events; explicit null is correct until INT-10 resolves names via `files.get`.
- **`jobs/batch-anchor.ts`** ([SCRUM-1118](https://arkova.atlassian.net/browse/SCRUM-1118)): `triggerC_computeFeeCeiling` clamps inputs to ≥0 and output to `[0, ABSOLUTE_FEE_CAP_SAT_PER_VB]`. `triggerA_shouldFireOnSize` docstring now explicitly marks the function as audit-pinning-only (never called in production; claim loop enforces BATCH_SIZE structurally). Log message in the below-threshold branch rewritten so `pendingCount=0` doesn't claim "oldest anchor is fresh."
- **`rules/schemas.test.ts`** ([SCRUM-1118](https://arkova.atlassian.net/browse/SCRUM-1118)): misleading "non-HTTPS URL" test renamed to "malformed target_url" — the test pins URL-format, not HTTPS enforcement.
- **`jobs/batch-anchor.audit.test.ts`** ([SCRUM-1119](https://arkova.atlassian.net/browse/SCRUM-1119)): duplicate boundary test removed; two new triggerC tests cover mid-band (45 min → 100) + below-threshold (29 min → 50).

Migration `0236_ark105_rules_executions_comment_fix.sql` is a compensating `COMMENT ON TABLE` fix — migration 0224's inline wording promised a "24h" idempotency window but the unique index is permanent. Per CLAUDE.md §1.2 we do not modify 0224.

## CIBA v1.0 additions (2026-04-21, PR #474)

New modules this release:

- **`api/queue-resolution.ts`** (ARK-101) — `GET /api/queue/pending`, `POST /api/queue/resolve`. Wraps `list_pending_resolution_anchors` + `resolve_anchor_queue` RPCs; Zod validation; RPC-error → HTTP status mapping in `mapRpcErrorToStatus` (re-used by `anchor-lineage.ts`).
- **`api/anchor-lineage.ts`** (ARK-104) — `GET /api/anchor/:id/lineage`, `POST /api/anchor/:id/supersede`. Returns [root..head] + `head_public_id` from `is_current` flag.
- **`api/rules-crud.ts`** (ARK-105/108) — `GET/POST/PATCH/DELETE /api/rules`. Cross-tenant writes guarded by explicit `.eq('org_id', callerOrg)` since the service_role client bypasses RLS. Fire-and-forget `emitRuleAudit` on every lifecycle event.
- **`api/rules-draft.ts`** (ARK-110) — `buildDraftRule` pure fn + `makeHandleDraftRule` factory. Forces `enabled=false` + caller's `org_id` regardless of provider output. Blocks `FORWARD_TO_URL` outright. `RuleDraftProvider` interface is injectable — Gemini wiring is a follow-up.
- **`jobs/treasury-alert.ts`** + **`jobs/treasury-alert-dispatcher.ts`** (ARK-103) — pure `decideTreasuryAlert` + Slack (AbortSignal.timeout 5s, redirect:manual) + email. Fail-closed on oracle outage.
- **`jobs/rules-engine.ts`** (ARK-106) — claims pending rule events, bulk-fetches rules once per tick (`in('org_id', orgIds)` — NOT per-org round-trips), inserts executions with `ON CONFLICT DO NOTHING`.
- **`jobs/queue-reminders.ts`** (ARK-107) — 15-min cron. `cronMatches` parses 5-field cron with DST-aware `Intl.DateTimeFormat` timezone handling.
- **`jobs/batch-anchor.audit.test.ts`** (ARK-102) — pins triggerA (size) / triggerB (age) / triggerC (fee ceiling) decision points as pure helpers.
- **`rules/schemas.ts`, `rules/evaluator.ts`, `rules/sanitizer.ts`** — Zod configs for 7 trigger types + 6 action types; pure evaluator covering all of them; SEC-02 prompt-injection sanitizer with 20-entry adversarial corpus.
- **`middleware/webhookHmac.ts`** (SEC-01) — uniform webhook HMAC with per-tenant secret, replay window, 1 MB body cap, `redirect: 'manual'` + constant-time compare. Body-size gate runs BEFORE secret fetch.
- **`middleware/perOrgRateLimit.ts`** (SCALE-01) — `requireOrgQuota({ kind, getOrgId })`. Fail-closed on DB error. Tier table pinned: FREE/PAID/ENTERPRISE.
- **`integrations/connectors/schemas.ts`** + **`adapters.ts`** (INT-10/12) — Zod webhook payload schemas + pure vendor→canonical adapters for DocuSign, Adobe Sign, Google Drive, SharePoint/OneDrive, Veremark, Checkr.
- **`ai/ruleMatcher.ts`** (ARK-109) — `matchBySemantics` with parallel cache reads + fire-and-forget cache writes. Reuses project-wide `cosineSimilarity` from `ai/eval/semantic-similarity.ts`. **PII strip is caller's responsibility — this module does no detection.**

### Treasury access policy (updated 2026-04-21)

Both `GET /api/treasury/status` AND `GET /api/treasury/health` are **platform-admin-only**. No carve-out for org admins. The health endpoint returns a narrower shape (USD + threshold + below flag only) but the access policy is identical.

### New env vars (see `docs/reference/ENV.md`)

`ENABLE_WEBHOOK_HMAC`, `ENABLE_RULES_ENGINE`, `ENABLE_QUEUE_REMINDERS`, `ENABLE_TREASURY_ALERTS`, `SLACK_TREASURY_WEBHOOK_URL`, `TREASURY_ALERT_EMAIL`, `TREASURY_LOW_BALANCE_USD`.

### AI observability (SCRUM-1067)

- `src/ai/observability.ts` initializes Arize AX tracing when `ARIZE_TRACING_ENABLED=true` and both `ARIZE_API_KEY` + `ARIZE_SPACE_ID` are present.
- Provider spans are metadata-only: provider, operation, model/version, token count, latency, confidence, cost/drift/hallucination/failure-mode fields when available. Never attach stripped text, prompts, fingerprints, emails, API keys, or document content.
- Together.ai, Vertex AI, and Gemini call paths are wrapped with `traceAiProviderCall`; exporter uses Arize's OTLP endpoint (`ARIZE_OTLP_ENDPOINT`, default `https://otlp.arize.com/v1`) and project name `ARIZE_PROJECT_NAME` (default `arkova-ai-providers`).

### Google Drive connector v2 (SCRUM-1099 / SCRUM-1100)

- `integrations/oauth/drive.ts` is the low-level Drive OAuth/watch client. Scope defaults are exactly `drive.file` + `drive.activity.readonly`; do not add broad Drive scopes without Jira/security review.
- `integrations/connectors/googleDrive.ts` coordinates OAuth completion, Secret Manager token storage, 7-day watch renewal, disconnect cleanup (`channels.stop` + OAuth revoke), and canonical rule-event shaping. Persistence is injected: connection metadata may store `tokenSecretName`, never raw access/refresh tokens.
- `rules/schemas.ts` + `rules/evaluator.ts` support Google Drive folder-bound rules via either the single AC shape `{ type: "drive_folder", folder_id, watch_channel_id }` or `drive_folders[]` for multiple folders. Evaluator matches Drive events by `payload.parent_ids`, `payload.file_id` / `external_file_id`, or optional resolved `folder_path`.

### DO / DON'T for this folder

- **DO** use `callRpc<T>(db, ...)` from `utils/rpc.ts` instead of `(db.rpc as any)(...)`.
- **DO** use `extractAuthUserId` + pass `userId` into handlers that need org scoping.
- **DO** fire-and-forget audit emits (`void emitRuleAudit(...)`) — never gate response latency on audit DB inserts.
- **DO** use `AbortSignal.timeout(ms)` for outbound `fetch` instead of manual `AbortController` + `setTimeout`.
- **DO** scope every write by `.eq('org_id', callerOrg)` on tables where the service_role client is used — RLS is bypassed.
- **DON'T** import `generateFingerprint` here — it's client-side only (CLAUDE.md §1.6).
- **DON'T** use `(db as any)` when the table is in `database.types.ts`; if you need the cast it means run `gen:types`.
- **DON'T** touch Cloud Run deployment config — human-only per `feedback_worker_hands_off`.

## Recent Changes

| Date | Sprint | Change |
|------|--------|--------|
| 2026-04-24 | SCRUM-1101/1102 | DocuSign connector continuation: `integrations/oauth/docusign.ts`, `integrations/connectors/docusign.ts`, and `api/v1/webhooks/docusign.ts` add OAuth helpers, DocuSign Connect HMAC verification, sanitized rules-event enqueue, and retryable `docusign.envelope_completed` job payloads. `api/rules-crud.ts` adds `POST /api/rules/:id/run`, org-admin auth, and 5/min/org in-memory rate limiting for manual rule executions. |
| 2026-03-10 ~12 PM | HARDENING-1 | 27 unit tests for `processAnchor()` + `processPendingAnchors()` (100% coverage on `anchor.ts`). Fixed silent audit event failure (BUG-H1-01). Deleted dead `anchorWithClaim.ts` (BUG-H1-02, BUG-H1-03). |
| 2026-03-10 ~2 PM | HARDENING-2 | 32 new tests: MockChainClient contract (18), getChainClient factory (5), job claim/completion flow (9). Total: 59 worker tests. 100% coverage on `anchor.ts`, `chain/mock.ts`, `chain/client.ts`. |
| 2026-03-10 ~4 PM | HARDENING-3 | 55 new tests: webhook delivery (30), Stripe client (7), Stripe handlers (18). Total: 114 worker tests. HMAC signature verification confirmed against `crypto.createHmac`. |
| 2026-03-10 ~5:20 PM | HARDENING-4 | 18 new tests: lifecycle integration (8), webhook dispatch wiring (10). Wired `dispatchWebhookEvent()` into `processAnchor()`. Added `processWebhookRetries` cron. Total: 132 worker tests. P7-TS-10 COMPLETE. |
| 2026-03-10 ~8 PM | HARDENING-5 | 96 new tests across 7 new test files: config (9), index (17), stripe/mock (9), jobs/report (19), jobs/webhook (12), utils/correlationId (12), utils/rateLimit (18). 80% thresholds on all. Total: 228 worker tests. Sprint COMPLETE. |
| 2026-03-10 ~11:30 PM | TYPE-FIX | Fixed pre-existing TS errors: `delivery.ts` (Json type cast for payload insert), `logger.ts` (pino CJS/ESM interop), `delivery.test.ts` (mock tuple/undefined casts), `client.test.ts` (missing afterEach import), `index.test.ts` (express importActual type). Synced `database.types.ts` from frontend. Zero TS errors across all source + test files. |
| 2026-03-11 | SONARQUBE | SonarQube remediation: S2068 credential fixes across test files, S6437 ReDoS regex replacements, S8215 Express disclosure fix, S2004 deeply nested mock flattening in load tests, security hotspot reviews (pseudorandom, CORS, CSRF, regex anchoring). All worker type errors resolved. |
| 2026-03-11 | P7-TS-11 | Wallet utilities: `chain/wallet.ts` (generateSignetKeypair, addressFromWif, isValidSignetWif), CLI scripts, 13 tests. |
| 2026-03-12 | P7-TS-12 | UTXO provider abstraction: `chain/utxo-provider.ts` (RpcUtxoProvider + MempoolUtxoProvider + factory), 35 tests. Broadcast tests added to signet.test.ts (3) and utxo-provider.test.ts (3). Integrated into SignetChainClient + getChainClient(). 363 total worker tests. |
| 2026-03-14 | H3-01 | Deleted dead `src/jobs/webhook.ts` + `src/jobs/webhook.test.ts` (superseded by `webhooks/delivery.ts`). Removed `webhook.ts` coverage entry from `vitest.config.ts`. |
| 2026-04-12 | NMT-09–16 | **Nessie continuation stories.** Eval regression pipeline (baseline-metrics.ts, 18 tests). Golden dataset phase 14 (120 entries, 14 tests). Domain router expanded with professional + identity groups (11 tests). Scripts: runpod-deploy-v5.ts, nessie-intelligence-distill-v2.ts, nessie-v7-export.ts. npm script: eval:regression. |
| 2026-03-12 | INFRA-01 | **Zero Trust Docker transformation.** Dockerfile converted to multi-process (Express + cloudflared sidecar). `entrypoint.sh` process manager created. `tunnel-config.yml` reference spec. `config.ts` extended with `cloudflareTunnelToken` + `sentryDsn`. `scripts/deploy-tunnel.sh` deployment script. NO ports exposed — all ingress via Cloudflare Tunnel. ADR-002: `docs/confluence/15_zero_trust_edge_architecture.md`. |

## Test Coverage Status (Final — HARDENING-5)

**1,043 worker tests across 67 test files. All pass 80%+ per-file thresholds.**

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
| ~~`src/jobs/webhook.ts`~~ | ~~deleted~~ | — | — | H3-01: dead code, superseded by `webhooks/delivery.ts` |
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
- `cloudflared` (binary, installed in Dockerfile) — Cloudflare Tunnel sidecar daemon
- Supabase JS client (`@supabase/supabase-js`) — database operations

## Zero Trust Architecture (INFRA-01)

The worker container runs **two processes** managed by `entrypoint.sh`:

1. **Express worker** (Node.js) — binds to `localhost:${PORT}` (default 3001), internal only
2. **cloudflared daemon** — creates outbound-only tunnel to Cloudflare's edge network

**Key files:**
- `Dockerfile` — multi-stage build, installs `cloudflared` binary (pinned version), NO `EXPOSE` directive
- `entrypoint.sh` — process supervisor: validates `CLOUDFLARE_TUNNEL_TOKEN`, starts Express, waits for health, starts tunnel, kills both on failure
- `tunnel-config.yml` — reference ingress spec (token mode uses Dashboard config, this is for local dev)
- ~~`scripts/deploy-tunnel.sh`~~ — planned but not yet created; tunnel creation done via Dashboard token mode

**Security invariants:**
- Container has NO public ports — direct IP:port access is impossible
- All traffic enters via Cloudflare Tunnel → Cloudflare WAF/DDoS → Access policies → worker
- `CLOUDFLARE_TUNNEL_TOKEN` injected via secrets manager, never logged
- Express health check runs inside container only (HEALTHCHECK directive)

## MVP Launch Gap Context
- **MVP-01 (Worker Production Deployment):** CRITICAL — deploy this service to GCP Cloud Run. Dockerfile is production-ready (multi-process with cloudflared). Needs: `.github/workflows/deploy-worker.yml`, GCP project config, env var secrets in Secret Manager, Cloud Run service definition. Cloudflare Tunnel token must be provisioned via `scripts/deploy-tunnel.sh`.
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
