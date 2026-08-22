-- BUG-009 (P1, 2026-08 soak) — the admin dashboards can publish a hard `0`
-- anchor count as if it were measured.
--
-- `refresh_cache_anchor_status_counts()` (last written by 0335) takes the whole
-- table total from a PLANNER ESTIMATE:
--
--     SELECT GREATEST(reltuples::bigint, 0) INTO v_total
--     FROM pg_class WHERE relname = 'anchors' ...;
--
-- and then derives SECURED by subtraction:
--
--     v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);
--
-- 0335 gave every *bucket* a `-1` sentinel for the timed-out case, but gave the
-- ESTIMATE no sentinel at all. `pg_class.reltuples` is `-1` on a relation that
-- has never been vacuumed or analysed (Postgres 14+) and `0` on one freshly
-- loaded, and `GREATEST(..., 0)` silently laundered both into a real-looking
-- zero. Every bucket then counted correctly at 0, so the subtraction produced
-- SECURED = 0 too, and the cache published:
--
--     {"total": 0, "SECURED": 0, "PENDING": 0, ...}
--
-- Observed live on the 2026-08 rig: that exact row, while `anchor_type_counts`
-- — same cron, same table, but a direct `count(*)` — correctly reported 12.
-- `POST /jobs/smoke-test` reads `total` and fails the `anchor-count` check when
-- it is not > 0, so the rig reported a database with no anchors in it.
--
-- Production only reads 3.49M because autovacuum keeps its estimate warm. That
-- is a property of prod's traffic, not a property of this function.
--
-- FIX: an estimate that cannot be trusted must never be rendered as a count.
--
--   1. Trust rules. The estimate is accepted only when it is strictly positive
--      AND not contradicted by rows we literally counted this run:
--        * `reltuples < 0`  -> "unknown" (PG14+, never analysed).
--        * `reltuples = 0`  -> either a genuinely empty table or a stale/absent
--                              estimate; indistinguishable from here.
--        * `reltuples < (pending + submitted + broadcasting + revoked)` ->
--                              provably stale: we just counted more live rows
--                              than the estimate claims exist in total.
--        * no `pg_class` row -> nothing to trust.
--
--   2. Resolution, not surrender. When the estimate is not trusted, fall back to
--      an EXACT `count(*)` under the same 1s budget the buckets already use.
--      This is deliberately not "give up": the estimate is missing precisely
--      when the table is small or freshly built, which is exactly when the exact
--      count is cheap — the rig's 12 rows resolve instantly and correctly, and
--      an empty table resolves to a true, authoritative `0`. If the count does
--      NOT finish inside the budget the table is large, which proves the `0`/
--      absent estimate was wrong, and `total` becomes `-1`.
--
--   3. `-1` propagates. SECURED is derived by subtraction, so it is only
--      computed when the total is trustworthy AND every bucket counted cleanly;
--      otherwise it is `-1` as well. A `-1` total can never be turned into a
--      secured-rate percentage.
--
-- The `-1` convention is already the contract on this cache, and consumers
-- already implement it: `get_anchor_status_counts_fast` returns `-1` for a
-- missing cache row (0324), `admin-ops-slo.ts` calls `isSentinelUnavailable()`
-- on BOTH `total` and `SECURED` before computing `anchorSecuredRate`, and
-- `anchor-stats.ts` maps anything non-numeric to `-1`. This migration makes the
-- producer honour a contract the readers were already written against.
--
-- One additive key, `total_source` ('exact' | 'estimate' | 'unavailable'), so an
-- operator reading the raw cache row can tell a measured number from a planner
-- guess without re-deriving it. It is a STRING, which matters: the one consumer
-- that iterates keys rather than naming them
-- (`pipelineThroughputMonitor.parseBatchProgress`) keeps numeric values only, so
-- a string key is inert there, and the two reader RPCs build their result from
-- an explicit key list. No existing key changes name, type, or meaning.
--
-- The flat object shape is preserved exactly as 0335 required — the readers
-- (`get_anchor_status_counts_fast`, `get_anchor_status_counts`) consume it
-- directly, and a wrapper object would make them throw.
--
-- Signature, owner, grants, cache key, statement budgets, and the sibling
-- refreshers are untouched. Applied NOWHERE by this PR: the 2026-08 full soak
-- freeze runs until 2026-08-19T15:51:30Z.
--
-- ROLLBACK:
--   Restore the 0335 body verbatim from
--   supabase/migrations/0335_scrum2236_dashboard_cache_budgets.sql (section 1):
--   `SELECT GREATEST(reltuples::bigint, 0) INTO v_total FROM pg_class WHERE
--   relname = 'anchors' AND relnamespace = 'public'::regnamespace;` with no
--   exact-count fallback and no trust check, the four 1s-budgeted bucket counts
--   with their `-1` sentinels, `v_secured := GREATEST(v_total - ... , 0)` gated
--   only on the buckets, and the INSERT ... ON CONFLICT DO UPDATE writing the
--   six keys WITHOUT `total_source`. Then:
--     NOTIFY pgrst, 'reload schema';
--   Note what rolling back restores: an un-analysed `anchors` table publishing
--   `{"total": 0, "SECURED": 0}` to the admin dashboard as a measured count.

CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_status_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_reltuples double precision;
  v_total bigint := -1;
  v_total_source text := 'unavailable';
  v_pending bigint := -1;
  v_submitted bigint := -1;
  v_broadcasting bigint := -1;
  v_revoked bigint := -1;
  v_secured bigint := -1;
  v_buckets_known boolean := false;
  v_bucket_sum bigint := 0;
  v_estimate_trusted boolean := false;
