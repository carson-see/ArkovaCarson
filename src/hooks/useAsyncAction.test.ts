/**
 * useAsyncAction Hook Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAsyncAction } from './useAsyncAction';

describe('useAsyncAction', () => {
  it('starts with loading=false and no error', () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { result } = renderHook(() => useAsyncAction(fn));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets loading=true during execution', async () => {
    let resolve!: (v: string) => void;
    const fn = vi.fn().mockReturnValue(new Promise<string>((r) => { resolve = r; }));

    const { result } = renderHook(() => useAsyncAction(fn));

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.execute();
    });

    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolve('done');
      await promise!;
    });

    expect(result.current.loading).toBe(false);
  });

  it('returns the result from the async function', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const { result } = renderHook(() => useAsyncAction(fn));

    let returnValue: unknown;
    await act(async () => {
      returnValue = await result.current.execute();
    });

    expect(returnValue!).toBe(42);
  });

  it('captures error message when function throws Error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Something broke'));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('Something broke');
    expect(result.current.loading).toBe(false);
  });

  it('uses fallback error for non-Error throws', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    const { result } = renderHook(() => useAsyncAction(fn, 'Custom fallback'));

    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('Custom fallback');
  });

  it('clearError resets error to null', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      try { await result.current.execute(); } catch { /* expected */ }
    });

    expect(result.current.error).toBe('fail');

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('passes arguments through to the wrapped function', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.execute('arg1', 'arg2');
    });

    expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
  });
});
