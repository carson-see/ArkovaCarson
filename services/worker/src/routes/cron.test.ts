/**
 * Tests for Cron Job HTTP Routes (GAP-02)
 *
 * Covers:
 *   - verifyCronAuth: CRON_SECRET, OIDC, platform admin token, rejection
 *   - cronAuth middleware: 401 when unauthenticated
 *   - Route handlers: success + error (500) paths for representative endpoints
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const mockFetchUsptoPAtents = vi.fn().mockResolvedValue(undefined);
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

// ─── Import after mocks ───
import { cronRouter } from './cron.js';
import { config } from '../config.js';
import { verifyAuthToken } from '../auth.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { callRpc } from '../utils/rpc.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/cron', cronRouter);
  return app;
}

describe('cron routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: development mode (auth bypassed)
    (config as { nodeEnv: string }).nodeEnv = 'development';
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
      expect(res.body).toEqual({ status: 'complete' });
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
    it('returns refreshed status', async () => {
      (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null });
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'refreshed' });
    });

    it('returns 500 on RPC failure', async () => {
      (callRpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const app = createApp();
      const res = await request(app).post('/cron/refresh-stats');
      expect(res.status).toBe(500);
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
});
