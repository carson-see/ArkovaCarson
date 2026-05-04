# SCRUM-1254 (R0-8) — Sentry Drift Telemetry Suite

> **Status:** alert config DOC. The actual Sentry alert rules are owned by
> the Sentry UI; this file is the source of truth for what they should be.
> Before/during R0-8 deployment, an admin opens
> https://arkova.sentry.io/alerts/rules/ and creates each rule below 1:1.
>
> **SCRUM-1308 (R0-8-FU2) update (2026-05-04):** structured spec is now in
> `infra/sentry/alert-rules.json` — copy-pasteable filter shapes per rule.
> The db-health-monitor emits an `alert_type` tag (`pg_cron_failure` /
> `dead_tuple_ratio` / `smoke_fail_streak` / `smoke_runtime`) so each rule
> below filters on its own class instead of message-substring matching.
> The Cloud Scheduler binding for `/cron/db-health` is now in
> `scripts/gcp-setup/cloud-scheduler.sh` (every 5 min, OIDC, retry 30s/120s).

## Five alerts

### Alert 1 — pg_cron failure rate

- **Source:** `services/worker/src/jobs/db-health-monitor.ts` invoked every 5 min via `POST /cron/db-health` (Cloud Scheduler).
- **Tag:** `source:db-health-monitor` `story:SCRUM-1254`
- **Sentry rule:** `Issue events tagged source:db-health-monitor where message contains "jobid="`
- **Action:** Slack #ops, severity error.
- **Page condition:** any single job fails 3 consecutive db-health runs (use Sentry's "Trigger after N occurrences within M minutes" — N=3, M=20).

### Alert 2 — Dead-tuple ratio

- **Source:** same monitor, message contains `Dead-tuple ratio on <table>`
- **Sentry rule:** `Issue events tagged source:db-health-monitor where message contains "Dead-tuple ratio"`
- **Action:** Slack #ops, severity error.
- **Page condition:** continuous for > 1 hour (12 db-health runs).

### Alert 3 — Smoke test fail-streak

- **Source:** message contains `Smoke test fail-streak: N consecutive failures` from db-health-monitor.
- **Trigger:** any single occurrence (the streak detection upstream already required 3 consecutive failures).
- **Page condition:** immediately on first event.

### Alert 4 — `count: 'exact'` baseline drift

- **Source:** CI step `count-exact-baseline` running `scripts/ci/check-count-exact-baseline.ts` on every PR.
- **Behavior:** PR is blocked at CI time, no Sentry needed for the block.
- **Bonus:** weekly cron (added later) emits a Sentry metric `code.count_exact_callsites` for trend visibility.

### Alert 5 — Cloud Run revision drift

- **Source:** `.github/workflows/revision-drift.yml` (R0-1).
- **Sentry rule:** issue tagged `source:revision-drift` and level=error.
- **Action:** Slack #ops, severity error.

## Single dashboard

Linked from `HANDOFF.md` "Now" entry. Surfaces:

- Cloud Run live SHA vs HEAD of main
- Smoke test pass/fail history (last 50 runs)
- Dead-tuple ratio trend on the 4 hot tables
- pg_cron job_run_details failure count (24h window)
- `count: 'exact'` callsite count over time (weekly)

Dashboard URL: TBD on first deploy.

## DoR / DoD

- [x] Sentry MCP connected.
- [x] Cron infrastructure exists (`services/worker/src/routes/cron.ts`).
- [x] R0-1 build SHA in /health (Alert 5 dependency).
- [ ] Cloud Scheduler binding for `/cron/db-health` (every 5 min) created post-merge.
- [ ] Five alert rules created in Sentry UI.
- [ ] Single dashboard URL recorded in HANDOFF.md "Now".

## Dependencies on follow-up sub-stories

- `get_recent_cron_failures(since_minutes int)` SECURITY DEFINER RPC reading `cron.job_run_details`.
- `get_table_bloat_stats(table_names text[])` SECURITY DEFINER RPC reading `pg_stat_user_tables`.

Both are filed as sub-stories under SCRUM-1254 and should land before the Cloud Scheduler binding. Until they exist, the monitor logs warnings but emits no false-positive Sentry events.
