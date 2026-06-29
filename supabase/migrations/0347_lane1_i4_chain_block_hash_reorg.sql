BEGIN;

-- Lane 1 Iteration 4 (chain integrity — BUG-A: false SECURED on same-height reorg)
--
-- detectReorgs() in services/worker/src/jobs/chain-maintenance.ts compared only
-- chain_block_height. A reorg that re-mines the anchoring TX into a DIFFERENT
-- block at the SAME height left the anchor falsely SECURED — the height-only
-- check saw no change even though the block hash (and therefore the proof) had
-- changed. block_hash is already parsed from the mempool.space response but was
-- unused, and `anchors` had `chain_block_height` but NO `chain_block_hash`
-- column to compare against.
--
-- This migration adds the missing `chain_block_hash` column to `anchors` (and
-- mirrors it on the O(1) verification index `anchor_chain_index`), and threads
-- the confirmed block hash into the SECURED-promotion RPC
-- `drain_submitted_to_secured_for_tx` so the value is persisted at promotion
-- time. With the stored hash, detectReorgs can revert SECURED → SUBMITTED on a
-- same-height block-hash mismatch; when the stored hash is NULL (legacy rows
-- secured before this migration) it falls back to the existing height-only
-- check — strictly-better, no regression.
--
-- Worker-only write path: `anchors` carries ENABLE + FORCE ROW LEVEL SECURITY
-- with a "service_role full access" policy plus prevent-direct-update triggers
-- that early-return for caller_role = 'service_role'. The worker writes via
-- service_role (and the RPC re-asserts the service_role GUC), so no RLS policy
-- or trigger change is required for these additive columns — confirmed against
-- 00000000000000_baseline_at_main_HEAD.sql. Additive nullable columns only; no
-- existing rows or behavior change.

ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS chain_block_hash text;

ALTER TABLE public.anchor_chain_index
  ADD COLUMN IF NOT EXISTS chain_block_hash text;

COMMENT ON COLUMN public.anchors.chain_block_hash IS
  'Lane 1 i4 (BUG-A): block hash of the confirmed Bitcoin block the anchoring TX was mined into, as reported by mempool.space at promotion time. Worker-only write via service_role (drain_submitted_to_secured_for_tx). Used by detectReorgs to catch same-height reorgs (block re-mined at the same height with a different hash). NULL for rows secured before this migration — detectReorgs falls back to height-only comparison for those.';

COMMENT ON COLUMN public.anchor_chain_index.chain_block_hash IS
  'Lane 1 i4 (BUG-A): mirror of anchors.chain_block_hash on the O(1) fingerprint-verification index, kept consistent with the other chain_* fields written by drain_submitted_to_secured_for_tx.';

-- Re-create the SECURED-promotion RPC with a trailing p_block_hash param.
-- The worker calls this with 6 named args today (p_chain_tx_id, p_block_height,
-- p_block_timestamp, p_confirmations, p_batch_size, p_max_iterations); adding
-- p_block_hash as a 7th param with DEFAULT NULL keeps that call valid. Body is
-- unchanged from the prod/baseline 6-arg definition except for the two new
-- chain_block_hash writes (anchors UPDATE + anchor_chain_index upsert) and the
-- new param. SECURITY DEFINER + search_path + statement_timeout + the
-- service_role GUC trigger short-circuit are all preserved verbatim.
CREATE OR REPLACE FUNCTION "public"."drain_submitted_to_secured_for_tx"(
  "p_chain_tx_id" "text",
  "p_block_height" integer,
  "p_block_timestamp" timestamp with time zone,
  "p_batch_size" integer DEFAULT 100,
  "p_max_iterations" integer DEFAULT 5,
  "p_confirmations" integer DEFAULT 1,
  "p_block_hash" "text" DEFAULT NULL
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '50s'
    AS $$
DECLARE
  v_updated int;
  v_updated_anchors jsonb;
  v_anchors jsonb := '[]'::jsonb;
  v_total_updated int := 0;
  v_iterations int := 0;
BEGIN
  -- Tell BEFORE-UPDATE triggers to short-circuit. SECURITY DEFINER doesn't
  -- change get_caller_role()'s reading of the JWT claim GUC.
  -- Contract: protect_anchor_fields/protect_anchor_status_transition and the
  -- duplicate-metadata guard depend on get_caller_role() honoring this
  -- service_role GUC. Preserve that trigger short-circuit if those guards are
  -- refactored.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  LOOP
    WITH batch AS (
      SELECT id FROM anchors
      WHERE chain_tx_id = p_chain_tx_id
        AND status = 'SUBMITTED'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE anchors a
      SET status = 'SECURED',
          chain_block_height = p_block_height,
          chain_block_hash = p_block_hash,
          chain_timestamp = p_block_timestamp,
          chain_confirmations = GREATEST(p_confirmations, 1)
      FROM batch
      WHERE a.id = batch.id
      RETURNING a.id, a.public_id, a.org_id, a.fingerprint
    ),
    chain_index AS (
      INSERT INTO public.anchor_chain_index (
        fingerprint_sha256,
        chain_tx_id,
        chain_block_height,
        chain_block_hash,
        chain_block_timestamp,
        confirmations,
        anchor_id
      )
      SELECT
        u.fingerprint,
        p_chain_tx_id,
        p_block_height,
        p_block_hash,
        p_block_timestamp,
        GREATEST(p_confirmations, 1),
        u.id
      FROM updated u
      WHERE u.fingerprint IS NOT NULL
      ON CONFLICT (fingerprint_sha256, chain_tx_id) DO UPDATE
      SET chain_block_height = EXCLUDED.chain_block_height,
          chain_block_hash = EXCLUDED.chain_block_hash,
          chain_block_timestamp = EXCLUDED.chain_block_timestamp,
          confirmations = GREATEST(COALESCE(public.anchor_chain_index.confirmations, 0), EXCLUDED.confirmations),
          anchor_id = EXCLUDED.anchor_id
      RETURNING 1
    )
    SELECT
      count(*)::int,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'public_id', public_id,
            'org_id', org_id
          )
        ),
        '[]'::jsonb
      )
    INTO v_updated, v_updated_anchors
    FROM updated;

    v_total_updated := v_total_updated + v_updated;
    v_anchors := v_anchors || v_updated_anchors;
    v_iterations := v_iterations + 1;

    EXIT WHEN v_updated < p_batch_size OR v_iterations >= p_max_iterations;
  END LOOP;

  RETURN jsonb_build_object(
    'tx_id', p_chain_tx_id,
    'updated', v_total_updated,
    'iterations', v_iterations,
    'anchors', v_anchors,
    'capped', v_iterations >= p_max_iterations
  );
