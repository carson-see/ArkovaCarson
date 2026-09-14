import { describe, it, expect, vi } from 'vitest';
import {
  EXIT_VALIDATION,
  PROD_SUPABASE_REF,
  DEFAULT_SOURCES,
  DEFAULT_SINCE,
  DEFAULT_BATCH_SIZE,
  isProdUrl,
  truncateCodePoints,
  computeDescription,
  buildBatchUpdateSql,
  nextCursor,
  parseCliArgs,
  runRepair,
  createSupabaseRepairClient,
  type RepairClient,
} from './repair-pipeline-anchor-descriptions.js';

describe('isProdUrl', () => {
  it('flags a SUPABASE_URL containing the prod ref', () => {
    expect(isProdUrl(`https://${PROD_SUPABASE_REF}.supabase.co`)).toBe(true);
  });

  it('does not flag a non-prod ref', () => {
    expect(isProdUrl('https://txvvrxngyfnnqahujbld.supabase.co')).toBe(false);
    expect(isProdUrl('http://127.0.0.1:54321')).toBe(false);
  });
});

describe('truncateCodePoints — surrogate-safe, code-point based (matches Postgres left())', () => {
  it('returns short text unchanged', () => {
    expect(truncateCodePoints('hello', 500)).toBe('hello');
  });

  it('truncates plain ASCII text to exactly max code points', () => {
    const text = 'a'.repeat(600);
    const result = truncateCodePoints(text, 500);
    expect(result).toHaveLength(500);
  });

  it('never splits a surrogate pair (the 2026-08-17 poison-record class of bug)', () => {
    // U+1F600 GRINNING FACE is one code point, two UTF-16 code units
    // (a high + low surrogate pair). Build a string whose 500th UTF-16 unit
    // would land inside a pair if truncation were unit-based instead of
    // code-point based.
    const emoji = '\u{1F600}'; // one code point, 2 UTF-16 units
    const text = 'a'.repeat(499) + emoji + emoji; // 499 + 2 code points = 501 code points
    const result = truncateCodePoints(text, 500);
    // Must keep exactly 500 CODE POINTS (499 'a's + one whole emoji), never a
    // lone high surrogate from splitting the second emoji's pair.
    expect(Array.from(result)).toHaveLength(500);
    expect(result).toBe('a'.repeat(499) + emoji);
    // A lone unpaired surrogate would fail JSON.stringify's replacement
    // round-trip in a way a whole code point never does — belt-and-suspenders
    // proof nothing got split.
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });
});

describe('computeDescription', () => {
  it('prefers abstract over description over summary', () => {
    expect(computeDescription({ abstract: 'A', description: 'B', summary: 'C' })).toBe('A');
    expect(computeDescription({ description: 'B', summary: 'C' })).toBe('B');
    expect(computeDescription({ summary: 'C' })).toBe('C');
  });

  it('treats an empty string as absent, not as the chosen value', () => {
    expect(computeDescription({ abstract: '', description: 'B' })).toBe('B');
    expect(computeDescription({ abstract: '', description: '', summary: '' })).toBeNull();
  });

  it('returns null for missing/null metadata', () => {
    expect(computeDescription(null)).toBeNull();
    expect(computeDescription(undefined)).toBeNull();
    expect(computeDescription({})).toBeNull();
  });

  it('truncates an overlong source text to 500 code points', () => {
    const long = 'x'.repeat(1000);
    const result = computeDescription({ abstract: long });
    expect(result).toHaveLength(500);
  });
});

