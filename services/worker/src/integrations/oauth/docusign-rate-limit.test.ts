import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimDocusignAccountApiSlot,
  createDocusignRateLimitedFetch,
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

  it('does not let a Retry-After retry get blocked by the local slot counter', async () => {
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
  });
});
