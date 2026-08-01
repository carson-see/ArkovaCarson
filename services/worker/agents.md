# agents.md — services/worker

_Last updated: 2026-08-01 (agents.md remediation: changelog split out)._

Express-based worker service handling privileged server-side operations: Merkle
batch anchoring, Stripe webhook verification, outbound webhook delivery, cron
scheduling, the rules engine, billing, and org tier/quota enforcement. Uses the
Supabase **service_role** key — never the anon key.

Per-directory detail lives in [`src/agents.md`](./src/agents.md) (key files +
the full subdirectory table). This file carries the cross-cutting rules.

## Live findings an agent must know before touching this code

- **Bitcoin is HYBRID, not sovereign** (2026-04-25, standing). Broadcast is
  GetBlock RPC; UTXO listing, fee estimation, and frontend balance enrichment
  still traverse public `mempool.space`. Read the path-by-path table below
  before changing chain code or making a sovereignty claim in customer-facing
  material.
- **In-process `node-cron` does NOT fire on Cloud Run.** Proven by the
  real-network soak: schedulers registered in `routes/scheduled.ts` go dormant
  under CPU throttling. Production cron is **Cloud Scheduler -> HTTP** against
  `routes/cron.ts`. A job wired only in-process silently never runs. Wire both,
  and treat the HTTP endpoint as the one that actually executes.
- **§1.6A connector-byte controls are enforced, not aspirational** (SCRUM-2492,
  2026-06-16). Six coupled mechanisms keep connector-fetched document bytes out
  of every leak sink: the `eslint-rules/no-connector-bytes-to-sink.cjs` rule,
  byte-safe-by-construction connector error types, `utils/logger.ts` type-based
  binary redaction, the `utils/sentry.ts` binary scrubber running FIRST,
  `utils/jobQueue.ts` `sanitizeLastError`, and the
  `jobs/connector-byte-safety.test.ts` runtime proof. Removing any one voids the
  CLAUDE.md §1.6A carve-out. Details in the changelog.
- **Never put a raw wallet address in limiter context, limiter state, or logs**
  (SCRUM-2705). The Nessie payer limiter keys only by an HMAC of the verified
  on-chain Transfer sender.
- Organization quota reads for rules/webhooks are authoritative but
  read-before-insert — they are **not** an atomic cross-instance hard cap. Only
  daily anchor usage is atomic (`increment_org_usage` RPC).

## Bitcoin paths — honest state (2026-04-25, SCRUM-1245)

After GetBlock partial restoration (revision `arkova-worker-00398-p77`, env-var-only update), production is in a **hybrid** state. Read this before changing any chain code or claiming sovereignty in customer-facing materials.

| Path | Provider | Sovereign? | Notes |
|---|---|---|---|
| Broadcast (`sendrawtransaction`) | GetBlock RPC | ✅ yes | Live as of `BITCOIN_UTXO_PROVIDER=getblock` flip 2026-04-25 |
| UTXO listing (`listunspent`) | GetBlock RPC → fallback to `mempool.space` | ❌ no | GetBlock shared endpoint returns "Method not allowed" — `utxo-provider.ts:459-474` `try { rpc } catch { mempool }` enters the catch branch every call. **Observability:** R1-8 / SCRUM-1262 added Sentry breadcrumb (category `chain.rpc-fallback`) + structured warn log (`chain_rpc_fallback: true`) on every fallback. R0-8 dashboard surfaces fallback rate; alert fires when stays at 100% (RPC functionally unused). |
| Fee estimation | `mempool.space` | ❌ no | `estimatesmartfee` IS supported by GetBlock (1013 sat/kvB confirmed), but worker has no `RpcFeeEstimator` and `BITCOIN_FEE_STRATEGY` only accepts `'static' \| 'mempool'` — needs code change + deploy |
| `getrawtransaction` / `getblockheader` | GetBlock RPC (verification pending) | ⚠️ likely yes — needs operator curl matrix | Used by `check-confirmations.ts:144` + `chain-maintenance.ts:140` reorg detection. Untested against prod GetBlock token; standard tx-indexed methods on GetBlock shared endpoints generally work. R1-8 / SCRUM-1262 deferred the curl matrix to operator (requires prod token access — see runbook in story description). If either fails, file R3 follow-up for second-source verification. |
| Frontend treasury balance polling | Browser → cached worker `treasury_cache` table → worker `/api/treasury/status` (8s timeout) → stale badge | ❌ no, but no longer leaks | R1-6 / SCRUM-1260: `useTreasuryBalance.ts` no longer falls through to direct mempool `address` polling on worker timeout — keeps last cached balance + flags stale instead. Mempool calls remain for receipts/price/fees enrichment (already-public address). |

**Signing path (separate concern):**
- `BITCOIN_TREASURY_WIF` in Secret Manager → decrypted into worker process memory at startup (current active signer)
- GCP KMS code path (`gcp-kms-signing-provider.ts`) — only selected when `bitcoinTreasuryWif` is unset
- `client.ts:279`: `// Signing: WIF takes precedence (current), KMS for future upgrade`
- `feedback_no_aws.md` — AWS branch in code is dead, never customer-facing

