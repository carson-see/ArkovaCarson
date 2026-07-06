/**
 * Tests for the OPS-03 SLO dashboard handler (SCRUM-2401).
 *
 * Pins: the platform-admin auth gate, the four SLO surfaces (queue
 * depth/flush, anchor SECURED rate, credit-ledger conservation, webhook
 * delivery), the breach flag derivation for each surface, and fail-open
 * per-surface error isolation (one surface's read failing must not blank
 * the other three — mirrors PipelineAdminPage's per-surface null pattern).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { isPlatformAdminMock } = vi.hoisted(() => ({ isPlatformAdminMock: vi.fn() }));

vi.mock('../utils/db.js', () => ({ db: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: isPlatformAdminMock }));

import { handleOpsSloStats } from './admin-ops-slo.js';
import { db } from '../utils/db.js';

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  return res;
}

/** Builds a chainable query-builder stub for `db.from(table)...`. */
function queryStub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.order = vi.fn(chain);
  // Every handler query terminates with `.limit(...)` — the sole resolving
  // method in this stub. If a future query drops `.limit`, add a thenable.
  builder.limit = vi.fn(() => Promise.resolve(result));
  return builder;
}

function mockFrom(byTable: Record<string, { data: unknown; error: unknown }>) {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    return queryStub(result);
  });
}

const anchorCountsHealthy = {
  PENDING: 5,
  SUBMITTED: 2,
  BROADCASTING: 1,
  SECURED: 992,
  REVOKED: 0,
  total: 1000,
};

const divergenceRowsClean = [
  { org_id: 'org-1', balance: 10, granted: 10, ledger_sum: 0, expected: 10, divergence: 0, diverged: false },
  { org_id: 'org-2', balance: 5, granted: 5, ledger_sum: 0, expected: 5, divergence: 0, diverged: false },
];

const divergenceRowsBreach = [
  { org_id: 'org-1', balance: 10, granted: 10, ledger_sum: 0, expected: 10, divergence: 0, diverged: false },
  { org_id: 'org-3', balance: 50, granted: 10, ledger_sum: 0, expected: 10, divergence: 40, diverged: true },
];

function mockRpcs(opts: {
  anchorCounts?: { data: unknown; error?: unknown };
  divergence?: { data: unknown; error?: unknown };
}) {
  (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'get_anchor_status_counts_fast') {
      return Promise.resolve(opts.anchorCounts ?? { data: anchorCountsHealthy, error: null });
    }
    if (name === 'org_credit_ledger_divergence') {
      return Promise.resolve(opts.divergence ?? { data: divergenceRowsClean, error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdminMock.mockReset();
});

describe('handleOpsSloStats — auth gate', () => {
  it('returns 403 when caller is not a platform admin', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(false);
    const res = mockRes();
    await handleOpsSloStats('user-1', {} as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden — platform admin access required' });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it('propagates isPlatformAdmin lookup errors', async () => {
    isPlatformAdminMock.mockRejectedValueOnce(new Error('lookup failed'));
    const res = mockRes();
    await expect(handleOpsSloStats('user-1', {} as Request, res)).rejects.toThrow('lookup failed');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('handleOpsSloStats — happy path (all healthy)', () => {
  it('returns 200 with all five surfaces populated and no breaches', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: {
        data: [
          { status: 'pending' }, { status: 'pending' },
          { status: 'anchored' }, { status: 'anchored' }, { status: 'anchored' },
          { status: 'failed' },
        ],
        error: null,
      },
      webhook_delivery_logs: {
        data: [
          { status: 'success' }, { status: 'success' }, { status: 'success' }, { status: 'success' },
          { status: 'success' }, { status: 'success' }, { status: 'success' }, { status: 'success' },
          { status: 'success' }, { status: 'failed' },
        ],
        error: null,
      },
      verification_events: {
        data: [
          { result: 'verified' }, { result: 'verified' }, { result: 'not_found' },
          { result: 'revoked' }, { result: 'error' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
        ],
        error: null,
      },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    expect(res.status).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];

    expect(payload.anchorSecuredRate.securedCount).toBe(992);
    expect(payload.anchorSecuredRate.totalCount).toBe(1000);
    expect(payload.anchorSecuredRate.available).toBe(true);
    expect(payload.anchorSecuredRate.breach).toBe(false);

    expect(payload.connectorQueue.available).toBe(true);
    expect(payload.connectorQueue.depth).toBe(2); // pending-ish (drainable) rows
    expect(payload.connectorQueue.anchored).toBe(3);
    expect(payload.connectorQueue.failed).toBe(1);
    expect(payload.connectorQueue.breach).toBe(false);

    expect(payload.creditConservation.available).toBe(true);
    expect(payload.creditConservation.orgsChecked).toBe(2);
    expect(payload.creditConservation.divergedCount).toBe(0);
    expect(payload.creditConservation.breach).toBe(false);

    expect(payload.webhookDelivery.available).toBe(true);
    expect(payload.webhookDelivery.successCount).toBe(9);
    expect(payload.webhookDelivery.totalCount).toBe(10);
    expect(payload.webhookDelivery.breach).toBe(false);

    // 1 'error' of 20 events = 5% error rate — at the healthy/breach boundary
    // threshold (breach is STRICTLY above 5%), so healthy here.
    expect(payload.apiErrors.available).toBe(true);
    expect(payload.apiErrors.errorCount).toBe(1);
    expect(payload.apiErrors.totalCount).toBe(20);
    expect(payload.apiErrors.breach).toBe(false);

    expect(payload.overallBreach).toBe(false);
    expect(typeof payload.checkedAt).toBe('string');
  });
});

describe('handleOpsSloStats — breach detection', () => {
  it('flags a credit-ledger divergence as a breach and sets overallBreach', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ divergence: { data: divergenceRowsBreach, error: null } });
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.creditConservation.available).toBe(true);
    expect(payload.creditConservation.divergedCount).toBe(1);
    expect(payload.creditConservation.breach).toBe(true);
    expect(payload.overallBreach).toBe(true);
    // PII-safe: no raw balance/divergence numbers, no bare org list beyond count
    expect(JSON.stringify(payload.creditConservation)).not.toMatch(/\b40\b/);
  });

  it('flags a low anchor SECURED rate as a breach', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      anchorCounts: {
        data: { PENDING: 400, SUBMITTED: 100, BROADCASTING: 0, SECURED: 500, REVOKED: 0, total: 1000 },
        error: null,
      },
    });
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.anchorSecuredRate.breach).toBe(true);
    expect(payload.overallBreach).toBe(true);
  });

  it('flags a low webhook delivery success rate as a breach', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: {
        data: [
          { status: 'failed' }, { status: 'failed' }, { status: 'failed' }, { status: 'success' },
        ],
        error: null,
      },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.webhookDelivery.breach).toBe(true);
    expect(payload.overallBreach).toBe(true);
  });

  it('flags a high verification API error rate as a breach', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
      verification_events: {
        // 2 errors of 10 = 20% error rate — well above the 5% threshold.
        data: [
          { result: 'error' }, { result: 'error' },
          { result: 'verified' }, { result: 'verified' }, { result: 'verified' },
          { result: 'verified' }, { result: 'not_found' }, { result: 'verified' },
          { result: 'verified' }, { result: 'revoked' },
        ],
        error: null,
      },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.apiErrors.available).toBe(true);
    expect(payload.apiErrors.errorCount).toBe(2);
    expect(payload.apiErrors.totalCount).toBe(10);
    expect(payload.apiErrors.breach).toBe(true);
    expect(payload.overallBreach).toBe(true);
  });
});

