/**
 * Ingestion response-contract tests — BUG-020 / BUG-021.
 *
 * BUG-020: every public-record ingestion route reported total upstream
 * failure as HTTP 200 with the error count buried in the body, so a Cloud
 * Scheduler job on any of them was green forever.
 *
 * BUG-021: `get_flag()` collapses "row absent" into its `p_default`, so a
 * fresh environment could not be told apart from a deliberately-disabled
 * one — every fetcher no-opped at HTTP 200 and a blind exerciser scored
 * 100% false coverage.
 *
 * These tests pin the contract itself, independent of any single route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../utils/logger.js');

const {
  tallyIngestionResult,
  classifyIngestion,
  httpStatusForIngestion,
  sendIngestionResult,
  readIngestionFlagState,
  runIngestionRoute,
  INGESTION_FLAG_KEY,
} = await import('./ingestionResponse.js');

/** Minimal Express `res` double capturing status + JSON body + headers. */
function makeRes() {
  const captured: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
  };
  return { res: res as never, captured };
}

/** Supabase double whose `switchboard_flags` read resolves to `outcome`. */
function makeDb(outcome: { data: { enabled: boolean } | null; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(outcome);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, select, eq, maybeSingle };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tallyIngestionResult', () => {
  it('reads the canonical inserted/skipped/errors shape', () => {
    expect(tallyIngestionResult({ inserted: 4, skipped: 1, errors: 2 })).toMatchObject({
      inserted: 4,
      skipped: 1,
      errors: 2,
      recognized: true,
    });
  });

  it('reads the total* aggregate shape used by multi-state fetchers', () => {
    const tally = tallyIngestionResult({
      totalInserted: 10,
      totalSkipped: 3,
      totalErrors: 5,
      stateResults: [
        { state: 'CA', inserted: 10, skipped: 3, errors: 5 },
      ],
    });
    // Top-level totals win — the nested per-state rows must NOT be double counted.
    expect(tally).toMatchObject({ inserted: 10, skipped: 3, errors: 5, recognized: true });
  });

  it('sums a `results` array when there are no top-level counters', () => {
    const tally = tallyIngestionResult({
      results: [
        { source: 'a', inserted: 2, skipped: 0, errors: 0 },
        { source: 'b', inserted: 0, skipped: 0, errors: 7 },
      ],
    });
    expect(tally).toMatchObject({ inserted: 2, errors: 7, recognized: true });
  });

  it('reads the embedder succeeded/failed shape', () => {
    expect(tallyIngestionResult({ total: 10, succeeded: 9, failed: 1 })).toMatchObject({
      inserted: 9,
      errors: 1,
      recognized: true,
    });
  });

  it('counts an explicit failure status as an error even when errors is 0', () => {
    // The /fetch-uspto case: hard 403 from upstream reported as errors: 0.
    const tally = tallyIngestionResult({
      status: 'download_failed',
      inserted: 0,
      skipped: 0,
      errors: 0,
    });
    expect(tally.errors).toBeGreaterThan(0);
  });

  it('does not treat a completed run as a failure status', () => {
    expect(tallyIngestionResult({ status: 'complete', inserted: 3, skipped: 0, errors: 0 }).errors).toBe(0);
  });

  it('reports recognized=false for a shape it cannot read', () => {
    expect(tallyIngestionResult({ fetched: 100 }).recognized).toBe(false);
    expect(tallyIngestionResult(undefined).recognized).toBe(false);
  });
});

describe('classifyIngestion', () => {
  it('is ok when nothing failed', () => {
    expect(classifyIngestion({ inserted: 5, skipped: 0, errors: 0, recognized: true })).toBe('ok');
  });

  it('is partial_failure when some work landed and some failed', () => {
    expect(classifyIngestion({ inserted: 5, skipped: 0, errors: 2, recognized: true })).toBe(
      'partial_failure',
    );
  });

  it('is total_failure when every item failed', () => {
    expect(classifyIngestion({ inserted: 0, skipped: 0, errors: 30, recognized: true })).toBe(
      'total_failure',
    );
  });

  it('treats skipped-only progress as real work, not total failure', () => {
    // A statute set already fully ingested legitimately inserts 0 and skips N.
    expect(classifyIngestion({ inserted: 0, skipped: 12, errors: 1, recognized: true })).toBe(
      'partial_failure',
    );
  });
});

describe('httpStatusForIngestion', () => {
  it('maps the contract to HTTP codes', () => {
    expect(httpStatusForIngestion('ok')).toBe(200);
    expect(httpStatusForIngestion('partial_failure')).toBe(207);
    expect(httpStatusForIngestion('total_failure')).toBe(502);
    expect(httpStatusForIngestion('disabled')).toBe(200);
    expect(httpStatusForIngestion('flag_not_configured')).toBe(503);
    expect(httpStatusForIngestion('flag_unreadable')).toBe(503);
  });

  it('never maps a failure classification to 200', () => {
    for (const status of ['partial_failure', 'total_failure', 'flag_not_configured', 'flag_unreadable'] as const) {
      expect(httpStatusForIngestion(status)).not.toBe(200);
    }
  });
});

