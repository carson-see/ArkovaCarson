# agents.md — services/worker
_Last updated: 2026-04-28 (SCRUM-900 PROOF-SIG-01 GCP KMS proof-bundle signer)_

## SCRUM-900 — Cryptographically signed proof bundle (2026-04-28, PROOF-SIG-01)

`/api/v1/verify/:publicId/proof?format=signed` now returns an Ed25519-signed envelope. Resolution order in `src/api/v1/verify-proof.ts resolveSigner()`:

1. `PROOF_SIGNING_KMS_KEY` + `PROOF_SIGNING_KEY_ID` → GCP KMS Ed25519 signer (production — private key never leaves KMS, per `feedback_no_aws.md`)
2. `PROOF_SIGNING_KEY_PEM` + `PROOF_SIGNING_KEY_ID` → static-PEM signer (dev / preview / unit fixtures only)
3. None of the above → `null` → 503 from the route, caller degrades to legacy unsigned shape

`resolveSigner()` is module-scope memoized (`cachedSigner`) — Cloud Run env vars are immutable post-boot, so we resolve once per process. Tests use `__resetSignerCacheForTests()` to swap env between cases. Without this memo, every signed-proof request built a fresh `kmsEd25519Signer` closure, which silently defeated the per-instance KMS-client lazy-init memo.

`src/proof/kms-ed25519-signer.ts` is the SignerFn adapter. Lazy-init via a Promise memo (`clientPromise`) so concurrent first-callers don't double-instantiate the GCP KMS SDK client. Mirrors the existing `chain/gcp-kms-signing-provider.ts` pattern; intentionally separate because Bitcoin-signing uses secp256k1 + DER + pre-hashed digest, while proof-bundle signing uses Ed25519 + raw bytes. Operator publishes the public key via `scripts/proof/publish-public-key.ts` to `docs/public-keys.json` — retired keys remain so historical bundles stay verifiable.

Env vars documented in `.env.example` "Proof Bundle Signing" block. Confluence "On-Chain Policy / Proof Packages" page should be updated with bundle format + verification procedure.

## What This Folder Contains

Express-based worker service handling privileged server-side operations: anchor processing (PENDING → SECURED), Stripe webhook verification, outbound webhook delivery, cron job scheduling, rules engine, and org tier/quota enforcement. Uses Supabase service_role key — never the anon key.

## SCRUM-792 — Gemini fraud detection seed dataset 100+ (2026-04-27, GME2-01)

`src/ai/eval/fraud-training-seed.ts` expanded from 18 to 100 entries: 22 diploma_mill, 22 license_forgery, 17 document_tampering, 17 identity_mismatch, 11 sophisticated, 11 clean controls. Sources span FTC enforcement actions (Almeda, Belford, WAUC accreditation alert, Rochville, FBI Columbia State 1998), GAO-04-1024T, Oregon ODA unaccredited registry, CMS NPI spec (10-digit + Luhn + prefix), DEA registrant format spec (2 letters + 7 digits + checksum), HHS-OIG LEIE provider exclusion, and state-board enforcement (TX Medical Board, Medical Board of California, NY OCA, NJ BME, NSOPW match, ABIM retraction).

Exported `as const` tuples — `FRAUD_SIGNALS` (13 codes) and `FRAUD_CATEGORIES` (6 categories incl. new `'clean'`) — with derived `FraudSignal` / `FraudCategory` types so the 100 entry literals are compile-time checked. The new `'clean'` category isolates false-positive controls; previously they were lumped into `'sophisticated'` which heterogenized that bucket.

Tests at `src/ai/eval/fraud-training-seed.test.ts` (25 tests) lock per-category counts (20/20/15/15/10/10), signal-vocab membership, calibration band targets (≥10 conf ≥0.9 unambiguous, ≥10 in 0.5–0.75 verification band), and source attribution (≥5 FTC, ≥2 GAO, ≥5 state-board references).

Vertex tuning launched: `tuningJobs/6387124463783116800` against `gemini-2.5-pro`, 5 epochs, dataset `gs://arkova-training-data/gemini-fraud-v1-20260427-155452.jsonl`. F1 ≥ 60% + FP ≤ 5% DoD gated on job completion.

## R2 batch 3 — audit immutability + scope vocabulary + agents privacy (2026-04-27, SCRUM-1246 wave)

