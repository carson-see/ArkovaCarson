# services/worker/src/routes/agents.md

Express routers + scheduler wiring. Two flavors of cron: in-process (dev/test backup) and HTTP-triggered (Cloud Scheduler in prod).

## Files
- `cron.ts` — HTTP-triggered cron endpoints. Cloud Scheduler hits these. Includes `POST /jobs/anchor-expiry-sweep` (SCRUM-1736).
- `cron.ts` — PR #841 containment: `POST /jobs/professional-education-extraction` returns 503 while `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false` so prod cannot query missing CPE/CLE schema objects.
- **`scheduled.ts`** — in-process backup `cron.schedule()` calls. Includes the `ANCHOR_TABLE_IN_PROCESS_JOBS` allowlist that gates which jobs are skipped in production when `DISABLE_IN_PROCESS_ANCHOR_CRON=true`. **SCRUM-1736 added `anchor-expiry-sweep` (daily `0 3 * * *`)** to both the schedule and the allowlist; without the allowlist entry the in-process job would still fire even with the maintenance flag on, defeating the point.
- `lifecycle.ts` — graceful-shutdown tracking via `trackOperation()`.
- `agents.ts`, `webhooks.ts`, `attestations.ts`, etc. — domain routers.

## Conventions
- Every cron endpoint wraps work in `trackOperation(...)` so SIGTERM drains in-flight jobs.
- Errors are logged with `{error, jobName}` context and never re-thrown (Cloud Scheduler treats non-200 as retry-eligible).
- HTTP-triggered jobs are protected by `X-Cron-Secret` per AUDIT-03 (handled in middleware before this router).
- In-process schedules are conditional: `chainInitialized` guard for chain-touching jobs; `disableInProcessAnchorCron` guard for `anchors`-table jobs.

## Recent changes

- 2026-06-01 (`admin.ts`): mounted the platform-admin org roster/search/add routes (handlers in `api/admin-org-members.ts`): `GET /admin/users/search` (registered **before** `/admin/users/:id` so "search" isn't captured as an `:id` param), `GET /admin/organizations/:id/members`, `POST /admin/organizations/:id/members`. Same `extractAuthUserId` → 401 / `isPlatformAdmin` → 403 envelope as the other admin routes.
- SCRUM-2210 (`billing.ts`): added `GET /api/billing/status` → `handleBillingStatus`. This is the `BillingInfo` endpoint the frontend `BillingPage` has always fetched but that was never implemented (`billingRouter` only had `/checkout/session` + `/billing/portal`) → 404 → billing page bricked. **Returns 200 on every normal path** with a usable `BillingInfo` — a free-tier default when the caller has no subscription, and a best-effort usage count (scoped by `org_id`, or by `user_id` for individual/non-org plans; `recordsUsed` falls back to 0 if the `anchors` count errors/times out) so a downstream failure can't brick billing (the SCRUM-1983 / SCRUM-2213 lesson). **The only 500 is a hard failure of the primary subscription lookup itself.** Read-only; uses `rateLimiters.api` (60/min).
- PR #924 (SCRUM-2040/2041): added `/nonce-sweep` and `/connector-health-check` cron routes. Connector health route now checks `result.ok` and returns 500 on persist failure (fail-close, matching docusign-reconciliation pattern).

## Open work
- SCRUM-1736 (PR #734) — `scheduled.ts` test counts updated for the new entry (3/3 tests pass after counter bump from 13/8/5 to 14/9/5).
