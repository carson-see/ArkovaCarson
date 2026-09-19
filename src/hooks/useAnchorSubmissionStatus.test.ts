import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const { workerFetch } = vi.hoisted(() => ({ workerFetch: vi.fn() }));
vi.mock('@/lib/workerClient', () => ({ workerFetch }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));

import { useAnchorSubmissionStatus } from './useAnchorSubmissionStatus';

describe('useAnchorSubmissionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerFetch.mockResolvedValue({ ok: true, json: async () => ({
      public_id: 'ARK-1', action: 'instant', anchor_status: 'PENDING',
      credit_state: 'pending', instant_status: 'NEEDS_CREDIT', retryable: true,
      updated_at: '2026-09-19T12:00:00Z',
    }) });
  });

  it('uses the explicit personal scope and parses the durable status', async () => {
    const { result } = renderHook(() => useAnchorSubmissionStatus('ARK-1', null), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.status?.instantStatus).toBe('NEEDS_CREDIT'));
    expect(workerFetch).toHaveBeenCalledWith('/api/v1/anchor-self-service/ARK-1/submission-status?scope=user');
    expect(result.current.status?.retryable).toBe(true);
  });

  it('uses the exact selected organization scope', async () => {
    renderHook(() => useAnchorSubmissionStatus('ARK-1', 'child-org'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(workerFetch).toHaveBeenCalled());
    expect(workerFetch).toHaveBeenCalledWith('/api/v1/anchor-self-service/ARK-1/submission-status?org_id=child-org');
  });

  it('fails closed on malformed successful payloads', async () => {
    workerFetch.mockResolvedValue({ ok: true, json: async () => ({ instant_status: 'MADE_UP' }) });
    const { result } = renderHook(() => useAnchorSubmissionStatus('ARK-1', null), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('Could not load securing status');
    expect(result.current.status).toBeNull();
  });
});
