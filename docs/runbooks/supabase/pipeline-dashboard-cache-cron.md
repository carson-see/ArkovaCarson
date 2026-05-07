# Pipeline Dashboard Cache Cron

This runbook is for SCRUM-1708. It installs or rolls back the production
`refresh-pipeline-dashboard-cache` pg_cron job without adding a migration while
the active migration-ledger stop flag is being reconciled.

## What This Does

- Unschedules every existing pg_cron job named `refresh-pipeline-dashboard-cache`.
- Creates exactly one active job with schedule `*/2 * * * *`.
- Refuses to schedule the cron job unless the supporting
  `idx_anchors_pipeline_status` index is present, valid, and ready.
- Uses the required command:

```sql
SET statement_timeout = '120s'; SELECT refresh_pipeline_dashboard_cache();
```

It does not touch `vacuum-anchors`, `batch-anchors`, Cloud Scheduler jobs, or
any migration ledger rows.

The SCRUM-1708 fast stats function and supporting-index rebuild are
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
- If the support index is not valid, stop and run the support-index rebuild
  before applying the cron.
- After applying the cron, `latest_job_runs[0].status` must show the latest
  pg_cron result and `cache_rows[*].updated_at` must advance without a manual
  refresh.

## Install Fast Stats Function

This replaces `public.refresh_cache_pipeline_stats()` with a pipeline-only cache
writer which uses the `idx_anchors_pipeline_status` support index for hot
anchor-status buckets. `pending_record_links` is estimated from `pg_stats`
`public_records.anchor_id` null fraction and marked with
`pending_record_links_approximate=true`; the prior exact count remained a hot
path that could consume roughly 10 seconds on production-scale data.

This step also installs `public.refresh_pipeline_dashboard_cache()` as a
non-overlapping wrapper using `pg_try_advisory_xact_lock(8675309, 1)` and
`statement_timeout=110s`. The wrapper keeps each cache-key refresh isolated in
its own exception block and returns `status: skipped` if a manual/worker refresh
is already in progress.

It also replaces the broad distribution cache writers
(`anchor_status_counts`, `by_source`, `anchor_type_counts`, and `record_types`)
with bounded pg_stats-backed writers so the master refresh does not time out on
full-table grouping queries.

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
`errors` array. Then run status and confirm:

- `stats_function.comment` matches the SCRUM-1708 pipeline-only fast stats
  comment.
- `refresh_function.comment` matches the SCRUM-1708 non-overlapping wrapper
  comment.
- `pipeline_stats.cache_value.pending_record_links_approximate=true`.
- Cache rows advanced.

## Rebuild Supporting Index

Run this before applying the refresh cron when `idx_anchors_pipeline_status` is
missing, invalid, or not ready. It drops only that index name, then schedules a
one-time pg_cron job to recreate it concurrently. The create runs through
pg_cron because the Supabase Management API can time out long concurrent index
builds before they finish. The script also temporarily sets `postgres` in
database `postgres` to `statement_timeout=0`, because pg_cron sessions otherwise
inherit Supabase's 120s database default and cancel the concurrent index build
before completion.

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
shows a valid supporting index.

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
- The single job is named `refresh-pipeline-dashboard-cache`.
- The job is active.
- The job schedule is `*/2 * * * *`.
- The job command is `SET statement_timeout = '120s'; SELECT refresh_pipeline_dashboard_cache();`.
- `pipeline_stats.updated_at` advances within two cron ticks.
- Extended soak evidence must cover at least two hours after the final schedule
  and function configuration, with zero failed runs in `cron.job_run_details`.
  `job startup timeout` is a failed soak gate and must be investigated or the
  acceptance window must be explicitly reset before owner merge.

## Rollback

```bash
SUPABASE_PROJECT_REF="vzwyaatejekddvltxyye" \
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --rollback
```

Rollback unschedules only jobs named `refresh-pipeline-dashboard-cache`.