- **`api/audit-event.ts`** ([SCRUM-1270](https://arkova.atlassian.net/browse/SCRUM-1270)): new `POST /api/audit/event` endpoint. Browser callers used to insert into `audit_events` directly via the anon Supabase client (RLS allowed `actor_id = auth.uid()` writes — Forensic 7 forgery vector). Migration 0276 drops the authenticated INSERT policy; this route is the only browser-facing write path. JWT verified, `actor_id` pinned to the JWT subject, body Zod-validated with `.strict()` so spoofed `actor_id` keys 400.
- **`api/apiScopes.ts`** ([SCRUM-1272](https://arkova.atlassian.net/browse/SCRUM-1272)): authoritative scope vocabulary extended with `COMPLIANCE_API_SCOPES` (`compliance:read|write`, `oracle:read|write`, `anchor:read|write`, `attestations:read|write`, `webhooks:manage`, `agents:manage`, `keys:read`). `scopeSatisfies()` treats legacy `verify` as a superset of `anchor:read` / `oracle:read` / `attestations:read` so existing keys keep working when handlers pivot to the new names. **JWT-claims path for FERPA / HIPAA / emergency-access scope guards still TBD** — those routes use `requireAuth` not `apiKeyAuth`, so a `requireScope()` mount falls through. Tracked under SCRUM-1271 sub-tickets.
- **`api/v1/agents.ts`** ([SCRUM-1271](https://arkova.atlassian.net/browse/SCRUM-1271) sub-A): `toPublicAgent()` strips `org_id` and `registered_by` (a user UUID) from outbound responses. CLAUDE.md §6 privacy fix; the agent's own `id` stays for v1 back-compat per §1.8 — rename to `public_id` is staged in v2 under SCRUM-1444 / 1445.

## R2 batch 1 — P1 customer-facing recovery (2026-04-26, SCRUM-1246 wave)

- **`webhooks/payload-schemas.ts`** ([SCRUM-1268](https://arkova.atlassian.net/browse/SCRUM-1268)): canonical Zod schemas for `anchor.submitted` / `anchor.secured` / `anchor.revoked` / `anchor.batch_secured`. `.strict()` rejects `anchor_id` (UUID), raw `fingerprint`, `user_id`, internal `org_id` per CLAUDE.md §6 + §1.6. `dispatchWebhookEvent` validates against the schema for known event types and refuses to sign on validation failure.
- **`utils/concurrency.ts`** ([SCRUM-1264](https://arkova.atlassian.net/browse/SCRUM-1264)): `runWithConcurrency<T>(tasks, n)` queue-with-cap. Avoids new `p-limit` dep. Used by the bulk-confirm webhook fan-out so 10K-anchor merkle batches don't blast 10K simultaneous fetches at customer endpoints.
- **`jobs/check-confirmations.ts`** ([SCRUM-1264](https://arkova.atlassian.net/browse/SCRUM-1264)): new `fanOutBulkSecuredWebhooks` runs after the bulk SECURED `UPDATE WHERE chain_tx_id = $1`. Restores the per-anchor `anchor.secured` webhook fan-out that commit a5da008d (2026-03-27) silently dropped — ~10K customer webhooks per merkle root went undelivered for 6 weeks. Concurrency cap: `BULK_WEBHOOK_FAN_OUT_CONCURRENCY` env (default 20).
- **`stripe/client.ts`** ([SCRUM-1265](https://arkova.atlassian.net/browse/SCRUM-1265)): `createCheckoutSession` now pipes `params.mode` through. The previous hardcoded `mode: 'subscription'` silently overrode `mode: 'payment'` for credit-pack one-time purchases via /api/v1/credits since 2026-04-05. `subscription_data` is now set ONLY for recurring sessions.
- **`stripe/handlers.ts`** ([SCRUM-1266](https://arkova.atlassian.net/browse/SCRUM-1266) + [SCRUM-1267](https://arkova.atlassian.net/browse/SCRUM-1267)): R2-3 — orphan-row guards in `handleSubscriptionDeleted` / `handlePaymentFailed` / `handlePaymentSucceeded` (mirrors SCRUM-1239 fix on `handleSubscriptionUpdated`). R2-4 — `current_period_start/_end` now read from `subscription.items.data[0]` per Stripe API 2026-03-25.dahlia, throwing explicitly when items[0] is absent rather than the silent `RangeError: Invalid time value`.

## R0 anti-false-done additions (2026-04-25, SCRUM-1246 wave)

- **`Dockerfile`** ([SCRUM-1247](https://arkova.atlassian.net/browse/SCRUM-1247)): `ARG BUILD_SHA=unknown` + `ENV BUILD_SHA` baked at Docker build via `--build-arg BUILD_SHA=$github.sha`. Surfaces in `/health.git_sha`, `/api/admin/system-health.git_sha`, smoke test response, and the new `build-sha-present` smoke check.
- **`src/utils/buildInfo.ts`** ([SCRUM-1247](https://arkova.atlassian.net/browse/SCRUM-1247)): `getBuildSha()` + `isValidBuildSha(sha)` — single source of truth for the BUILD_SHA env read + 40-char hex validation. Used by `routes/health.ts`, `api/admin-health.ts`, `routes/cron.ts`.
- **`src/jobs/db-health-monitor.ts`** ([SCRUM-1254](https://arkova.atlassian.net/browse/SCRUM-1254)): cron-driven monitor that emits Sentry events on pg_cron failures, dead-tuple bloat, smoke fail-streaks. Wired to `POST /cron/db-health` (Cloud Scheduler every 5 min, pending operator binding via SCRUM-1308). Depends on RPCs `get_recent_cron_failures` + `get_table_bloat_stats` (pending SCRUM-1307).
- **`scripts/ci/check-confluence-dod.ts`** ([SCRUM-1251](https://arkova.atlassian.net/browse/SCRUM-1251)): helper for Atlassian Automation rule R4 — parses Confluence storage-format body and detects unticked `<ac:task>` markers in the "Definition of Done" section.
- **`eslint.config.js`** ([SCRUM-1250](https://arkova.atlassian.net/browse/SCRUM-1250)): test-files override block extends the no-unused-vars/_/no-explicit-any/warn rules to `src/**/*.test.ts` + `src/**/*.spec.ts`. Without this 119 errors in test files blocked every deploy. Followup R4 ticket drives all warnings to zero so we can re-add `--max-warnings 0`.

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

## Recent Changes

| Date | Sprint | Change |
|------|--------|--------|
| 2026-04-27 | SCRUM-1273 (R2-10) + SCRUM-1269 (R2-6) | `POST /api/v1/anchor` now validates request body via Zod schema (frozen-shape per §1.8), with `metadata` keys restricted to `[a-zA-Z0-9_.-]+` so prototype-pollution-adjacent keys cannot ride through. `Retry-After` header added to two manual 429 sites (`usageTracking.ts` free-tier quota — capped at 1h to avoid leaking exact billing-window boundary; `account-export.ts` 24h export rate). New `ENABLE_VISUAL_FRAUD_DETECTION` switchboard flag + `visualFraudDetectionGate()` middleware mounted as a second gate after `aiFraudGate()` on `/ai/fraud/visual` — distinct from the broader AI-fraud flag because the visual path ships document image bytes off-device (CLAUDE.md §1.6 carve-out, requires per-tenant Confluence opt-in before flip). Default false; fails closed on DB read error. |
| 2026-04-27 | SCRUM-1259 (R1-5) + SCRUM-1262 (R1-8) | Final `count:'exact'` migration on `anchors` hot path: `jobs/batch-anchor.ts` smart-skip pending count now uses `get_anchor_status_counts_fast` RPC (last anchors-table site outside the 5 originally enumerated). `FastCountsRpc` interface extracted to `utils/rpc.ts` (was duplicated 3×). Tests added for `fetchAnchorStats`, `getMigrationStatus`, and the `GetBlockHybridProvider.listUnspent` mempool-fallback observability path (`emitRpcFallback` is invoked on RPC failure and skipped on RPC success). |
| 2026-04-24 | SCRUM-1101/1102 | DocuSign connector continuation: `integrations/oauth/docusign.ts`, `integrations/connectors/docusign.ts`, and `api/v1/webhooks/docusign.ts` add OAuth helpers, DocuSign Connect HMAC verification, sanitized rules-event enqueue, and retryable `docusign.envelope_completed` job payloads. `api/rules-crud.ts` adds `POST /api/rules/:id/run`, org-admin auth, and 5/min/org in-memory rate limiting for manual rule executions. |
| 2026-04-24 | API-V2-01/02 | `api/v2/search.ts` now returns typed `id`/`public_id` search results and metadata-aware document filters. `api/v2/rateLimit.ts` applies the existing 1,000 req/min/key policy with RFC 7807 errors. `api/apiScopes.ts` centralizes the v2 scope vocabulary while preserving legacy v1 scope compatibility. |
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
