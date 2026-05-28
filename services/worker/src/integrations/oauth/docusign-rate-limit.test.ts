import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
});
