/**
 * Tests for Cron Job HTTP Routes (GAP-02)
 *
 * Covers:
 *   - verifyCronAuth: CRON_SECRET, OIDC, platform admin token, rejection
 *   - cronAuth middleware: 401 when unauthenticated
 *   - Route handlers: success + error (500) paths for representative endpoints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks (must be before imports) ───

vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'development', // non-production → auth bypassed by default
    cronSecret: 'test-cron-secret-1234',
    cronOidcAudience: 'https://arkova-worker.run.app',
    frontendUrl: 'http://localhost:5173',
    corsAllowedOrigins: '',
    // SCRUM-1235: smoke-test config-sanity check inspects these
    stripeSecretKey: 'sk_test_smoke',
    bitcoinNetwork: 'testnet',
    enableProdNetworkAnchoring: false,
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../utils/rateLimit.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../auth.js', () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock('../utils/platformAdmin.js', () => ({
  isPlatformAdmin: vi.fn(),
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: vi.fn(),
}));

// Mock CORS middleware
vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ─── Mock all job imports ───

const mockProcessPendingAnchors = vi.fn().mockResolvedValue({ anchored: 5 });
vi.mock('../jobs/anchor.js', () => ({
  processPendingAnchors: (...args: unknown[]) => mockProcessPendingAnchors(...args),
}));

const mockCheckSubmittedConfirmations = vi.fn().mockResolvedValue({ confirmed: 3 });
vi.mock('../jobs/check-confirmations.js', () => ({
  checkSubmittedConfirmations: (...args: unknown[]) => mockCheckSubmittedConfirmations(...args),
}));

const mockProcessRevokedAnchors = vi.fn().mockResolvedValue({ revoked: 1 });
vi.mock('../jobs/revocation.js', () => ({
  processRevokedAnchors: (...args: unknown[]) => mockProcessRevokedAnchors(...args),
}));

const mockProcessWebhookRetries = vi.fn().mockResolvedValue(2);
vi.mock('../webhooks/delivery.js', () => ({
  processWebhookRetries: (...args: unknown[]) => mockProcessWebhookRetries(...args),
}));

const mockProcessMonthlyCredits = vi.fn().mockResolvedValue(10);
vi.mock('../jobs/credit-expiry.js', () => ({
  processMonthlyCredits: (...args: unknown[]) => mockProcessMonthlyCredits(...args),
}));

const mockFetchEdgarFilings = vi.fn().mockResolvedValue({ fetched: 100 });
const mockFetchEdgarHistoricalBackfill = vi.fn().mockResolvedValue({ backfilled: 50 });
const mockFetchEdgarBulk = vi.fn().mockResolvedValue({ ingested: 200 });
vi.mock('../jobs/edgarFetcher.js', () => ({
  fetchEdgarFilings: (...args: unknown[]) => mockFetchEdgarFilings(...args),
  fetchEdgarHistoricalBackfill: (...args: unknown[]) => mockFetchEdgarHistoricalBackfill(...args),
  fetchEdgarBulk: (...args: unknown[]) => mockFetchEdgarBulk(...args),
}));

// USPTO fetcher returns a FetchResult object (see jobs/usptoFetcher.ts). Mock shape
// matches the production return so the /fetch-uspto route forwards it to the client.
const mockFetchUsptoPAtents = vi.fn().mockResolvedValue({
  status: 'complete',
  inserted: 0,
  skipped: 0,
  errors: 0,
  resumeDate: '',
});
vi.mock('../jobs/usptoFetcher.js', () => ({
  fetchUsptoPAtents: (...args: unknown[]) => mockFetchUsptoPAtents(...args),
}));

const mockFetchFederalRegisterDocuments = vi.fn().mockResolvedValue(undefined);
vi.mock('../jobs/federalRegisterFetcher.js', () => ({
  fetchFederalRegisterDocuments: (...args: unknown[]) => mockFetchFederalRegisterDocuments(...args),
}));

const mockFetchOpenAlexWorks = vi.fn().mockResolvedValue({ fetched: 50 });
const mockFetchOpenAlexBulk = vi.fn().mockResolvedValue({ ingested: 500 });
vi.mock('../jobs/openalexFetcher.js', () => ({
  fetchOpenAlexWorks: (...args: unknown[]) => mockFetchOpenAlexWorks(...args),
  fetchOpenAlexBulk: (...args: unknown[]) => mockFetchOpenAlexBulk(...args),
}));

const mockFetchCourtOpinions = vi.fn().mockResolvedValue({ fetched: 30 });
const mockFetchStateCourts = vi.fn().mockResolvedValue({ fetched: 20 });
vi.mock('../jobs/courtlistenerFetcher.js', () => ({
  fetchCourtOpinions: (...args: unknown[]) => mockFetchCourtOpinions(...args),
  fetchStateCourts: (...args: unknown[]) => mockFetchStateCourts(...args),
}));

const mockProcessPublicRecordAnchoring = vi.fn().mockResolvedValue({ anchored: 10 });
vi.mock('../jobs/publicRecordAnchor.js', () => ({
  processPublicRecordAnchoring: (...args: unknown[]) => mockProcessPublicRecordAnchoring(...args),
}));

const mockEmbedPublicRecords = vi.fn().mockResolvedValue({ embedded: 25 });
vi.mock('../jobs/publicRecordEmbedder.js', () => ({
  embedPublicRecords: (...args: unknown[]) => mockEmbedPublicRecords(...args),
}));

const mockProcessAttestationAnchoring = vi.fn().mockResolvedValue({ anchored: 3 });
vi.mock('../jobs/attestationAnchor.js', () => ({
  processAttestationAnchoring: (...args: unknown[]) => mockProcessAttestationAnchoring(...args),
}));

const mockCheckAttestationExpiry = vi.fn().mockResolvedValue({ expired: 1 });
vi.mock('../jobs/attestationExpiry.js', () => ({
  checkAttestationExpiry: (...args: unknown[]) => mockCheckAttestationExpiry(...args),
}));

const mockFetchDapipInstitutions = vi.fn().mockResolvedValue({ fetched: 40 });
vi.mock('../jobs/dapipFetcher.js', () => ({
  fetchDapipInstitutions: (...args: unknown[]) => mockFetchDapipInstitutions(...args),
}));

const mockProcessBatchAnchors = vi.fn().mockResolvedValue({ batched: 100 });
vi.mock('../jobs/batch-anchor.js', () => ({
  processBatchAnchors: (...args: unknown[]) => mockProcessBatchAnchors(...args),
}));

const mockFetchAcncCharities = vi.fn().mockResolvedValue({ fetched: 15 });
vi.mock('../jobs/acncFetcher.js', () => ({
  fetchAcncCharities: (...args: unknown[]) => mockFetchAcncCharities(...args),
}));

const mockRunRegulatoryChangeScan = vi.fn().mockResolvedValue({ scanned: 12, alertsCreated: 3 });
vi.mock('../jobs/regulatory-change-scan.js', () => ({
  runRegulatoryChangeScan: (...args: unknown[]) => mockRunRegulatoryChangeScan(...args),
}));

vi.mock('../utils/sentry.js', () => ({
  withCronMonitoring: (_slug: string, _schedule: string, fn: () => unknown) => fn,
}));

const mockFetchStateBills = vi.fn().mockResolvedValue({ fetched: 30 });
const mockFetchMultipleStateBills = vi.fn().mockResolvedValue({ fetched: 90 });
vi.mock('../jobs/openStatesFetcher.js', () => ({
  fetchStateBills: (...args: unknown[]) => mockFetchStateBills(...args),
  fetchMultipleStateBills: (...args: unknown[]) => mockFetchMultipleStateBills(...args),
}));

const mockFetchCalBarAttorneys = vi.fn().mockResolvedValue({ fetched: 50 });
vi.mock('../jobs/calbarFetcher.js', () => ({
  fetchCalBarAttorneys: (...args: unknown[]) => mockFetchCalBarAttorneys(...args),
}));

const mockFetchFinraBrokers = vi.fn().mockResolvedValue({ fetched: 25 });
vi.mock('../jobs/finraBrokerCheckFetcher.js', () => ({
  fetchFinraBrokers: (...args: unknown[]) => mockFetchFinraBrokers(...args),
}));

const mockFetchSecIapdFirms = vi.fn().mockResolvedValue({ fetched: 20 });
vi.mock('../jobs/secIapdFetcher.js', () => ({
  fetchSecIapdFirms: (...args: unknown[]) => mockFetchSecIapdFirms(...args),
}));

const mockFetchNpiProviders = vi.fn().mockResolvedValue({ fetched: 100 });
vi.mock('../jobs/npiFetcher.js', () => ({
  fetchNpiProviders: (...args: unknown[]) => mockFetchNpiProviders(...args),
}));

const mockFetchSamEntities = vi.fn().mockResolvedValue({ fetched: 60 });
const mockFetchSamExclusions = vi.fn().mockResolvedValue({ fetched: 10 });
vi.mock('../jobs/samGovFetcher.js', () => ({
  fetchSamEntities: (...args: unknown[]) => mockFetchSamEntities(...args),
  fetchSamExclusions: (...args: unknown[]) => mockFetchSamExclusions(...args),
}));

const mockFetchFccLicenses = vi.fn().mockResolvedValue({ fetched: 35 });
vi.mock('../jobs/fccUlsFetcher.js', () => ({
  fetchFccLicenses: (...args: unknown[]) => mockFetchFccLicenses(...args),
}));

const mockDetectReorgs = vi.fn().mockResolvedValue({ reorgsDetected: 0 });
const mockMonitorStuckTransactions = vi.fn().mockResolvedValue({ stuck: 0 });
const mockRebroadcastDroppedTransactions = vi.fn().mockResolvedValue({ rebroadcast: 0 });
const mockConsolidateUtxos = vi.fn().mockResolvedValue({ consolidated: 0 });
const mockMonitorFeeRates = vi.fn().mockResolvedValue({ currentRate: 5 });
vi.mock('../jobs/chain-maintenance.js', () => ({
  detectReorgs: (...args: unknown[]) => mockDetectReorgs(...args),
  monitorStuckTransactions: (...args: unknown[]) => mockMonitorStuckTransactions(...args),
  rebroadcastDroppedTransactions: (...args: unknown[]) => mockRebroadcastDroppedTransactions(...args),
  consolidateUtxos: (...args: unknown[]) => mockConsolidateUtxos(...args),
  monitorFeeRates: (...args: unknown[]) => mockMonitorFeeRates(...args),
}));

const mockRecoverStuckBroadcasts = vi.fn().mockResolvedValue({ recovered: 0 });
vi.mock('../jobs/broadcast-recovery.js', () => ({
  recoverStuckBroadcasts: (...args: unknown[]) => mockRecoverStuckBroadcasts(...args),
}));

const mockRunMainnetMigration = vi.fn().mockResolvedValue({ migrated: 100 });
const mockGetMigrationStatus = vi.fn().mockResolvedValue({ status: 'complete', count: 166000 });
vi.mock('../jobs/mainnet-migration.js', () => ({
  runMainnetMigration: (...args: unknown[]) => mockRunMainnetMigration(...args),
  getMigrationStatus: (...args: unknown[]) => mockGetMigrationStatus(...args),
}));

const mockRunStripeAnchorReconciliation = vi.fn().mockResolvedValue({ reconciled: 5 });
const mockGenerateFinancialReport = vi.fn().mockResolvedValue({ generated: true });
const mockProcessFailedPaymentRecovery = vi.fn().mockResolvedValue({ recovered: 2 });
vi.mock('../billing/reconciliation.js', () => ({
  runStripeAnchorReconciliation: (...args: unknown[]) => mockRunStripeAnchorReconciliation(...args),
  generateFinancialReport: (...args: unknown[]) => mockGenerateFinancialReport(...args),
  processFailedPaymentRecovery: (...args: unknown[]) => mockProcessFailedPaymentRecovery(...args),
}));

const mockRunGraceExpirySweep = vi.fn().mockResolvedValue({ expired: 3 });
vi.mock('../jobs/grace-expiry-sweep.js', () => ({
  GRACE_EXPIRY_SWEEP_CRON: '*/15 * * * *',
  runGraceExpirySweep: (...args: unknown[]) => mockRunGraceExpirySweep(...args),
}));

