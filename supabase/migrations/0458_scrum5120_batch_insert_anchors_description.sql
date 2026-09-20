-- SCRUM-5120: batch_insert_anchors silently drops the caller-supplied `description`
--
-- `public.batch_insert_anchors(p_anchors jsonb)` (last redefined in 0370 for the
-- SCRUM-3031 dedup-lookup fix) never read `elem->>'description'` out of the
-- input JSONB, so every element's `description` field was silently discarded
-- on the way into `anchors` — the RPC returned a normal 200 (`{id, fingerprint}`
-- per row), so the caller had no signal anything was lost.
--
-- `services/worker/src/jobs/publicRecordAnchor.ts` (`buildPipelineAnchorInsert`,
-- via `publicRecordDescription`) has been building and sending `description` on
-- every pipeline anchor insert since before 0370 existed; it was never dropped
-- on the JS side, only swallowed here. 40,059 openalex + federal_register
-- anchors created since 2026-08-17 have `anchors.description IS NULL` with the
-- source text still recoverable from the linked `public_records.metadata`
-- (`abstract`, else `description`, else `summary`) via
-- `public_records.anchor_id = anchors.id` (`idx_public_records_anchor_id`).
-- The backfill for those existing rows is a separate, explicitly out-of-band
-- tool: `scripts/ops/repair-pipeline-anchor-descriptions.ts`. This migration
-- only stops the bug from recurring on every future call.
--
-- Fix: read `description` out of the input CTE and thread it through the
-- INSERT column list / matching SELECT. `anchors.description` is nullable
-- text with `anchors_description_max_length` (`char_length(description) <= 500`)
-- already enforcing the worker's own `truncateUtf16Safe(..., 500)` contract —
-- no new CHECK needed here. Every other line of 0370's body — the `::text`
-- dedup-lookup fix, the `existing` CTE's explicit
-- `a.fingerprint = d.fingerprint::character(64)` cast (the character(64)
-- fingerprint handling is load-bearing, see 0370's header for why casting the
-- whole CTE column instead would silently truncate an overlong fingerprint),
-- the `NOT EXISTS` anti-join, SECURITY DEFINER, `search_path`, `statement_timeout`
-- and the final `jsonb_agg` shape — is unchanged.
--
-- Grants: 0377 (`sec_recon_revoke_unguarded_rpc_family`) set this function to
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO
-- service_role`. CORRECTION (caught by the local `secdef-function-grants` CI
-- ratchet, scripts/ci/feedback-rules/secdef-function-grants.ts, before this
-- migration was committed): CREATE OR REPLACE FUNCTION on Supabase
-- RE-TRIGGERS `ALTER DEFAULT PRIVILEGES`, which grants `anon`/`authenticated`
-- EXECUTE directly at (re)creation time regardless of a same signature — this
-- is the exact mechanism behind five prior anon-callable-RLS-bypass incidents
-- (0364, 0377, 0378, 0388, 0406) that gate exists to stop, and the ACL is
-- decided by the LAST statement to touch it, not by 0377's now-superseded
-- revoke. So THIS file re-issues the identical
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO
-- service_role` immediately after the CREATE OR REPLACE below — required in
-- the SAME file as the (re)definition per that gate's own rule, not optional
-- belt-and-suspenders.
--
-- ROLLBACK: CREATE OR REPLACE FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") RETURNS "jsonb"
--     LANGUAGE "plpgsql" SECURITY DEFINER
--     SET "search_path" TO 'public'
--     SET "statement_timeout" TO '120s'
--     AS $$
--   DECLARE
--     v_result jsonb;
--   BEGIN
--     -- Insert all anchors, skip duplicates via partial unique index
--     -- Then return both newly inserted AND pre-existing anchors
--     WITH input_data AS (
--       SELECT
--         (elem->>'user_id')::uuid AS user_id,
--         (elem->>'org_id')::uuid AS org_id,
--         -- SCRUM-3031 (review follow-up): stays `::text`, NOT
--         -- `::character(64)`. This is deliberate, not the pre-0370 bug: an
--         -- explicit `::character(64)` cast HERE would silently truncate an
--         -- overlong fingerprint with no error (verified on real Postgres 17),
--         -- which could insert a corrupted-but-valid-looking fingerprint or
--         -- create a false dedup match — this table's dedup key must never
--         -- silently coerce. Keeping this `::text` means the `inserted` CTE's
--         -- `INSERT INTO anchors` below goes through the target column's own
--         -- IMPLICIT assignment cast to `character(64)`, which RAISES loudly
--         -- on any overlong value instead. The index-scan win from 0370 is
--         -- preserved a different way: see the `existing` CTE below, which
--         -- casts explicitly at the JOIN predicate instead of here.
--         (elem->>'fingerprint')::text AS fingerprint,
--         (elem->>'filename')::text AS filename,
--         (elem->>'credential_type')::credential_type AS credential_type,
--         'PENDING'::anchor_status AS status,
--         (elem->'metadata')::jsonb AS metadata
--       FROM jsonb_array_elements(p_anchors) AS elem
--     ),
--     inserted AS (
--       INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, metadata)
--       SELECT user_id, org_id, fingerprint, filename, credential_type, status, metadata
--       FROM input_data
--       ON CONFLICT (user_id, fingerprint) WHERE deleted_at IS NULL
--       DO NOTHING
--       RETURNING id, fingerprint
--     ),
--     -- Also look up any that already existed (were skipped by ON CONFLICT)
--     existing AS (
--       SELECT a.id, a.fingerprint
--       FROM anchors a
--       -- SCRUM-3031: explicit cast on d.fingerprint (the NON-indexed side) so
--       -- a.fingerprint (the INDEXED side) stays untouched and the native
--       -- bpchar = bpchar operator drives idx_anchors_user_fingerprint_unique /
--       -- idx_anchors_fingerprint_lookup. Safe from truncation: by the time
--       -- this CTE runs, the `inserted` CTE above has already validated every
--       -- input_data.fingerprint is <= 64 chars (its INSERT would have raised
--       -- otherwise), so this cast can only pad, never truncate.
--       INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint::character(64)
--       WHERE a.deleted_at IS NULL
--       AND NOT EXISTS (SELECT 1 FROM inserted i WHERE i.id = a.id)
--     ),
--     all_anchors AS (
--       SELECT id, fingerprint FROM inserted
--       UNION ALL
--       SELECT id, fingerprint FROM existing
--     )
--     SELECT jsonb_agg(jsonb_build_object('id', id, 'fingerprint', fingerprint))
--     INTO v_result
--     FROM all_anchors;
--
--     RETURN COALESCE(v_result, '[]'::jsonb);
--   END;
--   $$;
--
--   ALTER FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") OWNER TO "postgres";
--
--   COMMENT ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") IS
--     'SCRUM-3031 (migration 0370): dedup join casts explicitly to character(64) ON THE JOIN PREDICATE ONLY (a.fingerprint = d.fingerprint::character(64)), keeping idx_anchors_user_fingerprint_unique / idx_anchors_fingerprint_lookup usable instead of falling back to a full table scan + disk sort. input_data.fingerprint itself stays ::text so the INSERT still validates via the target column''s implicit assignment cast (raises loudly on overlong input instead of the review-caught silent-truncation bug from casting the whole CTE column). NOT EXISTS replaces NOT IN for anti-join house style.';
--
--   REVOKE ALL ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") FROM PUBLIC, "anon", "authenticated";
--   GRANT EXECUTE ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") TO "service_role";
--   -- (the REVOKE/GRANT pair above is NOT part of 0370's original body — it is
--   -- added here so the rollback does not silently reopen the anon/authenticated
--   -- hole that 0377 closed and this file's own REVOKE re-closes: restoring
--   -- 0370's body via CREATE OR REPLACE re-triggers ALTER DEFAULT PRIVILEGES
--   -- the same way this migration's forward path does, so a rollback with no
--   -- REVOKE after it would leave the function anon/authenticated-callable.)
--
--   NOTIFY pgrst, 'reload schema';
--   (restores the exact 0370 function body — reintroduces the SCRUM-5120
--   description-drop bug; do not use except to roll back a confirmed-bad
--   deploy of this migration.)

