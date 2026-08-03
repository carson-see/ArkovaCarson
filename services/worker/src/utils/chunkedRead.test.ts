import { describe, it, expect, vi, beforeEach } from 'vitest';

import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from './postgrest-filter.js';

const mockLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock('./logger.js', () => ({ logger: mockLogger }));

const { readInChunks } = await import('./chunkedRead.js');

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `2b3c4d5e-6f7a-4b8c-9d0e-${String(i).padStart(12, '0')}`);

describe('readInChunks', () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
  });

  it('does not touch the database for an empty value list', async () => {
    const fetchChunk = vi.fn();
    await expect(readInChunks('t', [], fetchChunk)).resolves.toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();
  });

  it('keeps every emitted chunk inside the URL budget and returns every row', async () => {
    const values = ids(5_000);
    const seen: string[][] = [];

    const rows = await readInChunks('t', values, (chunk) => {
      seen.push(chunk);
      return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null });
    });

    expect(seen.length).toBeGreaterThan(1);
    for (const chunk of seen) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    // No value dropped, none duplicated.
    expect(seen.flat()).toEqual(values);
    expect(rows).toHaveLength(5_000);
  });

  it('returns a PARTIAL result and logs when one chunk fails', async () => {
    const values = ids(400);
    let call = 0;

    const rows = await readInChunks('t', values, (chunk) =>
      Promise.resolve(
        call++ === 0
          ? { data: null, error: { message: 'request line too large' } }
          : { data: chunk.map((id) => ({ id })), error: null },
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(400);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('throws rather than returning an empty result when EVERY chunk fails', async () => {
    await expect(
      readInChunks('t', ids(400), () =>
        Promise.resolve({ data: null, error: { message: 'boom' } }),
      ),
    ).rejects.toThrow(/all \d+ chunk\(s\) failed/);
  });

  it('never logs the filter values themselves (they are ids — §1.4)', async () => {
    const values = ids(10);
    await readInChunks('t', values, () =>
      Promise.resolve({ data: null, error: { message: 'boom' } }),
    ).catch(() => undefined);

    const logged = JSON.stringify(mockLogger.error.mock.calls);
    for (const v of values) expect(logged).not.toContain(v);
  });

  it('tolerates a chunk that resolves with null data and no error', async () => {
    const rows = await readInChunks('t', ids(10), () => Promise.resolve({ data: null, error: null }));
    expect(rows).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
