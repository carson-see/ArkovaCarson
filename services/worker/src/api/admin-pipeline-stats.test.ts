/**
 * Tests for admin-pipeline-stats handler.
 *
 * SCRUM-1545 (R4-4-FU): pulls this previously-untested file up to the
 * recovery-epic coverage floor. Pins the auth gate, RPC happy path, the
 * 503 short-circuit on RPC failure (per SCRUM-1259's no-fanout decision),
 * legacy field-name back-compat, and the source breakdown shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { isPlatformAdminMock } = vi.hoisted(() => ({ isPlatformAdminMock: vi.fn() }));

vi.mock('../utils/db.js', () => ({ db: { rpc: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: isPlatformAdminMock }));

import { handlePipelineStats } from './admin-pipeline-stats.js';
import { db } from '../utils/db.js';

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  return res;
}

const fullRpcRow = {
  total_records: 2_950_000,
  anchor_linked_records: 1_200_000,
  pending_record_links: 50_000,
  pending_anchor_records: 1_000,
  broadcasting_records: 0,
  submitted_records: 200,
  secured_records: 1_000_000,
  bitcoin_anchored_records: 1_200_000,
  pending_bitcoin_records: 1_700_000,
  embedded_records: 2_500_000,
  cache_updated_at: '2026-05-04T00:00:00Z',
};

function mockRpcs(opts: {
  pipeline?: { data: Record<string, unknown> | null; error?: unknown };
  source?: { data: Array<{ source: string; count: number }> | null };
  pipelineRejects?: unknown;
}) {
  (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'get_pipeline_stats') {
      if (opts.pipelineRejects !== undefined) return Promise.reject(opts.pipelineRejects);
      return Promise.resolve(opts.pipeline ?? { data: fullRpcRow, error: null });
    }
    if (name === 'count_public_records_by_source') {
      return Promise.resolve(opts.source ?? { data: [], error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdminMock.mockReset();
});

describe('handlePipelineStats — auth gate', () => {
  it('returns 403 when caller is not a platform admin', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(false);
    const res = mockRes();
    await handlePipelineStats('user-1', {} as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden — platform admin access required' });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('propagates isPlatformAdmin lookup errors (Express error handler responsibility)', async () => {
    isPlatformAdminMock.mockRejectedValueOnce(new Error('lookup failed'));
    const res = mockRes();
    await expect(handlePipelineStats('user-1', {} as Request, res)).rejects.toThrow('lookup failed');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('handlePipelineStats — RPC happy path', () => {
  it('maps all fields from get_pipeline_stats + count_public_records_by_source', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      source: {
        data: [
          { source: 'sec_iapd', count: 12_345 },
          { source: 'edgar', count: 678 },
        ],
      },
    });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    expect(res.status).not.toHaveBeenCalled();
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.totalRecords).toBe(2_950_000);
    expect(payload.anchoredRecords).toBe(1_200_000);
    expect(payload.pendingRecords).toBe(1_700_000);
    expect(payload.embeddedRecords).toBe(2_500_000);
    expect(payload.anchorLinkedRecords).toBe(1_200_000);
    expect(payload.pendingRecordLinks).toBe(50_000);
    expect(payload.broadcastingRecords).toBe(0);
    expect(payload.submittedRecords).toBe(200);
    expect(payload.securedRecords).toBe(1_000_000);
    expect(payload.cacheUpdatedAt).toBe('2026-05-04T00:00:00Z');
    expect(payload.bySource).toEqual({ sec_iapd: 12_345, edgar: 678 });
  });

  it('falls back to legacy field names (anchored_records / pending_records) when modern keys are absent', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      pipeline: {
        data: {
          total_records: 100,
          anchored_records: 60,
          pending_records: 40,
          embedded_records: 80,
        },
        error: null,
      },
    });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.anchoredRecords).toBe(60);
    expect(payload.pendingRecords).toBe(40);
    expect(payload.anchorLinkedRecords).toBe(60);
  });

  it('returns 200 with empty bySource when source-breakdown RPC errors', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({
      source: { data: null },
    });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.bySource).toEqual({});
    expect(payload.totalRecords).toBe(2_950_000);
  });
});

describe('handlePipelineStats — RPC fail closed (SCRUM-1259)', () => {
  it('returns 503 when get_pipeline_stats data is null', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ pipeline: { data: null, error: null } });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Pipeline stats temporarily unavailable' }),
    );
  });

  it('returns 503 when get_pipeline_stats returns an error', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ pipeline: { data: null, error: { message: 'rpc broke' } } });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 when get_pipeline_stats Promise rejects (transport-level)', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ pipelineRejects: new Error('connection refused') });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('does not fan out exact-count fallback queries when RPC fails (SCRUM-1259 invariant)', async () => {
    isPlatformAdminMock.mockResolvedValueOnce(true);
    mockRpcs({ pipeline: { data: null, error: null } });
    const res = mockRes();
    await handlePipelineStats('admin-1', {} as Request, res);
    // Exactly the two RPC calls — no fallback fan-out.
    expect((db.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual([
      'count_public_records_by_source',
      'get_pipeline_stats',
    ]);
  });
});
