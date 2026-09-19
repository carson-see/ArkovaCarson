/**
 * SCRUM-5023 — `extendKey` request shape.
 *
 * The PATCH body is the part that can silently be wrong. ONE field carries the
 * intent: `expires_in_days` is a duration applied from the SERVER's clock, and
 * `null` removes the expiry. A non-null `expires_at` is refused by the worker
 * precisely so a client cannot write a past expiry from its own clock, so a
 * hook that sent `{ expires_at: <iso> }` would 400 on every call — and none of
 * that is visible from a component test that only asserts the callback fired.
 *
 * `allow_shorten` is the other half: `expires_in_days` REPLACES the expiry, so
 * without the flag the worker 409s any value earlier than the current one. A
 * hook that never sent it would make the confirmed "yes, shorten it" path fail
 * every time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, signOut: vi.fn() }),
}));

const workerFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workerClient', () => ({ workerFetch }));

import { useApiKeys } from './useApiKeys';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function okResponse(body: unknown = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  workerFetch.mockResolvedValue(okResponse({ keys: [] }));
});

describe('extendKey', () => {
  it('PATCHes a duration, never a timestamp', async () => {
    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await act(async () => {
      await result.current.extendKey('key-1', 90);
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path).includes('/keys/key-1'));
    expect(call).toBeDefined();
    expect(call![1].method).toBe('PATCH');

    const body = JSON.parse(call![1].body);
    expect(body).toEqual({ expires_in_days: 90 });
    // A client-supplied timestamp is exactly what the worker refuses.
    expect(body.expires_at).toBeUndefined();
  });

  it('clears the expiry with expires_in_days: null, never a timestamp field', async () => {
    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await act(async () => {
      await result.current.extendKey('key-1', null);
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path).includes('/keys/key-1'));
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({ expires_in_days: null });
    expect('expires_at' in body).toBe(false);
  });

  it('omits allow_shorten unless the caller asked for it', async () => {
    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await act(async () => {
      await result.current.extendKey('key-1', 30);
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path).includes('/keys/key-1'));
    expect('allow_shorten' in JSON.parse(call![1].body)).toBe(false);
  });

  it('sends allow_shorten when the caller confirmed a shortening', async () => {
    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await act(async () => {
      await result.current.extendKey('key-1', 30, true);
    });

    const call = workerFetch.mock.calls.find(([path]) => String(path).includes('/keys/key-1'));
    expect(JSON.parse(call![1].body)).toEqual({ expires_in_days: 30, allow_shorten: true });
  });

  it('throws on a non-OK response so the caller can keep its dialog open', async () => {
    workerFetch.mockResolvedValueOnce(okResponse({ keys: [] }));
    workerFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'api_key_already_revoked' }),
    });

    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await expect(
      act(async () => { await result.current.extendKey('key-1', 30); }),
    ).rejects.toThrow();
  });
});
