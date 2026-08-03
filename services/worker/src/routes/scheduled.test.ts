import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockCronSchedule, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    nodeEnv: 'test',
    batchAnchorIntervalMinutes: 10,
    disableInProcessAnchorCron: false,
    enableConfirmationProofBackfill: false,
    enableConnectorArtifactDrain: false,
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
vi.mock('../jobs/confirmation-proof-backfill.js', () => ({
  runConfirmationProofBackfill: vi.fn().mockResolvedValue({
    skipped: true, scanned: 0, txAttempted: 0, txConfirmed: 0, txPending: 0, txStale: 0, anchorsUpdated: 0, anchorsMissing: 0,
  }),
}));
vi.mock('../jobs/connector-artifact-drain.js', () => ({
  runConnectorArtifactDrain: vi.fn().mockResolvedValue({
    skipped: true, orgsProcessed: 0, orgsFailed: 0, claimed: 0, anchored: 0, failed: 0,
  }),
}));
vi.mock('../jobs/drive-file-changed.js', () => ({
  runDriveFileChangedJobs: vi.fn().mockResolvedValue({
    claimed: 0, completed: 0, failed: 0, dead: 0, updateFailed: 0, jobIds: [],
  }),
}));
// GH #1835/#1836: restored in-process backup (PR #1944 review correction),
// unconditional (not flag-gated) and NOT part of ANCHOR_TABLE_IN_PROCESS_JOBS
// — it's a renewal-only sweep, not an anchor-table read.
const mockRunDriveSubscriptionRenewal = vi.fn().mockResolvedValue({
  scanned: 0, renewed: 0, degraded: 0, failed: 0,
});
vi.mock('../jobs/drive-subscription-renewal-deps.js', () => ({
  runDriveSubscriptionRenewal: (...args: unknown[]) => mockRunDriveSubscriptionRenewal(...args),
}));
vi.mock('./lifecycle.js', () => ({ trackOperation: vi.fn((operation) => operation) }));
vi.mock('../utils/sentry.js', () => ({ withCronMonitoring: vi.fn((_name, _schedule, fn) => fn) }));

describe('setupScheduledJobs', () => {
  beforeEach(() => {
    mockConfig.nodeEnv = 'test';
    mockConfig.disableInProcessAnchorCron = false;
    mockConfig.enableConfirmationProofBackfill = false;
    mockConfig.enableConnectorArtifactDrain = false;
    mockCronSchedule.mockClear();
    vi.clearAllMocks();
  });

  it('registers in-process cron outside production', async () => {
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // 16 = 12 pre-existing on main + anchor-expiry-sweep (SCRUM-1736)
    //      + check-stuck-anchors (SCRUM-2234)
    //      + reconcile-credit-conservation (S1-9)
    //      + drive-subscription-renewal (GH #1835/#1836, unconditional,
    //        restored per PR #1944 review correction — lease-guarded, see
    //        scheduled.ts's comment).
    expect(mockCronSchedule).toHaveBeenCalledTimes(16);
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

    expect(mockCronSchedule).toHaveBeenCalledTimes(16);
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
    // reconcile-credit-conservation and GH #1835/#1836's
    // drive-subscription-renewal are both NOT on the allowlist (read-only /
    // renewal-only, no anchor-table dependency), so they keep running: 7
    // remain (5 originals + the reconciler + the renewal sweep).
    expect(mockCronSchedule).toHaveBeenCalledTimes(7);
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

  it('registers populate-confirmation-proofs every 15 min when the flag is on (PROOF-03 / SCRUM-2336)', async () => {
    mockConfig.enableConfirmationProofBackfill = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // 16 baseline (incl. reconcile-credit-conservation S1-9 + GH #1835/#1836's
    // drive-subscription-renewal) + the gated confirmation-proof backfill job = 17.
    expect(mockCronSchedule).toHaveBeenCalledTimes(17);
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('*/15 * * * *');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('does NOT register the backfill job when the flag is off (default-OFF, zero prod impact)', async () => {
    mockConfig.enableConfirmationProofBackfill = false;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // 16 baseline jobs (incl. reconcile-credit-conservation S1-9 + GH #1835/
    // #1836's drive-subscription-renewal); the backfill job is NOT
    // registered when the flag is off.
    expect(mockCronSchedule).toHaveBeenCalledTimes(16);
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).not.toContain('*/15 * * * *');
  });

  it('skips the backfill job under the maintenance flag in production (anchor-table allowlist)', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    mockConfig.enableConfirmationProofBackfill = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    const skippedJobNames = mockLogger.warn.mock.calls
      .filter((call) => typeof (call[0] as { jobName?: string } | undefined)?.jobName === 'string')
      .map((call) => (call[0] as { jobName: string }).jobName);

    expect(skippedJobNames).toContain('populate-confirmation-proofs');
  });

  it('registers drain-connector-artifacts every 5 min when the flag is on (QUEUE-06 / SCRUM-2352)', async () => {
    mockConfig.enableConnectorArtifactDrain = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    // 16 baseline (incl. reconcile-credit-conservation SCRUM-2349 + GH #1835/
    // #1836's drive-subscription-renewal) + the gated connector-artifact drain job.
    expect(mockCronSchedule).toHaveBeenCalledTimes(17);
    const expressions = mockCronSchedule.mock.calls.map((call) => call[0] as string);
    expect(expressions).toContain('*/5 * * * *');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('does NOT register the drain job when the flag is off (default-OFF, zero prod impact)', async () => {
    // The drain job is the only flag-gated addition here, so with the flag off
    // the schedule count stays at the 16-job baseline (the `*/5` expression is
    // shared with process-revoked-anchors, so the count — not the expression —
    // is the load-bearing signal that the gated job did NOT register).
    mockConfig.enableConnectorArtifactDrain = false;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    expect(mockCronSchedule).toHaveBeenCalledTimes(16);
  });

  it('skips the drain job under the maintenance flag in production (anchor-table allowlist)', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    mockConfig.enableConnectorArtifactDrain = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    const skippedJobNames = mockLogger.warn.mock.calls
      .filter((call) => typeof (call[0] as { jobName?: string } | undefined)?.jobName === 'string')
      .map((call) => (call[0] as { jobName: string }).jobName);

    expect(skippedJobNames).toContain('drain-connector-artifacts');
  });
});