BEGIN
  -- Per-status counts first: they are what makes a stale estimate detectable.
  -- Each keeps its own 1s budget and -1 sentinel (SCRUM-2236 / 0335).
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

  v_buckets_known := (v_pending >= 0 AND v_submitted >= 0 AND v_broadcasting >= 0 AND v_revoked >= 0);
  IF v_buckets_known THEN
    v_bucket_sum := v_pending + v_submitted + v_broadcasting + v_revoked;
  END IF;

  -- Whole-table total: cheap planner estimate, no scan. NOT laundered through
  -- GREATEST(...,0) — a non-positive reltuples is the "no usable statistics"
  -- signal and must survive as one.
  SELECT c.reltuples INTO v_reltuples
  FROM pg_class c
  WHERE c.relname = 'anchors' AND c.relnamespace = 'public'::regnamespace;

  v_estimate_trusted := (
    v_reltuples IS NOT NULL
    AND v_reltuples > 0
    -- Provably stale: fewer rows estimated in the whole table than we just
    -- counted in four of its statuses.
    AND NOT (v_buckets_known AND v_reltuples::bigint < v_bucket_sum)
  );

  IF v_estimate_trusted THEN
    v_total := v_reltuples::bigint;
    v_total_source := 'estimate';
  ELSE
    -- The estimate is missing or contradicted. Resolve it exactly under the same
    -- 1s budget: an un-analysed table is almost always a small one, where this
    -- is instant and correct. If it does NOT finish the table is large, which is
    -- itself proof the 0/absent estimate was wrong -> -1, never 0.
    BEGIN
      SET LOCAL statement_timeout = '1s';
      -- No deleted_at filter: reltuples counts physical rows, so the exact
      -- fallback must measure the same population the estimate would have.
      SELECT count(*) INTO v_total FROM anchors;
      v_total_source := 'exact';
    EXCEPTION
      WHEN query_canceled THEN v_total := -1; v_total_source := 'unavailable';
      WHEN OTHERS THEN v_total := -1; v_total_source := 'unavailable';
    END;
  END IF;

  -- SECURED is a derived figure. Derive it only from a trustworthy total AND a
  -- complete set of buckets; otherwise emit the sentinel (callers render "—").
  IF v_total >= 0 AND v_buckets_known THEN
    v_secured := GREATEST(v_total - v_bucket_sum, 0);
  ELSE
    v_secured := -1;
  END IF;

  -- Flat object, same key set as the baseline / get_anchor_status_counts_fast,
  -- plus the additive `total_source` string. The -1 sentinel lives inside that
  -- same flat shape, so no reader changes.
  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', v_pending, 'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting, 'SECURED', v_secured,
    'REVOKED', v_revoked, 'total', v_total,
    'total_source', v_total_source
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_anchor_status_counts"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_anchor_status_counts"() IS
  'SCRUM-2236 + BUG-009. Per-status count(*) on anchors is index-resident (idx_anchors_status_active_count) with a 1s SET LOCAL statement_timeout + explicit EXCEPTION WHEN query_canceled (57014) -1 sentinel as a safety net; WHEN query_canceled is mandatory, WHEN OTHERS does not catch it. BUG-009: the whole-table total is a pg_class.reltuples PLANNER ESTIMATE and is no longer laundered through GREATEST(...,0). A non-positive estimate, an absent pg_class row, or an estimate smaller than the buckets just counted is treated as untrusted and resolved by an exact count(*) under the same 1s budget; if that does not finish, total AND the derived SECURED are -1 (sentinel, never a count). total_source is an additive string key: exact | estimate | unavailable. Rationale: an un-analysed anchors table used to publish {"total":0,"SECURED":0} as authoritative, which is what /jobs/smoke-test read as "no anchors exist".';


-- ---------------------------------------------------------------------------
-- SEC (found by scripts/ci/feedback-rules/secdef-function-grants.ts while this
-- migration was being written): this SECURITY DEFINER refresher is granted to
-- `anon` AND `authenticated` in the baseline —
--   baseline:14236  GRANT ALL ON FUNCTION public.refresh_cache_anchor_status_counts() TO anon;
--   baseline:14237  ... TO authenticated;
-- so an UNAUTHENTICATED caller can invoke it over PostgREST and make the
-- database run four count(*) scans over the ~3.5M-row `anchors` table and write
-- a row into `pipeline_dashboard_cache`. That is unauthenticated compute
-- amplification plus an unauthenticated write, on an account-free endpoint the
-- worker's §1.10 rate limiter never sees. Same defect class as 0364 / 0377 /
-- 0378 / 0388 / 0396.
--
-- `CREATE OR REPLACE` preserves the ACL, so the redefinition above does NOT
-- close it — the revoke has to be explicit, and it has to come AFTER the
-- definition. `PUBLIC` is named alongside the two roles because a revoke naming
-- only anon/authenticated is a no-op against a PUBLIC grant, and a revoke naming
-- only PUBLIC does not remove the DIRECT grants `ALTER DEFAULT PRIVILEGES` gives
-- those two roles at CREATE time. Identifiers are unquoted so the ratchet can
-- see them.
--
-- Non-regressive: the only callers are `POST /cron/refresh-stats`
-- (`DASHBOARD_CACHE_REFRESHERS` in services/worker/src/routes/cron.ts) and
-- `scripts/ops/ensure-pipeline-dashboard-cache-cron.ts`, both service_role.
-- Grep confirms zero browser call sites in `src/`.
--
-- ROLLBACK for this block specifically (restores the hole — do not):
--   GRANT ALL ON FUNCTION public.refresh_cache_anchor_status_counts() TO anon;
--   GRANT ALL ON FUNCTION public.refresh_cache_anchor_status_counts() TO authenticated;
REVOKE ALL ON FUNCTION public.refresh_cache_anchor_status_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_anchor_status_counts() TO service_role;

NOTIFY pgrst, 'reload schema';
