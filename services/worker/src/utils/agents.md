# services/worker/src/utils/agents.md

Shared utilities consumed across the worker. Each file is small and single-purpose. Test colocated as `<name>.test.ts`.

## Files
- `db.ts` — Supabase service-role client. Lazy-initialized; throws if env not set.
- `logger.ts` — pino logger with PII scrubbing (CLAUDE.md §1 Sentry rule).
- `rpc.ts` — typed `callRpc()` wrapper over `db.rpc()` with consistent error logging.
- `apiKeys.ts` — HMAC-SHA256 hash of raw API keys. Keep in sync with `services/edge/` and the `validate_api_key` RPC (migration 0299) which uses the same secret.
- `orgCredits.ts` — `deductOrgCredit()` wraps the `deduct_org_credit` RPC. Returns `{allowed, error?, balance?, required?}` shape that v1 anchor-submit consumes.
- `anchorCreditGate.ts` (SCRUM-1631 PR #680) — shared 402/503 response helper around `deductOrgCredit`. Returns `false` when a response has been written; caller early-returns.
- **`anchorQuotaGate.ts` (SCRUM-1740, PR #738)** — sandbox quota gate. Reads `org_credits.{is_test, anchor_quota}` and counts non-deleted anchors for the org. Returns 402 problem+json (`type=https://arkova.ai/errors/quota-exhausted`) when at/over cap. No-op for prod orgs (anchor_quota IS NULL). **Fails OPEN** on transient DB read errors — sandbox quota is a soft cap, not a security boundary; 8 unit tests cover every branch including fail-open.
- `orgSuspensionGuard.ts` (SCRUM-1667) — sub-org suspension check.
- Various: `sentry.ts`, `telemetry.ts`, `correlationId.ts`, `cors.ts`, `rateLimit.ts` (legacy v1), `validation.ts`, `urls.ts`, etc.

## Conventions
- Every utility that touches the DB takes the `SupabaseClient` as a parameter (not imported) so tests don't need to `vi.mock('./db.js')` on every file.
- Fail-closed for security gates (auth, scope). Fail-open for soft business gates (sandbox quota, soft rate limits) with loud logging.
- Zod validation at the helper boundary so callers don't need to repeat schema parsing.

## Open work
- SCRUM-1740 (PR #738) — quota gate awaits merge.
