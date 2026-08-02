/**
 * Credit Expiry Job Tests
 *
 * @see MVP-25
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockRpc = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

const captureCreditRpcFailureAlert = vi.hoisted(() => vi.fn());
vi.mock('../utils/sentry.js', () => ({ captureCreditRpcFailureAlert }));

import { processMonthlyCredits } from './credit-expiry.js';

describe('processMonthlyCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns count of processed users', async () => {
    mockRpc.mockResolvedValue({ data: 5, error: null });

    const result = await processMonthlyCredits();

    expect(result).toBe(5);
    expect(mockRpc).toHaveBeenCalledWith('allocate_monthly_credits', undefined);
    // Happy path — no alert.
    expect(captureCreditRpcFailureAlert).not.toHaveBeenCalled();
  });

  it('returns 0 on RPC error and alerts Sentry (no fallback exists for this RPC)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC failed' } });

    const result = await processMonthlyCredits();

    expect(result).toBe(0);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'allocate_monthly_credits',
        failMode: 'closed',
      }),
    );
  });

  it('returns 0 when no users need processing', async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });

    const result = await processMonthlyCredits();

    expect(result).toBe(0);
    expect(captureCreditRpcFailureAlert).not.toHaveBeenCalled();
  });

  it('handles thrown errors and alerts Sentry', async () => {
    mockRpc.mockRejectedValue(new Error('Network error'));

    const result = await processMonthlyCredits();

    expect(result).toBe(0);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'allocate_monthly_credits',
        failMode: 'closed',
      }),
    );
  });
});
