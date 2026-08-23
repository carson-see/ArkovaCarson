# Sentry zombie cron-monitor cleanup — runbook

**2026-08-18 UPDATE — alerting problem CLOSED via Sentry MCP.** All 12 zombie issues were
set to **ignored (forever)** with activity-feed comments, and the two repair-related storms
(ARKOVA-WORKER-2M, -2W) were **resolved** — all via `update_issue`, 2026-08-18. The noise
stops regardless of monitor existence; new missed check-ins from the dead envs accrue
silently to the ignored issues.

What remains is quota hygiene only: the 16 monitor-environment deletions below. Verified
2026-08-18 (three `search_sentry_tools` sweeps): the MCP's cron-monitor surface is
read-only (`find_monitors`/`get_monitor_details`; full mutation exists only for *uptime*
monitors), and no monitor-write credential exists in our infra — Secret Manager holds only
the write-only `sentry-dsn`, CI emits via the DSN envelope API, and the vite
`SENTRY_AUTH_TOKEN` is a Vercel-side releases-scoped sourcemap token. The deletions take
~2 min in the UI when signed in; they are no longer blocking anything.

## Correction to the earlier hypothesis

The zombie environments are NOT launch-72h/legacy-soak. They are five other dead
environments (env name = K_SERVICE), none of which exist in Cloud Run any more:
`arkova-worker-t3-migration-soak`, `arkova-worker-folders-1657-soak`,
`arkova-worker-maxsoak-154f9ff2`, `arkova-worker-docusign-soak`, and `development`
(last check-in 2026-05-20). The fullsoak rig appears in NO monitor environment.

## The 16 deletions (Sentry UI: Insights → Crons → monitor → env selector → Delete Environment)

| Monitor | Delete these environments |
|---|---|
| `webhook-retries` | t3-migration-soak, folders-1657-soak, maxsoak-154f9ff2, docusign-soak, development |
| `check-confirmations` | same 5 |
| `process-revocations` | same 5 |
| `grace-expiry-sweep` | development |

API alternative (org auth token): `DELETE https://us.sentry.io/api/0/organizations/arkova/monitors/{slug}/?environment={env}` — **the `environment` param is mandatory; omitting it deletes the entire monitor.** NEVER delete any monitor's `production` environment.

## The 12 issues — DONE 2026-08-18 (ignored forever via MCP `update_issue`)

webhook-retries: ARKOVA-WORKER-1S, -20, -23, -27 · check-confirmations: -1T, -1Z, -21, -26 · process-revocations: -1V, -1Y, -22, -28

After the env deletions land, these can be flipped to resolved; until then ignored-forever
is the correct state (resolve would regress on the next missed check-in).

## Verified healthy and untouched

All 10 monitors' `production` environments checked in 19:00–19:05Z. Both repair-related
alert streams (ARKOVA-WORKER-2M batch-insert fallback, ARKOVA-WORKER-2W linker-stall
fatal) stopped at 18:00:02Z — final events, silent for 6+ cycles after the poison-row
repair. **2M/2W resolved 2026-08-18** after 18+ silent hours, with root-cause comments
linking the poison-record repair and draft PRs #2266/#2267 (2M) and #2254 (2W).
