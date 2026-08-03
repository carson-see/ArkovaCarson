/**
 * `exportTrainingData` — the mark-exported write.
 *
 * This job appends rows to a JSONL corpus on disk and THEN sets
 * `training_exported = true`. That flag is the only thing stopping the next
 * tick from selecting and appending the same rows again, so a failed mark is
 * not a lost update — it is unbounded duplicate growth in the training corpus,
 * one full page per tick, forever.
 *
 * The filter took the whole page (`.limit(1000)` upstream) in a single `.in()`,
 * several times the PostgREST request-line budget. postgrest-js RESOLVES the
 * resulting 400 as `{ data: null, error }` rather than throwing, so the job
 * logged one line and returned a success-shaped `{ exported: 1000, errors: 1 }`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

const OUTPUT_PATH = '/tmp/arkova-test-training/never-written.jsonl';
vi.mock('../config.js', () => ({
  config: { trainingDataOutputPath: '/tmp/arkova-test-training/never-written.jsonl' },
}));

// The disk write is not under test; stub it so no file is created.
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../utils/postgrest-filter.js';

const { exportTrainingData } = await import('./trainingExporter.js');

const recordIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `4e5f6a7b-8c9d-4e0f-9a1b-${String(i).padStart(12, '0')}`);

function mockSupabase(opts: { ids: string[]; failChunk?: (v: string[]) => boolean }) {
  const seenFilters: string[][] = [];
  const rows = opts.ids.map((id, i) => ({
    id,
    title: `record ${i}`,
    source_url: `https://example.gov/${i}`,
    record_type: 'STATUTE',
    metadata: {},
    content_hash: 'a'.repeat(64),
  }));

  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
        }),
      }),
      update: () => ({
        in: (_c: string, values: string[]) => {
          seenFilters.push(values);
          const fail =
            opts.failChunk?.(values)
            ?? encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES;
          return Promise.resolve(
            fail
              ? { data: null, error: { message: 'request line too large' } }
              : { data: null, error: null },
          );
        },
      }),
    }),
  } as unknown as SupabaseClient;

  return { client, seenFilters };
}

describe('exportTrainingData — mark-exported filter', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('keeps every emitted filter inside the URL budget at a full export page', async () => {
    const ids = recordIds(1_000);
    const { client, seenFilters } = mockSupabase({ ids });

    const result = await exportTrainingData(client);

    expect(seenFilters.length).toBeGreaterThan(1);
    for (const chunk of seenFilters) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    // Every id marked — an unmarked id is a row that gets appended again.
    expect(seenFilters.flat().sort()).toEqual([...ids].sort());
    expect(result.exported).toBe(1_000);
    expect(result.errors).toBe(0);
  });

  it('throws rather than returning a success-shaped result when every mark fails', async () => {
    const { client } = mockSupabase({ ids: recordIds(50), failChunk: () => true });

    // The rows are already on disk. Reporting `{ exported: 50 }` here is what
    // let the corpus grow by a full page per tick with no failing signal.
    await expect(exportTrainingData(client)).rejects.toThrow(/all 1 chunk\(s\) failed/);
  });

  it('counts a partially failed mark as an error and names the re-export risk', async () => {
    const ids = recordIds(400);
    const firstId = ids[0];
    const { client } = mockSupabase({ ids, failChunk: (v) => v.includes(firstId) });

    const result = await exportTrainingData(client);

    expect(result.errors).toBeGreaterThan(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chunkStart: expect.any(Number) }),
      expect.stringContaining('re-exported'),
    );
  });

  it('is a no-op when the output path is unset or there is nothing to export', async () => {
    const { client, seenFilters } = mockSupabase({ ids: [] });

    const result = await exportTrainingData(client);

    expect(result).toEqual({ exported: 0, errors: 0 });
    expect(seenFilters).toHaveLength(0);
    expect(OUTPUT_PATH).toContain('never-written');
  });
});
