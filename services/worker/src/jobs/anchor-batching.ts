/**
 * Shared Bitcoin anchoring batch limits.
 *
 * One Bitcoin transaction commits one Merkle root, so the cap is about
 * operational payload size, not OP_RETURN capacity per leaf. Keep all pipeline
 * anchoring jobs on the same contract so throughput cannot drift by subsystem.
 *
 * PostgREST request-line limits and `.in()` filter chunking live in
 * `utils/postgrest-filter.ts` — a wire-shape concern, not an anchoring one, and
 * several non-anchoring modules need them.
 */

export const MAX_ANCHORS_PER_BITCOIN_TX = 10_000;
export const MIN_ANCHORS_PER_BITCOIN_TX = 100;

export function resolveAnchorBatchSize(rawValue?: number | string | null): number {
  const parsed =
    typeof rawValue === 'number'
      ? rawValue
      : Number.parseInt(String(rawValue ?? MAX_ANCHORS_PER_BITCOIN_TX), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MAX_ANCHORS_PER_BITCOIN_TX;
  }

  return Math.min(
    Math.max(Math.floor(parsed), MIN_ANCHORS_PER_BITCOIN_TX),
    MAX_ANCHORS_PER_BITCOIN_TX,
  );
}
