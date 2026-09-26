/* eslint-disable arkova/no-unscoped-service-test -- Supabase Storage signing has no table query; the exact object path and private bucket are the scope. */
/* eslint-disable arkova/no-mock-echo -- Signed URL values identify first versus refreshed leases; call timing and replacement are the behavior under test. */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSignedUrl = vi.hoisted(() => vi.fn());
const { authStateListeners, onAuthStateChange } = vi.hoisted(() => {
  const authStateListeners: Array<(event: string, session: unknown) => void> = [];
  const onAuthStateChange = vi.fn((cb: (event: string, session: unknown) => void) => {
    authStateListeners.push(cb);
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  return { authStateListeners, onAuthStateChange };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ createSignedUrl }) },
    auth: { onAuthStateChange },
  },
}));

/** Fires every registered `supabase.auth.onAuthStateChange` listener — stands
 * in for a real session/AAL change (sign-in, MFA step-up, token refresh). */
function fireAuthStateChange(event = 'TOKEN_REFRESHED') {
  for (const listener of authStateListeners) listener(event, null);
}

import {
  ProfileMediaImage,
  safeProfileMediaFallbackUrl,
  useProfileMediaUrl,
} from './ProfileMediaImage';

describe('profile media signing', () => {
  beforeEach(() => {
    vi.useRealTimers();
    createSignedUrl.mockReset();
    authStateListeners.length = 0;
    onAuthStateChange.mockClear();
  });

  it.each([
    ['https://cdn.example/avatar.png', 'https://cdn.example/avatar.png'],
    ['/legacy/avatar.png', '/legacy/avatar.png'],
    ['http://tracker.example/avatar.png', undefined],
    ['data:image/svg+xml,<svg/>', undefined],
    ['//tracker.example/avatar.png', undefined],
    ['/\\tracker.example/avatar.png', undefined],
    ['/legacy/\navatar.png', undefined],
  ])('bounds legacy fallback %s', (input, expected) => {
    expect(safeProfileMediaFallbackUrl(input)).toBe(expected);
  });

  it('falls back safely when signing rejects instead of leaking an unhandled rejection', async () => {
    createSignedUrl.mockRejectedValueOnce(new Error('network unavailable'));
    const { result } = renderHook(() => useProfileMediaUrl('users/person/avatar/a.png', 'https://cdn.example/legacy.png'));
    await waitFor(() => expect(createSignedUrl).toHaveBeenCalledTimes(1));
    expect(result.current).toBe('https://cdn.example/legacy.png');
  });

  it('refreshes a short-lived signed URL before its thirty-second expiry', async () => {
    vi.useFakeTimers();
    createSignedUrl
      .mockResolvedValueOnce({ data: { signedUrl: 'https://signed.example/one' }, error: null })
      .mockResolvedValueOnce({ data: { signedUrl: 'https://signed.example/two' }, error: null });
    const { result } = renderHook(() => useProfileMediaUrl('users/person/avatar/a.png'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe('https://signed.example/one');
    await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('https://signed.example/two');
  });

  it('clears the prior lease when a refresh rejects', async () => {
    vi.useFakeTimers();
    createSignedUrl
      .mockResolvedValueOnce({ data: { signedUrl: 'https://signed.example/one' }, error: null })
      .mockRejectedValueOnce(new Error('signing unavailable'));
    const { result } = renderHook(() => useProfileMediaUrl(
      'users/person/avatar/a.png', 'https://cdn.example/legacy.png',
    ));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe('https://signed.example/one');
    await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
    expect(result.current).toBe('https://cdn.example/legacy.png');
  });

  it('removes a broken image from rendering and preserves the caller error handler', async () => {
    const onError = vi.fn();
    render(<ProfileMediaImage fallbackUrl="https://cdn.example/broken.png" alt="Profile" onError={onError} />);
    screen.getByRole('img', { name: 'Profile' }).dispatchEvent(new Event('error', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Profile' })).not.toBeInTheDocument());
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // D4 (PR #3033 independent review, pass 2): the retry was a flat 5 s,
  // unconditional and forever — an AAL1 user looking at their own private media
  // polled Storage 12x/min per image indefinitely, including in a hidden tab.
  describe('signing retry', () => {
    const PATH = 'users/person/avatar/a.png';
    const FALLBACK = 'https://cdn.example/legacy.png';

    function setVisibility(state: 'visible' | 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    beforeEach(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    it('backs off exponentially up to a ceiling instead of retrying every five seconds', async () => {
      vi.useFakeTimers();
      createSignedUrl.mockResolvedValue({ data: null, error: { message: 'temporarily unavailable', status: 500 } });
      renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
      await act(async () => { await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
      // 5s, 10s, 20s, 40s, then the 60s ceiling.
      for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 60_000].entries()) {
        await act(async () => { vi.advanceTimersByTime(delay - 1); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(index + 1);
        await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(index + 2);
      }
    });

    it('gives up after a bounded number of consecutive failures and stays on the fallback absent a recovery signal', async () => {
      vi.useFakeTimers();
      createSignedUrl.mockResolvedValue({ data: null, error: { message: 'temporarily unavailable', status: 500 } });
      const { result } = renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
      await act(async () => { await Promise.resolve(); });
      for (let i = 0; i < 12; i += 1) {
        await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
      }
      expect(createSignedUrl.mock.calls.length).toBeLessThanOrEqual(6);
      expect(result.current).toBe(FALLBACK);
      const settled = createSignedUrl.mock.calls.length;
      // Time alone is still not a recovery signal — bounded means bounded.
      await act(async () => { vi.advanceTimersByTime(600_000); await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(settled);
    });

    // P2 review follow-up (PR #3033): a temporary outage exhausted the bounded
    // retries above, and the hook stayed on the fallback for the rest of the
    // session — scheduling AND the visibility handler both refused to sign
    // once stopped, and the effect depends only on `storagePath`, so nothing
    // short of a remount could recover. Reproduced: six offline failures ->
    // a subsequently-successful signing mock -> `online` event -> a visible-
    // tab event -> still no recovery. Fixed by resetting the circuit on a
    // meaningful recovery signal (`online`, tab becoming visible, or an
    // auth-state change) instead of latching permanently.
    describe('recovery after exhaustion (was: permanent — see P2 review follow-up)', () => {
      it('recovers when the browser comes back online after exhausting retries', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'temporarily unavailable', status: 500 } });
        const { result } = renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        for (let i = 0; i < 12; i += 1) {
          await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
        }
        const settled = createSignedUrl.mock.calls.length;
        expect(result.current).toBe(FALLBACK);

        createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/recovered' }, error: null });
        await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });

        expect(createSignedUrl.mock.calls.length).toBeGreaterThan(settled);
        expect(result.current).toBe('https://signed.example/recovered');
      });

      it('recovers when the tab becomes visible after exhausting retries', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'temporarily unavailable', status: 500 } });
        renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        for (let i = 0; i < 12; i += 1) {
          await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
        }
        const settled = createSignedUrl.mock.calls.length;

        createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/recovered' }, error: null });
        act(() => { setVisibility('hidden'); });
        await act(async () => { setVisibility('visible'); await Promise.resolve(); });

        expect(createSignedUrl.mock.calls.length).toBeGreaterThan(settled);
      });

      it('resumes bounded backoff (not unbounded polling) if recovery itself fails again', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'temporarily unavailable', status: 500 } });
        renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        for (let i = 0; i < 12; i += 1) {
          await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
        }
        const settled = createSignedUrl.mock.calls.length;

        // Recovery signal fires, but the object is still unavailable — must
        // not spin: it re-settles after another bounded run, not forever.
        await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
        for (let i = 0; i < 12; i += 1) {
          await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
        }
        const resettled = createSignedUrl.mock.calls.length;
        expect(resettled - settled).toBeLessThanOrEqual(6);

        await act(async () => { vi.advanceTimersByTime(600_000); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(resettled);
      });
    });

    describe('permission failures: reconsidered only on a session/AAL change, never continuous unauthorized polling', () => {
      it('stops immediately on a permission-style denial rather than backing off', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found', status: 403 } });
        renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(600_000); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);
      });

      it('does NOT retry on a plain online/visibility signal — that would be continuous unauthorized polling', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found', status: 403 } });
        renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);

        await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);

        act(() => { setVisibility('hidden'); });
        await act(async () => { setVisibility('visible'); await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);
      });

      it('reconsiders after a session/AAL change (sign-in, MFA step-up, token refresh)', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found', status: 403 } });
        renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        expect(createSignedUrl).toHaveBeenCalledTimes(1);

        createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/now-authorized' }, error: null });
        await act(async () => { fireAuthStateChange('MFA_CHALLENGE_VERIFIED'); await Promise.resolve(); });

        expect(createSignedUrl).toHaveBeenCalledTimes(2);
      });

      it('unsubscribes the auth-state listener on unmount', async () => {
        vi.useFakeTimers();
        createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/one' }, error: null });
        const { unmount } = renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
        await act(async () => { await Promise.resolve(); });
        expect(onAuthStateChange).toHaveBeenCalledTimes(1);
        const { unsubscribe } = onAuthStateChange.mock.results[0]!.value.data.subscription;
        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      });
    });

    it('does not poll while the tab is hidden and re-signs when it comes back', async () => {
      vi.useFakeTimers();
      createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/one' }, error: null });
      renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
      await act(async () => { await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
      act(() => { setVisibility('hidden'); });
      await act(async () => { vi.advanceTimersByTime(300_000); await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
      await act(async () => { setVisibility('visible'); await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('resets the backoff after a success', async () => {
      vi.useFakeTimers();
      createSignedUrl
        .mockResolvedValueOnce({ data: null, error: { message: 'unavailable', status: 500 } })
        .mockResolvedValueOnce({ data: null, error: { message: 'unavailable', status: 500 } })
        .mockResolvedValueOnce({ data: { signedUrl: 'https://signed.example/ok' }, error: null })
        .mockResolvedValue({ data: null, error: { message: 'unavailable', status: 500 } });
      const { result } = renderHook(() => useProfileMediaUrl(PATH, FALLBACK));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
      expect(result.current).toBe('https://signed.example/ok');
      // Healthy lease refresh is unchanged at 25s...
      await act(async () => { vi.advanceTimersByTime(25_000); await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(4);
      // ...and the next failure restarts the backoff at its base, not the ceiling.
      await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
      expect(createSignedUrl).toHaveBeenCalledTimes(5);
    });
  });

  // D7 (PR #3033 review): the hook's no-storage-path branch — the legacy
  // `avatar_url` / `logo_url` rows that predate UAT-14 — goes through the same
  // bounding as a rendered fallback, and signs nothing.
  describe('legacy fallback when no storage path is present', () => {
    beforeEach(() => { createSignedUrl.mockReset(); });

    it.each([
      ['https://cdn.example/legacy.png', 'https://cdn.example/legacy.png'],
      ['/legacy/avatar.png', '/legacy/avatar.png'],
      ['http://tracker.example/avatar.png', undefined],
      ['javascript:alert(1)', undefined],
      ['//tracker.example/avatar.png', undefined],
      [null, undefined],
    ])('bounds %s and never signs', (fallback, expected) => {
      const { result } = renderHook(() => useProfileMediaUrl(null, fallback));
      expect(result.current).toBe(expected);
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('falls back for an empty-string storage path rather than signing it', () => {
      const { result } = renderHook(() => useProfileMediaUrl('', 'https://cdn.example/legacy.png'));
      expect(result.current).toBe('https://cdn.example/legacy.png');
      expect(createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
