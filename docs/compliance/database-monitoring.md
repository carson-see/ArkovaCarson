# Database Monitoring & Query Performance

> **Version:** 2026-03-23 | **Classification:** INTERNAL
> **Covers:** PERF-5 (pg_stat_statements), SCALE-19 (EXPLAIN ANALYZE)

---

## 1. pg_stat_statements Monitoring (PERF-5)

### Setup

Supabase Pro automatically enables `pg_stat_statements`. Access via:

1. **Supabase Dashboard** → SQL Editor → Run:
```sql
-- Top 10 slowest queries (by total time)
SELECT
  query,
  calls,
  total_exec_time::numeric(12,2) AS total_ms,
  mean_exec_time::numeric(12,2) AS avg_ms,
  max_exec_time::numeric(12,2) AS max_ms,
  rows
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat%'
ORDER BY total_exec_time DESC
LIMIT 10;
```

2. **Queries exceeding 500ms threshold:**
```sql
SELECT
  query,
  calls,
  mean_exec_time::numeric(12,2) AS avg_ms,
  max_exec_time::numeric(12,2) AS max_ms,
  rows
FROM pg_stat_statements
WHERE mean_exec_time > 500
ORDER BY mean_exec_time DESC;
```

3. **Most frequently called queries:**
```sql
SELECT
  query,
  calls,
  mean_exec_time::numeric(12,2) AS avg_ms,
  total_exec_time::numeric(12,2) AS total_ms
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 20;
```

### Alerting

Set up monitoring in Supabase Dashboard → Monitoring → Alerts:
- **Alert 1:** Any query with mean_exec_time > 500ms
- **Alert 2:** Total connections > 50 (of 60 limit)
- **Alert 3:** Database size > 6GB (of 8GB limit)

### Reset Statistics

```sql
-- Reset after index changes or migrations
SELECT pg_stat_statements_reset();
```

---

## 2. Critical Query Plans (SCALE-19)

Run these EXPLAIN ANALYZE queries after migrations or index changes to verify performance.

### Public Verification (Highest Traffic)

```sql
-- get_public_anchor: Should use idx_anchors_public_id
EXPLAIN ANALYZE
SELECT a.*, o.display_name
FROM anchors a
LEFT JOIN organizations o ON o.id = a.org_id
WHERE a.public_id = 'ARK-TEST-001'
  AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED')
  AND a.deleted_at IS NULL;
-- Expected: Index Scan on idx_anchors_public_id
```

### Fingerprint Verification

```sql
-- anchor_chain_index lookup: Should use primary key
EXPLAIN ANALYZE
SELECT * FROM anchor_chain_index
WHERE fingerprint_sha256 = 'abc123...';
-- Expected: Index Scan on anchor_chain_index_pkey
```

### Pipeline Records Listing

```sql
-- Admin pipeline page: Should use composite index
EXPLAIN ANALYZE
SELECT * FROM public_records
WHERE source = 'EDGAR'
  AND anchor_id IS NULL
ORDER BY created_at DESC
LIMIT 25;
-- Expected: Index Scan on idx_public_records_unanchored
```

### User Anchor Listing

```sql
-- Dashboard: Should use idx_anchors_user_status_created
EXPLAIN ANALYZE
SELECT * FROM anchors
WHERE user_id = '<uuid>'
  AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 50;
-- Expected: Index Scan on idx_anchors_user_status_created
```

### JSONB Metadata Queries

```sql
-- Pipeline source filter: Should use GIN index
EXPLAIN ANALYZE
SELECT * FROM anchors
WHERE metadata @> '{"pipeline_source": "EDGAR"}'::jsonb
LIMIT 25;
-- Expected: Bitmap Index Scan on idx_anchors_metadata_gin
```

### Semantic Search

```sql
-- Embedding similarity: Should use ivfflat or hnsw index
EXPLAIN ANALYZE
SELECT id, title, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS similarity
FROM public_records
WHERE embedding IS NOT NULL
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 10;
-- Expected: Index Scan on idx_public_records_embedding (ivfflat)
```

---

## 3. Index Health Check

Run periodically to identify unused or bloated indexes:

```sql
-- Unused indexes (candidates for removal)
SELECT
  schemaname, tablename, indexname,
  idx_scan AS times_used,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Table bloat estimation
SELECT
  schemaname, tablename,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  CASE WHEN n_live_tup > 0
    THEN round(100.0 * n_dead_tup / n_live_tup, 1)
    ELSE 0
  END AS dead_pct
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_dead_tup DESC
LIMIT 10;
```

---

## 4. Connection Monitoring

```sql
-- Current connections by state
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state;

-- Long-running queries (>30s)
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
  AND state != 'idle';
```

---

## 5. Recommended Monitoring Schedule

| Check | Frequency | Alert Threshold |
|-------|-----------|----------------|
| Slow queries (pg_stat_statements) | Daily | mean > 500ms |
| Connection count | Real-time | > 50 of 60 |
| Database size | Weekly | > 6GB of 8GB |
| Dead row percentage | Weekly | > 20% |
| Index usage | Monthly | Unused indexes > 100MB |
| EXPLAIN ANALYZE on critical paths | After migrations | Plan change detected |
| Orphaned anchor check | Weekly | count > 0 |
