/**
 * Unit tests for USPTO Patent Fetcher (PatentsView bulk TSV)
 *
 * The fetcher downloads a ZIP containing a TSV file from PatentsView S3,
 * streams and parses it, then batch-inserts into public_records.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockSupabase } from './__testHelpers.js';

// ---- Hoisted mocks ----
const { mockRpc, mockUpsert, mockSelectChain, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockUpsert = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockLimit = vi.fn();
  const mockOrder = vi.fn(() => ({ limit: mockLimit }));
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.order = mockOrder;
  selectChain.limit = mockLimit;

  return { mockRpc, mockUpsert, mockSelectChain: { chain: selectChain, limit: mockLimit, order: mockOrder }, mockLogger };
});

vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

function makeMock() {
  return createMockSupabase({
    rpcMock: mockRpc,
    fromImpl: vi.fn((_table: string) => ({
      select: vi.fn(() => mockSelectChain.chain),
      upsert: mockUpsert,
    })),
  });
}

/**
 * Create a ZIP buffer containing a TSV file with patent data.
 * Uses system `zip` command to avoid adding test-only dependencies.
 */
function createMockPatentZip(rows: string[][]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'uspto-test-'));
  try {
    const headers = ['patent_id', 'patent_date', 'patent_title', 'patent_abstract', 'patent_type'];
    const tsvContent = [headers.join('\t'), ...rows.map(r => r.join('\t'))].join('\n');
    writeFileSync(join(dir, 'g_patent.tsv'), tsvContent);
    execSync(`cd "${dir}" && zip -q g_patent.tsv.zip g_patent.tsv`);
    return readFileSync(join(dir, 'g_patent.tsv.zip'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * BUG-023: the hardcoded PatentsView S3 URL now returns 403 AccessDenied, so
 * the bulk source must be supplied explicitly. Tests that exercise the
 * streaming path pass it as an option.
 */
const TEST_SOURCE_URL = 'https://example.invalid/g_patent.tsv.zip';

describe('usptoFetcher — dead bulk source (BUG-023)', () => {
  it('refuses to run — loudly — when no bulk source is configured', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    delete process.env.USPTO_BULK_TSV_URL;

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client);

    // No request at all — the legacy S3 URL must not be reachable from code.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('source_unavailable');
    // The masked-failure regression: this must NOT report errors: 0.
    expect(result.errors).toBeGreaterThan(0);
  });

  it('does not carry the revoked PatentsView S3 URL as a default', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../usptoFetcher.ts', import.meta.url), 'utf-8'),
    );
    // The dead bucket may only appear in prose explaining why it is dead.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
    expect(codeLines.join('\n')).not.toContain('s3.amazonaws.com/data.patentsview.org');
  });

  it('counts a hard upstream failure as an error, not errors: 0', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, body: null }));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client, { sourceUrl: TEST_SOURCE_URL });

    expect(result.status).toBe('download_failed');
    expect(result.errors).toBeGreaterThan(0);
  });
});

describe('usptoFetcher', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client);

    expect(result.status).toBe('disabled');
    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
    });
  });

  it('fetches and inserts patents from bulk TSV ZIP', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    mockUpsert.mockResolvedValue({ error: null });

    const zipBuffer = createMockPatentZip([
      ['11234567', '2026-01-15', 'Test Patent One', 'Abstract for patent one', 'utility'],
      ['11234568', '2026-01-16', 'Test Patent Two', 'Abstract for patent two', 'utility'],
      ['11234569', '2026-01-17', 'Test Patent Three', 'Abstract for patent three', 'design'],
    ]);

    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(zipBuffer));
        controller.close();
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: webStream,
      status: 200,
    }));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client, { sourceUrl: TEST_SOURCE_URL });

    expect(fetch).toHaveBeenCalled();
    expect(result.status).toBe('complete');
    expect(result.inserted).toBe(3);
    expect(result.errors).toBe(0);

    expect(mockUpsert).toHaveBeenCalled();
    const insertedRows = mockUpsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(insertedRows[0]).toMatchObject({
      source: 'uspto',
      source_id: '11234567',
      title: 'Test Patent One',
      record_type: 'patent_grant',
    });
    expect(insertedRows[0].metadata).toMatchObject({
      patent_id: '11234567',
      patent_date: '2026-01-15',
      patent_type: 'utility',
    });
  });

  it('skips patents before resume date', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({
      data: [{ metadata: { patent_date: '2026-01-16' } }],
    });
    mockUpsert.mockResolvedValue({ error: null });

    const zipBuffer = createMockPatentZip([
      ['11234567', '2026-01-15', 'Old Patent', 'Should be skipped', 'utility'],
      ['11234568', '2026-01-16', 'Same Day Patent', 'Should be skipped', 'utility'],
      ['11234569', '2026-01-17', 'New Patent', 'Should be inserted', 'utility'],
    ]);

    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(zipBuffer));
        controller.close();
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: webStream,
      status: 200,
    }));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client, { sourceUrl: TEST_SOURCE_URL });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('handles download failure gracefully', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
    }));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client, { sourceUrl: TEST_SOURCE_URL });

    expect(result.status).toBe('download_failed');
    expect(result.inserted).toBe(0);
  });

  it('handles network error gracefully', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network timeout')));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    const result = await fetchUsptoPAtents(makeMock().client, { sourceUrl: TEST_SOURCE_URL });

    expect(result.status).toBe('download_failed');
    expect(result.inserted).toBe(0);
  });
});
