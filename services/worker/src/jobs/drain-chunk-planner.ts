/**
 * Chunked-drain planner (SCRUM-2900 / BUG-008).
 *
 * The nightly drain must clear a large PENDING backlog in BOUNDED chunks: the
 * fee/credit model caps each broadcast batch (~10k anchors per Bitcoin tx). An
 * unbounded single-pass drain over a very large backlog is unsafe — oversized
 * transaction, unbounded memory, and a single failure loses the whole pass.
 *
 * This is a PURE planner: given a backlog size and a per-pass cap it returns
 * the exact sequence of bounded chunks. The coverage invariant (SCRUM-2620
 * repro) is the point — at chunk boundaries no item may be dropped or
 * double-processed, so `sum(chunks) === backlog` always holds and every chunk
 * is in `(0, cap]`.
 *
 * Side-effect-free by construction: no DB, no clock, no chain. The drain job
 * consumes the plan to size its claim/broadcast loop.
 */

/** Default per-pass cap (~10k anchors/tx, fee/credit model). */
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