const mockRunAllocationRollover = vi.fn().mockResolvedValue({
  total_orgs: 5,
  rolled: 4,
  skipped: 1,
  errors: 0,
});
vi.mock('../jobs/monthly-allocation-rollover.js', () => ({
  MONTHLY_ALLOCATION_ROLLOVER_CRON: '0 0 1 * *',
  runAllocationRollover: (...args: unknown[]) => mockRunAllocationRollover(...args),
}));

// ─── Import after mocks ───
import { cronRouter } from './cron.js';
import { config } from '../config.js';
import { verifyAuthToken } from '../auth.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { callRpc } from '../utils/rpc.js';
import { db } from '../utils/db.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/cron', cronRouter);
  return app;
}

describe('cron routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mutated config fields back to defaults so each test starts clean.
    // If a test fails mid-run, the next test still gets a known-good config.
    const mutableConfig = config as {
      nodeEnv: string;
      cronSecret?: string;
      cronOidcAudience?: string;
    };
    mutableConfig.nodeEnv = 'development';
    mutableConfig.cronSecret = 'test-cron-secret-1234';
    mutableConfig.cronOidcAudience = 'https://arkova-worker.run.app';
  });

  // ═══════════════════════════════════════
  // Auth Tests
  // ═══════════════════════════════════════

  describe('cronAuth middleware', () => {
    it('bypasses auth in non-production mode', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated requests in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('accepts valid CRON_SECRET header in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('X-Cron-Secret', 'test-cron-secret-1234');
      expect(res.status).toBe(200);
    });

    it('rejects invalid CRON_SECRET header in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('X-Cron-Secret', 'wrong-secret-value!!');
      expect(res.status).toBe(401);
    });

    it('rejects CRON_SECRET with wrong length', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('X-Cron-Secret', 'short');
      expect(res.status).toBe(401);
    });

    it('accepts platform admin Bearer token in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      (verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue('user-123');
      (isPlatformAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('Authorization', 'Bearer admin-jwt-token');
      expect(res.status).toBe(200);
      expect(verifyAuthToken).toHaveBeenCalledWith('admin-jwt-token', config, expect.anything());
    });

    it('rejects non-admin Bearer token in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      (verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue('user-456');
      (isPlatformAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('Authorization', 'Bearer non-admin-token');
      // Falls through to OIDC which will also fail → 401
      expect(res.status).toBe(401);
    });

    it('rejects empty Bearer token in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
    });

    it('rejects missing Authorization header in production', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(401);
    });

    // SCRUM-640: Revisions deployed with CRON_OIDC_AUDIENCE but without
    // CRON_SECRET used to 401 unconditionally because the middleware bailed
    // at `!config.cronSecret` instead of falling through to OIDC. These
    // three tests pin the post-fix contract.
    it('SCRUM-640: does not log "CRON_SECRET not configured" when OIDC audience is set', async () => {
      const { logger } = await import('../utils/logger.js');
      const errorSpy = logger.error as ReturnType<typeof vi.fn>;
      errorSpy.mockClear();

      const mutable = config as { nodeEnv: string; cronSecret?: string };
      mutable.nodeEnv = 'production';
      mutable.cronSecret = undefined;
      const app = createApp();

      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(401);

      const loggedMessages = errorSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(loggedMessages.some((m) => m.includes('CRON_SECRET not configured'))).toBe(false);
    });

    it('SCRUM-640: still accepts valid X-Cron-Secret header when cronSecret is configured', async () => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('X-Cron-Secret', 'test-cron-secret-1234');
      expect(res.status).toBe(200);
    });

    it('SCRUM-640: ignores stale X-Cron-Secret header on OIDC-only deploy and falls through to Bearer', async () => {
      // Scenario: legacy Cloud Scheduler job (or proxy) still attaches an
      // X-Cron-Secret header on a revision where CRON_SECRET was removed and
      // CRON_OIDC_AUDIENCE is the only configured auth. Must not 401 early —
      // must fall through to the Authorization: Bearer path.
      const mutable = config as { nodeEnv: string; cronSecret?: string };
      mutable.nodeEnv = 'production';
      mutable.cronSecret = undefined;

      // Simulate a valid platform admin Bearer token as the "Method 2"
      // fallthrough (so we don't need to mock Google JWKS in a unit test).
      (verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue('admin-user');
      (isPlatformAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('X-Cron-Secret', 'stale-header-from-legacy-scheduler')
        .set('Authorization', 'Bearer admin-jwt-token');
      expect(res.status).toBe(200);
    });

    it('SCRUM-640: rejects cron if neither CRON_SECRET nor CRON_OIDC_AUDIENCE configured', async () => {
      const mutable = config as {
        nodeEnv: string;
        cronSecret?: string;
        cronOidcAudience?: string;
      };
      mutable.nodeEnv = 'production';
      mutable.cronSecret = undefined;
      mutable.cronOidcAudience = undefined;
      const app = createApp();

      const res = await request(app)
        .post('/cron/process-anchors')
        .set('Authorization', 'Bearer some-token');
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════
  // Core Anchoring Routes
  // ═══════════════════════════════════════

  describe('POST /process-anchors', () => {
    it('returns job result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ anchored: 5 });
    });

    it('returns 500 on job failure', async () => {
      mockProcessPendingAnchors.mockRejectedValueOnce(new Error('DB down'));
      const app = createApp();
      const res = await request(app).post('/cron/process-anchors');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Processing failed');
    });
  });

  describe('POST /batch-anchors', () => {
    it('returns job result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/batch-anchors');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ batched: 100 });
    });

    it('returns 500 on job failure', async () => {
      mockProcessBatchAnchors.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/batch-anchors');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /check-confirmations', () => {
    it('returns result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/check-confirmations');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ confirmed: 3 });
    });

    it('returns 500 on failure', async () => {
      mockCheckSubmittedConfirmations.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/check-confirmations');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /process-revocations', () => {
    it('returns result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/process-revocations');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: 1 });
    });

    it('returns 500 on failure', async () => {
      mockProcessRevokedAnchors.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/process-revocations');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /webhook-retries', () => {
    it('returns retried count', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/webhook-retries');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ retried: 2 });
    });

    it('returns 500 on failure', async () => {
      mockProcessWebhookRetries.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/webhook-retries');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /credit-expiry', () => {
    it('returns processed count', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/credit-expiry');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ processed: 10 });
    });

    it('returns 500 on failure', async () => {
      mockProcessMonthlyCredits.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/credit-expiry');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Pipeline Fetcher Routes
  // ═══════════════════════════════════════

  describe('POST /fetch-edgar', () => {
    it('returns result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-edgar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 100 });
    });

    it('returns 500 on failure', async () => {
      mockFetchEdgarFilings.mockRejectedValueOnce(new Error('SEC down'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-edgar');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-uspto', () => {
    it('returns success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-uspto');
      expect(res.status).toBe(200);
      // Route forwards the FetchResult from the fetcher verbatim.
      expect(res.body).toMatchObject({ status: 'complete' });
      expect(res.body).toHaveProperty('inserted');
      expect(res.body).toHaveProperty('resumeDate');
    });

    it('returns 500 on failure', async () => {
      mockFetchUsptoPAtents.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-uspto');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-federal-register', () => {
    it('returns success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-federal-register');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'complete' });
    });

    it('returns 500 on failure', async () => {
      mockFetchFederalRegisterDocuments.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-federal-register');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-openalex', () => {
    it('returns result on success', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-openalex');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 50 });
    });

    it('returns 500 on failure', async () => {
      mockFetchOpenAlexWorks.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-openalex');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /openalex-bulk', () => {
    it('accepts query params and returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/openalex-bulk?startDate=2020-01-01&maxPages=100');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ingested: 500 });
    });

    it('accepts body params', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/openalex-bulk')
        .send({ startDate: '2020-01-01', endDate: '2024-01-01', minCitations: 5, maxPages: 200, resumeCursor: 'abc' });
      expect(res.status).toBe(200);
    });

    it('returns 500 on failure', async () => {
      mockFetchOpenAlexBulk.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/openalex-bulk');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-courtlistener', () => {
    it('returns result with query params', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-courtlistener')
        .send({ startDate: '2000-01-01', maxPages: 100 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 30 });
    });

    it('returns 500 on failure', async () => {
      mockFetchCourtOpinions.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-courtlistener');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-state-courts', () => {
    it('returns result with state param', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-state-courts')
        .send({ state: 'NY' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 20 });
    });

    it('returns 500 on failure', async () => {
      mockFetchStateCourts.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-state-courts');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-state-bills', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-state-bills')
        .send({ state: 'TX', maxPages: 100 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 30 });
    });

    it('returns 500 on failure', async () => {
      mockFetchStateBills.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-state-bills');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-all-state-bills', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-all-state-bills')
        .send({ states: ['CA', 'NY'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 90 });
    });

    it('returns 500 on failure', async () => {
      mockFetchMultipleStateBills.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-all-state-bills');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /embed-public-records', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/embed-public-records');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ embedded: 25 });
    });

    it('returns 500 on failure', async () => {
      mockEmbedPublicRecords.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/embed-public-records');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /anchor-public-records', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/anchor-public-records');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ anchored: 10 });
    });

    it('returns 500 on failure', async () => {
      mockProcessPublicRecordAnchoring.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/anchor-public-records');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /edgar-backfill', () => {
    it('returns result with batch param', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/edgar-backfill?batch=3');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ backfilled: 50 });
    });

    it('returns 500 on failure', async () => {
      mockFetchEdgarHistoricalBackfill.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/edgar-backfill');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /edgar-bulk', () => {
    it('accepts params and returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/edgar-bulk')
        .send({ startYear: 2000, endYear: 2024, maxQueries: 50 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ingested: 200 });
    });

    it('returns 500 on failure', async () => {
      mockFetchEdgarBulk.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/edgar-bulk');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-dapip', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-dapip');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 40 });
    });

    it('returns 500 on failure', async () => {
      mockFetchDapipInstitutions.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-dapip');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-acnc', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-acnc');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 15 });
    });

    it('returns 500 on failure', async () => {
      mockFetchAcncCharities.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-acnc');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Attestation Routes
  // ═══════════════════════════════════════

  describe('POST /anchor-attestations', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/anchor-attestations');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ anchored: 3 });
    });

    it('returns 500 on failure', async () => {
      mockProcessAttestationAnchoring.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/anchor-attestations');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /check-attestation-expiry', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/check-attestation-expiry');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expired: 1 });
    });

    it('returns 500 on failure', async () => {
      mockCheckAttestationExpiry.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/check-attestation-expiry');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Broadcast Recovery
  // ═══════════════════════════════════════

  describe('POST /recover-broadcasts', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/recover-broadcasts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recovered: 0 });
    });

    it('returns 500 on failure', async () => {
      mockRecoverStuckBroadcasts.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/recover-broadcasts');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Chain Maintenance Routes
  // ═══════════════════════════════════════

  describe('POST /detect-reorgs', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/detect-reorgs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reorgsDetected: 0 });
    });

    it('returns 500 on failure', async () => {
      mockDetectReorgs.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/detect-reorgs');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /monitor-stuck-txs', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/monitor-stuck-txs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stuck: 0 });
    });

    it('returns 500 on failure', async () => {
      mockMonitorStuckTransactions.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/monitor-stuck-txs');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /rebroadcast-txs', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/rebroadcast-txs');
      expect(res.status).toBe(200);
    });

    it('returns 500 on failure', async () => {
      mockRebroadcastDroppedTransactions.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/rebroadcast-txs');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /consolidate-utxos', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/consolidate-utxos');
      expect(res.status).toBe(200);
    });

    it('returns 500 on failure', async () => {
      mockConsolidateUtxos.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/consolidate-utxos');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /monitor-fees', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/monitor-fees');
      expect(res.status).toBe(200);
    });

    it('returns 500 on failure', async () => {
      mockMonitorFeeRates.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/monitor-fees');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Billing Reconciliation Routes
  // ═══════════════════════════════════════

  describe('POST /grace-expiry-sweep', () => {
    it('returns grace expiry sweep result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/grace-expiry-sweep');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expired: 3 });
      expect(mockRunGraceExpirySweep).toHaveBeenCalled();
    });

    it('returns 500 on failure', async () => {
      mockRunGraceExpirySweep.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/grace-expiry-sweep');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /monthly-allocation-rollover', () => {
    it('returns rollover summary', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/monthly-allocation-rollover');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ total_orgs: 5, rolled: 4, skipped: 1, errors: 0 });
      expect(mockRunAllocationRollover).toHaveBeenCalled();
    });

    it('returns 500 on failure', async () => {
      mockRunAllocationRollover.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/monthly-allocation-rollover');
      expect(res.status).toBe(500);
    });

    // SCRUM-1219 the original bug was a path mismatch — Cloud Scheduler hit
    // a route that didn't exist. Read the actual scheduler config and assert
    // the route path matches; a typo on either side fails this test.
    it('route path matches what cloud-scheduler.sh registers', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const here = path.dirname(new URL(import.meta.url).pathname);
      const schedulerScript = path.resolve(here, '../../../../scripts/gcp-setup/cloud-scheduler.sh');
      const contents = fs.readFileSync(schedulerScript, 'utf8');
      const match = contents.match(/"monthly-allocation-rollover\|[^|]+\|(\/jobs\/[^"]+)"/);
      expect(match).not.toBeNull();
      const scheduledPath = match![1];
      expect(scheduledPath).toBe('/jobs/monthly-allocation-rollover');
      // The cron router is mounted at /jobs in production (services/worker/src/index.ts)
      // and at /cron in this test (createApp). The relative path after the
      // mount prefix must match.
      const handlerPath = scheduledPath.replace('/jobs', '');
      expect(handlerPath).toBe('/monthly-allocation-rollover');

      const app = createApp();
      const res = await request(app).post(`/cron${handlerPath}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /reconcile-stripe', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/reconcile-stripe');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reconciled: 5 });
    });

    it('returns 500 on failure', async () => {
      mockRunStripeAnchorReconciliation.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/reconcile-stripe');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /financial-report', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/financial-report');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ generated: true });
    });

    it('returns 500 on failure', async () => {
      mockGenerateFinancialReport.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/financial-report');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /payment-recovery', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/payment-recovery');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recovered: 2 });
    });

    it('returns 500 on failure', async () => {
      mockProcessFailedPaymentRecovery.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/payment-recovery');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Mainnet Migration Routes
  // ═══════════════════════════════════════

  describe('POST /mainnet-migration', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/mainnet-migration');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ migrated: 100 });
    });

    it('returns 500 on failure', async () => {
      mockRunMainnetMigration.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/mainnet-migration');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /migration-status', () => {
    it('returns status', async () => {
      const app = createApp();
      const res = await request(app).get('/cron/migration-status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'complete', count: 166000 });
    });

    it('returns 500 on failure', async () => {
      mockGetMigrationStatus.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).get('/cron/migration-status');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Professional License Fetchers
  // ═══════════════════════════════════════

  describe('POST /fetch-calbar', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-calbar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 50 });
    });

    it('returns 500 on failure', async () => {
      mockFetchCalBarAttorneys.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-calbar');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-finra', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-finra');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 25 });
    });

    it('returns 500 on failure', async () => {
      mockFetchFinraBrokers.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-finra');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-sec-iapd', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-sec-iapd');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 20 });
    });

    it('returns 500 on failure', async () => {
      mockFetchSecIapdFirms.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-sec-iapd');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-npi', () => {
    it('returns result with body params', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-npi')
        .send({ states: ['CA', 'NY'], maxPerRun: 500 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 100 });
    });

    it('returns 500 on failure', async () => {
      mockFetchNpiProviders.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-npi');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-sam-entities', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-sam-entities')
        .send({ states: ['CA'], maxPerRun: 200 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 60 });
    });

    it('returns 500 on failure', async () => {
      mockFetchSamEntities.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-sam-entities');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-sam-exclusions', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/fetch-sam-exclusions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 10 });
    });

    it('returns 500 on failure', async () => {
      mockFetchSamExclusions.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-sam-exclusions');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /fetch-fcc', () => {
    it('returns result', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/cron/fetch-fcc')
        .send({ maxPerRun: 100 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fetched: 35 });
    });

    it('returns 500 on failure', async () => {
      mockFetchFccLicenses.mockRejectedValueOnce(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/fetch-fcc');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Utility Routes
  // ═══════════════════════════════════════

  describe('POST /refresh-stats', () => {
    it('refreshes BOTH pipeline_dashboard_cache AND legacy mat views', async () => {
      // Hotfix 2026-04-28: handler used to call only
      // refresh_stats_materialized_views, leaving pipeline_dashboard_cache
      // stale (the actual table the dashboard reads). Now drives both.
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock
        .mockResolvedValueOnce({ data: { status: 'refreshed', duration_ms: 12 }, error: null })
        .mockResolvedValueOnce({ data: null, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refreshed');
      expect(res.body.errors).toEqual([]);
      // First call must be the dashboard cache (the user-visible one).
      expect(callRpcMock.mock.calls[0]?.[1]).toBe('refresh_pipeline_dashboard_cache');
      expect(callRpcMock.mock.calls[1]?.[1]).toBe('refresh_stats_materialized_views');
    });

    it('still returns 200 if the legacy mat-view refresh fails (non-fatal)', async () => {
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock
        .mockResolvedValueOnce({ data: { status: 'refreshed', duration_ms: 12 }, error: null })
        .mockRejectedValueOnce(new Error('mat-view fail'));
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(200);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].source).toBe('stats_materialized_views');
    });

    it('returns 500 if the dashboard cache refresh fails even when legacy refresh succeeds', async () => {
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock
        .mockRejectedValueOnce(new Error('dashboard fail'))
        .mockResolvedValueOnce({ data: null, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        status: 'failed',
        reason: 'pipeline_dashboard_cache failed',
        refreshed: ['stats_materialized_views'],
      });
      expect(res.body.errors).toEqual([
        expect.objectContaining({ source: 'pipeline_dashboard_cache' }),
      ]);
    });

    it('returns 500 if the dashboard cache RPC returns a malformed success payload', async () => {
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        status: 'failed',
        reason: 'pipeline_dashboard_cache failed',
        refreshed: ['stats_materialized_views'],
      });
      expect(res.body.errors[0]).toMatchObject({
        source: 'pipeline_dashboard_cache',
      });
      expect(res.body.errors[0].message).toContain('Invalid refresh_pipeline_dashboard_cache payload');
    });

    it('propagates skipped dashboard refresh status from the RPC', async () => {
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock
        .mockResolvedValueOnce({
          data: {
            status: 'skipped',
            reason: 'another refresh in progress',
            duration_ms: 9,
          },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'skipped',
        reason: 'another refresh in progress',
        duration_ms: 9,
        refreshed: ['stats_materialized_views'],
        errors: [],
      });
    });

    it('returns 500 with all errors when both refresh paths fail', async () => {
      const callRpcMock = callRpc as ReturnType<typeof vi.fn>;
      callRpcMock.mockRejectedValue(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(500);
      expect(res.body.errors).toHaveLength(2);
    });
  });

  describe('POST /cleanup-retention', () => {
    it('returns cleanup result', async () => {
      (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { deleted: 5 }, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/cleanup-retention');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { deleted: 5 } });
    });

    it('returns 500 on RPC error response', async () => {
      (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'RPC fail' } });
      const app = createApp();
      const res = await request(app).post('/cron/cleanup-retention');
      expect(res.status).toBe(500);
    });

    it('returns 500 on exception', async () => {
      (callRpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/cleanup-retention');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /cron/smoke-test', () => {
    /**
     * SCRUM-1235: smoke test rewrite. The runner uses two SECURITY DEFINER
     * RPCs instead of `count: 'exact'` scans on a 1.4M-row anchors table:
     *   - get_anchor_status_counts_fast() — for the anchor-count check
     *   - verify_anchors_rls_enabled()    — for the rls-active check
     *
     * recent-secured uses .is(deleted_at, null) + explicit ORDER BY so the
     * partial index `idx_anchors_status_created` is selected.
     *
     * SCRUM-1247 (R0-1): added build-sha-present check + gitSha in response.
     * Tests that set process.env.BUILD_SHA must restore the original value.
     */
    let originalBuildSha: string | undefined;
    beforeEach(() => {
      originalBuildSha = process.env.BUILD_SHA;
    });
    afterEach(() => {
      if (originalBuildSha === undefined) delete process.env.BUILD_SHA;
      else process.env.BUILD_SHA = originalBuildSha;
    });

    function buildAnchorsSelectChain(opts: { recentSecured?: { created_at: string } | null; databaseFail?: boolean } = {}) {
      const { recentSecured = { created_at: '2026-04-01T00:00:00Z' }, databaseFail = false } = opts;
      const dbResult = databaseFail
        ? { data: null, error: { message: 'database down' } }
        : { data: [{ id: '1' }], error: null };
      const recentData = recentSecured ? [recentSecured] : [];

      return {
        select: vi.fn().mockReturnValue({
          // path: select('id').limit(1) — database connectivity
          limit: vi.fn().mockResolvedValue(dbResult),
          // path: select('created_at').eq().gte().is().order().limit() — recent-secured
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: recentData, error: null }),
                }),
              }),
            }),
          }),
        }),
      };
    }

    function setupHappyPathMocks(opts: Parameters<typeof buildAnchorsSelectChain>[0] = {}) {
      const anchorsChain = buildAnchorsSelectChain(opts);
      const auditEventsChain = { insert: vi.fn().mockResolvedValue({ error: null }) };

      (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'audit_events') return auditEventsChain;
        return anchorsChain;
      });

      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'get_anchor_status_counts_fast') {
          return Promise.resolve({
            data: { PENDING: 12, SUBMITTED: 0, BROADCASTING: 3, SECURED: 1_410_000, REVOKED: 5, total: 1_410_020 },
            error: null,
          });
        }
        if (name === 'verify_anchors_rls_enabled') {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      });

      return { anchorsChain, auditEventsChain };
    }

    // SCRUM-1247 (R0-1): smoke test gained a 6th `build-sha-present` check
    // that pass when BUILD_SHA env is a valid 40-char hex.
    it('runs smoke tests and returns 6 results', async () => {
      setupHappyPathMocks();
      process.env.BUILD_SHA = 'a'.repeat(40);

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      expect(res.body.results).toBeDefined();
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.total).toBe(6);
      expect(res.body.gitSha).toBe('a'.repeat(40));
      expect(res.body.timestamp).toBeDefined();
      const names = res.body.results.map((r: { name: string }) => r.name);
      expect(names).toEqual([
        'database',
        'anchor-count',
        'recent-secured',
        'config-sanity',
        'rls-active',
        'build-sha-present',
      ]);
    });

    it('passes all 6 checks when DB, RPCs, and BUILD_SHA are healthy', async () => {
      setupHappyPathMocks();
      process.env.BUILD_SHA = 'a'.repeat(40);

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      expect(res.body.passed).toBe(6);
      expect(res.body.failed).toBe(0);
      expect(res.body.status).toBe('pass');
      expect(res.status).toBe(200);
    });

    it('build-sha-present fails when BUILD_SHA is unset', async () => {
      setupHappyPathMocks();
      delete process.env.BUILD_SHA;

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const shaCheck = res.body.results.find((r: { name: string }) => r.name === 'build-sha-present');
      expect(shaCheck.status).toBe('fail');
      expect(shaCheck.detail).toContain('image was built without --build-arg BUILD_SHA');
      expect(res.body.gitSha).toBe('unknown');
    });

    it('build-sha-present fails when BUILD_SHA is malformed (not 40-char hex)', async () => {
      setupHappyPathMocks();
      process.env.BUILD_SHA = 'not-a-real-sha';

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const shaCheck = res.body.results.find((r: { name: string }) => r.name === 'build-sha-present');
      expect(shaCheck.status).toBe('fail');
      expect(res.body.gitSha).toBe('not-a-real-sha');
    });

    it('anchor-count uses get_anchor_status_counts_fast RPC, not count:exact', async () => {
      const { anchorsChain } = setupHappyPathMocks();

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      expect(db.rpc).toHaveBeenCalledWith('get_anchor_status_counts_fast');
      const anchorCount = res.body.results.find((r: { name: string }) => r.name === 'anchor-count');
      expect(anchorCount.status).toBe('pass');
      expect(anchorCount.detail).toContain('1410020');
      const selectCalls = (anchorsChain.select as ReturnType<typeof vi.fn>).mock.calls;
      const usedExactCount = selectCalls.some(
        (call) => typeof call[1] === 'object' && call[1] !== null && 'count' in call[1] && call[1].count === 'exact',
      );
      expect(usedExactCount).toBe(false);
    });

    it('anchor-count fails when get_anchor_status_counts_fast RPC errors', async () => {
      setupHappyPathMocks();
      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'get_anchor_status_counts_fast') {
          return Promise.resolve({ data: null, error: { message: 'statement timeout' } });
        }
        if (name === 'verify_anchors_rls_enabled') {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const anchorCount = res.body.results.find((r: { name: string }) => r.name === 'anchor-count');
      expect(anchorCount.status).toBe('fail');
      expect(anchorCount.error).toBe('statement timeout');
      expect(res.body.failed).toBeGreaterThanOrEqual(1);
    });

    it('anchor-count fails when total is 0 (production should never have 0 anchors)', async () => {
      setupHappyPathMocks();
      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'get_anchor_status_counts_fast') {
          return Promise.resolve({
            data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 0, REVOKED: 0, total: 0 },
            error: null,
          });
        }
        if (name === 'verify_anchors_rls_enabled') {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const anchorCount = res.body.results.find((r: { name: string }) => r.name === 'anchor-count');
      expect(anchorCount.status).toBe('fail');
    });

    it('rls-active uses verify_anchors_rls_enabled RPC and passes when true', async () => {
      setupHappyPathMocks();

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      expect(db.rpc).toHaveBeenCalledWith('verify_anchors_rls_enabled');
      const rls = res.body.results.find((r: { name: string }) => r.name === 'rls-active');
      expect(rls.status).toBe('pass');
    });

    it('rls-active FAILS CLOSED when RLS is disabled (RPC returns false)', async () => {
      setupHappyPathMocks();
      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'get_anchor_status_counts_fast') {
          return Promise.resolve({
            data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 1, REVOKED: 0, total: 1 },
            error: null,
          });
        }
        if (name === 'verify_anchors_rls_enabled') {
          return Promise.resolve({ data: false, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const rls = res.body.results.find((r: { name: string }) => r.name === 'rls-active');
      expect(rls.status).toBe('fail');
      expect(rls.detail).toMatch(/not enforced|disabled|false/i);
    });

    it('rls-active fails when RPC errors', async () => {
      setupHappyPathMocks();
      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'get_anchor_status_counts_fast') {
          return Promise.resolve({
            data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 1, REVOKED: 0, total: 1 },
            error: null,
          });
        }
        if (name === 'verify_anchors_rls_enabled') {
          return Promise.resolve({ data: null, error: { message: 'function does not exist' } });
        }
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const rls = res.body.results.find((r: { name: string }) => r.name === 'rls-active');
      expect(rls.status).toBe('fail');
    });

    it('recent-secured query uses is(deleted_at, null) + order(created_at desc) for index hit', async () => {
      const { anchorsChain } = setupHappyPathMocks();

      const app = createApp();
      await request(app).post('/cron/smoke-test');

      const selectReturn = anchorsChain.select.mock.results.find((r) => r.value && typeof r.value === 'object' && 'eq' in r.value)?.value;
      expect(selectReturn).toBeDefined();
      const eqReturn = selectReturn.eq.mock.results[0]?.value;
      expect(eqReturn).toBeDefined();
      const gteReturn = eqReturn.gte.mock.results[0]?.value;
      expect(gteReturn).toBeDefined();
      expect(gteReturn.is).toHaveBeenCalledWith('deleted_at', null);
      const isReturn = gteReturn.is.mock.results[0]?.value;
      expect(isReturn.order).toHaveBeenCalledWith('created_at', { ascending: false });
    });

    it('recent-secured fails when there are no SECURED anchors in the last 7 days', async () => {
      setupHappyPathMocks({ recentSecured: null });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      const recent = res.body.results.find((r: { name: string }) => r.name === 'recent-secured');
      expect(recent.status).toBe('fail');
      expect(res.body.failed).toBeGreaterThanOrEqual(1);
    });

    it('returns 503 when any check fails', async () => {
      setupHappyPathMocks({ databaseFail: true });

      const app = createApp();
      const res = await request(app).post('/cron/smoke-test');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('fail');
      expect(res.body.failed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /cron/smoke-test/history', () => {
    it('returns smoke test history from audit_events', async () => {
      const mockHistory = [
        {
          created_at: '2026-04-01T00:00:00Z',
          details: JSON.stringify({ passed: 5, failed: 0, total: 5, results: [] }),
        },
      ];
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockHistory, error: null }),
            }),
          }),
        }),
      });

      const app = createApp();
      const res = await request(app).get('/cron/smoke-test/history');
      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(1);
      expect(res.body.history[0].passed).toBe(5);
    });

    it('returns 500 on database error', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
            }),
          }),
        }),
      });

      const app = createApp();
      const res = await request(app).get('/cron/smoke-test/history');
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════
  // Regulatory Change Scan (NCA-FU1 #1)
  // ═══════════════════════════════════════

  describe('POST /regulatory-change-scan', () => {
    it('returns scan result with Sentry monitoring wrapper', async () => {
      const app = createApp();
      const res = await request(app).post('/cron/regulatory-change-scan');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        scanned: 12,
        alerts_created: 3,
        timestamp: expect.any(String),
      });
    });

    it('returns 500 on scan failure', async () => {
      mockRunRegulatoryChangeScan.mockRejectedValueOnce(new Error('scan failed'));
      const app = createApp();
      const res = await request(app).post('/cron/regulatory-change-scan');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Processing failed');
    });
  });
});
