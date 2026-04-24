/**
 * Rollover job tests (SCRUM-1164)
 *
 * Mock the DB so we can force a mix of orgs that succeed, no-op, and error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(),
    rpc: vi.fn(),
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

import { db } from '../utils/db.js';
import { runAllocationRollover } from './monthly-allocation-rollover.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = db as any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_ALLOCATION_ROLLOVER;
});

function mockOpenPeriods(orgIds: string[]) {
  mockDb.from.mockImplementationOnce(() => ({
    select: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValueOnce({
      data: orgIds.map((id) => ({ org_id: id })),
      error: null,
    }),
  }));
}

describe('runAllocationRollover', () => {
  it('returns zero summary when disabled', async () => {
    process.env.ENABLE_ALLOCATION_ROLLOVER = 'false';
    const s = await runAllocationRollover();
    expect(s).toEqual({ total_orgs: 0, rolled: 0, skipped: 0, errors: 0 });
    expect(mockDb.from).not.toHaveBeenCalled();
  });

  it('returns summary with error flag when list query fails', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValueOnce({ data: null, error: { message: 'boom' } }),
    }));
    const s = await runAllocationRollover();
    expect(s.errors).toBe(1);
    expect(s.total_orgs).toBe(0);
  });

  it('deduplicates org ids before calling RPC', async () => {
    mockOpenPeriods(['a', 'a', 'b']);
    mockDb.rpc.mockResolvedValue({ data: { ok: true }, error: null });

    const s = await runAllocationRollover();
    expect(s.total_orgs).toBe(2);
    expect(mockDb.rpc).toHaveBeenCalledTimes(2);
  });

  it('counts rolled / skipped / errors correctly', async () => {
    mockOpenPeriods(['good', 'noop', 'bad']);
    mockDb.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: false, reason: 'no_current_period' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'rls' } });

    const s = await runAllocationRollover();
    expect(s.rolled).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.errors).toBe(1);
  });

  it('increments errors on thrown RPC', async () => {
    mockOpenPeriods(['throws']);
    mockDb.rpc.mockRejectedValueOnce(new Error('connection reset'));

    const s = await runAllocationRollover();
    expect(s.errors).toBe(1);
  });
});
