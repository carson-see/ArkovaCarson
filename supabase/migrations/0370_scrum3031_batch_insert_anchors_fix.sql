-- SCRUM-3031: batch_insert_anchors wedge — dedup-lookup type mismatch (migration 0370)
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
--   Fix: cast input_data.fingerprint to `character(64)` (matching the
--   column's native type) so the join predicate stays native bpchar = bpchar
--   and both fingerprint-indexed access paths remain usable. Also swaps the
--   `a.id NOT IN (SELECT id FROM inserted)` anti-join for `NOT EXISTS`
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
      -- SCRUM-3031: cast to character(64) — anchors.fingerprint's native
      -- type — NOT text. A text cast here forces an implicit cast on the
      -- indexed anchors.fingerprint column in the "existing" join below,
      -- which defeats idx_anchors_user_fingerprint_unique /
      -- idx_anchors_fingerprint_lookup and degrades to a full Seq Scan +
      -- disk-spilling sort of the entire anchors table on every call.
      (elem->>'fingerprint')::character(64) AS fingerprint,
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
    INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint
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
  'SCRUM-3031 (migration 0370): fingerprint cast fixed to character(64) so the dedup join keeps using idx_anchors_user_fingerprint_unique / idx_anchors_fingerprint_lookup instead of falling back to a full table scan + disk sort. NOT EXISTS replaces NOT IN for anti-join house style.';

NOTIFY pgrst, 'reload schema';
