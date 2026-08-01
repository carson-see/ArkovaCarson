/**
 * Shared Bitcoin anchoring batch limits.
 *
 * One Bitcoin transaction commits one Merkle root, so the cap is about
 * operational payload size, not OP_RETURN capacity per leaf. Keep all pipeline
 * anchoring jobs on the same contract so throughput cannot drift by subsystem.
 */

export const MAX_ANCHORS_PER_BITCOIN_TX = 10_000;
export const MIN_ANCHORS_PER_BITCOIN_TX = 100;

/** Max rows PostgREST returns in one response. Governs pagination, NOT filter width. */
export const POSTGREST_ROW_LIMIT = 1_000;

/**
 * Byte budget for a single URL-encoded query-string filter value.
 *
 * PostgREST sits behind a proxy that rejects oversized request lines with
 * 400 Bad Request. 8 KiB is comfortably under the usual 16 KiB ceiling.
 */
export const POSTGREST_URL_FILTER_BUDGET_BYTES = 8_192;

/**
 * Max ids per `.in('id', chunk)` filter.
 *
 * A UUID costs ~39 bytes in the encoded `in.(...)` list — 36 for the uuid plus
 * a comma separator that `encodeURIComponent` expands to `%2C` (3 bytes).
 * Measured: 200 ids encode to 7,802 B against the 8,192 B budget. Headroom is
 * ~5%, so 210 already lands on the ceiling — do not raise this constant without
 * re-measuring (`anchor-batching.test.ts` pins the arithmetic).
 *
 * Do NOT chunk id filters by POSTGREST_ROW_LIMIT — that conflates two unrelated
 * limits (how many rows come back vs. how wide the URL may be) and is exactly
 * what silently killed public-record anchoring for 70+ hours on 2026-07-29.
 */
export const POSTGREST_IN_FILTER_CHUNK = 200;

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
