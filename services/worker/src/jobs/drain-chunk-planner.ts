/**
 * Chunked-drain planner (SCRUM-2900 / BUG-008).
 *
 * The nightly drain clears a large PENDING backlog in BOUNDED passes. Each pass
 * is one `processBatchAnchors()` invocation, which claims at most one batch.
 *
 * IMPORTANT — what the cap actually bounds (Bitcoin/DBA review correction):
 * the per-pass cap is a DB-CLAIM / MEMORY bound, NOT a transaction-size or fee
 * bound. One batch commits ONE Merkle root under ONE ~36-byte OP_RETURN tx
 * regardless of leaf count (batch-anchor.ts: "unlimited anchors at the same
 * Bitcoin cost"), so a fatter batch is NOT a fatter/costlier tx. The cap exists
 * because a batch must (a) fit the in-memory Merkle tree, (b) write that many
 * `anchor_proofs` rows, and (c) be claimed through the 1000-row PostgREST loop.
 * It mirrors batch-anchor.ts `BATCH_SIZE` (env `BATCH_ANCHOR_MAX_SIZE`).
 *
 * This planner is a PURE PASS-COUNT ESTIMATOR: given a snapshot backlog and the
 * per-pass cap it returns the bounded pass sequence. The `sum(chunks) === backlog`
 * coverage invariant is a property of the ARITHMETIC, not a DB guarantee — real
 * no-double-claim / no-gap safety lives in the atomic `claim_pending_anchors`
 * RPC + the in-process batch mutex (batch-anchor.ts), NOT here. A consumer may
 * ONLY use this plan to size the NUMBER of `processBatchAnchors()` invocations;
 * it must NEVER drive a lower-level claim/broadcast loop that bypasses the
 * per-call fee-ceiling (Trigger C) + intent/mutex guards.
 *
 * Side-effect-free: no DB, no clock, no chain.
 */

/**
 * Default per-pass cap. MUST mirror batch-anchor.ts `BATCH_SIZE` (env
 * `BATCH_ANCHOR_MAX_SIZE`, prod=10000, lower-bound 100). Kept as a local
 * constant so this module stays pure (no config/db/chain import); a drift here
 * vs a lowered `BATCH_ANCHOR_MAX_SIZE` would over-count per-pass coverage, so a
 * real consumer must pass the live cap rather than rely on this default. See
 * batch-drain-deadman.ts for the same local-mirror-with-caveat pattern.
 */
export const DEFAULT_MAX_CHUNK = 10_000;

export interface DrainPlan {
  /** Number of bounded passes required to clear the backlog. */
  passes: number;
  /** Per-pass chunk sizes, in order. Each is in (0, maxChunk]. */
  chunks: number[];
  /** Total items covered by the plan — always equals the input backlog. */
  totalCovered: number;
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}

/**
 * Plan the bounded chunks needed to drain `backlog` items, no chunk larger
 * than `maxChunk`. Fails loud on invalid inputs rather than silently clamping
 * (a silent clamp is exactly the boundary bug this guards against).
 */
export function planDrainChunks(
  backlog: number,
  maxChunk: number = DEFAULT_MAX_CHUNK,
): DrainPlan {
  assertNonNegativeInt(backlog, 'backlog');
  assertPositiveInt(maxChunk, 'maxChunk');

  const chunks: number[] = [];
  let remaining = backlog;
  while (remaining > 0) {
    const take = Math.min(maxChunk, remaining);
    chunks.push(take);
    remaining -= take;
  }

  return {
    passes: chunks.length,
    chunks,
    totalCovered: chunks.reduce((a, b) => a + b, 0),
  };
}