-- CREATE OR REPLACE FUNCTION does not take a lock on the anchors table itself,
-- but anchors is a hot table (CLAUDE.md §1.2) and this file legitimately
-- pattern-matches the hot-table DDL gate, so bound it anyway — harmless here,
-- required everywhere else DDL touches this function's table.
SET LOCAL lock_timeout = '5s';

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
      -- SCRUM-5120: read the caller-supplied description. Nullable text;
      -- `anchors_description_max_length` (<= 500 chars) is enforced by the
      -- target column's own CHECK constraint on INSERT, same as it always
      -- was for every other write path into `anchors.description`.
      (elem->>'description')::text AS description,
      (elem->'metadata')::jsonb AS metadata
    FROM jsonb_array_elements(p_anchors) AS elem
  ),
  inserted AS (
    INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, description, metadata)
    SELECT user_id, org_id, fingerprint, filename, credential_type, status, description, metadata
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
  'SCRUM-5120 (migration 0458): threads elem->>''description'' through the input CTE and the INSERT column list/matching SELECT so pipeline-anchor descriptions (services/worker/src/jobs/publicRecordAnchor.ts buildPipelineAnchorInsert) are actually persisted instead of silently dropped. Dedup-lookup behavior is unchanged from 0370 (SCRUM-3031): join predicate casts explicitly to character(64) ON THE JOIN PREDICATE ONLY (a.fingerprint = d.fingerprint::character(64)), keeping idx_anchors_user_fingerprint_unique / idx_anchors_fingerprint_lookup usable; input_data.fingerprint stays ::text so the INSERT still validates via the target column''s implicit assignment cast. NOT EXISTS anti-join house style unchanged.';

-- SCRUM-5120 / secdef-function-grants ratchet: CREATE OR REPLACE re-triggers
-- ALTER DEFAULT PRIVILEGES, so 0377's revoke does not survive this
-- redefinition on its own — reissue it here, in this same file, after the
-- (re)definition. `FROM PUBLIC` alone would NOT be enough (does not remove a
-- direct anon/authenticated grant); both roles must be named explicitly.
REVOKE ALL ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") TO "service_role";

NOTIFY pgrst, 'reload schema';