describe('sendIngestionResult', () => {
  it('passes a clean result through verbatim at 200', () => {
    const { res, captured } = makeRes();
    sendIngestionResult(res, 'fetch-edgar', { inserted: 100, skipped: 0, errors: 0 });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ inserted: 100, skipped: 0, errors: 0 });
  });

  it('returns 502 — never 200 — when every item failed', () => {
    const { res, captured } = makeRes();
    sendIngestionResult(res, 'fetch-ipeds', { inserted: 0, skipped: 0, errors: 30 });
    expect(captured.status).toBe(502);
    expect(captured.body).toMatchObject({ ingestion_status: 'total_failure', ingestion_errors: 30 });
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns 502 for a masked hard dependency failure reported as errors: 0', () => {
    const { res, captured } = makeRes();
    sendIngestionResult(res, 'fetch-uspto', {
      status: 'download_failed',
      inserted: 0,
      skipped: 0,
      errors: 0,
    });
    expect(captured.status).toBe(502);
    expect(captured.body).toMatchObject({ ingestion_status: 'total_failure' });
  });

  it('returns 207 with an explicit status for a partial run', () => {
    const { res, captured } = makeRes();
    sendIngestionResult(res, 'fetch-kenya', { inserted: 25, skipped: 0, errors: 5 });
    expect(captured.status).toBe(207);
    expect(captured.body).toMatchObject({
      ingestion_status: 'partial_failure',
      ingestion_errors: 5,
      ingestion_inserted: 25,
    });
  });

  it('keeps an unreadable shape at 200 but says so, rather than guessing failure', () => {
    const { res, captured } = makeRes();
    sendIngestionResult(res, 'fetch-mystery', { fetched: 100 });
    expect(captured.status).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('readIngestionFlagState', () => {
  it('is enabled when the row exists and is true', async () => {
    const db = makeDb({ data: { enabled: true }, error: null });
    await expect(readIngestionFlagState(db.client, INGESTION_FLAG_KEY)).resolves.toBe('enabled');
    expect(db.from).toHaveBeenCalledWith('switchboard_flags');
  });

  it('is disabled when the row exists and is false', async () => {
    const db = makeDb({ data: { enabled: false }, error: null });
    await expect(readIngestionFlagState(db.client, INGESTION_FLAG_KEY)).resolves.toBe('disabled');
  });

  it('distinguishes an ABSENT row from an explicit false — the BUG-021 core', async () => {
    const db = makeDb({ data: null, error: null });
    await expect(readIngestionFlagState(db.client, INGESTION_FLAG_KEY)).resolves.toBe(
      'not_configured',
    );
  });

  it('is unreadable when the switchboard read errors', async () => {
    const db = makeDb({ data: null, error: { message: 'PGRST116' } });
    await expect(readIngestionFlagState(db.client, INGESTION_FLAG_KEY)).resolves.toBe('unreadable');
  });
});

describe('runIngestionRoute', () => {
  it('runs the job and returns its result when the flag is on', async () => {
    const db = makeDb({ data: { enabled: true }, error: null });
    const { res, captured } = makeRes();
    const run = vi.fn().mockResolvedValue({ inserted: 7, skipped: 0, errors: 0 });

    await runIngestionRoute(res, { route: 'fetch-npi', run, client: db.client });

    expect(run).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ inserted: 7, skipped: 0, errors: 0 });
  });

  it('does NOT return a silent 200 no-op when the flag row is missing', async () => {
    const db = makeDb({ data: null, error: null });
    const { res, captured } = makeRes();
    const run = vi.fn();

    await runIngestionRoute(res, { route: 'fetch-ipeds', run, client: db.client });

    expect(run).not.toHaveBeenCalled();
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({ ingestion_status: 'flag_not_configured' });
    expect(captured.headers['Retry-After']).toBeDefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports a deliberately disabled flag explicitly at 200 without running the job', async () => {
    const db = makeDb({ data: { enabled: false }, error: null });
    const { res, captured } = makeRes();
    const run = vi.fn();

    await runIngestionRoute(res, { route: 'fetch-ipeds', run, client: db.client });

    expect(run).not.toHaveBeenCalled();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ingestion_status: 'disabled' });
  });

  it('returns 503 when the switchboard cannot be read', async () => {
    const db = makeDb({ data: null, error: { message: 'boom' } });
    const { res, captured } = makeRes();
    const run = vi.fn();

    await runIngestionRoute(res, { route: 'fetch-ipeds', run, client: db.client });

    expect(run).not.toHaveBeenCalled();
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({ ingestion_status: 'flag_unreadable' });
  });

  it('returns 500 when the job throws', async () => {
    const db = makeDb({ data: { enabled: true }, error: null });
    const { res, captured } = makeRes();
    const run = vi.fn().mockRejectedValue(new Error('SEC down'));

    await runIngestionRoute(res, { route: 'fetch-edgar', run, client: db.client });

    expect(captured.status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it('honours a per-route flag key', async () => {
    const db = makeDb({ data: { enabled: true }, error: null });
    const { res } = makeRes();
    await runIngestionRoute(res, {
      route: 'embed-public-records',
      flagKey: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
      run: vi.fn().mockResolvedValue({ total: 0, succeeded: 0, failed: 0 }),
      client: db.client,
    });
    expect(db.eq).toHaveBeenCalledWith('flag_key', 'ENABLE_PUBLIC_RECORD_EMBEDDINGS');
  });
});
