/**
 * SCRUM-3031: worker-side hardening around the batch_insert_anchors RPC.
 *
 * The RPC's own root cause (an implicit-cast type mismatch defeating the
 * fingerprint dedup index) is fixed in migration 0370 — see
 * src/tests/scrum-3031-batch-insert-anchors-wedge.test.ts for that evidence.
 *
 * REVIEW FOLLOW-UP — CORRECTNESS REGRESSION CAUGHT AND FIXED: the first cut
 * of this hardening retried timeout-classified RPC failures up to 3x with
 * jittered backoff. A reviewer caught that this was itself a wedge risk:
 * `withDbTimeout` is a bare `Promise.race` against a `setTimeout` with no
 * `AbortController`/signal wired into the Supabase call, so when it "times
 * out" client-side, the original RPC call — and the Postgres backend query
 * it triggered — does NOT stop running server-side. PostgREST does not
 * cancel a backend statement when the HTTP client disconnects (open
 * PostgREST behavior, see https://github.com/PostgREST/postgrest/issues/3517).
 * So the retry loop could launch a SECOND (and on repeated timeouts, a
 * THIRD) `batch_insert_anchors` execution while an earlier one was still
 * running server-side, holding `RowExclusiveLock` on `anchors` — exactly
 * the wedge scenario this hardening exists to prevent.
 *
 * Fix (`callBatchInsertAnchorsOnce`, renamed from `...WithRetry` since it no
 * longer retries): exactly ONE attempt. An `AbortController` signal is
 * passed into `client.rpc(...).abortSignal(...)` so a timed-out attempt's
 * client-side fetch is aborted (frees the local connection immediately —
 * but per the PostgREST issue above, this is NOT guaranteed to cancel the
 * server-side statement, so it must never be treated as a cancellation
 * guarantee). On timeout, the function does not retry; it surfaces the
 * error immediately, same as a real (non-timeout) Postgrest error, and the
 * caller (`insertAnchorChunk`) falls through to `insertAnchorSerialFallback`
 * — never issuing a second `batch_insert_anchors` call for the same chunk.
 *
 * These tests exercise `callBatchInsertAnchorsOnce` in isolation via a
 * mocked `withDbTimeout` — no real timers/DB involved — and specifically
 * assert the no-overlap property: at most one `withDbTimeout` call (hence
 * at most one RPC attempt) per invocation, and that the abort signal is
 * actually wired into the rpc call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWithDbTimeout, mockLogger } = vi.hoisted(() => ({
  mockWithDbTimeout: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../../utils/db.js', () => ({
  db: {},
  withDbTimeout: mockWithDbTimeout,
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: vi.fn() }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: vi.fn() }),
}));

import {
  callBatchInsertAnchorsOnce,
  BATCH_INSERT_RPC_TIMEOUT_MS,
} from '../publicRecordAnchor.js';

function timeoutError(ms = BATCH_INSERT_RPC_TIMEOUT_MS): Error {
  return new Error(`DB operation timed out after ${ms}ms`);
}

const SAMPLE_CHUNK = [
  {
    user_id: '44444444-0000-0000-0000-000000000001',
    org_id: null,
    fingerprint: 'a'.repeat(64),
    filename: 'doc.pdf',
    credential_type: 'REGULATION',
    metadata: {},
  },
] as unknown as Parameters<typeof callBatchInsertAnchorsOnce>[1];

/**
 * A `client.rpc(...)` test double that mirrors the REAL supabase-js
 * `PostgrestFilterBuilder` shape closely enough to exercise the abort-signal
 * wiring: calling it returns a thenable that also exposes a chainable
 * `.abortSignal(signal)` (recording the signal it was called with) before
 * resolving/rejecting to whatever was configured.
 */
