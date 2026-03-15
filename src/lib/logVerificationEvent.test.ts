/**
 * Verification Event Logger Tests
 *
 * @see P6-TS-06
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}));

import { logVerificationEvent } from './logVerificationEvent';

describe('logVerificationEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls log_verification_event RPC with correct params', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await logVerificationEvent({
      publicId: 'pub-123',
      method: 'web',
      result: 'verified',
      fingerprintProvided: true,
    });

    expect(mockRpc).toHaveBeenCalledWith('log_verification_event',
      expect.objectContaining({
        p_public_id: 'pub-123',
        p_method: 'web',
        p_result: 'verified',
        p_fingerprint_provided: true,
      }),
    );
  });

  it('defaults fingerprintProvided to false', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await logVerificationEvent({
      publicId: 'pub-456',
      method: 'api',
      result: 'not_found',
    });

    expect(mockRpc).toHaveBeenCalledWith('log_verification_event',
      expect.objectContaining({ p_fingerprint_provided: false }),
    );
  });

  it('never throws even when RPC fails', async () => {
    mockRpc.mockRejectedValue(new Error('RPC down'));

    await expect(
      logVerificationEvent({
        publicId: 'pub-789',
        method: 'qr',
        result: 'error',
      }),
    ).resolves.toBeUndefined();
  });
});
