/** SQL owns recovery eligibility and journal locking; this suite proves caller bounds and refusal. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReconcile = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const signals: AbortSignal[] = [];
vi.mock('./batch-anchor.js', () => ({ reconcileTxidJournals: (...args: unknown[]) => mockReconcile(...args) }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/db.js', () => ({ db: {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => {
    const response = mockRpc(...args);
    return Object.assign(Promise.resolve(response), {
      abortSignal(signal: AbortSignal) { signals.push(signal); return response; },
    });
  },
} }));

const { recoverStuckBroadcasts, RECOVERY_BATCH_SIZE, MAX_RECOVERY_PASSES, RECOVERY_TIME_BUDGET_MS } = await import('./broadcast-recovery.js');
const { logger } = await import('../utils/logger.js');
const journal = { protectionLoaded: true, scanned: 0, adopted: 0, reverted: 0, held: 0 };
const row = (i: number) => ({ anchor_id: `anchor-${i}`, anchor_fingerprint: `fp-${i}`, claimed_by: 'worker-old', stuck_since: '2026-09-07T00:00:00Z' });
function cohort(size: number) {
  let remaining = size;
  mockRpc.mockImplementation(async (_name: string, args: { p_limit: number }) => {
    const count = Math.min(remaining, args.p_limit); const first = size - remaining; remaining -= count;
    return { data: Array.from({ length: count }, (_, i) => row(first + i)), error: null };
  });
  return () => remaining;
}
beforeEach(() => {
  vi.clearAllMocks(); signals.length = 0;
  mockReconcile.mockResolvedValue(journal);
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockFrom.mockImplementation(() => { throw new Error('Direct anchor writes must not run during recovery'); });
});
afterEach(() => { vi.useRealTimers(); });

describe('bounded atomic broadcast recovery', () => {
  it('refuses generic recovery when journal protection is unavailable', async () => {
    mockReconcile.mockResolvedValue({ ...journal, protectionLoaded: false });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: true });
    expect(mockRpc).not.toHaveBeenCalled(); expect(logger.error).toHaveBeenCalled();
  });
  it('maps acknowledged SQL rows and passes the stale threshold plus batch limit', async () => {
    mockRpc.mockResolvedValue({ data: [row(0), { ...row(1), claimed_by: null }], error: null });
    const result = await recoverStuckBroadcasts(7);
    expect(mockRpc).toHaveBeenCalledWith('recover_stuck_broadcasts', { p_stale_minutes: 7, p_limit: RECOVERY_BATCH_SIZE });
    expect(result).toEqual({ recovered: 2, anchors: [{ id: 'anchor-0', fingerprint: 'fp-0', claimedBy: 'worker-old' }, { id: 'anchor-1', fingerprint: 'fp-1', claimedBy: 'unknown' }], passes: 1, incomplete: false });
  });
  it('accepts an actual empty array as a drained cohort', async () => {
    expect(await recoverStuckBroadcasts()).toEqual({ recovered: 0, anchors: [], passes: 1, incomplete: false });
  });
  it('drains 10,000 rows in bounded SQL calls and never directly reads or writes anchors', async () => {
    const remaining = cohort(10_000); const result = await recoverStuckBroadcasts();
    expect(result.recovered).toBe(10_000); expect(remaining()).toBe(0); expect(result.incomplete).toBe(false);
    expect(result.passes).toBe(21);
    expect(mockRpc.mock.calls.every(([, args]) => args.p_limit === RECOVERY_BATCH_SIZE)).toBe(true);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ anchorSample: expect.any(Array), sampleTruncated: true }), expect.any(String));
    const summary: unknown = vi.mocked(logger.warn).mock.calls.find(([fields]) => typeof fields === 'object' && fields !== null && 'anchorSample' in fields)?.[0];
    expect(summary).toBeDefined();
    if (!summary || typeof summary !== 'object' || !('anchorSample' in summary)) throw new Error('Missing recovery summary');
    expect(summary.anchorSample).toHaveLength(50);
  });
  it('defers remaining work when the pass budget is exhausted', async () => {
    const remaining = cohort(30_000); const result = await recoverStuckBroadcasts();
    expect(result).toMatchObject({ passes: MAX_RECOVERY_PASSES, recovered: 20_000, incomplete: true });
    expect(remaining()).toBe(10_000); expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ incomplete: true }), expect.stringContaining('pass budget'));
  });
  it.each(['PGRST202', 'PGRST203', 'PGRST205', '42883', '57014', '42501'])('fails closed for RPC error %s without client-side fallback', async (code) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'controlled database refusal' } });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, anchors: [], incomplete: true });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code }) }), expect.stringContaining('RPC failed'));
  });
  it.each([null, {}, [null], [{ anchor_id: 'x' }], [{ ...row(0), claimed_by: {} }], [row(0), row(0)]])('does not treat malformed RPC data as an empty or recovered cohort: %j', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, anchors: [], incomplete: true });
    expect(logger.error).toHaveBeenCalled(); expect(mockFrom).not.toHaveBeenCalled();
  });
  it('rejects a response exceeding the requested SQL batch bound', async () => {
    mockRpc.mockResolvedValue({ data: Array.from({ length: RECOVERY_BATCH_SIZE + 1 }, (_, i) => row(i)), error: null });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: true });
    expect(logger.error).toHaveBeenCalled();
  });
  it('retains acknowledged progress when a later request throws', async () => {
    mockRpc.mockResolvedValueOnce({ data: Array.from({ length: RECOVERY_BATCH_SIZE }, (_, i) => row(i)), error: null }).mockRejectedValueOnce(new Error('connection lost after server commit'));
    const result = await recoverStuckBroadcasts();
    expect(result).toMatchObject({ recovered: RECOVERY_BATCH_SIZE, passes: 2, incomplete: true });
    expect(mockFrom).not.toHaveBeenCalled(); expect(logger.error).toHaveBeenCalled();
  });
  it('does not count a duplicate recovery reply twice across batches', async () => {
    const rows = Array.from({ length: RECOVERY_BATCH_SIZE }, (_, i) => row(i));
    mockRpc.mockResolvedValue({ data: rows, error: null });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: RECOVERY_BATCH_SIZE, passes: 2, incomplete: true });
    expect(logger.error).toHaveBeenCalled();
  });
  it('starts the budget before journal reconciliation and defers generic recovery if it is spent', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    mockReconcile.mockImplementation(async () => { vi.setSystemTime(RECOVERY_TIME_BUDGET_MS); return journal; });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: true });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('prevents overlapping invocations while journal reconciliation is still pending', async () => {
    let release!: (value: typeof journal) => void;
    mockReconcile.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = recoverStuckBroadcasts();
    const second = await recoverStuckBroadcasts();
    release(journal); await first;
    expect(second).toMatchObject({ recovered: 0, incomplete: true });
    expect(mockReconcile).toHaveBeenCalledTimes(1); expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('releases the invocation guard after a rejected journal request', async () => {
    mockReconcile.mockRejectedValueOnce(new Error('journal transport unavailable'));
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: true });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: false });
    expect(logger.error).toHaveBeenCalled();
  });
  it('passes the remaining deadline as an abort signal to a slow RPC', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let release!: (value: { data: never[]; error: { message: string } }) => void;
    mockRpc.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const run = recoverStuckBroadcasts(); await Promise.resolve(); await Promise.resolve();
    const signal = signals[0];
    await vi.advanceTimersByTimeAsync(RECOVERY_TIME_BUDGET_MS);
    release({ data: [], error: { message: 'request aborted' } });
    const result = await run;
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(true);
    expect(result.incomplete).toBe(true);
  });
});
