/* eslint-disable arkova/no-unscoped-service-test -- Supabase Storage signing has no table query; the exact object path and private bucket are the scope. */
/* eslint-disable arkova/no-mock-echo -- Signed URL values identify first versus refreshed leases; call timing and replacement are the behavior under test. */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
}));

import {
  ProfileMediaImage,
  safeProfileMediaFallbackUrl,
  useProfileMediaUrl,
} from './ProfileMediaImage';

describe('profile media signing', () => {
  beforeEach(() => {
    vi.useRealTimers();
    createSignedUrl.mockReset();
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
});