describe('handleOpsSloStats — per-surface fail-open isolation', () => {
  it('marks anchorSecuredRate unavailable on RPC error without blanking other surfaces', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ anchorCounts: { data: null, error: { message: 'timeout' } } });
    mockFrom({
      connector_artifact: { data: [{ status: 'pending' }], error: null },
      webhook_delivery_logs: { data: [{ status: 'success' }], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    expect(res.status).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.anchorSecuredRate.available).toBe(false);
    expect(payload.anchorSecuredRate.breach).toBe(false); // unknown != breach
    expect(payload.connectorQueue.available).toBe(true);
    expect(payload.webhookDelivery.available).toBe(true);
  });

  it('marks creditConservation unavailable when the divergence RPC throws', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts_fast') return Promise.resolve({ data: anchorCountsHealthy, error: null });
      if (name === 'org_credit_ledger_divergence') return Promise.reject(new Error('connection refused'));
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.creditConservation.available).toBe(false);
    expect(payload.creditConservation.breach).toBe(false);
    expect(payload.overallBreach).toBe(false);
  });

  it('marks connectorQueue unavailable on a select error', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: { data: null, error: { message: 'select failed' } },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.connectorQueue.available).toBe(false);
    expect(payload.connectorQueue.breach).toBe(false);
  });

  it('marks webhookDelivery unavailable on a select error', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: null, error: { message: 'select failed' } },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.webhookDelivery.available).toBe(false);
    expect(payload.webhookDelivery.breach).toBe(false);
  });

  it('marks apiErrors unavailable on a select error without blanking other surfaces', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({});
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
      verification_events: { data: null, error: { message: 'select failed' } },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.apiErrors.available).toBe(false);
    expect(payload.apiErrors.breach).toBe(false);
    expect(payload.webhookDelivery.available).toBe(true);
    expect(payload.creditConservation.available).toBe(true);
  });
});

describe('handleOpsSloStats — empty states', () => {
  it('reports zero-total surfaces as available, non-breaching (nothing to violate an SLO on)', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      anchorCounts: { data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 0, REVOKED: 0, total: 0 }, error: null },
      divergence: { data: [], error: null },
    });
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.anchorSecuredRate.totalCount).toBe(0);
    expect(payload.anchorSecuredRate.breach).toBe(false);
    expect(payload.webhookDelivery.totalCount).toBe(0);
    expect(payload.webhookDelivery.breach).toBe(false);
    expect(payload.creditConservation.orgsChecked).toBe(0);
    expect(payload.creditConservation.breach).toBe(false);
    expect(payload.apiErrors.totalCount).toBe(0);
    expect(payload.apiErrors.breach).toBe(false);
    expect(payload.overallBreach).toBe(false);
  });

  it('treats the -1 sentinel (cache not yet populated) as unavailable, not a breach', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      anchorCounts: {
        data: { PENDING: -1, SUBMITTED: -1, BROADCASTING: -1, SECURED: -1, REVOKED: -1, total: -1 },
        error: null,
      },
    });
    mockFrom({
      connector_artifact: { data: [], error: null },
      webhook_delivery_logs: { data: [], error: null },
    });

    const res = mockRes();
    await handleOpsSloStats('admin-1', {} as Request, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.anchorSecuredRate.available).toBe(false);
    expect(payload.anchorSecuredRate.breach).toBe(false);
  });
});
