/**
 * Coverage for the lock-wait monitor (2026-08-11 P0 early-warning signal).
 *
 * The contract this pins is not just "does it detect a lock wait" — it is the
 * exact SHAPE of the log line, because a Cloud Monitoring log-based metric
 * (`worker_db_lock_wait`, see scripts/gcp-setup/log-metrics/db-lock-wait.json)
 * matches on `jsonPayload.alert_type="db_lock_wait"` and extracts
 * `jsonPayload.relation` / `jsonPayload.lock_mode` as metric labels. If the
 * emitter and the metric filter drift, the alarm silently stops firing — which
 * is the exact failure class this whole change exists to remove.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const loggerWarn = vi.fn();
const loggerInfo = vi.fn();
const sentryCapture = vi.fn();

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { warn: (...a: unknown[]) => loggerWarn(...a), info: (...a: unknown[]) => loggerInfo(...a) },
}));
vi.mock('../utils/sentry.js', () => ({
  Sentry: { captureMessage: (...a: unknown[]) => sentryCapture(...a) },
}));
vi.mock('../utils/rpc.js', () => ({ callRpc: (...a: unknown[]) => rpcMock(...a) }));

const { runLockWaitMonitor, LOCK_WAIT_ALERT_TYPE, LOCK_WAIT_THRESHOLD_SECONDS } = await import(
  './lock-wait-monitor.js'
);

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    relation: 'organizations',
    lock_mode: 'AccessExclusiveLock',
    wait_seconds: 137,
    blocked_pid: 3136488,
    blocking_pids: [3135399, 3135446],
    ...over,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  loggerWarn.mockReset();
  loggerInfo.mockReset();
  sentryCapture.mockReset();
});

describe('runLockWaitMonitor', () => {
  it('asks the RPC for waits at the documented threshold', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await runLockWaitMonitor();
    expect(rpcMock).toHaveBeenCalledWith({}, 'get_lock_waits', {
      p_min_wait_seconds: LOCK_WAIT_THRESHOLD_SECONDS,
    });
    expect(LOCK_WAIT_THRESHOLD_SECONDS).toBe(60);
  });

  it('emits ONE structured log line per waiting lock, with the metric contract fields', async () => {
    rpcMock.mockResolvedValue({ data: [row()], error: null });
    const result = await runLockWaitMonitor();

    expect(result.waits).toHaveLength(1);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = loggerWarn.mock.calls[0] as [Record<string, unknown>, string];

    // These three field names ARE the Cloud Monitoring contract. Changing any
    // of them without changing log-metrics/db-lock-wait.json breaks the alarm.
    expect(payload.alert_type).toBe('db_lock_wait');
    expect(payload.relation).toBe('public.organizations');
    expect(payload.lock_mode).toBe('AccessExclusiveLock');

    expect(payload.wait_seconds).toBe(137);
    expect(payload.blocked_pid).toBe(3136488);
    expect(payload.blocking_pids).toEqual([3135399, 3135446]);
    expect(typeof message).toBe('string');
  });

  it('exports the alert_type the log-based metric filters on', () => {
    expect(LOCK_WAIT_ALERT_TYPE).toBe('db_lock_wait');
  });

  it('qualifies the relation name so the metric label is unambiguous', async () => {
    rpcMock.mockResolvedValue({ data: [row({ relation: 'anchors' })], error: null });
    await runLockWaitMonitor();
    expect((loggerWarn.mock.calls[0][0] as Record<string, unknown>).relation).toBe('public.anchors');
  });

  it('does not double-prefix a relation the RPC already qualified', async () => {
    rpcMock.mockResolvedValue({ data: [row({ relation: 'public.anchors' })], error: null });
    await runLockWaitMonitor();
    expect((loggerWarn.mock.calls[0][0] as Record<string, unknown>).relation).toBe('public.anchors');
  });

  it('emits one line per wait when several are queued behind the same barrier', async () => {
    rpcMock.mockResolvedValue({
      data: [row(), row({ relation: 'anchors', blocked_pid: 999 }), row({ blocked_pid: 1000 })],
      error: null,
    });
    const result = await runLockWaitMonitor();
    expect(result.waits).toHaveLength(3);
    expect(loggerWarn).toHaveBeenCalledTimes(3);
  });

  it('stays silent when nothing is waiting — no alarm, no noise', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await runLockWaitMonitor();
    expect(result.waits).toEqual([]);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(sentryCapture).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalled();
  });

  it('never emits the alert_type field on the RPC-failure path', async () => {
    // A monitor that logs its OWN failure using the alarm's field name would
    // page on "the monitor is broken" with a message that reads "a lock is
    // stuck". Those are different incidents and must not share a signal.
    rpcMock.mockResolvedValue({ data: null, error: { message: 'PGRST002' } });
    const result = await runLockWaitMonitor();
    expect(result.waits).toEqual([]);
    expect(result.degraded).toBe(true);
    for (const call of loggerWarn.mock.calls) {
      expect((call[0] as Record<string, unknown>).alert_type).not.toBe('db_lock_wait');
    }
  });

  it('reports degraded rather than throwing when the RPC rejects outright', async () => {
    rpcMock.mockRejectedValue(new Error('socket hang up'));
    const result = await runLockWaitMonitor();
    expect(result.degraded).toBe(true);
    expect(result.waits).toEqual([]);
  });

  it('tolerates a null data payload without crashing the cron', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const result = await runLockWaitMonitor();
    expect(result.waits).toEqual([]);
  });

  it('raises a Sentry event only for barrier-forming lock modes', async () => {
    rpcMock.mockResolvedValue({ data: [row({ lock_mode: 'AccessExclusiveLock' })], error: null });
    await runLockWaitMonitor();
    expect(sentryCapture).toHaveBeenCalledTimes(1);
    const tags = (sentryCapture.mock.calls[0][1] as { tags: Record<string, string> }).tags;
    expect(tags.alert_type).toBe('db_lock_wait');
    expect(tags.relation).toBe('public.organizations');
  });

  it('still logs — but does not Sentry-page — for a plain AccessShareLock wait', async () => {
    // A waiting AccessShareLock is a symptom of a barrier someone else formed.
    // Worth a metric point; not worth a second page for the same incident.
    rpcMock.mockResolvedValue({ data: [row({ lock_mode: 'AccessShareLock' })], error: null });
    await runLockWaitMonitor();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(sentryCapture).not.toHaveBeenCalled();
  });
});