**Open follow-ups** (each will be a story under the recovery epic; do not roll into this story):
1. `RpcFeeEstimator` class + `'rpc'` value in `BITCOIN_FEE_STRATEGY` enum (`config.ts:43`) so fees can route through GetBlock too
2. ~~Frontend `useTreasuryBalance.ts` — kill direct browser hits to `mempool.space`~~ — partially done in R1-6 (balance no longer leaks); receipts/price/fees enrichment kept (R3 will move fully behind worker)
3. Full sovereignty: stand up Bitcoin Core + Electrs/Esplora and flip `BITCOIN_UTXO_PROVIDER=rpc`
4. WIF → KMS migration (or document a deliberate WIF retention decision in CLAUDE.md and stop claiming "GCP KMS (prod)")
5. ~~Observability counter for `listUnspent` fallback~~ — done in R1-8 / SCRUM-1262
6. **Operator action (R1-8):** run the curl matrix against prod GetBlock token for `getrawtransaction`, `getblockheader`, `getblockchaininfo`, `getblockcount`. Record results in [Forensic 1/8 Confluence page](https://arkova.atlassian.net/wiki/spaces/A/pages/27362208) and update the table above. If either reorg/confirmation method fails, file R3 follow-up for second-source verification.

## Treasury access policy (updated 2026-04-21)

Both `GET /api/treasury/status` AND `GET /api/treasury/health` are **platform-admin-only**. No carve-out for org admins. The health endpoint returns a narrower shape (USD + threshold + below flag only) but the access policy is identical.

## CIBA v1.0 env vars (see `docs/reference/ENV.md`)

`ENABLE_WEBHOOK_HMAC`, `ENABLE_RULES_ENGINE`, `ENABLE_QUEUE_REMINDERS`, `ENABLE_TREASURY_ALERTS`, `SLACK_TREASURY_WEBHOOK_URL`, `TREASURY_ALERT_EMAIL`, `TREASURY_LOW_BALANCE_USD`.

## AI observability (SCRUM-1067)

- `src/ai/observability.ts` initializes Arize AX tracing when `ARIZE_TRACING_ENABLED=true` and both `ARIZE_API_KEY` + `ARIZE_SPACE_ID` are present.
- Provider spans are metadata-only: provider, operation, model/version, token count, latency, confidence, cost/drift/hallucination/failure-mode fields when available. Never attach stripped text, prompts, fingerprints, emails, API keys, or document content.
- Together.ai, Vertex AI, and Gemini call paths are wrapped with `traceAiProviderCall`; exporter uses Arize's OTLP endpoint (`ARIZE_OTLP_ENDPOINT`, default `https://otlp.arize.com/v1`) and project name `ARIZE_PROJECT_NAME` (default `arkova-ai-providers`).

## Google Drive connector v2 (SCRUM-1099 / SCRUM-1100)

- `integrations/oauth/drive.ts` is the low-level Drive OAuth/watch client. Scope defaults are exactly `drive.file` + `drive.activity.readonly`; do not add broad Drive scopes without Jira/security review.
- `integrations/connectors/googleDrive.ts` coordinates OAuth completion, Secret Manager token storage, 7-day watch renewal, disconnect cleanup (`channels.stop` + OAuth revoke), and canonical rule-event shaping. Persistence is injected: connection metadata may store `tokenSecretName`, never raw access/refresh tokens.
- `rules/schemas.ts` + `rules/evaluator.ts` support Google Drive folder-bound rules via either the single AC shape `{ type: "drive_folder", folder_id, watch_channel_id }` or `drive_folders[]` for multiple folders. Evaluator matches Drive events by `payload.parent_ids`, `payload.file_id` / `external_file_id`, or optional resolved `folder_path`.

## DO / DON'T for this folder

- **DO** use `callRpc<T>(db, ...)` from `utils/rpc.ts` instead of `(db.rpc as any)(...)`.
- **DO** use `extractAuthUserId` + pass `userId` into handlers that need org scoping.
- **DO** fire-and-forget audit emits (`void emitRuleAudit(...)`) — never gate response latency on audit DB inserts.
- **DO** use `AbortSignal.timeout(ms)` for outbound `fetch` instead of manual `AbortController` + `setTimeout`.
- **DO** scope every write by `.eq('org_id', callerOrg)` on tables where the service_role client is used — RLS is bypassed.
- **DON'T** import `generateFingerprint` here — it's client-side only (CLAUDE.md §1.6).
- **DON'T** use `(db as any)` when the table is in `database.types.ts`; if you need the cast it means run `gen:types`.
- **DON'T** touch Cloud Run deployment config — human-only per `feedback_worker_hands_off`.

## Do / Don't Rules

- **DO** use `vi.hoisted()` for mutable mock state shared between `vi.mock()` factories and test code (avoids `ReferenceError: Cannot access before initialization`)
- **DO** mock `../config.js` and `../utils/logger.js` in every test file — they import from env vars that don't exist in test
- **DO** use `vi.fn()` chains (`.mockReturnThis()`, `.mockResolvedValueOnce()`) for Supabase client mocks
- **DON'T** call real Stripe or Bitcoin APIs — use mock interfaces
- **DON'T** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
- **DON'T** import `generateFingerprint` — fingerprinting is client-side only (Constitution 1.6)
- **DON'T** add OCR libraries (`pdfjs-dist`, `tesseract.js`) — OCR runs on the user's device (`src/lib/ocrWorker.ts`, Constitution 1.6). Both were removed as orphaned zero-importer `devDependencies`; needing one here means the design routes document content server-side, which 1.6 forbids
- **DON'T** modify existing migration files — write compensating migrations

## Test coverage gate

Per-file 80%+ coverage thresholds are enforced via
`services/worker/vitest.config.ts`. `scripts/ci/check-coverage-monotonic.ts`
blocks any PR that lowers a per-file threshold without the
`coverage-drop-allowed` label **and** a linked `coverage-restoration` Jira
ticket.

Test and file counts drift every sprint — read them from a run, not from this
file. (Last count recorded here: 4,682 tests across 363 test files, 2026-04-28.
The 2026-03-10 HARDENING-5 baseline table is in the changelog.)

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

---

Historical change log: [./agents-changelog.md](./agents-changelog.md)
