import { describe, it, expect, vi, beforeEach } from 'vitest';

import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from './postgrest-filter.js';

const mockLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock('./logger.js', () => ({ logger: mockLogger }));

const { fetchProfilePublicIdsByActorIds } = await import('./profilePublicIds.js');

const uuids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `1a2b3c4d-5e6f-4a8b-9c0d-${String(i).padStart(12, '0')}`);

/**
 * Emulates the real wire, which is the entire point: postgrest-js RESOLVES a
 * 400 as `{ data: null, error }`, it does not throw. A mock that throws would
 * make every one of these tests pass against the defective code.
 */
function mockDb(opts: {
  rows?: Array<{ id: string; public_id: string | null }>;
  failChunks?: 'all' | 'first' | 'none';
}) {
  const { rows = [], failChunks = 'none' } = opts;
  const seenFilters: string[][] = [];
  let call = 0;

  const db = {
    from: () => ({
      select: () => ({
        in: (_col: string, values: string[]) => {
          seenFilters.push(values);
          const idx = call++;
          const fails =
            failChunks === 'all' || (failChunks === 'first' && idx === 0) ||
            encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES;
          if (fails) {
            return Promise.resolve({
              data: null,
              error: { message: 'request line too large', code: 'PGRST' },
            });
          }
          const set = new Set(values);
          return Promise.resolve({ data: rows.filter((r) => set.has(r.id)), error: null });
        },
      }),
    }),
  };

  return { db, seenFilters };
}

describe('fetchProfilePublicIdsByActorIds', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('returns an empty map without touching the database for no actors', async () => {
    const { db, seenFilters } = mockDb({});
    await expect(fetchProfilePublicIdsByActorIds(db, [], 'test')).resolves.toEqual(new Map());
    expect(seenFilters).toHaveLength(0);
  });

  it('keeps every emitted filter inside the URL budget for an unbounded actor set', async () => {
    // An anchor's audit trail has no bound on distinct actors; 5,000 is well
    // inside what a long-lived credential accumulates.
    const ids = uuids(5_000);
    const { db, seenFilters } = mockDb({
      rows: ids.map((id) => ({ id, public_id: `pub_${id.slice(-4)}` })),
    });

    const out = await fetchProfilePublicIdsByActorIds(db, ids, 'test');

    expect(seenFilters.length).toBeGreaterThan(1);
    for (const chunk of seenFilters) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    // Every actor still resolved — chunking must not lose rows.
    expect(out.size).toBe(5_000);
  });

  it('throws rather than reporting an empty map when every chunk fails', async () => {
    const ids = uuids(10);
    const { db } = mockDb({ failChunks: 'all' });

    await expect(fetchProfilePublicIdsByActorIds(db, ids, 'test')).rejects.toThrow(
      /all 1 chunk\(s\) failed/,
    );
  });

  it('returns the partial map when only some chunks fail, and logs the failure', async () => {
    const ids = uuids(400); // > POSTGREST_IN_FILTER_CHUNK, so at least two chunks
    const rows = ids.map((id) => ({ id, public_id: `pub_${id.slice(-4)}` }));
    const { db, seenFilters } = mockDb({ rows, failChunks: 'first' });

    const out = await fetchProfilePublicIdsByActorIds(db, ids, 'test');

    expect(seenFilters.length).toBeGreaterThan(1);
    // First chunk lost, the rest resolved — a partial attribution map, not a throw.
    expect(out.size).toBeGreaterThan(0);
    expect(out.size).toBeLessThan(400);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('skips profiles with a null public_id instead of mapping them to null', async () => {
    const ids = uuids(3);
    const { db } = mockDb({
      rows: [
        { id: ids[0], public_id: 'pub_a' },
        { id: ids[1], public_id: null },
        { id: ids[2], public_id: 'pub_c' },
      ],
    });

    const out = await fetchProfilePublicIdsByActorIds(db, ids, 'test');

    expect(out.get(ids[0])).toBe('pub_a');
    expect(out.has(ids[1])).toBe(false);
    expect(out.get(ids[2])).toBe('pub_c');
  });
});
