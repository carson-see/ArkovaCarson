# services/worker/src/
_Last updated: 2026-08-03 (PR #1944 review: config.workerPublicUrl + run-lease.ts K_REVISION absorption)_

Root of the Arkova anchoring worker — a Node + Express service for backend processing (webhooks, cron, Bitcoin anchoring, billing, API).

## 2026-08-03 — PR #1944 review: two SCRUM-1258 (ad-hoc process.env) closes

- **`config.ts` gains `workerPublicUrl` (`WORKER_PUBLIC_URL`, optional, `z.string().url()`).** Added so `jobs/drive-subscription-renewal-deps.ts` (GH #1835) could resolve the worker's own public base URL through the Zod-validated config export instead of an ad-hoc env read. `integrations/oauth/docusign.ts`'s `requireConnectConfig` reads the SAME underlying var directly via its own `deps.env ?? process.env` passthrough (pre-existing, unaffected by this change) — reconciling that one onto `config.workerPublicUrl` too is a natural follow-up, not done here (out of scope for the PR that surfaced the gap).
- **`jobs/run-lease.ts`'s `runLeaseHolder()` now reads `config.kRevision` instead of `process.env.K_REVISION` directly.** This was a genuinely PRE-EXISTING SCRUM-1258 violation (confirmed present on a clean `origin/main` checkout, unrelated to any Drive work) — `config.ts` already absorbed `K_REVISION` into `kRevision` (the R1-4 critical-absorption pass), `run-lease.ts` just never switched over to it. Fixed alongside the Drive PR because leaving it meant the required "Dependency Scanning" CI check would stay red regardless of anything in that PR. `run-lease.test.ts`'s holder-identity tests now mock `config.js` directly (`config` is parsed once at module-import time, so mutating `process.env.K_REVISION` mid-test no longer has any effect on it).

## 2026-07-28 SOAK FINDING F-2 — per-IP limiter shadows per-API-key limiter (HIGH, open)

`index.ts:377` mounts a 60 req/min **per-source-IP** limiter on a broad `/api` prefix, ahead of the real 1,000/min-per-API-key limiter. All `/api/v1/*` traffic is capped at 60/min regardless of key tier — contradicts §1.10. This is why the 72h signet soak load plateaued at ~2.6 RPS against a 28 RPS target (a product defect, not rig capacity). Would throttle every paying customer at launch. Canonical writeup: `docs/staging/SOAK-FINDINGS-2026-08.md`. Anyone touching rate limiting in `index.ts` or `middleware/` must know this before adding/reordering limiter mounts.

## 2026-07-28 GET /api/health alias (pentest-prep, CLAUDE.md §1.9)

- `index.ts` extracted the inline `/health` handler into a named `healthCheckHandler` const and registers it at BOTH `app.get('/health', ...)` and `app.get('/api/health', ...)` — byte-identical handler, `/health` behavior unchanged. CLAUDE.md §1.9 asserts "/api/health always available" but only `/health` was ever mounted; confirmed live 404 on `/api/health` at both `api.arkova.ai` and the Cloud Run origin before this fix. Do not diverge the two routes — if `/health` ever needs route-specific behavior, keep `/api/health` wired to the same handler unless there's an explicit reason to split.

## 2026-07-21 SCRUM-2990 partner-provisioning surface is flag-gated (reserved prefix)

- `index.ts` mounts `/api/partner-provisioning` behind `partnerProvisioningGate()` (ENABLE_PARTNER_PROVISIONING switchboard flag; fail-closed — absent/false/read-error → 404, surface dark; no env fallback). No routes exist under the prefix yet (the SCRUM-2990 skeleton is a pure state machine; table + routes are post-window). ANY future partner-provisioning router MUST mount under this prefix so it inherits the gate — `src/api/partner-provisioning.guard.test.ts` asserts the wiring.

## 2026-07-06 S3-P0 / DISC-03 config note

- `config.ts` `bitcoinUtxoProvider` Zod default flipped `'mempool'` → `'getblock'` (closes the acknowledged DISC-03 code-default-divergence WARN; prod deploy env + both R-5 expected-config JSONs already assert "getblock"). A getblock env without `BITCOIN_RPC_URL` now fails LOUDLY at chain-client init instead of silently degrading broadcast to the public mempool API. Mock/dev paths (USE_MOCKS / prod-anchoring off) are unaffected.

## 2026-05-20 AI Fraud Safety Note

- `config.ts` documents `ENABLE_VISUAL_FRAUD_DETECTION` as a legacy gate. The server route is fail-closed pending SCRUM-1955 client-side worker rearchitecture; do not re-enable server-side document/image byte processing in fraud paths.

## 2026-05-21 PR #841 Containment Note

- `config.ts` exposes `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY`, default false. Keep CPE/CLE professional-education runtime paths disabled until prod schema and migration-ledger reconciliation is complete.

## 2026-05-29 PR #877 Version Resolution Mount Note

- `index.ts` must mount `/api/v1/versions` with `requireVersionOrgAdminContext` before `versionResolutionRouter`; do not rely on the router to attach org context internally.

## Key Files

- **index.ts** — Express app compositor. Mounts routers, Sentry, compression, Stripe webhook handler, public badge endpoint, and cron scheduler. Slim (~100 lines); route handlers live in `routes/`.
- **config.ts** — Zod-validated environment config. All secrets from env vars, never logged. Exports singleton `config`.
- **auth.ts** — JWT verification: local `jose` verification (preferred) with Supabase API fallback.
- **config.test.ts** / **auth.test.ts** / **index.test.ts** — Unit tests for config parsing, auth, and app bootstrap.
- **mcp-*.test.ts** / **memory-leaks.test.ts** — MCP tool schema tests, kill-switch tests, origin allowlist tests, memory leak tests.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | Versioned HTTP API routes (`/api/v1/*`) |
| `audit/` | Cloud Logging sink for audit events |
| `billing/` | Metered billing, payment guard, reconciliation |
| `chain/` | Bitcoin chain client (OP_RETURN anchoring) |
| `compliance/` | Compliance-specific logic |
| `constants/` | Shared enum constants (connectors, FERPA, HIPAA, webhook paths) |
| `email/` | Email sender infrastructure (Resend SDK) |
| `emails/` | Individual email templates (grace warning, delinquent split) |
| `infra/` | Infrastructure tests (Cloudflare Tunnel sidecar) |
| `integrations/` | Third-party connector integrations (Drive, DocuSign, ATS) |
| `jobs/` | Background cron jobs (anchoring, confirmations, billing, sweeps) |
| `lib/` | Shared domain libraries (credential evidence, URLs) |
| `middleware/` | Express middleware (auth, rate limits, feature gates, HMAC) |
| `notifications/` | In-app notification dispatcher |
| `proof/` | Signed proof bundles (KMS Ed25519) |
| `routes/` | Express router modules (billing, anchor, admin, cron) |
| `rules/` | Rules engine (evaluator, schemas, sanitizer) |
| `signatures/` | Signature utilities |
| `stripe/` | Stripe SDK client, webhook handlers, mock |
| `test-utils/` | Test helpers (migration reader) |
| `tests/` | Cross-cutting integration and chaos tests |
| `types/` | Shared TypeScript types (generated DB types, ambient decls) |
| `utils/` | Utility modules (logger, DB, Sentry, rate limiter, RPC) |
| `webhooks/` | Outbound webhook dispatch |

## Rules

- No Next.js API routes for long-running jobs (Constitution).
- `generateFingerprint` is client-side only — never import it here.
- All secrets from env vars; treasury keys never logged.
- `anchor.status = 'SECURED'` is worker-only via service_role.