END;
$$;

ALTER FUNCTION "public"."drain_submitted_to_secured_for_tx"(
  "p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone,
  "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer, "p_block_hash" "text"
) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"(
  "p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone,
  "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer, "p_block_hash" "text"
) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"(
  "p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone,
  "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer, "p_block_hash" "text"
) TO "service_role";

-- Drop the now-redundant 6-arg overload. PostgREST cannot disambiguate the
-- worker's 6-named-arg call between the old 6-arg function and the new 7-arg
-- function (they differ only by the trailing DEFAULT) — the CLAUDE.md §6
-- "function overloads differing only by DEFAULT → single function with DEFAULT"
-- rule. The 7-arg version above subsumes every existing call site. The legacy
-- 4-arg overload (p_batch_size DEFAULT 1000, no confirmations) is left intact:
-- it has a distinct arity, is not part of this ambiguity, and is out of scope.
DROP FUNCTION IF EXISTS "public"."drain_submitted_to_secured_for_tx"(
  "p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone,
  "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer
);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- -- Restore the prior 6-arg overload (baseline definition) so the worker's
-- -- 6-named-arg call resolves after the 7-arg version is dropped.
-- CREATE OR REPLACE FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer DEFAULT 100, "p_max_iterations" integer DEFAULT 5, "p_confirmations" integer DEFAULT 1) RETURNS "jsonb"
--     LANGUAGE "plpgsql" SECURITY DEFINER
--     SET "search_path" TO 'public'
--     SET "statement_timeout" TO '50s'
--     AS $$
-- DECLARE
--   v_updated int;
--   v_updated_anchors jsonb;
--   v_anchors jsonb := '[]'::jsonb;
--   v_total_updated int := 0;
--   v_iterations int := 0;
-- BEGIN
--   PERFORM set_config('request.jwt.claim.role', 'service_role', true);
--   LOOP
--     WITH batch AS (
--       SELECT id FROM anchors
--       WHERE chain_tx_id = p_chain_tx_id AND status = 'SUBMITTED' AND deleted_at IS NULL
--       ORDER BY created_at ASC LIMIT p_batch_size FOR UPDATE SKIP LOCKED
--     ),
--     updated AS (
--       UPDATE anchors a SET status = 'SECURED', chain_block_height = p_block_height,
--         chain_timestamp = p_block_timestamp, chain_confirmations = GREATEST(p_confirmations, 1)
--       FROM batch WHERE a.id = batch.id RETURNING a.id, a.public_id, a.org_id, a.fingerprint
--     ),
--     chain_index AS (
--       INSERT INTO public.anchor_chain_index (fingerprint_sha256, chain_tx_id, chain_block_height, chain_block_timestamp, confirmations, anchor_id)
--       SELECT u.fingerprint, p_chain_tx_id, p_block_height, p_block_timestamp, GREATEST(p_confirmations, 1), u.id
--       FROM updated u WHERE u.fingerprint IS NOT NULL
--       ON CONFLICT (fingerprint_sha256, chain_tx_id) DO UPDATE
--       SET chain_block_height = EXCLUDED.chain_block_height, chain_block_timestamp = EXCLUDED.chain_block_timestamp,
--           confirmations = GREATEST(COALESCE(public.anchor_chain_index.confirmations, 0), EXCLUDED.confirmations),
--           anchor_id = EXCLUDED.anchor_id RETURNING 1
--     )
--     SELECT count(*)::int, COALESCE(jsonb_agg(jsonb_build_object('public_id', public_id, 'org_id', org_id)), '[]'::jsonb)
--     INTO v_updated, v_updated_anchors FROM updated;
--     v_total_updated := v_total_updated + v_updated; v_anchors := v_anchors || v_updated_anchors; v_iterations := v_iterations + 1;
--     EXIT WHEN v_updated < p_batch_size OR v_iterations >= p_max_iterations;
--   END LOOP;
--   RETURN jsonb_build_object('tx_id', p_chain_tx_id, 'updated', v_total_updated, 'iterations', v_iterations, 'anchors', v_anchors, 'capped', v_iterations >= p_max_iterations);
-- END; $$;
-- ALTER FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) OWNER TO "postgres";
-- REVOKE ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) FROM PUBLIC;
-- GRANT ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) TO "service_role";
-- -- Drop the 7-arg version added by this migration.
-- DROP FUNCTION IF EXISTS "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer, "p_block_hash" "text");
-- ALTER TABLE public.anchor_chain_index DROP COLUMN IF EXISTS chain_block_hash;
-- ALTER TABLE public.anchors DROP COLUMN IF EXISTS chain_block_hash;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
