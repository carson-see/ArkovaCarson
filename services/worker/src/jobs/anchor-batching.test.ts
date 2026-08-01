import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHORS_PER_BITCOIN_TX,
  MIN_ANCHORS_PER_BITCOIN_TX,
  POSTGREST_IN_FILTER_CHUNK,
  POSTGREST_ROW_LIMIT,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
  resolveAnchorBatchSize,
} from './anchor-batching.js';

/**
 * Builds the `id=in.(...)` query-string value PostgREST receives for a chunk of
 * UUIDs, so the budget assertions below measure the real wire format rather
 * than an approximation.
 */
function encodedInFilterBytes(idCount: number): number {
  const ids = Array.from({ length: idCount }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  return encodeURIComponent(`in.(${ids.join(',')})`).length;
}

describe('PostgREST in-filter chunking (prod incident 2026-07-29)', () => {
  it('keeps an in-filter chunk inside the URL budget', () => {
    expect(encodedInFilterBytes(POSTGREST_IN_FILTER_CHUNK)).toBeLessThan(
      POSTGREST_URL_FILTER_BUDGET_BYTES,
    );
  });

  it('proves the row limit is NOT a safe in-filter size', () => {
    // The regression: fetchAnchorRows chunked ids by POSTGREST_ROW_LIMIT and fed
    // them to .in('id', chunk). 1,000 UUIDs is a ~38KB query string, which
    // PostgREST rejected with 400 Bad Request on every chunk. Every anchor row
    // lookup failed, nothing partitioned as pending, and public-record anchoring
    // silently produced zero anchors for 70+ hours while the cron returned 200.
    expect(encodedInFilterBytes(POSTGREST_ROW_LIMIT)).toBeGreaterThan(
      POSTGREST_URL_FILTER_BUDGET_BYTES,
    );
  });

  it('separates the row-return limit from the URL filter limit', () => {
    expect(POSTGREST_IN_FILTER_CHUNK).toBeLessThan(POSTGREST_ROW_LIMIT);
  });
});

describe('anchor batching contract', () => {
  it('pins the platform-wide Bitcoin transaction cap to 10k anchors', () => {
    expect(MAX_ANCHORS_PER_BITCOIN_TX).toBe(10_000);
  });

  it('defaults invalid values to the 10k cap', () => {
    expect(resolveAnchorBatchSize()).toBe(10_000);
    expect(resolveAnchorBatchSize('not-a-number')).toBe(10_000);
  });

  it('allows lower test overrides but never below the floor', () => {
    expect(resolveAnchorBatchSize(500)).toBe(500);
    expect(resolveAnchorBatchSize(1)).toBe(MIN_ANCHORS_PER_BITCOIN_TX);
  });

  it('never allows an override above 10k', () => {
    expect(resolveAnchorBatchSize(50_000)).toBe(10_000);
  });
});
