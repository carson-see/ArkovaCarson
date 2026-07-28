/**
 * SCRUM-3031: worker-side hardening around the batch_insert_anchors RPC.
 *
 * The RPC's own root cause (an implicit-cast type mismatch defeating the
 * fingerprint dedup index) is fixed in migration 0370 — see
 * src/tests/scrum-3031-batch-insert-anchors-wedge.test.ts for that evidence.
 * This file covers the CTO's item (4): "regardless of root cause, add
 * worker-side statement-timeout/backoff around the RPC call ... so a wedged
 * call can never hold locks for 106s again (fail fast, log, retry with
 * jitter)". These tests exercise `callBatchInsertAnchorsWithRetry` in
 * isolation via a mocked `withDbTimeout` — no real timers/DB involved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockSupabase } from './__testHelpers.js';

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
  callBatchInsertAnchorsWithRetry,
  BATCH_INSERT_RPC_MAX_ATTEMPTS,
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
] as unknown as Parameters<typeof callBatchInsertAnchorsWithRetry>[1];

describe('SCRUM-3031: callBatchInsertAnchorsWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves immediately on a fast, successful RPC call (no retry, no delay)', async () => {
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const { client, rpc } = createMockSupabase();
    rpc.mockResolvedValue({ data: [{ id: 'a1', fingerprint: 'a'.repeat(64) }], error: null });

    const result = await callBatchInsertAnchorsWithRetry(client, SAMPLE_CHUNK, 0);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'a1', fingerprint: 'a'.repeat(64) }]);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
    expect(mockWithDbTimeout).toHaveBeenCalledWith(expect.any(Function), BATCH_INSERT_RPC_TIMEOUT_MS);
  });

  it('does NOT retry a real Postgrest-level error (falls through immediately, same as before SCRUM-3031)', async () => {
    mockWithDbTimeout.mockImplementationOnce((op: () => Promise<unknown>) => op());
    const { client, rpc } = createMockSupabase();
    const pgError = { message: 'permission denied', code: '42501' };
    rpc.mockResolvedValue({ data: null, error: pgError });

    const result = await callBatchInsertAnchorsWithRetry(client, SAMPLE_CHUNK, 0);

    expect(result.error).toEqual(pgError);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries a timeout with jittered backoff, then succeeds', async () => {
    mockWithDbTimeout
      .mockRejectedValueOnce(timeoutError())
      .mockImplementationOnce((op: () => Promise<unknown>) => op());
    const { client, rpc } = createMockSupabase();
    rpc.mockResolvedValue({ data: [{ id: 'a1', fingerprint: 'a'.repeat(64) }], error: null });

    const result = await callBatchInsertAnchorsWithRetry(client, SAMPLE_CHUNK, 0);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'a1', fingerprint: 'a'.repeat(64) }]);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 0, chunkSize: 1, attempt: 1 }),
      expect.stringContaining('timed out'),
    );
    // Backoff was logged with a positive, bounded delay (base 1000ms + up to 500ms jitter).
    const loggedBackoff = mockLogger.warn.mock.calls[0][0].backoffMs as number;
    expect(loggedBackoff).toBeGreaterThanOrEqual(1000);
    expect(loggedBackoff).toBeLessThan(1500);
  }, 10_000);

  it('exhausts retries on repeated timeouts and surfaces the last timeout error (caller falls back to serial insert)', async () => {
    mockWithDbTimeout.mockRejectedValue(timeoutError());
    const { client } = createMockSupabase();

    const result = await callBatchInsertAnchorsWithRetry(client, SAMPLE_CHUNK, 0);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/timed out/);
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(BATCH_INSERT_RPC_MAX_ATTEMPTS);
    // Never a tight loop: every retry-but-one logs a backoff wait.
    expect(mockLogger.warn).toHaveBeenCalledTimes(BATCH_INSERT_RPC_MAX_ATTEMPTS - 1);
  }, 10_000);

  it('does not retry a non-timeout thrown error (network failure) — surfaces immediately', async () => {
    mockWithDbTimeout.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'));
    const { client } = createMockSupabase();

    const result = await callBatchInsertAnchorsWithRetry(client, SAMPLE_CHUNK, 0);

    expect(result.data).toBeNull();
    expect((result.error as Error).message).toBe('fetch failed: ECONNRESET');
    expect(mockWithDbTimeout).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
