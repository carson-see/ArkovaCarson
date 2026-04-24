/**
 * Payment grace expiry sweep tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallRpc, mockLogger } = vi.hoisted(() => {
  const mockCallRpc = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockCallRpc, mockLogger };
});

vi.mock('../utils/db.js', () => ({
  db: { rpc: vi.fn() },
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: mockCallRpc,
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

import { db } from '../utils/db.js';
import { GRACE_EXPIRY_SWEEP_CRON, runGraceExpirySweep } from './grace-expiry-sweep.js';

describe('runGraceExpirySweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallRpc.mockResolvedValue({ data: 0, error: null });
  });

  it('uses the 15-minute cron cadence', () => {
    expect(GRACE_EXPIRY_SWEEP_CRON).toBe('*/15 * * * *');
  });

  it('calls expire_payment_grace_if_due and returns expired count', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: 4, error: null });
    const result = await runGraceExpirySweep();
    expect(result).toEqual({ expired: 4 });
    expect(mockCallRpc).toHaveBeenCalledWith(db, 'expire_payment_grace_if_due');
  });

  it('normalizes null RPC data to zero', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(runGraceExpirySweep()).resolves.toEqual({ expired: 0 });
  });

  it('returns zero and logs on RPC error', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(runGraceExpirySweep()).resolves.toEqual({ expired: 0 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: { message: 'rpc failed' } }),
      'Payment grace expiry sweep RPC failed',
    );
  });

  it('returns zero and logs when RPC throws', async () => {
    const error = new Error('network');
    mockCallRpc.mockRejectedValueOnce(error);
    await expect(runGraceExpirySweep()).resolves.toEqual({ expired: 0 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
      'Payment grace expiry sweep failed',
    );
  });
});
