/**
 * F-D0-5 (fullsoak 2026-08-12, day0-bl2-secured-e2e-evidence.md §2.6a): a
 * mempool.space response that sends headers and then PARKS the body must not
 * wedge the confirmation run.
 *
 * The suspected prod mechanism: `fetchTxStatus` guarded the REQUEST with
 * `AbortSignal.timeout(10000)` but then did `await response.json()` with no
 * deadline on the body read. One parked read suspended the whole run inside
 * `withRunLease`, whose heartbeat then renewed the lease indefinitely —
 * disabling SUBMITTED→SECURED promotion for every tenant with zero logs.
 *
 * This suite drives the REAL job pipeline (real `readJsonBounded` /
 * `readTextBounded`, deadline shrunk from 10s to ~25ms so the test is fast)
 * against a fetch double whose first tx-status body never settles, and pins
 * that the run ABANDONS the parked read, retries, and completes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSelectChain, grantedRunLeaseTable } from './__tests__/__testHelpers.js';

const { mockLogger, mockConfig, dbFrom, mockRpc } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mockConfig = {
    logLevel: 'info',
    // signet: minConfirmations = 1, so the pipeline needs no tip-height math
    // beyond the fetch itself and no drain to complete this scenario.
    bitcoinNetwork: 'signet' as string,
    nodeEnv: 'production' as string,
    useMocks: false,
    mempoolApiUrl: undefined as string | undefined,
    kRevision: 'arkova-worker-test',
    frontendUrl: 'http://localhost:5173',
  };
  const mockRpc = vi.fn();
  const dbFrom = vi.fn();
  return { mockLogger, mockConfig, dbFrom, mockRpc };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/db.js', () => ({ db: { from: dbFrom, rpc: mockRpc } }));
vi.mock('../utils/verifyCache.js', () => ({ invalidateVerificationCache: vi.fn() }));
vi.mock('../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('../utils/sentry.js', () => ({ captureConfirmationTipHeightUnavailable: vi.fn() }));

// Shrink the module's body-read deadline so the parked read times out in tens
// of milliseconds. The primitive keeps its REAL implementation — only the
// deadline argument is overridden; the true production value is pinned by the
// MEMPOOL_BODY_READ_TIMEOUT_MS ratchet below, and the primitive's timing
// behavior by its own suite (utils/body-read-timeout.test.ts).
vi.mock('../utils/body-read-timeout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/body-read-timeout.js')>();
  return {
    ...actual,
    readJsonBounded: (response: never, url: string, _timeoutMs: number) =>
      actual.readJsonBounded(response, url, 25),
    readTextBounded: (response: never, url: string, _timeoutMs: number) =>
      actual.readTextBounded(response, url, 25),
  };
});

import { MEMPOOL_BODY_READ_TIMEOUT_MS, checkSubmittedConfirmations } from './check-confirmations.js';

const SUBMITTED_TX = 'a'.repeat(64);

/**
 * Ratchet: the production body-read deadline matches the request deadline the
 * incident's evidence names (10s). A future change to this constant should be
 * a deliberate decision, not a drive-by.
 */
it('keeps the production mempool body-read deadline at 10s', () => {
  expect(MEMPOOL_BODY_READ_TIMEOUT_MS).toBe(10_000);
});

describe('checkSubmittedConfirmations under a parked provider body read', () => {
  const originalFetch = globalThis.fetch;
  let txStatusFetches: number;

  beforeEach(() => {
    vi.clearAllMocks();
    txStatusFetches = 0;

    const candidateChain = buildSelectChain({
      selectResult: {
        data: [
          {
            id: 'anchor-0001',
            chain_tx_id: SUBMITTED_TX,
            created_at: '2026-08-12T14:00:00.000Z',
          },
        ],
        error: null,
      },
    });

    dbFrom.mockImplementation((table: string) => {
      if (table === 'job_queue') return grantedRunLeaseTable();
      if (table === 'anchors') return { select: vi.fn(() => candidateChain.chain) };
      throw new Error(`unexpected table read in body-timeout suite: ${table}`);
    });

    globalThis.fetch = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/blocks/tip/height')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('123456') });
      }
      txStatusFetches += 1;
      if (txStatusFetches === 1) {
        // The prod failure mode: headers arrive, the body never does.
        return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
      }
      // The retry after the abandoned read: a definitive 404 → not retryable,
      // fetchTxStatus returns null and the run moves on.
      return Promise.resolve({ ok: false, status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it(
    'abandons the parked body read, retries, and completes the run instead of hanging forever',
    { timeout: 4_000 },
    async () => {
      const result = await checkSubmittedConfirmations();

      // The run FINISHED — with the parked read unpatched this await never
      // settles and the test dies on its timeout, which is the red state.
      expect(result).toEqual({ checked: 1, confirmed: 0 });

      // The hang was abandoned and retried, not waited out.
      expect(txStatusFetches).toBeGreaterThanOrEqual(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ txChecked: 1 }),
        'Confirmation check complete',
      );
    },
  );
});
