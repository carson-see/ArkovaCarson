/**
 * SCRUM-4983 review follow-up: ONE pinned-egress seam for every outbound
 * webhook socket (delivery, replay, verification ping, both test pings).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createSafeFetchImpl, SafeFetchError } from '../lib/safe-fetch.js';
import { __setWebhookFetchForTests, formatEgressFailure, webhookFetch } from './egress.js';

afterEach(() => __setWebhookFetchForTests(null));

describe('webhookFetch', () => {
  it('routes through the injected seam when one is set', async () => {
    const seam = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    __setWebhookFetchForTests(seam);
    const res = await webhookFetch('https://hooks.example.com/in', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(seam).toHaveBeenCalledWith('https://hooks.example.com/in', { method: 'POST' });
  });

  it('refuses a host that rebinds to the metadata IP without dispatching', async () => {
    const dispatch = vi.fn();
    __setWebhookFetchForTests(
      createSafeFetchImpl({ resolve: async () => ['169.254.169.254'], dispatch }),
    );
    await expect(webhookFetch('https://hooks.example.com/in', {})).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'private_target',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('formatEgressFailure', () => {
  it('marks a pinned-layer refusal permanent with a stable message', () => {
    expect(formatEgressFailure(new SafeFetchError('private_target', 'x'))).toEqual({
      permanent: true,
      code: 'private_target',
      message: 'egress_refused: private_target',
    });
  });

  it('passes transient errors through as retryable', () => {
    expect(formatEgressFailure(new Error('ECONNRESET'))).toEqual({
      permanent: false,
      code: null,
      message: 'ECONNRESET',
    });
    expect(formatEgressFailure('boom')).toEqual({ permanent: false, code: null, message: 'Unknown error' });
  });
});
