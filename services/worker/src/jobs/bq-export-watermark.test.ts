/**
 * Watermark helper tests (SCRUM-1723 / SCRUM-1727 dependency).
 *
 * Each helper is a thin Supabase wrapper. Tests mock the db chain and assert:
 *   - the right table + columns + filters are sent
 *   - happy-path resolves with shaped data
 *   - DB errors throw with descriptive messages (so cron catches/logs them)
 *
 * Drives coverage for bq-export-watermark.ts to ~100%.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
vi.mock('../utils/db.js', () => ({ db: { from: (...args: unknown[]) => fromMock(...args) } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
  readWatermark,
} from './bq-export-watermark.js';

beforeEach(() => {
  fromMock.mockReset();
});

describe('readWatermark', () => {
  it('returns the row mapped onto the Watermark interface', async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        table_name: 'anchors',
        last_synced_at: '2026-05-07T10:00:00Z',
        last_synced_id: 'uuid-123',
        last_run_status: 'success',
        last_run_error: null,
      },
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ single });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const wm = await readWatermark('anchors');

    expect(fromMock).toHaveBeenCalledWith('bq_export_watermarks');
    expect(eq).toHaveBeenCalledWith('table_name', 'anchors');
    expect(wm.tableName).toBe('anchors');
    expect(wm.lastSyncedAt).toBe('2026-05-07T10:00:00Z');
    expect(wm.lastSyncedId).toBe('uuid-123');
    expect(wm.lastRunStatus).toBe('success');
    expect(wm.lastRunError).toBeNull();
  });

  it('throws when the row is missing', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });

    await expect(readWatermark('anchors')).rejects.toThrow(/missing or unreadable/);
  });

  it('throws on DB error', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection lost' } });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });

    await expect(readWatermark('audit_events')).rejects.toThrow(/connection lost/);
  });
});

describe('markRunStarted', () => {
  it('sets last_run_status=running and clears last_run_error', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    await markRunStarted('verifications');

    expect(update).toHaveBeenCalledWith({ last_run_status: 'running', last_run_error: null });
    expect(eq).toHaveBeenCalledWith('table_name', 'verifications');
  });

  it('throws on DB error', async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: 'unique violation' } });
    fromMock.mockReturnValue({ update: () => ({ eq }) });

    await expect(markRunStarted('anchors')).rejects.toThrow(/unique violation/);
  });
});

describe('markRunSucceeded', () => {
  it('advances watermark + clears error + sets status=success', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    await markRunSucceeded({
      tableName: 'audit_events',
      newWatermark: '2026-05-07T11:00:00Z',
      newLastId: 'last-uuid',
    });

    expect(update).toHaveBeenCalledWith({
      last_synced_at: '2026-05-07T11:00:00Z',
      last_synced_id: 'last-uuid',
      last_run_status: 'success',
      last_run_error: null,
    });
    expect(eq).toHaveBeenCalledWith('table_name', 'audit_events');
  });

  it('coerces undefined newLastId to null', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    await markRunSucceeded({ tableName: 'organizations', newWatermark: '2026-05-07T11:00:00Z' });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ last_synced_id: null }));
  });

  it('throws on DB error', async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: 'serialization failure' } });
    fromMock.mockReturnValue({ update: () => ({ eq }) });

    await expect(
      markRunSucceeded({ tableName: 'anchors', newWatermark: '2026-05-07T11:00:00Z' }),
    ).rejects.toThrow(/serialization failure/);
  });
});

describe('markRunFailed', () => {
  it('sets last_run_status=failed and captures error message (truncated to 4096)', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    const longErr = 'X'.repeat(5000);
    await markRunFailed('api_keys', longErr);

    expect(update).toHaveBeenCalledTimes(1);
    const updateCallArg = update.mock.calls[0][0];
    expect(updateCallArg.last_run_status).toBe('failed');
    expect(updateCallArg.last_run_error.length).toBe(4096);
  });

  it('does NOT throw when DB itself fails (best-effort path)', async () => {
    // markRunFailed is called inside other functions' catch blocks; if THAT
    // throws, the original error gets masked. So markRunFailed must not throw.
    const eq = vi.fn().mockResolvedValue({ error: { message: 'db unavailable' } });
    fromMock.mockReturnValue({ update: () => ({ eq }) });

    await expect(markRunFailed('anchors', 'original error')).resolves.toBeUndefined();
  });
});
