# services/worker/src/
_Last updated: 2026-07-06 (S3-A back-catalogue classifier confirm token)_

Root of the Arkova anchoring worker — a Node + Express service for backend processing (webhooks, cron, Bitcoin anchoring, billing, API).

## 2026-07-06 S3-A Classifier Confirm Token

- `config.ts` exposes `proofClassifierConfirm` (`PROOF_CLASSIFIER_CONFIRM`, optional). The S3-A back-catalogue classifier (`jobs/proof-backcatalog-classifier.ts`) is dry-run-only unless this equals `EXECUTE` AND the caller passes `execute=true`. Deliberately a SEPARATE token from `PROOF_BACKFILL_CONFIRM` so arming one proof write-job never arms the other.

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
