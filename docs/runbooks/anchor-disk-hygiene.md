# Anchor Disk Hygiene

This runbook covers the `public.anchors` disk-growth issue on the primary Supabase project.

## Why this exists

`public.anchors` is a hot table with large rows and frequent updates. Historically the batch anchoring flow rewrote `anchors.metadata` with Merkle proof data, which created heavy dead-tuple churn and index bloat.

The durable fix is split into two parts:

1. Stop creating new bloat.
2. Reclaim the old bloat safely.

## What shipped

- [0243_scale02_anchor_disk_hygiene.sql](../../supabase/migrations/0243_scale02_anchor_disk_hygiene.sql)
  - Adds `anchor_proofs.batch_id`
  - Makes `anchor_proofs.block_height` / `block_timestamp` nullable
  - Tunes `public.anchors` fillfactor/autovacuum settings
  - Replaces `submit_batch_anchors`
  - Defines `finalize_public_record_anchor_batch`
  - Defines `link_public_records_to_anchors`
- [0244_scale02_anchor_index_cleanup.sql](../../supabase/migrations/0244_scale02_anchor_index_cleanup.sql)
  - Drops redundant `anchors` indexes
  - Keep separate because lock contention on `anchors` can block it
- Worker changes:
  - [batch-anchor.ts](../../services/worker/src/jobs/batch-anchor.ts)
  - [publicRecordAnchor.ts](../../services/worker/src/jobs/publicRecordAnchor.ts)
  - [anchorProofs.ts](../../services/worker/src/utils/anchorProofs.ts)
  - Both batch flows now persist proof rows to `anchor_proofs`
- Verification path:
  - [verify-proof.ts](../../services/worker/src/api/v1/verify-proof.ts)
  - Proof lookup now prefers `anchor_proofs` and falls back to legacy metadata

## Current state

- Core anti-bloat migration is safe to apply immediately.
- Redundant index cleanup may fail on a busy table because `DROP INDEX` still needs a lock.
- Existing dead tuples and old page layout will not shrink on their own.

## One-time reclaim

Supabase documents `pg_repack` as the supported online reclaim path, and it requires the client-side CLI plus the `-k` flag on Supabase.

References:

- [Supabase pg_repack docs](https://supabase.com/docs/guides/database/extensions/pg_repack)
- [Supabase database size guide](https://supabase.com/docs/guides/platform/database-size)

Requirements:

- Run during a maintenance window
- Ensure free disk roughly `2x` the size of the table plus indexes
- Use the project database host and a privileged Postgres connection

Command template:

```bash
pg_repack -k \
  -h db.<PROJECT_REF>.supabase.co \
  -p 5432 \
  -U postgres \
  -d postgres \
  --no-order \
  --table public.anchors
```

After repack, retry the redundant-index cleanup migration if it has not already landed.

## Retry index cleanup

If `0244_scale02_anchor_index_cleanup.sql` times out on a busy period, retry it during a lower-traffic window:

```sql
SET lock_timeout = '5s';
DROP INDEX IF EXISTS public.idx_anchors_public_id;
DROP INDEX IF EXISTS public.idx_anchors_pending_status;
RESET lock_timeout;
```

Keep `idx_anchors_pending_claim`; it is the surviving copy of the duplicate pending index.

## Verification queries

Check `anchors` storage settings:

```sql
select reloptions
from pg_class
where oid = 'public.anchors'::regclass;
```

Check proof-table shape:

```sql
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'anchor_proofs'
  and column_name in ('batch_id', 'block_height', 'block_timestamp')
order by column_name;
```

Check the batch RPCs:

```sql
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'submit_batch_anchors',
    'finalize_public_record_anchor_batch',
    'link_public_records_to_anchors'
  )
order by proname;
```

Check for dead-tuple regression:

```sql
select
  relname,
  n_live_tup,
  n_dead_tup,
  round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 2) as dead_pct
from pg_stat_user_tables
where schemaname = 'public'
  and relname in ('anchors', 'public_records', 'public_record_embeddings')
order by dead_pct desc nulls last;
```

Check largest `anchors` indexes:

```sql
select
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) as size,
  idx_scan
from pg_stat_user_indexes
where schemaname = 'public'
  and relname = 'anchors'
order by pg_relation_size(indexrelid) desc;
```

## Billing note

Reducing database size does not automatically shrink provisioned disk during normal operation. Supabase right-sizes disk on a later project upgrade once the underlying database is smaller.
