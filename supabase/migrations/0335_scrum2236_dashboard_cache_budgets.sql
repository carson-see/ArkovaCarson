-- SCRUM-2236 (HARDEN-1) — budget the four unhardened dashboard cache refreshers.
--
-- refresh_pipeline_dashboard_cache() averaged ~55s over 22,686 cron calls
-- (cron runs every 2 min) and was throwing recurring prod statement-timeout
-- ERRORs. Two siblings (refresh_cache_pipeline_stats / refresh_cache_anchor_tx_stats)
-- were already hardened under SCRUM-1256 with the budget+estimate+sentinel pattern.
-- The remaining four sub-refreshers still ran unbudgeted full scans on the ~3M-row
-- anchors / public_records tables under a single coarse 60s statement_timeout:
--
--   refresh_cache_anchor_status_counts  -- per-status count(*) on anchors
--   refresh_cache_anchor_type_counts    -- GROUP BY credential_type,status on anchors
--   refresh_cache_by_source             -- GROUP BY source on public_records
--   refresh_cache_record_types          -- DISTINCT record_type on public_records
--
-- DURABLE FIX (the real one): partial / covering indexes so the per-status,
-- GROUP BY source, and DISTINCT record_type scans are genuinely index-resident
-- and finish in well under the budget. These are shipped as operator-applied,
-- NON-TRANSACTIONAL `CREATE INDEX CONCURRENTLY` steps (see the block at the bottom
-- of this file), per the 0313/0330 convention — CONCURRENTLY cannot run inside the
-- transaction `supabase db push` wraps migrations in, and a plain locking CREATE
-- INDEX would take a heavy lock on a multi-GB hot table.
--
-- WHY THE BUDGET ALONE WAS NOT ENOUGH (review finding #2): `SET LOCAL
-- statement_timeout` inside a function arms the timer against the OUTER statement's
-- start, not the inner SELECT's. When these sub-refreshers run inside the
-- refresh_pipeline_dashboard_cache() cron wrapper, the outer statement clock has
-- already been running, so the "1s budget" can leave the inner scan ~0 ms of real
-- headroom and cancel it spuriously. The indexes are the fix that makes the scans
-- fast for real; the 1s budget + explicit 57014 catch remain ONLY as a last-ditch
-- safety net so a pathological plan still degrades gracefully instead of aborting
-- the whole refresh transaction.
--
-- GRACEFUL DEGRADATION ON A BUDGET HIT (review finding #1 — the BREAKING bug this
-- migration fixes):
--   * anchor_status_counts: -1 sentinel for the timed-out bucket(s). This matches
--     the existing -1 convention that get_anchor_status_counts_fast already renders
--     "—", and the bucket shape (a flat jsonb_build_object) is unchanged, so the
--     reader is unaffected.
--   * anchor_type_counts / by_source / record_types: their reader RPCs consume the
--     BARE cache_value directly —
--        get_anchor_type_counts    : jsonb_array_elements(cache_value)
--        get_distinct_record_types : jsonb_array_elements_text(cache_value)
--        count_public_records_by_source : jsonb_each(cache_value) + (value)::bigint
--     A wrapper object like { stale:true, stale-reason:..., value:[...] } would make
--     EVERY one of those readers THROW ("cannot extract elements from a scalar/
--     object", or an invalid bigint cast on the wrapper keys). So on a budget
--     hit we NEVER change the shape: we simply SKIP THE WRITE and leave the prior
--     bare cache_value untouched (the cron retries every 2 min). The only time we
--     write on a cancel is when NO prior row exists at all, in which case we seed
--     the bare empty value ([] or {}) the readers already handle. The cache value
--     for these three keys is therefore ALWAYS a bare array / object — never a
--     wrapper — and no reader RPC change is needed.
--
-- Signatures, owners, grants, cache keys, and the success-path JSON shapes are
-- unchanged. SECURITY DEFINER + `SET search_path = public` preserved on all four.
--
-- ROLLBACK:
--   Restore the four baseline bodies (the unbudgeted 60s-timeout full-scan path)
--   from 00000000000000_baseline_at_main_HEAD.sql exactly as below, then
--   NOTIFY pgrst, 'reload schema';
--
--   -- refresh_cache_anchor_status_counts (baseline):
--   --   SET statement_timeout '60s'; SELECT reltuples INTO v_total FROM pg_class
--   --   WHERE relname='anchors'; four bare `SELECT count(*) ... FROM anchors WHERE
--   --   status=... AND deleted_at IS NULL`; v_secured := GREATEST(total - others, 0);
--   --   INSERT ... ON CONFLICT DO UPDATE.
--   -- refresh_cache_anchor_type_counts (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_agg(row_to_json(t)) INTO v_result
--   --   FROM (SELECT COALESCE(credential_type::text,'UNKNOWN'), status::text, count(*)
--   --   FROM anchors WHERE deleted_at IS NULL GROUP BY credential_type,status
--   --   ORDER BY count(*) DESC) t; INSERT COALESCE(v_result,'[]') ON CONFLICT.
--   -- refresh_cache_by_source (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_object_agg(source,cnt) INTO
--   --   v_by_source FROM (SELECT source, count(*) cnt FROM public_records GROUP BY
--   --   source) t; INSERT COALESCE(v_by_source,'{}') ON CONFLICT.
--   -- refresh_cache_record_types (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_agg(record_type ORDER BY
--   --   record_type) INTO v_result FROM (SELECT DISTINCT record_type FROM
--   --   public_records) t; INSERT COALESCE(v_result,'[]') ON CONFLICT.
--   -- Indexes (if applied): drop standalone, outside a txn —
--   --   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_status_active_count;
--   --   DROP INDEX CONCURRENTLY IF EXISTS public.idx_public_records_source_brin_btree;
--   --   DROP INDEX CONCURRENTLY IF EXISTS public.idx_public_records_record_type_distinct;

-- ---------------------------------------------------------------------------
-- 1. refresh_cache_anchor_status_counts — per-status count(*) gets a 1s budget
--    + 57014 sentinel (-1). Total stays a pg_class.reltuples estimate (instant).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_status_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_total bigint := 0;
  v_pending bigint := -1;
  v_submitted bigint := -1;
  v_broadcasting bigint := -1;
  v_revoked bigint := -1;
  v_secured bigint := -1;
BEGIN
  -- Whole-table total: cheap planner estimate, no scan.
  SELECT GREATEST(reltuples::bigint, 0) INTO v_total
  FROM pg_class
  WHERE relname = 'anchors' AND relnamespace = 'public'::regnamespace;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_pending FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_pending := -1;
    WHEN OTHERS THEN v_pending := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_submitted FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_submitted := -1;
    WHEN OTHERS THEN v_submitted := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting := -1;
    WHEN OTHERS THEN v_broadcasting := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_revoked := -1;
    WHEN OTHERS THEN v_revoked := -1;
  END;

  -- Derive SECURED from the estimate minus the known buckets only when every
  -- bucket counted cleanly; otherwise emit the -1 sentinel (callers render "—").
  IF v_pending >= 0 AND v_submitted >= 0 AND v_broadcasting >= 0 AND v_revoked >= 0 THEN
    v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);
  ELSE
    v_secured := -1;
  END IF;

  -- Shape is a flat object identical to the baseline / get_anchor_status_counts_fast.
  -- The -1 sentinel lives inside that same flat shape, so the reader is unaffected.
  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', v_pending, 'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting, 'SECURED', v_secured,
    'REVOKED', v_revoked, 'total', v_total
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_anchor_status_counts"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_anchor_status_counts"() IS 'SCRUM-2236 (HARDEN-1): per-status count(*) on anchors now backed by idx_anchors_status_active_count (status WHERE deleted_at IS NULL) so the scan is index-resident; a 1s SET LOCAL statement_timeout + explicit EXCEPTION WHEN query_canceled (SQLSTATE 57014) sentinel (-1) remain only as a safety net. Total is a pg_class.reltuples estimate. The -1 sentinel lives inside the same flat object shape as the baseline, so get_anchor_status_counts_fast / get_anchor_status_counts are unaffected. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

-- ---------------------------------------------------------------------------
-- 2. refresh_cache_anchor_type_counts — budgeted GROUP BY on anchors.
--    On a budget hit, the cache value MUST stay a BARE jsonb array because the
--    reader (get_anchor_type_counts) does jsonb_array_elements(cache_value). So
--    we SKIP the write and leave the prior bare value untouched; we only seed a
--    bare empty array when no prior row exists at all. NEVER a wrapper object.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_type_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_result jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_agg(row_to_json(t)::jsonb) INTO v_result
    FROM (
      SELECT COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
             status::text AS status, count(*)::bigint AS count
      FROM anchors WHERE deleted_at IS NULL
      GROUP BY credential_type, status ORDER BY count(*) DESC
    ) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    -- Preserve the prior BARE array unchanged: skip the write when a row already
    -- exists. Only seed a bare empty array if the cache has never been populated.
    -- (No wrapper object — the reader does jsonb_array_elements on the bare value.)
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('anchor_type_counts', '[]'::jsonb, now())
    ON CONFLICT (cache_key) DO NOTHING;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_type_counts', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_anchor_type_counts"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_anchor_type_counts"() IS 'SCRUM-2236 (HARDEN-1): GROUP BY credential_type,status on anchors now backed by idx_anchors_credential_type_status (WHERE deleted_at IS NULL); a 1s SET LOCAL statement_timeout + EXCEPTION WHEN query_canceled (57014) remain as a safety net. On a budget hit the prior BARE jsonb array is left untouched (write skipped via ON CONFLICT DO NOTHING; bare [] seeded only when no row exists) so get_anchor_type_counts'' jsonb_array_elements(cache_value) never sees a wrapper and never throws. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

-- ---------------------------------------------------------------------------
-- 3. refresh_cache_by_source — budgeted GROUP BY source on public_records.
--    Reader (count_public_records_by_source) does jsonb_each(cache_value) and
--    casts each value to bigint, so the cache value MUST stay a BARE object on a
--    budget hit. Skip the write; seed a bare {} only when no prior row exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_by_source"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_by_source jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_object_agg(source, cnt) INTO v_by_source
    FROM (SELECT source, count(*) AS cnt FROM public_records GROUP BY source) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    -- Preserve the prior BARE object: skip the write when a row exists; only seed
    -- a bare empty object if never populated. No wrapper — the reader does
    -- jsonb_each(cache_value) and casts each value to bigint.
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('by_source', '{}'::jsonb, now())
    ON CONFLICT (cache_key) DO NOTHING;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('by_source', COALESCE(v_by_source, '{}'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_by_source"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_by_source"() IS 'SCRUM-2236 (HARDEN-1): GROUP BY source on public_records now backed by idx_public_records_source; a 1s SET LOCAL statement_timeout + EXCEPTION WHEN query_canceled (57014) remain as a safety net. On a budget hit the prior BARE object is left untouched (ON CONFLICT DO NOTHING; bare {} seeded only when no row exists) so count_public_records_by_source'' jsonb_each(cache_value) + (value)::bigint cast never sees a wrapper and never throws. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

-- ---------------------------------------------------------------------------
-- 4. refresh_cache_record_types — budgeted DISTINCT record_type on public_records.
--    Reader (get_distinct_record_types) does jsonb_array_elements_text(cache_value)
--    so the cache value MUST stay a BARE array on a budget hit. Skip the write;
--    seed a bare [] only when no prior row exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_record_types"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_result jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_agg(record_type ORDER BY record_type) INTO v_result
    FROM (SELECT DISTINCT record_type FROM public_records) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    -- Preserve the prior BARE array: skip the write when a row exists; only seed a
    -- bare empty array if never populated. No wrapper — the reader does
    -- jsonb_array_elements_text(cache_value).
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('record_types', '[]'::jsonb, now())
    ON CONFLICT (cache_key) DO NOTHING;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('record_types', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_record_types"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_record_types"() IS 'SCRUM-2236 (HARDEN-1): DISTINCT record_type on public_records now backed by idx_public_records_record_type_distinct (record_type); a 1s SET LOCAL statement_timeout + EXCEPTION WHEN query_canceled (57014) remain as a safety net. On a budget hit the prior BARE array is left untouched (ON CONFLICT DO NOTHING; bare [] seeded only when no row exists) so get_distinct_record_types'' jsonb_array_elements_text(cache_value) never sees a wrapper and never throws. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- OPERATOR-APPLIED, NON-TRANSACTIONAL INDEXES (the DURABLE fix for review #2)
-- ===========================================================================
-- These make the budgeted scans genuinely fast so the 1s budget is never the
-- thing that decides correctness — it is a safety net only. CREATE INDEX
-- CONCURRENTLY cannot run inside the transaction that `supabase db push` wraps a
-- migration in, and a plain locking CREATE INDEX would take a heavy lock on the
-- multi-GB hot anchors / public_records tables. Per the 0313 / 0330 convention
-- the operator runs each of these STANDALONE, OUTSIDE any transaction, on the
-- live table. All are IF NOT EXISTS so re-running is safe.
--
--   -- (a) Per-status count(*) on anchors WHERE deleted_at IS NULL.
--   --     A status-only partial index keeps each per-status count an index-only
--   --     scan over a single equality range. (idx_anchors_status_created exists
--   --     but leads with (status, created_at DESC); a narrow (status) partial is
--   --     a smaller, count-optimal structure.)
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_status_active_count
--     ON public.anchors (status) WHERE (deleted_at IS NULL);
--
--   -- (b) GROUP BY credential_type, status on anchors WHERE deleted_at IS NULL.
--   --     Already covered by the EXISTING idx_anchors_credential_type_status
--   --     ((credential_type, status) WHERE deleted_at IS NULL) — no new index
--   --     needed; listed here so the operator confirms it is present:
--   --   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_credential_type_status
--   --     ON public.anchors (credential_type, status) WHERE (deleted_at IS NULL);
--
--   -- (c) GROUP BY source on public_records.
--   --     Already covered by the EXISTING idx_public_records_source ((source)) —
--   --     no new index needed; confirm present:
--   --   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_records_source
--   --     ON public.public_records (source);
--
--   -- (d) DISTINCT record_type on public_records.
--   --     Already covered by the EXISTING idx_public_records_record_type
--   --     ((record_type)), which the planner can drive a skip-scan / ordered
--   --     DISTINCT off — no new index needed; confirm present:
--   --   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_records_record_type
--   --     ON public.public_records (record_type);
--
-- NET NEW INDEX to apply: only (a) idx_anchors_status_active_count. (b)/(c)/(d)
-- already exist in the baseline schema and are listed for operator verification.
-- ===========================================================================