function createAbortAwareMockSupabase(resolution: {
  data?: unknown;
  error?: unknown;
  rejectWith?: unknown;
}) {
  const rpc = vi.fn();
  const abortSignalCalls: AbortSignal[] = [];

  rpc.mockImplementation(() => {
    const settle = () =>
      resolution.rejectWith !== undefined
        ? Promise.reject(resolution.rejectWith)
        : Promise.resolve({ data: resolution.data ?? null, error: resolution.error ?? null });

    const builder = {
      abortSignal: vi.fn((signal: AbortSignal) => {
        abortSignalCalls.push(signal);
        return builder;
      }),
      then: (
        onFulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => settle().then(onFulfilled, onRejected),
    };
    return builder;
  });

  return { client: { rpc } as unknown as Parameters<typeof callBatchInsertAnchorsOnce>[0], rpc, abortSignalCalls };
}

describe('SCRUM-3031: callBatchInsertAnchorsOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves immediately on a fast, successful RPC call', async () => {
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const { client, rpc } = createAbortAwareMockSupabase({ data: [{ id: 'a1', fingerprint: 'a'.repeat(64) }] });

    const result = await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'a1', fingerprint: 'a'.repeat(64) }]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
    expect(mockWithDbTimeout).toHaveBeenCalledWith(expect.any(Function), BATCH_INSERT_RPC_TIMEOUT_MS);
  });

  it('wires a real AbortSignal into client.rpc(...).abortSignal(...)', async () => {
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const { client, abortSignalCalls } = createAbortAwareMockSupabase({ data: [] });

    await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(abortSignalCalls).toHaveLength(1);
    expect(abortSignalCalls[0]).toBeInstanceOf(AbortSignal);
    expect(abortSignalCalls[0].aborted).toBe(false);
  });

  it('does NOT retry a real Postgrest-level error (falls through immediately, same as before SCRUM-3031)', async () => {
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const pgError = { message: 'permission denied', code: '42501' };
    const { client, rpc } = createAbortAwareMockSupabase({ error: pgError });

    const result = await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(result.error).toEqual(pgError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
  });

  it('NO-OVERLAP GUARANTEE: on a timeout, makes exactly ONE attempt — never retries — and surfaces the timeout error for the caller to fall back to serial insert', async () => {
    // mockWithDbTimeout rejects directly here (simulating the race's
    // setTimeout branch winning) without invoking the wrapped operation —
    // so client.rpc() is never called in THIS scenario, same as the
    // withDbTimeout contract in production: once it rejects, the caller has
    // already moved on. The real-world guarantee under test is that
    // callBatchInsertAnchorsOnce calls withDbTimeout exactly once no matter
    // how "wedged" the RPC is — see the 'wires a real AbortSignal' test
    // above for proof the operation itself does invoke .abortSignal() when
    // withDbTimeout actually runs it.
    mockWithDbTimeout.mockRejectedValueOnce(timeoutError());
    const { client } = createAbortAwareMockSupabase({ data: [] });

    const result = await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/timed out/);
    // The core regression-guard assertion: exactly one withDbTimeout call
    // (hence exactly one RPC attempt) no matter how many timeouts occur —
    // a second concurrent execution against the same rows is exactly the
    // wedge this hardening exists to prevent.
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 0, chunkSize: 1 }),
      expect.stringContaining('timed out'),
    );
    // No backoff/retry logging — this is a single-attempt, fail-fast path.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-timeout thrown error (network failure) — surfaces immediately, no warn log', async () => {
    mockWithDbTimeout.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'));
    const { client } = createAbortAwareMockSupabase({ data: [] });

    const result = await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(result.data).toBeNull();
    expect((result.error as Error).message).toBe('fetch failed: ECONNRESET');
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('tolerates a client.rpc(...) mock with no .abortSignal() method (defensive fallback for lighter test doubles)', async () => {
    // Some other test files' createMockSupabase() rpc mocks return a bare
    // resolved value with no .abortSignal — production code must not throw
    // against that shape; it should just skip the abort wiring.
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'a1', fingerprint: 'a'.repeat(64) }], error: null });
    const client = { rpc } as unknown as Parameters<typeof callBatchInsertAnchorsOnce>[0];

    const result = await callBatchInsertAnchorsOnce(client, SAMPLE_CHUNK, 0);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'a1', fingerprint: 'a'.repeat(64) }]);
  });
});
