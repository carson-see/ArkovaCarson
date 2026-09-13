-- 0443_backfill_anchor_proof_block_height.sql
-- SCRUM-3953 / BUG-2026-09-02-005 — correct `anchor_proofs.block_height` and
--   `anchor_proofs.block_timestamp` from the confirmed `anchors` row.
--
--   `anchor_proofs.block_height` was written once, at BROADCAST, from
--   `broadcastSignedTx`'s `getBlockchainInfo().blocks` — the chain TIP at that
--   instant, not the height of the block the transaction was later mined into.
--   Nothing corrected it afterwards: `ConfirmationProof` carried no height, so
--   the confirmation pass rewrote the stale value onto itself.
--   `anchors.chain_block_height` IS corrected at confirmation
--   (`check-confirmations.ts` -> `drain_submitted_to_secured_for_tx`).
--
--   Measured on prod `vzwyaatejekddvltxyye` 2026-09-02 (read-only): 711,027 of
--   713,949 rows disagreed, 100% of them LOW, by the number of blocks mined
--   between broadcast and confirmation (1: 45%, 2: 36%, 3: 12%, tail to 13).
--   `anchors.chain_block_height` was verified against the chain itself
--   (`getblockheader` over the production GetBlock RPC) for all 44 block hashes
--   that carried more than one recorded height: it matched in 44/44, while in
--   34 of those 44 NEITHER `anchor_proofs` value was the real height.
--
--   Why this matters beyond tidiness: the certificate PDF's embedded
--   machine-readable packet published this height beside a correct
--   `block_hash`/`block_header`, and every Arkova verifier binds the height to
--   the chain — so a genuine anchor verified as `HEIGHT_MISMATCH`. The code
--   fix ships in the same PR; this migration repairs the rows already written.
--
--   SAFETY PREDICATE. A row is corrected ONLY when both tables already agree on
--   WHICH BLOCK the anchor is in (`p.block_hash = a.chain_block_hash`). That
--   makes this a pure height repair on rows whose block identity is not in
--   question — it can never move a row to a different block, and it silently
--   skips anything ambiguous (either hash null, or the two disagreeing) for
--   separate investigation. A 20,000-row prod sample showed 20,000 agreements
--   and zero disagreements, so the predicate is near-total in practice.
--
--   `block_timestamp` is repaired in the same pass: it held the BROADCAST wall
--   clock (`new Date()` in `broadcastSignedTx`), always earlier than the block.
--   `anchors.chain_timestamp` equals the header's own nTime on 20,000/20,000
--   sampled prod rows (2026-09-10, bytes [68,72) of `anchor_proofs.block_header`);
--   `anchor_proofs.block_timestamp` matched on 0.
--
--   Idempotent: `IS DISTINCT FROM` means a second run corrects nothing.
--
-- ROLLBACK:
--   None, deliberately. The pre-migration values are the broadcast-time chain
--   tips — provably wrong numbers with no independent source to restore them
--   from (the tip at a past instant is not recoverable from the chain). A
--   "rollback" could only re-corrupt the column, and re-running the forward
--   migration is a no-op, so recovery from a bad forward run is the forward run
--   itself. If a true revert is ever required, restore `anchor_proofs` from the
--   point-in-time backup taken before this migration ran; that is the only
--   faithful undo and it must be an explicit operator decision.
--
--   REHEARSED on an isolated throwaway Postgres 17 container (never prod, never
--   a rig, never the shared local stack): forward -> re-run -> confirmed
--   second run reports 0 rows, and rows failing the block-hash-agreement
--   predicate are left untouched. Re-rehearsed 2026-09-10 after adding the
--   block_timestamp repair.
--
-- Tier: T3 (touches supabase/migrations/ + anchor lifecycle data).
-- Types: no schema change, so no `database.types.ts` delta and no
--        `NOTIFY pgrst, 'reload schema'` — this is data only.

BEGIN;

-- §1.2: `anchors` is a hot table and is READ by this statement, so bound the
-- lock wait rather than becoming a FIFO barrier in front of every later lock
-- request (the 2026-08-11 P0 mechanism). Wrapped in BEGIN/COMMIT because a
-- bare `SET LOCAL` outside a transaction is discarded by `db push` (25P01),
-- which would let the CI regex pass a no-op.
SET LOCAL lock_timeout = '5s';

-- A ~711k-row backfill cannot finish inside the default 60s statement timeout,
-- and a partial run that dies mid-statement is the failure mode that produced
-- the 2026-04 SECURED gap. Lift it for this migration only.
SET LOCAL statement_timeout = '0';

DO $$
DECLARE
  v_batch   integer := 20000;
  v_fixed   integer;
  v_total   bigint := 0;
BEGIN
  LOOP
    WITH candidate AS (
      SELECT p.ctid AS row_id, a.chain_block_height AS correct_height,
             a.chain_timestamp AS correct_ts
      FROM public.anchor_proofs p
      JOIN public.anchors a ON a.id = p.anchor_id
      WHERE p.block_hash IS NOT NULL
        AND a.chain_block_hash = p.block_hash          -- same block, no question
        AND a.chain_block_height IS NOT NULL
        AND (p.block_height IS DISTINCT FROM a.chain_block_height
             OR (a.chain_timestamp IS NOT NULL
                 AND p.block_timestamp IS DISTINCT FROM a.chain_timestamp))
      LIMIT v_batch
    )
    UPDATE public.anchor_proofs p
    SET block_height = c.correct_height,
        block_timestamp = COALESCE(c.correct_ts, p.block_timestamp)
    FROM candidate c
    WHERE p.ctid = c.row_id;

    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    EXIT WHEN v_fixed = 0;
    v_total := v_total + v_fixed;
    RAISE NOTICE 'anchor_proofs block_height/block_timestamp corrected: % (running total %)', v_fixed, v_total;
  END LOOP;

  RAISE NOTICE 'SCRUM-3953 backfill complete: % row(s) corrected', v_total;
END
$$;

-- Post-condition: no row may keep a height that contradicts the block it names.
-- Fails the migration loudly rather than reporting a hollow success.
DO $$
DECLARE
  v_remaining bigint;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.anchor_proofs p
  JOIN public.anchors a ON a.id = p.anchor_id
  WHERE p.block_hash IS NOT NULL
    AND a.chain_block_hash = p.block_hash
    AND a.chain_block_height IS NOT NULL
    AND (p.block_height IS DISTINCT FROM a.chain_block_height
         OR (a.chain_timestamp IS NOT NULL
             AND p.block_timestamp IS DISTINCT FROM a.chain_timestamp));

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'SCRUM-3953 backfill incomplete: % row(s) still disagree with anchors (height or time)',
      v_remaining;
  END IF;
END
$$;

COMMIT;
