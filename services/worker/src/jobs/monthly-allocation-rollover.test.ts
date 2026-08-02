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

const captureCreditRpcFailureAlert = vi.hoisted(() => vi.fn());
vi.mock('../utils/sentry.js', () => ({ captureCreditRpcFailureAlert }));

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

  // SCRUM-3050: this previously returned `{errors: 1}` and the route answered
  // HTTP 200 — a rollover that could not even enumerate the open periods
  // reporting success. On a monthly cadence that silence lasts until customers
  // notice missing credits, so it now fails loudly.
  it('THROWS when the list query fails (must not report success)', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValueOnce({ data: null, error: { message: 'boom' } }),
    }));
    await expect(runAllocationRollover()).rejects.toThrow(/could not enumerate/i);
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

  it('counts a thrown RPC as an error (and still completes other orgs)', async () => {
    mockOpenPeriods(['throws', 'good']);
    mockDb.rpc
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const s = await runAllocationRollover();
    expect(s.errors).toBe(1);
    expect(s.rolled).toBe(1);
  });

  it('alerts Sentry only for the errored org, not the rolled/skipped orgs (no fallback exists for this RPC)', async () => {
    mockOpenPeriods(['good', 'noop', 'bad']);
    mockDb.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: false, reason: 'no_current_period' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'rls' } });

    await runAllocationRollover();

    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'roll_over_monthly_allocation',
        failMode: 'closed',
        orgId: 'bad',
      }),
    );
  });

  it('increments errors on thrown RPC and alerts Sentry', async () => {
    // Two orgs, not one: with a single all-failing org this would hit the
    // SCRUM-3050 postcondition throw (see the describe block below) and never
    // return a summary to assert on. A mixed cohort keeps this test focused
    // on the Sentry-alert content for the thrown-RPC path specifically.
    mockOpenPeriods(['throws', 'good']);
    mockDb.rpc
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ data: { ok: true }, error: null });

    const s = await runAllocationRollover();
    expect(s.errors).toBe(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'roll_over_monthly_allocation',
        failMode: 'closed',
        orgId: 'throws',
        operation: 'monthly-allocation-rollover.runAllocationRollover.thrown',
      }),
    );
  });
});

// SCRUM-3050 — silent-failure hardening. The 70h anchoring outage shape was a
// handler that logged every per-unit error, continued, produced nothing, and
// answered HTTP 200. This job is the narrow, highest-risk application of the
// postcondition assertion: it touches billing and runs monthly, so a silent
// total failure has the worst detection latency in the fleet.
describe('runAllocationRollover postcondition (SCRUM-3050)', () => {
  it('THROWS when every org errored — a run that rolled nobody is not a success', async () => {
    mockOpenPeriods(['a', 'b', 'c']);
    mockDb.rpc.mockResolvedValue({ data: null, error: { message: 'rls' } });

    await expect(runAllocationRollover()).rejects.toThrow(
      /monthly-allocation-rollover.*completed 0/i,
    );
  });

  it('does NOT throw when there were no open periods (an idle month is legitimate)', async () => {
    mockOpenPeriods([]);
    const s = await runAllocationRollover();
    expect(s).toEqual({ total_orgs: 0, rolled: 0, skipped: 0, errors: 0 });
  });

  it('does NOT throw on partial failure — retrying would redo the orgs that rolled', async () => {
    mockOpenPeriods(['good', 'bad']);
    mockDb.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'rls' } });

    const s = await runAllocationRollover();
    expect(s.rolled).toBe(1);
    expect(s.errors).toBe(1);
  });

  it('treats a fully SKIPPED run as success — a no-op period is completed work, not a failure', async () => {
    mockOpenPeriods(['a', 'b']);
    mockDb.rpc.mockResolvedValue({ data: { ok: false, reason: 'no_current_period' }, error: null });

    const s = await runAllocationRollover();
    expect(s.skipped).toBe(2);
    expect(s.errors).toBe(0);
  });
});
