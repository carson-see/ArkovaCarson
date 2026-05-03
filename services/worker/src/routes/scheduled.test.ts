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
vi.mock('../webhooks/delivery.js', () => ({ processWebhookRetries: vi.fn() }));
vi.mock('../jobs/credit-expiry.js', () => ({ processMonthlyCredits: vi.fn() }));
vi.mock('../jobs/chain-maintenance.js', () => ({
  consolidateUtxos: vi.fn(),
  detectReorgs: vi.fn(),
  monitorFeeRates: vi.fn(),
  monitorStuckTransactions: vi.fn(),
  rebroadcastDroppedTransactions: vi.fn(),
}));
vi.mock('../jobs/broadcast-recovery.js', () => ({ recoverStuckBroadcasts: vi.fn() }));
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

    expect(mockCronSchedule).toHaveBeenCalledTimes(13);
  });

  it('keeps production in-process cron enabled by default', async () => {
    mockConfig.nodeEnv = 'production';
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    expect(mockCronSchedule).toHaveBeenCalledTimes(13);
  });

  it('skips anchor-table in-process cron in production when maintenance flag is enabled', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.disableInProcessAnchorCron = true;
    const { setupScheduledJobs } = await import('./scheduled.js');

    setupScheduledJobs(true);

    expect(mockCronSchedule).toHaveBeenCalledTimes(5);
    expect(mockLogger.warn).toHaveBeenCalledTimes(8);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { jobName: 'process-pending-anchors', expression: '* * * * *' },
      'Skipping in-process anchor cron in production because DISABLE_IN_PROCESS_ANCHOR_CRON=true',
    );
  });
});
