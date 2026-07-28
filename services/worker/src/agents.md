# services/worker/src/
_Last updated: 2026-07-28 (pentest-prep: /api/health alias)_

Root of the Arkova anchoring worker — a Node + Express service for backend processing (webhooks, cron, Bitcoin anchoring, billing, API).

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
