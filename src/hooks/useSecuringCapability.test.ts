import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const { mockWorkerFetch } = vi.hoisted(() => ({ mockWorkerFetch: vi.fn() }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'test-user-id' }, loading: false }) }));
vi.mock('@/lib/workerClient', () => ({ workerFetch: mockWorkerFetch }));

import { useSecuringCapability } from './useSecuringCapability';

describe('useSecuringCapability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => ({
      canSecureInstantly: true, creditBalance: 7, instantSecureCost: 1,
      scope: 'organization', canPurchase: false, purchaseGuidance: 'Ask an organization administrator to purchase credits.',
    }) });
  });

  it('uses the trusted server capability and exact credit pool', async () => {
    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.capability).toEqual(expect.objectContaining({ canSecureInstantly: true, creditBalance: 7, scope: 'organization' }));
  });

  it('fails closed until the server responds', () => {
    mockWorkerFetch.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });
    expect(result.current.capability.canSecureInstantly).toBe(false);
    expect(result.current.capability.instantSecureCost).toBe(1);
  });

  it.each([
    {},
    { canSecureInstantly: true, creditBalance: -1, instantSecureCost: 1, scope: 'user', canPurchase: true, purchaseGuidance: null },
    { canSecureInstantly: true, creditBalance: 2, instantSecureCost: 0, scope: 'user', canPurchase: true, purchaseGuidance: null },
    { canSecureInstantly: true, creditBalance: 2, instantSecureCost: 1, scope: 'parent', canPurchase: true, purchaseGuidance: null },
  ])('fails closed when a successful response is malformed (%j)', async (payload) => {
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => payload });
    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.capability.canSecureInstantly).toBe(false);
    expect(result.current.capability.canPurchase).toBe(false);
    expect(result.current.error).toBe('Could not load instant secure availability');
  });

  it('fails closed and exposes a recoverable error when the endpoint is unavailable', async () => {
    mockWorkerFetch.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.capability.canSecureInstantly).toBe(false);
    expect(result.current.error).toBe('Could not load instant secure availability');
  });
});
