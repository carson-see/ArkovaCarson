/**
 * useTheme Hook Tests (MVP-12 / AUDIT-12)
 *
 * Tests the hook's state management and theme resolution logic.
 * localStorage interaction is tested implicitly — the hook has try/catch guards
 * that gracefully handle unavailable localStorage in test environments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

describe('useTheme', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock matchMedia — return false for dark preference (= light system theme)
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('defaults to system theme', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
  });

  it('setTheme changes to dark', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('setTheme changes to light', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme('light');
    });

    expect(result.current.theme).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('resolvedTheme returns light or dark, never system', () => {
    const { result } = renderHook(() => useTheme());
    // When theme is 'system', resolvedTheme should be the actual resolved value
    expect(['light', 'dark']).toContain(result.current.resolvedTheme);
  });

  it('system theme resolves based on matchMedia', () => {
    // matchMedia returns false for dark → system resolves to light
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe('light');
  });
});
