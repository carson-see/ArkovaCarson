import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimDocusignAccountApiSlot,
  createDocusignRateLimitedFetch,
  DocusignRateLimitError,
  getDocusignAccountRateLimitStoreSizeForTests,
  resetDocusignAccountRateLimitStoreForTests,
} from './docusign-rate-limit.js';

describe('createDocusignRateLimitedFetch', () => {
  beforeEach(() => {
    resetDocusignAccountRateLimitStoreForTests();
  });

  it('honors Retry-After on DocuSign 429 responses before retrying', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const rateLimitedFetch = createDocusignRateLimitedFetch({
      accountId: 'account-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const response = await rateLimitedFetch('https://account-d.docusign.com/oauth/token', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('caps excessive Retry-After sleeps before retrying', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '3600' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const rateLimitedFetch = createDocusignRateLimitedFetch({
      accountId: 'account-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const response = await rateLimitedFetch('https://account-d.docusign.com/oauth/token', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('rejects non-replayable fetch inputs before attempting a retryable request', async () => {
    const fetchImpl = vi.fn();
    const rateLimitedFetch = createDocusignRateLimitedFetch({
      accountId: 'account-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(rateLimitedFetch(new Request('https://account-d.docusign.com/oauth/token'))).rejects
      .toThrow(/Request inputs/);
    await expect(rateLimitedFetch('https://account-d.docusign.com/oauth/token', {
      method: 'POST',
      body: new ReadableStream(),
    })).rejects.toThrow(/ReadableStream/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sweeps idle expired account entries while claiming fresh slots', () => {
    let nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    for (let i = 0; i < 255; i += 1) {
      claimDocusignAccountApiSlot({
        accountId: `stale-${i}`,
        now: () => new Date(nowMs),
      });
    }
    expect(getDocusignAccountRateLimitStoreSizeForTests()).toBe(255);

    nowMs += 60 * 60 * 1000;
    claimDocusignAccountApiSlot({
      accountId: 'fresh',
      now: () => new Date(nowMs),
    });

    expect(getDocusignAccountRateLimitStoreSizeForTests()).toBe(1);
  });

  it('reuses the original local slot reservation for a Retry-After retry', async () => {
    const accountId = 'account-boundary';
    const now = () => new Date('2026-05-28T12:00:00.000Z');
    for (let i = 0; i < 2_999; i += 1) {
      claimDocusignAccountApiSlot({ accountId, now });
    }
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const rateLimitedFetch = createDocusignRateLimitedFetch({
      accountId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
      sleep,
    });

    const response = await rateLimitedFetch('https://account-d.docusign.com/oauth/token', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(() => claimDocusignAccountApiSlot({ accountId, now })).toThrow(DocusignRateLimitError);
  });

  it('counts non-retried server errors against the local account budget', async () => {
    const accountId = 'account-server-error';
    const now = () => new Date('2026-05-28T12:00:00.000Z');
    for (let i = 0; i < 2_999; i += 1) {
      claimDocusignAccountApiSlot({ accountId, now });
    }
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const rateLimitedFetch = createDocusignRateLimitedFetch({
      accountId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });

    const response = await rateLimitedFetch('https://account-d.docusign.com/oauth/token', {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(() => claimDocusignAccountApiSlot({ accountId, now })).toThrow(DocusignRateLimitError);
  });
});
