-- SCRUM-3031: batch_insert_anchors wedge — dedup-lookup type mismatch (migration 0370)
--
-- REVIEW FOLLOW-UP (same PR, pre-apply — 0370 was never applied to prod/rig,
-- see supabase/migrations/agents.md, so this file is being corrected in
-- place rather than compensated with a new migration; per repo convention
-- edits to an already-APPLIED migration are forbidden, edits to a
-- never-applied one are not):
--
-- The first cut of this fix cast `input_data.fingerprint` directly to
-- `character(64)` in the CTE (`(elem->>'fingerprint')::character(64)`).
-- Verified empirically on real Postgres 17: that EXPLICIT cast silently
-- TRUNCATES an overlong value with no error — `('<66 hex chars>')::character(64)`
-- succeeds and keeps only the first 64 characters — whereas the PRE-0370
-- path (`::text` in the CTE, relying on the INSERT target column's own
-- IMPLICIT assignment cast to `anchors.fingerprint character(64)`) RAISES
-- `value too long for type character(64)`. Two different overlong strings
-- sharing a 64-char prefix compare EQUAL after that silent truncation.
-- `public_records.content_hash` (the value that becomes this fingerprint —
-- see `services/worker/src/jobs/publicRecordAnchor.ts`,
-- `fingerprint: record.content_hash`) has no CHECK constraint and is
-- computed by 20+ independent fetchers, so a malformed/overlong value here
-- is reachable, not theoretical. Silently truncating it would let a
-- corrupted fingerprint pass as valid-looking (if the 64-char prefix
-- happens to match `^[A-Fa-f0-9]{64}$`) or collapse two distinct inputs
-- into a false dedup match — on `anchors.fingerprint`, the product's
-- integrity-critical field. That is a correctness regression this
-- migration must not introduce.
--
-- Fix (this version): split the cast by role instead of casting the whole
-- CTE column.
--   - `input_data.fingerprint` stays `::text` (restores the pre-0370 INSERT
--     path exactly) so the `inserted` CTE's `INSERT INTO anchors (...)`
--     still goes through the target column's IMPLICIT assignment cast to
--     `character(64)` — which RAISES loudly on any overlong value, for
--     every row in the batch, before the `existing` CTE (or anything
--     downstream) ever runs. (Postgres always executes a data-modifying CTE
--     referenced by the final query, regardless of read order, so this
--     validation is not optional/short-circuitable.) A too-short or
--     non-hex value is still caught the same way it always was, by the
--     target table's `anchors_fingerprint_format` CHECK constraint — no
--     change there.
--   - The `existing` CTE's dedup JOIN instead casts explicitly at the
--     predicate: `a.fingerprint = d.fingerprint::character(64)`. This casts
--     the NON-indexed side (`d.fingerprint`, a CTE-projected value) so
--     `a.fingerprint` (the INDEXED column) stays untouched and the native
--     `bpchar = bpchar` operator drives the index scan — same mechanism as
--     the first cut, just relocated. This explicit cast can never silently
--     truncate a bad value here, because by the time `existing` runs, the
--     `inserted` CTE has already proven (via the implicit-cast raise, see
--     above) that every fingerprint in the batch is <= 64 characters — so
--     this cast can only pad with trailing spaces (for the pathological
--     already-rejected-by-the-CHECK-constraint short/non-hex case), never
--     truncate.
--
-- Net effect: identical query plan / index usage to the first cut (see
-- EXPLAIN evidence below, re-verified against this version), but a
-- malformed/overlong fingerprint anywhere in the batch now aborts the
-- whole call loudly again, exactly like pre-0370, instead of silently
-- corrupting a fingerprint or creating a false dedup match.
--
-- ROLLBACK: CREATE OR REPLACE FUNCTION public.batch_insert_anchors(p_anchors jsonb)
--   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
--   SET statement_timeout TO '120s' AS $$
--   DECLARE v_result jsonb; BEGIN
--     WITH input_data AS (
--       SELECT (elem->>'user_id')::uuid AS user_id, (elem->>'org_id')::uuid AS org_id,
--         (elem->>'fingerprint')::text AS fingerprint, (elem->>'filename')::text AS filename,
--         (elem->>'credential_type')::credential_type AS credential_type,
--         'PENDING'::anchor_status AS status, (elem->'metadata')::jsonb AS metadata
--       FROM jsonb_array_elements(p_anchors) AS elem
--     ), inserted AS (
--       INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, metadata)
--       SELECT user_id, org_id, fingerprint, filename, credential_type, status, metadata FROM input_data
--       ON CONFLICT (user_id, fingerprint) WHERE deleted_at IS NULL DO NOTHING
--       RETURNING id, fingerprint
--     ), existing AS (
--       SELECT a.id, a.fingerprint FROM anchors a
--       INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint
--       WHERE a.deleted_at IS NULL AND a.id NOT IN (SELECT id FROM inserted)
--     ), all_anchors AS (
--       SELECT id, fingerprint FROM inserted UNION ALL SELECT id, fingerprint FROM existing
--     )
--     SELECT jsonb_agg(jsonb_build_object('id', id, 'fingerprint', fingerprint)) INTO v_result FROM all_anchors;
--     RETURN COALESCE(v_result, '[]'::jsonb);
--   END; $$;
--   (restores the pre-0370 body verbatim — reintroduces the wedge, do not use
--   except to roll back a confirmed-bad deploy)
--
-- ROOT CAUSE (confirmed via local Postgres repro at 200k-row representative
-- scale, single-owner skew matching the pipeline anchor owner — see PR body
-- for the full EXPLAIN transcript):
--
--   anchors.fingerprint is `character(64)` (fixed-length, CHECK
--   fingerprint ~ '^[A-Fa-f0-9]{64}$'). The "existing" dedup CTE built
--   input_data.fingerprint as `text` (`(elem->>'fingerprint')::text`), so
--   the join predicate `a.fingerprint = d.fingerprint` compared bpchar to
--   text. Postgres resolves that via an implicit cast on the bpchar side
--   (`(a.fingerprint)::text = d.fingerprint`) — which wraps the INDEXED
--   column in a cast, so `idx_anchors_user_fingerprint_unique` /
--   `idx_anchors_fingerprint_lookup` can no longer drive an index scan for
--   that predicate. The planner falls back to `Seq Scan on anchors` +
--   an external-merge disk-spilling sort to Merge Join against the ~1000-row
--   batch. This cost is a function of TOTAL anchors table size, not of how
--   many rows in the batch actually conflict — so it fires on every call,
--   including "zero rows inserted" repeat calls, which is exactly the
--   symptom in the ticket (~106s/call, near the function's own 120s
--   statement_timeout, holding RowExclusiveLock on `anchors` for the
--   duration).
--
--   Local repro (200,011-row anchors table, single user_id matching the
--   real pipeline-owner skew, 1000-row all-conflicting p_anchors batch —
--   1/15th of prod's ~2.97M anchors, so prod cost scales considerably
--   worse than what's shown below):
--     BEFORE: Merge Join, actual time 530.263..532.237ms, rows=1000
--             -> Seq Scan on public.anchors (200,011 rows, 49ms)
--             -> Sort Method: external merge  Disk: 33680kB
--             Execution Time: 533.834 ms
--     AFTER:  Nested Loop + Memoize, actual time 0.380..11.512ms, rows=1000
--             -> Index Scan using idx_anchors_fingerprint_lookup
--             Execution Time: 11.578 ms
--   ~46x faster at 1/15th scale; the fixed plan is O(batch_size * log(N))
--   (index probes) instead of O(N) (full table scan + sort), so the win
--   widens, not narrows, at prod's 2.97M-row scale — this is the confirmed
--   root cause of the wedge.
--
--   Fix: cast ONLY at the "existing" CTE's join predicate —
--   `a.fingerprint = d.fingerprint::character(64)` — so the join predicate
--   stays native bpchar = bpchar and both fingerprint-indexed access paths
--   remain usable, WITHOUT casting `input_data.fingerprint` itself (which
--   stays `::text`, preserving the INSERT path's implicit-assignment-cast
--   validation — see the REVIEW FOLLOW-UP note at the top of this file for
--   why an earlier version of this fix that cast the whole CTE column was a
--   correctness regression: an explicit `::character(64)` cast silently
--   truncates overlong input with no error, while the implicit
--   assignment cast used for an INSERT target column raises). Also swaps
--   the `a.id NOT IN (SELECT id FROM inserted)` anti-join for `NOT EXISTS`
--   (defensive parity with the 0330 anti-join convention elsewhere in this
--   codebase — no behavioral change here since `inserted.id` can never be
--   NULL, but NOT EXISTS is the house style and avoids the NOT-IN/NULL
--   footgun if that ever changes).
--
--   statement_timeout stays 120s (unchanged) as a backstop; the real
--   defense against a future wedge is the worker-side statement-timeout +
--   jittered backoff added in the same PR (services/worker/src/jobs/
--   publicRecordAnchor.ts), which prevents any single call — regressed or
--   not — from holding the lock past a bounded window.

CREATE OR REPLACE FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '120s'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Insert all anchors, skip duplicates via partial unique index
  -- Then return both newly inserted AND pre-existing anchors
  WITH input_data AS (
    SELECT
      (elem->>'user_id')::uuid AS user_id,
      (elem->>'org_id')::uuid AS org_id,
      -- SCRUM-3031 (review follow-up): stays `::text`, NOT
      -- `::character(64)`. This is deliberate, not the pre-0370 bug: an
      -- explicit `::character(64)` cast HERE would silently truncate an
      -- overlong fingerprint with no error (verified on real Postgres 17),
      -- which could insert a corrupted-but-valid-looking fingerprint or
      -- create a false dedup match — this table's dedup key must never
      -- silently coerce. Keeping this `::text` means the `inserted` CTE's
      -- `INSERT INTO anchors` below goes through the target column's own
      -- IMPLICIT assignment cast to `character(64)`, which RAISES loudly
      -- on any overlong value instead. The index-scan win from 0370 is
      -- preserved a different way: see the `existing` CTE below, which
      -- casts explicitly at the JOIN predicate instead of here.
      (elem->>'fingerprint')::text AS fingerprint,
      (elem->>'filename')::text AS filename,
      (elem->>'credential_type')::credential_type AS credential_type,
      'PENDING'::anchor_status AS status,
      (elem->'metadata')::jsonb AS metadata
    FROM jsonb_array_elements(p_anchors) AS elem
  ),
  inserted AS (
    INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, metadata)
    SELECT user_id, org_id, fingerprint, filename, credential_type, status, metadata
    FROM input_data
    ON CONFLICT (user_id, fingerprint) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id, fingerprint
  ),
  -- Also look up any that already existed (were skipped by ON CONFLICT)
  existing AS (
    SELECT a.id, a.fingerprint
    FROM anchors a
    -- SCRUM-3031: explicit cast on d.fingerprint (the NON-indexed side) so
    -- a.fingerprint (the INDEXED side) stays untouched and the native
    -- bpchar = bpchar operator drives idx_anchors_user_fingerprint_unique /
    -- idx_anchors_fingerprint_lookup. Safe from truncation: by the time
    -- this CTE runs, the `inserted` CTE above has already validated every
    -- input_data.fingerprint is <= 64 chars (its INSERT would have raised
    -- otherwise), so this cast can only pad, never truncate.
    INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint::character(64)
    WHERE a.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted i WHERE i.id = a.id)
  ),
  all_anchors AS (
    SELECT id, fingerprint FROM inserted
    UNION ALL
    SELECT id, fingerprint FROM existing
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'fingerprint', fingerprint))
  INTO v_result
  FROM all_anchors;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

ALTER FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") IS
  'SCRUM-3031 (migration 0370): dedup join casts explicitly to character(64) ON THE JOIN PREDICATE ONLY (a.fingerprint = d.fingerprint::character(64)), keeping idx_anchors_user_fingerprint_unique / idx_anchors_fingerprint_lookup usable instead of falling back to a full table scan + disk sort. input_data.fingerprint itself stays ::text so the INSERT still validates via the target column''s implicit assignment cast (raises loudly on overlong input instead of the review-caught silent-truncation bug from casting the whole CTE column). NOT EXISTS replaces NOT IN for anti-join house style.';

NOTIFY pgrst, 'reload schema';
