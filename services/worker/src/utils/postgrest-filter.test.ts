import { describe, expect, it } from 'vitest';
import {
  POSTGREST_IN_FILTER_CHUNK,
  POSTGREST_ROW_LIMIT,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
  PageScanError,
  assertNotAllChunksFailed,
  chunkForInFilter,
  scanAllPages,
} from './postgrest-filter.js';
import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';

function uuids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
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
    const chunks = chunkForInFilter(uuids(10_000));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.values.length).toBeLessThanOrEqual(POSTGREST_IN_FILTER_CHUNK);
    }
  });

  it('never emits a chunk over the URL budget, even for values far longer than a UUID', () => {
    // The count cap alone is calibrated for 36-byte UUIDs. `public_records`
    // dedup filters on `source_id`, an arbitrary upstream identifier (URLs,
    // docket numbers) — 200 of those would blow the budget while a count-only
    // cap reported success.
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

  it('charges the quotes postgrest-js adds around reserved-character values', () => {
    // postgrest-js wraps any value containing `,`, `(` or `)` in double quotes
    // before joining. Measuring with `encodeURIComponent` misses BOTH the
    // quotes and the 3-byte cost of the parens themselves, under-counting a
    // docket-shaped id by roughly 3x — so 200 of them passed the count cap and
    // went out ~1 KB over budget while the helper reported them as safe.
    const docketIds = Array.from({ length: 400 }, (_, i) => `Doe,Roe(ND-Cal)(2024)No${i}`);

    const chunks = chunkForInFilter(docketIds);

    for (const chunk of chunks) {
      expect(encodedInFilterBytesFor(chunk.values)).toBeLessThanOrEqual(
        POSTGREST_URL_FILTER_BUDGET_BYTES,
      );
    }
    // The byte cap, not the count cap, is what bound these.
    expect(chunks[0].values.length).toBeLessThan(POSTGREST_IN_FILTER_CHUNK);
  });

  it('measures spaces and multi-byte values at their real wire cost', () => {
    // Two encoders disagree in OPPOSITE directions here: a space is 1 byte on
    // the wire (`+`) but 3 under encodeURIComponent, while an emoji is 12.
    // Pinning both keeps the accounting honest rather than accidentally safe.
    const mixed = Array.from({ length: 600 }, (_, i) => `record ${i} \u{1F600} name`);

    for (const chunk of chunkForInFilter(mixed)) {
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
    for (const chunk of chunks) {
      expect(chunk.start).toBe(expectedStart);
      expect(input.slice(chunk.start, chunk.start + chunk.values.length)).toEqual(chunk.values);
      expectedStart += chunk.values.length;
    }
  });

  it('produces no chunks for an empty input', () => {
    // A caller that counts attempted chunks must see zero attempts, not one
    // empty `.in.()` request.
    expect(chunkForInFilter([])).toEqual([]);
  });

  it('emits an over-budget single value alone rather than dropping or merging it', () => {
    // Degenerate but must be honest: one value can exceed the budget by itself
    // and cannot be split. Emit it alone instead of silently discarding it or
    // padding a chunk around it.
    const oversized = 'y'.repeat(POSTGREST_URL_FILTER_BUDGET_BYTES * 2);
    const input = ['short-a', oversized, 'short-b'];

    const chunks = chunkForInFilter(input);

    expect(chunks.flatMap((c) => c.values)).toEqual(input);
    const oversizedChunk = chunks.find((c) => c.values.includes(oversized));
    expect(oversizedChunk?.values).toEqual([oversized]);
  });
});

describe('assertNotAllChunksFailed', () => {
  it('throws when every attempted chunk failed', () => {
    expect(() => assertNotAllChunksFailed('fetchThings', 5, 5, '900 id(s)')).toThrow(
      /fetchThings: all 5 chunk\(s\) failed for 900 id\(s\)/,
    );
  });

  it('stays silent on a partial failure — a partial result is still a real result', () => {
    expect(() => assertNotAllChunksFailed('fetchThings', 5, 4, '900 id(s)')).not.toThrow();
  });

  it('stays silent when no chunk was attempted', () => {
    // 0 === 0 must NOT read as "everything failed". Omitting this guard is a
    // live bug the moment a caller loses its empty-input early return.
    expect(() => assertNotAllChunksFailed('fetchThings', 0, 0, '0 id(s)')).not.toThrow();
  });
});

/**
 * `scanAllPages` — the read-side half of the same `db-max-rows` ambiguity
 * `chunkForInFilter` handles on the filter side.
 *
 * The failure it exists to prevent is quieter than an over-wide filter: a
 * too-wide `.in()` takes a 400 and is loud, while a scan that stops early
 * returns a plausible short answer at HTTP 200. `api/v1/auditBatchVerify.ts`
 * shipped exactly that, and the first attempt at fixing it hand-rolled the loop
 * and reintroduced it via `if (page.length < POSTGREST_ROW_LIMIT) break`.
 */
describe('scanAllPages', () => {
  /** A server that caps a page at `cap` rows regardless of the width asked for. */
  function server(rows: number[], cap: number) {
    const requested: Array<{ offset: number; limit: number }> = [];
    const fetchPage = (offset: number, limit: number) => {
      requested.push({ offset, limit });
      return Promise.resolve({
        data: rows.slice(offset, offset + Math.min(limit, cap)),
        error: null,
      });
    };
    return { fetchPage, requested };
  }

  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('reads every row when the server cap EQUALS the requested width', async () => {
    const { fetchPage } = server(rows(2500), POSTGREST_ROW_LIMIT);
    const scan = await scanAllPages(fetchPage, { maxRows: 25_000, maxPages: 64 });
    expect(scan.status).toBe('complete');
    expect(scan.rows).toHaveLength(2500);
  });

  it('reads every row when the server cap is BELOW the requested width', async () => {
    // `db-max-rows` is a server setting this code cannot see. Treating a short
    // page as end-of-data stops after page 1 and reports 500 of 5,000 rows.
    const { fetchPage, requested } = server(rows(5000), 500);
    const scan = await scanAllPages(fetchPage, { maxRows: 25_000, maxPages: 64 });
    expect(scan.status).toBe('complete');
    expect(scan.rows).toHaveLength(5000);
    // Offsets advance by rows RETURNED, not by the width requested.
    expect(requested.slice(0, 4).map((r) => r.offset)).toEqual([0, 500, 1000, 1500]);
  });

  it('reads every row when the server cap is ABOVE the requested width', async () => {
    const { fetchPage } = server(rows(2500), 5000);
    const scan = await scanAllPages(fetchPage, { maxRows: 25_000, maxPages: 64 });
    expect(scan.status).toBe('complete');
    expect(scan.rows).toHaveLength(2500);
  });

  it('treats an empty result set as complete, not as a failure', async () => {
    const { fetchPage, requested } = server([], POSTGREST_ROW_LIMIT);
    const scan = await scanAllPages(fetchPage, { maxRows: 10, maxPages: 64 });
    expect(scan).toEqual({ rows: [], status: 'complete' });
    expect(requested).toHaveLength(1);
  });

  it('costs exactly one extra request to prove there is no further page', async () => {
    const { fetchPage, requested } = server(rows(2 * POSTGREST_ROW_LIMIT), POSTGREST_ROW_LIMIT);
    const scan = await scanAllPages(fetchPage, { maxRows: 25_000, maxPages: 64 });
    expect(scan.status).toBe('complete');
    // Two full pages, then the empty one that ends it. A short-page shortcut
    // would save this request and buy a silent truncation with it.
    expect(requested).toHaveLength(3);
  });

  it('reports row_budget_exceeded rather than a complete short read', async () => {
    const { fetchPage } = server(rows(50_000), POSTGREST_ROW_LIMIT);
    const scan = await scanAllPages(fetchPage, { maxRows: 25_000, maxPages: 64 });
    expect(scan.status).toBe('row_budget_exceeded');
    expect(scan.rows.length).toBeGreaterThan(25_000);
  });

  it('reports page_budget_exhausted and cannot loop forever', async () => {
    // A server that never returns an empty page: every offset yields rows.
    let calls = 0;
    const fetchPage = () => {
      calls += 1;
      return Promise.resolve({ data: [1, 2, 3], error: null });
    };
    const scan = await scanAllPages(fetchPage, { maxRows: 1_000_000, maxPages: 8 });
    expect(scan.status).toBe('page_budget_exhausted');
    expect(calls).toBe(8);
  });

  it('throws PageScanError carrying the offset, never a silent empty result', async () => {
    const fetchPage = (offset: number) =>
      offset === 0
        ? Promise.resolve({ data: [1, 2, 3], error: null })
        : Promise.resolve({ data: null, error: { code: 'PGRST103' } });

    await expect(scanAllPages(fetchPage, { maxRows: 100, maxPages: 8 })).rejects.toThrow(
      PageScanError,
    );
    await scanAllPages(fetchPage, { maxRows: 100, maxPages: 8 }).catch((err) => {
      expect(err).toBeInstanceOf(PageScanError);
      expect((err as PageScanError).offset).toBe(3);
      expect((err as PageScanError).pgCode).toBe('PGRST103');
    });
  });
});
