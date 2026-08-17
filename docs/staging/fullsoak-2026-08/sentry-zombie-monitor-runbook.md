# Sentry zombie cron-monitor cleanup — runbook (needs founder auth)

**2026-08-17. Inventory verified via Sentry MCP; deletions BLOCKED — no credential with
monitor-write scope exists anywhere (Secret Manager has only the write-only `sentry-dsn`;
the MCP catalog has no cron-monitor mutation tools). ~93,000 noise events across 12 issues
continue until these 16 deletions are made (~2 min in the UI once signed in).**

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

## Then resolve these 12 issues (they stop recurring once the envs are gone)

webhook-retries: ARKOVA-WORKER-1S, -20, -23, -27 · check-confirmations: -1T, -1Z, -21, -26 · process-revocations: -1V, -1Y, -22, -28

## Verified healthy and untouched

All 10 monitors' `production` environments checked in 19:00–19:05Z. Both repair-related
alert streams (ARKOVA-WORKER-2M batch-insert fallback, ARKOVA-WORKER-2W linker-stall
fatal) stopped at 18:00:02Z — final events, silent for 6+ cycles after the poison-row
repair. 2M/2W safe to resolve after a few more clean cycles.
