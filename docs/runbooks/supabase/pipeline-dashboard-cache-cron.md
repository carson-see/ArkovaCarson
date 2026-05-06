# Pipeline Dashboard Cache Cron

This runbook is for SCRUM-1708. It installs or rolls back the production
`refresh-pipeline-dashboard-cache` pg_cron job without adding a migration while
the active migration-ledger stop flag is being reconciled.

## What This Does

- Unschedules every existing pg_cron job named `refresh-pipeline-dashboard-cache`.
- Creates exactly one active job with schedule `* * * * *`.
- Refuses to schedule the cron job unless the supporting
  `idx_anchors_pipeline_status` index is present, valid, and ready, or the
  SCRUM-1708 fast stats function is installed.
- Uses the required command:

```sql
SET statement_timeout = '50s'; SELECT refresh_pipeline_dashboard_cache();
```

It does not touch `vacuum-anchors`, `batch-anchors`, Cloud Scheduler jobs, or
any migration ledger rows.

The SCRUM-1708 fast stats function and optional supporting-index rebuild are
operational changes captured here instead of new migrations because the
production migration ledger has an active STOP-class numbering collision. Do not
add a migration for this slice until that ledger is reconciled.

## Preflight

```bash
export SUPABASE_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1)"
export SUPABASE_PROJECT_REF="ujtlwnoqfhtitcmsnrpq" # staging first
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts
```

Record the returned `cron_jobs` and `cache_rows` in the PR. Standing staging is
a soak artifact, not a clean production mirror, so evidence from it must be
labeled as staging-behavior evidence only.

Also record `support_indexes`:

- `idx_anchors_pipeline_status` must have `indisvalid=true`,
  `indisready=true`, and `indislive=true`.
- `index_progress` must be empty before applying the cron.
- If the support index is not valid, `stats_function.comment` must be
  `SCRUM-1708 fast cache refresh: avoids idx_anchors_pipeline_status dependency while the production support index is invalid.`
- After applying the cron, `latest_job_runs[0].status` must show the latest
  pg_cron result and `cache_rows[*].updated_at` must advance without a manual
  refresh.

## Install Fast Stats Function

Use this when production has no valid `idx_anchors_pipeline_status` and a
concurrent rebuild would take too long for the incident. This replaces only
`public.refresh_cache_pipeline_stats()` with a cache writer that avoids the
invalid support index dependency:

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --install-fast-stats-function
```

Then run one manual refresh before scheduling:

```sql
SELECT refresh_pipeline_dashboard_cache();
```

Expected result: JSON with `status: refreshed`, `succeeded: 6`, and an empty
`errors` array. Then run status and confirm `stats_function.comment` matches
the SCRUM-1708 fast stats comment and cache rows advanced.

## Rebuild Supporting Index

Only use this when there is enough operational room to wait for a full
concurrent rebuild. It drops only that index name, then schedules a one-time
pg_cron job to recreate it concurrently. The create runs through pg_cron because
the Supabase Management API can time out long concurrent index builds before
they finish. The script also temporarily sets `postgres` in database `postgres`
to `statement_timeout=0`, because pg_cron sessions otherwise inherit Supabase's
120s database default and cancel the concurrent index build before completion.

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --rebuild-support-index
```

Expected index definition:

```sql
CREATE INDEX CONCURRENTLY idx_anchors_pipeline_status
ON public.anchors (status, created_at DESC)
INCLUDE (chain_tx_id)
WHERE deleted_at IS NULL AND metadata ? 'pipeline_source';
```

Run status while the rebuild is active to capture `index_progress`, then run
status again after it finishes. Do not apply the refresh cron while
`index_progress` is non-empty or the index validity flags are false.

After the index is valid, clean up one-time rebuild jobs:

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --cleanup-support-index-rebuild-jobs
```

The cleanup command also resets the temporary `postgres` role/database
`statement_timeout` override.

## Apply on Staging

```bash
SUPABASE_PROJECT_REF="ujtlwnoqfhtitcmsnrpq" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --apply
```

Wait at least two minutes, then run the status command again. The
`pipeline_stats.updated_at` cache row should advance without a manual refresh.

## Apply on Production

Only apply after staging evidence has been captured and production preflight
shows either a valid supporting index or the SCRUM-1708 fast stats function.

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --apply
```

Postflight:

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts
```

Expected result:

- `cron_jobs` contains exactly one row.
- `jobname` is `refresh-pipeline-dashboard-cache`.
- `active` is `true`.
- `command` is `SET statement_timeout = '50s'; SELECT refresh_pipeline_dashboard_cache();`.
- `pipeline_stats.updated_at` advances within two cron ticks.

## Rollback

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --rollback
```

Rollback unschedules only jobs named `refresh-pipeline-dashboard-cache`.
