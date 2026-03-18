/**
 * useAnchorStatusToast Tests (BETA-13)
 *
 * Tests that status change toast notifications fire when
 * anchor status transitions via realtime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAnchorStatusToast } from './useAnchorStatusToast';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { toast } from 'sonner';

describe('useAnchorStatusToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fire toast on initial render', () => {
    renderHook(() => useAnchorStatusToast('PENDING'));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('fires success toast on PENDING → SECURED transition', () => {
    const { rerender } = renderHook(
      ({ status }) => useAnchorStatusToast(status),
      { initialProps: { status: 'PENDING' as string } },
    );

    rerender({ status: 'SECURED' });

    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/secured/i),
    );
  });

  it('fires success toast on SUBMITTED → SECURED transition', () => {
    const { rerender } = renderHook(
      ({ status }) => useAnchorStatusToast(status),
      { initialProps: { status: 'SUBMITTED' as string } },
    );

    rerender({ status: 'SECURED' });

    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/secured/i),
    );
  });

  it('fires error toast on SECURED → REVOKED transition', () => {
    const { rerender } = renderHook(
      ({ status }) => useAnchorStatusToast(status),
      { initialProps: { status: 'SECURED' as string } },
    );

    rerender({ status: 'REVOKED' });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/revoked/i),
    );
  });

  it('does not fire toast when status stays the same', () => {
    const { rerender } = renderHook(
      ({ status }) => useAnchorStatusToast(status),
      { initialProps: { status: 'SECURED' as string } },
    );

    rerender({ status: 'SECURED' });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not fire toast when status is undefined', () => {
    renderHook(() => useAnchorStatusToast(undefined));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
