/* eslint-disable arkova/no-unscoped-service-test -- audit_events writes use RLS via auth.uid() in the policy, not query-level user_id filter */
/**
 * Tests for HIPAA Session Timeout — REG-06 (SCRUM-565)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { signOut: vi.fn().mockResolvedValue({}) },
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

import { useIdleTimeout } from './useIdleTimeout';

describe('useIdleTimeout — REG-06', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is inactive when timeoutMinutes is 0', () => {
    const { result } = renderHook(() => useIdleTimeout({ timeoutMinutes: 0 }));
    expect(result.current.isActive).toBe(false);
    expect(result.current.isWarning).toBe(false);
  });

  it('is active when timeoutMinutes > 0', () => {
    const { result } = renderHook(() => useIdleTimeout({ timeoutMinutes: 15 }));
    expect(result.current.isActive).toBe(true);
    expect(result.current.minutesRemaining).toBe(15);
  });

  it('shows warning before timeout', () => {
    const { result } = renderHook(() =>
      useIdleTimeout({ timeoutMinutes: 15, warningMinutes: 2 })
    );

    // Advance to warning period (13 minutes + a bit)
    act(() => {
      vi.advanceTimersByTime(13 * 60 * 1000 + 10_000);
    });

    expect(result.current.isWarning).toBe(true);
    expect(result.current.minutesRemaining).toBeLessThanOrEqual(2);
  });

  it('resets timer on manual reset', () => {
    const { result } = renderHook(() => useIdleTimeout({ timeoutMinutes: 15 }));

    // Advance 10 minutes
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });

    // Reset
    act(() => {
      result.current.reset();
    });

    expect(result.current.isWarning).toBe(false);
    expect(result.current.minutesRemaining).toBe(15);
  });

  it('calls onTimeout callback when session expires', () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useIdleTimeout({ timeoutMinutes: 15, onTimeout })
    );

    // Advance past timeout
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000 + 10_000);
    });

    expect(onTimeout).toHaveBeenCalled();
  });

  it('default warning is 2 minutes before timeout', () => {
    const { result } = renderHook(() => useIdleTimeout({ timeoutMinutes: 5 }));

    // Advance 2.5 minutes (should not warn yet)
    act(() => {
      vi.advanceTimersByTime(2.5 * 60 * 1000 + 10_000);
    });
    expect(result.current.isWarning).toBe(false);

    // Advance to 3.5 minutes (should warn - 1.5 min remaining < 2 min warning)
    act(() => {
      vi.advanceTimersByTime(1 * 60 * 1000);
    });
    expect(result.current.isWarning).toBe(true);
  });
});
