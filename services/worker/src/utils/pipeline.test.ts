/**
 * `getExistingSourceIds` — the public-record dedup lookup in `utils/pipeline.ts`,
 * the module new fetchers are told to import from instead of re-declaring.
 *
 * It carried both halves of the defect that killed public-record anchoring for
 * 70 hours, though only one half was live. The discarded error (a 400 becoming
 * an empty result set) was reachable in production. The unchunked `.in()` was
 * NOT: the single caller today passes module-constant statute section ids, tens
 * at a time. It is fixed as a latent trap for the next fetcher to adopt this
 * helper with a data-sized id list — do not read these tests as evidence of a
 * second live outage.
 *
 * They pin the fix from the outside — the emitted wire filter and the failure
 * semantics — not the chunking arithmetic, which is owned by
 * `jobs/anchor-batching.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./logger.js', () => ({ logger: mockLogger }));

import { getExistingSourceIds } from './pipeline.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../jobs/anchor-batching.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function encodedInFilterBytes(values: string[]): number {
  return encodeURIComponent(`in.(${values.join(',')})`).length;
}

/**
 * Records the `.in()` filter each chunk actually puts on the wire. `matches`
 * decides which source_ids the table "already has"; `errorFor` fails selected
 * chunks so failure semantics can be driven per chunk.
 */
function recordingSupabase(options: {
  matches?: Set<string>;
  errorFor?: (chunkIndex: number) => unknown;
} = {}) {
  const inCalls: string[][] = [];
  let chunkIndex = 0;

  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_column: string, values: string[]) => {
            const index = chunkIndex++;
            inCalls.push(values);
            const error = options.errorFor?.(index) ?? null;
            if (error) return Promise.resolve({ data: null, error });
            const matched = options.matches
              ? values.filter((v) => options.matches?.has(v))
              : [];
            return Promise.resolve({
              data: matched.map((source_id) => ({ source_id })),
              error: null,
            });
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;

  return { client, inCalls };
}

/** Real-world shape: source ids are upstream identifiers, not UUIDs. */
function sourceIds(count: number, width = 40): string[] {
  return Array.from(
    { length: count },
    (_, i) => `https://example.gov/${'s'.repeat(width)}/${i}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getExistingSourceIds', () => {
  it('returns an empty set without querying when given no ids', async () => {
    const { client, inCalls } = recordingSupabase();

    await expect(getExistingSourceIds(client, 'edgar', [])).resolves.toEqual(new Set());
    expect(inCalls).toHaveLength(0);
  });

  it('keeps every emitted id filter inside the PostgREST URL budget', async () => {
    // Pre-fix this issued ONE filter containing every id in the fetch page.
    const { client, inCalls } = recordingSupabase();

    await getExistingSourceIds(client, 'edgar', sourceIds(2_000));

    expect(inCalls.length).toBeGreaterThan(1);
    for (const values of inCalls) {
      expect(encodedInFilterBytes(values)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
  });

  it('unions matches across chunks without dropping or duplicating ids', async () => {
    const ids = sourceIds(1_000);
    const present = new Set([ids[0], ids[499], ids[999]]);
    const { client } = recordingSupabase({ matches: present });

    const result = await getExistingSourceIds(client, 'edgar', ids);

    expect(result).toEqual(present);
  });

  it('throws rather than returning an empty dedup set when every chunk fails', async () => {
    // The silent-empty path: an empty Set reads as "nothing is a duplicate",
    // so a permanently broken dedup looks identical to a clean corpus.
    const { client } = recordingSupabase({ errorFor: () => ({ message: 'Bad Request' }) });

    await expect(getExistingSourceIds(client, 'edgar', sourceIds(1_000))).rejects.toThrow(
      /refusing to report an empty dedup set as success/,
    );
  });

  it('keeps a partial result when only some chunks fail, and logs each failure', async () => {
    // A partial dedup set is safe — batchUpsertRecords upserts with
    // ignoreDuplicates, so a missed duplicate is a redundant write, not a bad
    // row. Failing the whole fetch here would be worse than the partial answer.
    const ids = sourceIds(1_000);
    const present = new Set(ids);
    const { client, inCalls } = recordingSupabase({
      matches: present,
      errorFor: (i) => (i === 0 ? { message: 'Bad Request' } : null),
    });

    const result = await getExistingSourceIds(client, 'edgar', ids);

    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBeLessThan(ids.length);
    // Nothing from the failed first chunk leaked into the result.
    for (const value of inCalls[0]) expect(result.has(value)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [context] = mockLogger.error.mock.calls[0];
    expect((context as { chunkStart?: number }).chunkStart).toBe(0);
  });
});
