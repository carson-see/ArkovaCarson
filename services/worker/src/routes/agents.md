# services/worker/src/routes/agents.md

Express routers + scheduler wiring. Two flavors of cron: in-process (dev/test backup) and HTTP-triggered (Cloud Scheduler in prod).

## Files
- `cron.ts` — HTTP-triggered cron endpoints. Cloud Scheduler hits these. Includes `POST /jobs/anchor-expiry-sweep` (SCRUM-1736).
- **`scheduled.ts`** — in-process backup `cron.schedule()` calls. Includes the `ANCHOR_TABLE_IN_PROCESS_JOBS` allowlist that gates which jobs are skipped in production when `DISABLE_IN_PROCESS_ANCHOR_CRON=true`. **SCRUM-1736 added `anchor-expiry-sweep` (daily `0 3 * * *`)** to both the schedule and the allowlist; without the allowlist entry the in-process job would still fire even with the maintenance flag on, defeating the point.
- `lifecycle.ts` — graceful-shutdown tracking via `trackOperation()`.
- `agents.ts`, `webhooks.ts`, `attestations.ts`, etc. — domain routers.

## Conventions
- Every cron endpoint wraps work in `trackOperation(...)` so SIGTERM drains in-flight jobs.
- Errors are logged with `{error, jobName}` context and never re-thrown (Cloud Scheduler treats non-200 as retry-eligible).
- HTTP-triggered jobs are protected by `X-Cron-Secret` per AUDIT-03 (handled in middleware before this router).
- In-process schedules are conditional: `chainInitialized` guard for chain-touching jobs; `disableInProcessAnchorCron` guard for `anchors`-table jobs.

## Open work
- SCRUM-1736 (PR #734) — `scheduled.ts` test counts updated for the new entry (3/3 tests pass after counter bump from 13/8/5 to 14/9/5).
