/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
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

  // SAFE-BY-DEFAULT (VITE_WORKER_URL incident): without an `isSafeError`
  // predicate, NO thrown error's `.message` is trusted — not even a plain
  // `Error`. Previously every `Error` was trusted by default, which is
  // exactly what let `useInviteMember` risk leaking `resolveWorkerBaseUrl`'s
  // internal config text into `error` state the moment a future caller
  // wired it into UI. See useAsyncAction.ts's isSafeError doc.
  it('falls back to fallbackError for a plain Error when no isSafeError predicate is given (new safe default)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Something broke'));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('An unexpected error occurred');
    expect(result.current.error).not.toBe('Something broke');
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

  // Explicit reproduction of the reviewed finding: a curated error type must
  // still surface its message verbatim; a non-curated Error must not, even
  // though both are `instanceof Error`.
  describe('isSafeError predicate (curated vs non-curated errors)', () => {
    class CuratedError extends Error {}

    it('a non-curated Error thrown inside execute() leaves error set to the fallback, never the raw message', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('internal config detail: VITE_WORKER_URL is unset'));
      const isSafeError = (err: unknown): err is CuratedError => err instanceof CuratedError;
      const { result } = renderHook(() => useAsyncAction(fn, 'Generic failure', isSafeError));

      await act(async () => {
        try { await result.current.execute(); } catch { /* expected */ }
      });

      expect(result.current.error).toBe('Generic failure');
      expect(result.current.error).not.toContain('VITE_WORKER_URL');
    });

    it('a curated error still surfaces its message verbatim', async () => {
      const fn = vi.fn().mockRejectedValue(new CuratedError('This person is already a member.'));
      const isSafeError = (err: unknown): err is CuratedError => err instanceof CuratedError;
      const { result } = renderHook(() => useAsyncAction(fn, 'Generic failure', isSafeError));

      await act(async () => {
        try { await result.current.execute(); } catch { /* expected */ }
      });

      expect(result.current.error).toBe('This person is already a member.');
    });

    it('restores the old blanket-trust behavior when isSafeError accepts every Error (opt-in, e.g. useRevokeAnchor)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Cannot revoke a record under legal hold.'));
      const trustAllErrors = (err: unknown): err is Error => err instanceof Error;
      const { result } = renderHook(() => useAsyncAction(fn, 'Generic failure', trustAllErrors));

      await act(async () => {
        try { await result.current.execute(); } catch { /* expected */ }
      });

      expect(result.current.error).toBe('Cannot revoke a record under legal hold.');
    });
  });

  it('clearError resets error to null', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      try { await result.current.execute(); } catch { /* expected */ }
    });

    expect(result.current.error).not.toBeNull();

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
