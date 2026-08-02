import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHORS_PER_BITCOIN_TX,
  MIN_ANCHORS_PER_BITCOIN_TX,
  POSTGREST_IN_FILTER_CHUNK,
  POSTGREST_ROW_LIMIT,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
  chunkForInFilter,
  resolveAnchorBatchSize,
} from './anchor-batching.js';

function uuids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
}

/**
 * The oracle: the exact query-string value PostgREST receives for one `.in()`
 * filter. Deliberately re-derived here from the raw wire format instead of
 * reusing the production byte accounting — if the two ever drift, that is the
 * bug these tests exist to catch.
 */
function encodedInFilterBytesFor(values: string[]): number {
  return encodeURIComponent(`in.(${values.join(',')})`).length;
}

function encodedInFilterBytes(idCount: number): number {
  return encodedInFilterBytesFor(uuids(idCount));
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

/**
 * The width invariant lives HERE, once, on the helper — not replicated as a
 * per-call-site assertion.
 *
 * A per-call-site test only ever covers the call sites that existed when it was
 * written: PR #1795 fixed two of the three id-filter loops in
 * publicRecordAnchor.ts and its tests passed while the third still shipped the
 * defect (PR #1812). The guarantee has to be a property of the only supported
 * way to build the filter, so a NEW call site inherits it by construction.
 */
describe('chunkForInFilter', () => {
  it('exposes no chunk-size parameter — the width is not a caller decision', () => {
    // Both production defects were a caller picking the wrong size constant.
    // The helper takes exactly one argument (the values); there is no knob to
    // get wrong. This assertion is what makes that structural rather than
    // conventional.
    expect(chunkForInFilter).toHaveLength(1);
  });

  it('never emits a chunk wider than POSTGREST_IN_FILTER_CHUNK values', () => {
    const chunks = chunkForInFilter(uuids(MAX_ANCHORS_PER_BITCOIN_TX));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.values.length).toBeLessThanOrEqual(POSTGREST_IN_FILTER_CHUNK);
    }
  });

  it('never emits a chunk over the URL budget, even for values far longer than a UUID', () => {
    // The count cap alone is calibrated for 36-byte UUIDs. `public_records`
    // dedup filters on `source_id`, which is an arbitrary upstream identifier
    // (URLs, docket numbers) — 200 of those would blow the budget while a
    // count-only cap reported success. The helper measures encoded bytes, so
    // the guarantee holds for any value type.
    const longValues = Array.from(
      { length: 500 },
      (_, i) => `https://example.gov/records/${'x'.repeat(180)}/${i}`,
    );

    const chunks = chunkForInFilter(longValues);

    for (const chunk of chunks) {
      expect(encodedInFilterBytesFor(chunk.values)).toBeLessThanOrEqual(
        POSTGREST_URL_FILTER_BUDGET_BYTES,
      );
      // …and the byte cap, not the count cap, is what bound these.
      expect(chunk.values.length).toBeLessThan(POSTGREST_IN_FILTER_CHUNK);
    }
  });

  it('charges the URL-encoded cost of a value, not its raw length', () => {
    // `,` costs 3 bytes on the wire (%2C), not 1. Accounting in raw characters
    // under-counts and lets a chunk cross the budget it claims to respect.
    const encodingHeavy = Array.from({ length: 400 }, (_, i) => `a,b,c/${'%'.repeat(40)}/${i}`);

    for (const chunk of chunkForInFilter(encodingHeavy)) {
      expect(encodedInFilterBytesFor(chunk.values)).toBeLessThanOrEqual(
        POSTGREST_URL_FILTER_BUDGET_BYTES,
      );
    }
  });

  it('preserves every value exactly once and in order', () => {
    const input = uuids(1_234);

    const flattened = chunkForInFilter(input).flatMap((chunk) => chunk.values);

    expect(flattened).toEqual(input);
  });

  it('reports the true source offset of each chunk so error logs stay accurate', () => {
    const input = uuids(1_234);

    const chunks = chunkForInFilter(input);

    let expectedStart = 0;
    chunks.forEach((chunk, i) => {
      expect(chunk.start).toBe(expectedStart);
      expect(chunk.index).toBe(i);
      expect(chunk.total).toBe(chunks.length);
      expect(input.slice(chunk.start, chunk.start + chunk.values.length)).toEqual(chunk.values);
      expectedStart += chunk.values.length;
    });
  });

  it('produces no chunks for an empty input', () => {
    // A caller that counts attempted chunks must see zero attempts, not one
    // empty `.in.()` request.
    expect(chunkForInFilter([])).toEqual([]);
  });

  it('emits an over-budget single value alone rather than dropping or merging it', () => {
    // Degenerate but must be honest: one value can exceed the budget by itself
    // and cannot be split. Emit it alone (the request will fail loudly at the
    // call site) instead of silently discarding it or padding a chunk around it.
    const oversized = 'y'.repeat(POSTGREST_URL_FILTER_BUDGET_BYTES * 2);
    const input = ['short-a', oversized, 'short-b'];

    const chunks = chunkForInFilter(input);

    expect(chunks.flatMap((c) => c.values)).toEqual(input);
    const oversizedChunk = chunks.find((c) => c.values.includes(oversized));
    expect(oversizedChunk?.values).toEqual([oversized]);
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
