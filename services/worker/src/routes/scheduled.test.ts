import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockCronSchedule, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    nodeEnv: 'test',
    batchAnchorIntervalMinutes: 10,
    disableInProcessAnchorCron: false,
  },
  mockCronSchedule: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('node-cron', () => ({
  default: { schedule: mockCronSchedule },
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/rpc.js', () => ({ callRpc: vi.fn() }));
vi.mock('../jobs/anchor.js', () => ({ processPendingAnchors: vi.fn() }));
vi.mock('../jobs/batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../jobs/check-confirmations.js', () => ({ checkSubmittedConfirmations: vi.fn() }));
vi.mock('../jobs/revocation.js', () => ({ processRevokedAnchors: vi.fn() }));
vi.mock('../webhooks/delivery.js', () => ({ processWebhookRetries: vi.fn(), dispatchWebhookEvent: vi.fn() }));
vi.mock('../jobs/credit-expiry.js', () => ({ processMonthlyCredits: vi.fn() }));
vi.mock('../jobs/chain-maintenance.js', () => ({
  consolidateUtxos: vi.fn(),
  detectReorgs: vi.fn(),
  monitorFeeRates: vi.fn(),
  monitorStuckTransactions: vi.fn(),
  rebroadcastDroppedTransactions: vi.fn(),
}));
vi.mock('../jobs/broadcast-recovery.js', () => ({ recoverStuckBroadcasts: vi.fn() }));
vi.mock('../jobs/anchorExpirySweep.js', () => ({
  sweepExpiredAnchors: vi.fn(),
  makeAnchorExpirySweepDb: vi.fn(() => ({})),
}));
vi.mock('../jobs/stuck-anchor-monitor.js', () => ({
  runStuckAnchorCheck: vi.fn().mockResolvedValue({ healthy: true, alertFired: false }),
}));
vi.mock('../jobs/credit-conservation-reconciler.js', () => ({
  runCreditConservationReconciler: vi.fn().mockResolvedValue({
    healthy: true,
    alertFired: false,
    divergedCount: 0,
    orgsChecked: 0,
  }),
}));
vi.mock('./lifecycle.js', () => ({ trackOperation: vi.fn((operation) => operation) }));
vi.mock('../utils/sentry.js', () => ({ withCronMonitoring: vi.fn((_name, _schedule, fn) => fn) }));

describe('setupScheduledJobs', () => {
  beforeEach(() => {
    mockConfig.nodeEnv = 'test';
    mockConfig.disableInProcessAnchorCron = false;
    mockCronSchedule.mockClear();
    vi.clearAllMocks();
  });

  it('registers in-process cron outside production', async () => {
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // 15 = 12 pre-existing on main + anchor-expiry-sweep (SCRUM-1736)
    //      + check-stuck-anchors (SCRUM-2234)
    //      + reconcile-credit-conservation (S1-9).
    expect(mockCronSchedule).toHaveBeenCalledTimes(15);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('registers anchor-expiry-sweep at 03:00 UTC daily (SCRUM-1736)', async () => {
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // Explicitly verify anchor-expiry-sweep is registered with its cron expression.
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('0 3 * * *');
  });

  it('keeps production in-process cron enabled by default', async () => {
    mockConfig.nodeEnv = 'production';
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    expect(mockCronSchedule).toHaveBeenCalledTimes(15);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('skips anchor-table in-process cron in production when maintenance flag is enabled', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // The anchor-table allowlist holds 9 jobs (SCRUM-1736's anchor-expiry-sweep
    // + SCRUM-2234's check-stuck-anchors joined the 7 originals), so under the
    // maintenance flag 9 schedules are skipped (9 warns). S1-9's
    // reconcile-credit-conservation is read-only and NOT on the allowlist, so
    // it keeps running: 6 remain (5 originals + the reconciler).
    expect(mockCronSchedule).toHaveBeenCalledTimes(6);
    expect(mockLogger.warn).toHaveBeenCalledTimes(9);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { jobName: 'anchor-expiry-sweep', expression: '0 3 * * *' },
      'Skipping in-process anchor cron in production because DISABLE_IN_PROCESS_ANCHOR_CRON=true',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { jobName: 'process-batch-anchors', expression: '*/10 * * * *' },
      'Skipping in-process anchor cron in production because DISABLE_IN_PROCESS_ANCHOR_CRON=true',
    );
  });

  it('anchor-expiry-sweep is in the skipped set under maintenance mode (SCRUM-1736)', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // Extract the set of skipped job names from the warn calls.
    const skippedJobNames = mockLogger.warn.mock.calls
      .filter((call) => typeof (call[0] as { jobName?: string } | undefined)?.jobName === 'string')
      .map((call) => (call[0] as { jobName: string }).jobName);

    expect(skippedJobNames).toContain('anchor-expiry-sweep');
  });

  it('registers check-stuck-anchors hourly (SCRUM-2234)', async () => {
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // Hourly cron expression must be registered.
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('0 * * * *');
  });

  it('check-stuck-anchors is in the skipped set under maintenance mode (SCRUM-2234)', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    const skippedJobNames = mockLogger.warn.mock.calls
      .filter((call) => typeof (call[0] as { jobName?: string } | undefined)?.jobName === 'string')
      .map((call) => (call[0] as { jobName: string }).jobName);

    expect(skippedJobNames).toContain('check-stuck-anchors');
  });

  it('registers reconcile-credit-conservation daily at 09:00 UTC (S1-9)', async () => {
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // Daily 09:00 UTC cron expression must be registered, deliberately offset
    // from the 03:00 anchor-expiry sweep / batch flush.
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('0 9 * * *');
  });

  it('reconcile-credit-conservation is NOT skipped under maintenance mode (S1-9, read-only)', async () => {
    // The money-conservation reconciler is read-only and must survive the
    // DISABLE_IN_PROCESS_ANCHOR_CRON flag: a paused anchor pipeline must not
    // silence credit-ledger integrity checks. So it never appears in the
    // skipped-job warn set.
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    const skippedJobNames = mockLogger.warn.mock.calls
      .filter((call) => typeof (call[0] as { jobName?: string } | undefined)?.jobName === 'string')
      .map((call) => (call[0] as { jobName: string }).jobName);

    expect(skippedJobNames).not.toContain('reconcile-credit-conservation');
    // And the daily schedule is still registered even under the flag.
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('0 9 * * *');
  });
});