describe('buildBatchUpdateSql — the reference single-statement SQL', () => {
  it('is bounded by a 5s lock_timeout', () => {
    const { text } = buildBatchUpdateSql(['a'], ['openalex']);
    expect(text).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('joins anchors to public_records on anchor_id = id', () => {
    const { text } = buildBatchUpdateSql(['a'], ['openalex']);
    expect(text).toMatch(/FROM public_records pr/);
    expect(text).toMatch(/pr\.anchor_id\s*=\s*a\.id/);
  });

  it('guards on a.description IS NULL (idempotent — never overwrites an existing description)', () => {
    const { text } = buildBatchUpdateSql(['a'], ['openalex']);
    expect(text).toMatch(/a\.description IS NULL/);
  });

  it('truncates via left(..., 500), never .slice()', () => {
    const { text } = buildBatchUpdateSql(['a'], ['openalex']);
    expect(text).toMatch(/left\(/);
    expect(text).toContain('500');
  });

  it('scopes both the id batch and the source list as query parameters', () => {
    const { text, values } = buildBatchUpdateSql(['id-1', 'id-2'], ['openalex', 'federal_register']);
    expect(text).toMatch(/a\.id = ANY\(\$1\)/);
    expect(text).toMatch(/pr\.source = ANY\(\$2\)/);
    expect(values).toEqual([['id-1', 'id-2'], ['openalex', 'federal_register'], DEFAULT_SINCE]);
  });

  it('applies the same abstract/description/summary coalesce priority as computeDescription', () => {
    const { text } = buildBatchUpdateSql(['a'], ['openalex']);
    const abstractIdx = text.indexOf("'abstract'");
    const descriptionIdx = text.indexOf("'description'");
    const summaryIdx = text.indexOf("'summary'");
    expect(abstractIdx).toBeGreaterThan(-1);
    expect(descriptionIdx).toBeGreaterThan(abstractIdx);
    expect(summaryIdx).toBeGreaterThan(descriptionIdx);
  });
});

describe('nextCursor — keyset planner', () => {
  it('returns null for an empty page (walk exhausted)', () => {
    expect(nextCursor([])).toBeNull();
  });

  it('returns the last row id, not the first', () => {
    expect(nextCursor([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe('c');
  });
});

describe('parseCliArgs', () => {
  it('defaults to dry-run, default sources, default since, default batch size, no max-batches', () => {
    const opts = parseCliArgs([]);
    expect(opts.apply).toBe(false);
    expect(opts.sources).toEqual([...DEFAULT_SOURCES]);
    expect(opts.since).toBe(DEFAULT_SINCE);
    expect(opts.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(opts.maxBatches).toBeNull();
    expect(opts.allowProd).toBe(false);
  });

  it('--apply flips apply on', () => {
    expect(parseCliArgs(['--apply']).apply).toBe(true);
  });

  it('--i-know-this-is-prod flips allowProd on', () => {
    expect(parseCliArgs(['--i-know-this-is-prod']).allowProd).toBe(true);
  });

  it('parses a comma-separated --sources list, trimming whitespace', () => {
    expect(parseCliArgs(['--sources', 'openalex, federal_register , courtlistener']).sources).toEqual([
      'openalex', 'federal_register', 'courtlistener',
    ]);
  });

  it('rejects an empty --sources list', () => {
    expect(() => parseCliArgs(['--sources', ' , ,'])).toThrow(/--sources must not be empty/);
  });

  it('rejects a malformed --since', () => {
    expect(() => parseCliArgs(['--since', '08-17-2026'])).toThrow(/--since must be YYYY-MM-DD/);
    expect(() => parseCliArgs(['--since', 'not-a-date'])).toThrow(/--since must be YYYY-MM-DD/);
  });

  it('accepts a valid --since', () => {
    expect(parseCliArgs(['--since', '2026-08-17']).since).toBe('2026-08-17');
  });

  it('rejects a non-positive --max-batches', () => {
    expect(() => parseCliArgs(['--max-batches', '0'])).toThrow(/--max-batches must be a positive integer/);
    // node:util parseArgs treats a bare `-1` after a string-option flag as an
    // ambiguous "looks like another flag" token and throws its OWN error
    // before this validation runs (same parseArgs behavior noted in
    // scripts/ops/mfa-break-glass.ts) — use the `=` form to actually reach
    // the negative-number branch of this validation.
    expect(() => parseCliArgs(['--max-batches=-1'])).toThrow(/--max-batches must be a positive integer/);
    expect(() => parseCliArgs(['--max-batches', 'abc'])).toThrow(/--max-batches must be a positive integer/);
  });

  it('accepts a valid --max-batches', () => {
    expect(parseCliArgs(['--max-batches', '3']).maxBatches).toBe(3);
  });

  it('rejects an out-of-range --batch-size', () => {
    expect(() => parseCliArgs(['--batch-size', '0'])).toThrow(/--batch-size must be a positive integer/);
    expect(() => parseCliArgs(['--batch-size', '5001'])).toThrow(/--batch-size must be a positive integer/);
  });
});

/** Builds a mocked RepairClient (no network) backed by an in-memory fixture. */
function fakeClient(
  anchors: Array<{ id: string; description: string | null }>,
  records: Array<{ anchor_id: string; source: string; metadata: Record<string, unknown> }>,
): { client: RepairClient; state: () => Array<{ id: string; description: string | null }> } {
  const state = anchors.map((a) => ({ ...a }));
  const client: RepairClient = {
    async fetchCandidateIds(lastId, limit) {
      return state
        .filter((a) => a.description === null)
        .filter((a) => lastId === null || a.id > lastId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((a) => ({ id: a.id }));
    },
    async fetchSourceRows(ids, sources) {
      return records
        .filter((r) => ids.includes(r.anchor_id) && sources.includes(r.source))
        .map((r, i) => ({ id: `source-${i.toString().padStart(4, '0')}`, anchor_id: r.anchor_id, metadata: r.metadata }));
    },
    async updateDescription(id, description) {
      const row = state.find((a) => a.id === id);
      if (!row || row.description !== null) return { updated: false };
      row.description = description;
      return { updated: true };
    },
  };
  return { client, state: () => state.map((a) => ({ ...a })) };
}

describe('runRepair — batch loop (mocked client, no network)', () => {
  const baseOptions = {
    sources: ['openalex', 'federal_register'],
    since: '2026-08-17',
    batchSize: 2,
    maxBatches: null,
    allowProd: false,
  };

  it('dry-run counts candidates but writes nothing', async () => {
    const { client, state } = fakeClient(
      [{ id: 'a1', description: null }, { id: 'a2', description: null }],
      [
        { anchor_id: 'a1', source: 'openalex', metadata: { abstract: 'Text A' } },
        { anchor_id: 'a2', source: 'federal_register', metadata: { summary: 'Text B' } },
      ],
    );
    const log = vi.fn();
    const result = await runRepair(client, { ...baseOptions, apply: false }, log);

    expect(result.updated).toBe(2);
    expect(result.candidatesSeen).toBe(2);
    // Nothing actually written.
    expect(state().every((a) => a.description === null)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
  });

  it('apply writes descriptions and is idempotent on a second run', async () => {
    const { client, state } = fakeClient(
      [{ id: 'a1', description: null }, { id: 'a2', description: null }],
      [
        { anchor_id: 'a1', source: 'openalex', metadata: { abstract: 'Text A' } },
        { anchor_id: 'a2', source: 'federal_register', metadata: { summary: 'Text B' } },
      ],
    );

    const first = await runRepair(client, { ...baseOptions, apply: true }, vi.fn());
    expect(first.updated).toBe(2);
    expect(state()).toEqual([
      { id: 'a1', description: 'Text A' },
      { id: 'a2', description: 'Text B' },
    ]);

    // Re-run: both rows already have a description, so the candidate query
    // (description IS NULL) returns nothing — zero updates, no error, no
    // overwrite.
    const second = await runRepair(client, { ...baseOptions, apply: true }, vi.fn());
    expect(second.updated).toBe(0);
    expect(second.candidatesSeen).toBe(0);
    expect(state()).toEqual([
      { id: 'a1', description: 'Text A' },
      { id: 'a2', description: 'Text B' },
    ]);
  });

  it('walks multiple batches via the id keyset, not offset', async () => {
    const anchors = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, description: null as string | null }));
    const records = anchors.map((a) => ({
      anchor_id: a.id,
      source: 'openalex',
      metadata: { abstract: `Text ${a.id}` },
    }));
    const { client } = fakeClient(anchors, records);

    const log = vi.fn();
    // batchSize=2 over 5 rows => batches of 2,2,1.
    const result = await runRepair(client, { ...baseOptions, apply: true, batchSize: 2 }, log);

    expect(result.batches).toBe(3);
    expect(result.updated).toBe(5);
    expect(result.firstId).toBe('a0');
    expect(result.lastId).toBe('a4');
  });

  it('skips a candidate whose public_records row has no usable text', async () => {
    const { client, state } = fakeClient(
      [{ id: 'a1', description: null }],
      [{ anchor_id: 'a1', source: 'openalex', metadata: {} }], // no abstract/description/summary
    );
    const result = await runRepair(client, { ...baseOptions, apply: true }, vi.fn());
    expect(result.updated).toBe(0);
    expect(state()[0].description).toBeNull();
  });

  it('skips a candidate with no linked public_records row at all', async () => {
    const { client, state } = fakeClient([{ id: 'a1', description: null }], []);
    const result = await runRepair(client, { ...baseOptions, apply: true }, vi.fn());
    expect(result.updated).toBe(0);
    expect(state()[0].description).toBeNull();
  });

  it('respects --max-batches, leaving later candidates untouched', async () => {
    const anchors = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, description: null as string | null }));
    const records = anchors.map((a) => ({
      anchor_id: a.id,
      source: 'openalex',
      metadata: { abstract: `Text ${a.id}` },
    }));
    const { client, state } = fakeClient(anchors, records);

    const result = await runRepair(client, { ...baseOptions, apply: true, batchSize: 2, maxBatches: 1 }, vi.fn());

    expect(result.batches).toBe(1);
    expect(result.updated).toBe(2);
    // Only the first batch's rows were touched.
    expect(state().filter((a) => a.description !== null)).toHaveLength(2);
  });

  it('stops cleanly when there are zero candidates', async () => {
    const { client } = fakeClient([], []);
    const result = await runRepair(client, { ...baseOptions, apply: true }, vi.fn());
    expect(result.batches).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.firstId).toBeNull();
    expect(result.lastId).toBeNull();
  });
});

describe('main() validation refusals (via parseCliArgs + isProdUrl, exercised the way main() does)', () => {
  it('parseCliArgs failure would map to EXIT_VALIDATION in main()', () => {
    // main() catches parseCliArgs throwing and returns EXIT_VALIDATION —
    // asserted here structurally since main() itself talks to process.argv/env.
    expect(() => parseCliArgs(['--since', 'bad'])).toThrow();
    expect(EXIT_VALIDATION).toBe(1);
  });

  it('a prod SUPABASE_URL without --i-know-this-is-prod is refusable before any client exists', () => {
    const url = `https://${PROD_SUPABASE_REF}.supabase.co`;
    const opts = parseCliArgs([]);
    expect(isProdUrl(url) && !opts.allowProd).toBe(true);
  });

  it('a prod SUPABASE_URL with --i-know-this-is-prod is allowed through', () => {
    const url = `https://${PROD_SUPABASE_REF}.supabase.co`;
    const opts = parseCliArgs(['--i-know-this-is-prod']);
    expect(isProdUrl(url) && !opts.allowProd).toBe(false);
  });
});


describe('review regressions — complete and bounded repair planning', () => {
  const opts = { sources: ['openalex'], since: '2026-09-01', batchSize: 5000, maxBatches: null, allowProd: false, apply: false };
  it('continues a server-capped short candidate page until the keyset returns empty', async () => {
    const fetchCandidateIds = vi.fn().mockResolvedValueOnce([{ id: 'a1' }]).mockResolvedValueOnce([{ id: 'a2' }]).mockResolvedValueOnce([]);
    const result = await runRepair({ fetchCandidateIds, fetchSourceRows: async () => [], updateDescription: vi.fn() }, opts, vi.fn());
    expect(result.candidatesSeen).toBe(2);
    expect(fetchCandidateIds).toHaveBeenNthCalledWith(2, 'a1', 5000);
  });
  it('prints an executable-parameter plan with the selected date bound and no source text', async () => {
    const client = { fetchCandidateIds: vi.fn().mockResolvedValueOnce([{ id: 'a1' }]).mockResolvedValueOnce([]), fetchSourceRows: async () => [{ id: 'source-1', anchor_id: 'a1', metadata: { abstract: 'private source text' } }], updateDescription: vi.fn() };
    const log = vi.fn(); await runRepair(client, opts, log);
    const line = log.mock.calls.map(([line]) => line as string).find((line) => line.startsWith('sql_plan='));
    expect(line).toBeDefined();
    const plan = JSON.parse(line!.slice('sql_plan='.length));
    expect(plan.values).toEqual([['a1'], ['openalex'], '2026-09-01']);
    expect(plan.text).toContain('pr.created_at >= $3');
    expect(plan.text).toContain("SET LOCAL statement_timeout = '30s'");
    expect(line).not.toContain('private source text');
    expect(client.updateDescription).not.toHaveBeenCalled();
  });
  it('does not declare completion for null candidate data', async () => {
    const query = { select: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
    const client = createSupabaseRepairClient({ from: () => query } as never);
    await expect(client.fetchCandidateIds(null, 2)).rejects.toThrow(/non-array/);
  });
  it('chunks source filters and consumes capped source pages through the final empty page', async () => {
    const chunks: string[][] = []; const ranges: number[] = [];
    const from = () => {
      let ids: string[] = []; let offset = 0;
      const query = { select: () => query, in: (column: string, values: string[]) => { if (column === 'anchor_id') { ids = values; chunks.push(values); } return query; }, gte: () => query, order: () => query, range: (start: number) => { offset = start; ranges.push(start); return query; }, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: ids.slice(offset, offset + 1).map((id) => ({ id, anchor_id: id, metadata: {} })), error: null }).then(resolve) }; return query;
    };
    const ids = Array.from({ length: 201 }, (_, i) => 'id-' + i.toString().padStart(3, '0'));
    const client = createSupabaseRepairClient({ from } as never);
    const rows = await client.fetchSourceRows(ids, ['openalex'], '2026-09-01');
    expect(rows).toHaveLength(201);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(ranges).toContain(200);
  });
});


describe('deterministic source selection review', () => {
  it('uses the lowest source id containing usable text rather than the last returned row', async () => {
    const write = vi.fn().mockResolvedValue({ updated: true });
    const sourceRows = [
      { id: '001', anchor_id: 'a1', metadata: { abstract: 123 } },
      { id: '002', anchor_id: 'a1', metadata: { abstract: 123, description: 'chosen fallback' } },
      { id: '003', anchor_id: 'a1', metadata: { abstract: 'later source' } },
    ];
    await runRepair({ fetchCandidateIds: vi.fn().mockResolvedValueOnce([{ id: 'a1' }]).mockResolvedValueOnce([]), fetchSourceRows: async () => sourceRows, updateDescription: write }, { sources: ['openalex'], since: '2026-08-17', batchSize: 1000, maxBatches: null, allowProd: false, apply: true }, vi.fn());
    expect(write).toHaveBeenCalledWith('a1', 'chosen fallback');
  });
});
