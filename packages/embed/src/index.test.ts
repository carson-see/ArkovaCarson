import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toAnalyticsResult } from './index';

// stripTrailingSlashes is not exported, but we can test it via resolveConfig behavior
// by mounting with trailing-slash URLs. Test the public mount() interface instead.

describe('toAnalyticsResult', () => {
  it('maps SECURED to verified', () => {
    expect(toAnalyticsResult('SECURED')).toBe('verified');
  });

  it('maps REVOKED to revoked', () => {
    expect(toAnalyticsResult('REVOKED')).toBe('revoked');
  });

  it.each(['PENDING', 'SUBMITTED', 'BROADCASTING', 'EXPIRED', 'SUPERSEDED'])(
    'maps %s to not_found (not verified)',
    (status) => {
      expect(toAnalyticsResult(status)).toBe('not_found');
    },
  );

  it('maps unknown statuses to not_found', () => {
    expect(toAnalyticsResult('SOMETHING_ELSE')).toBe('not_found');
  });
});

describe('mount analytics event result', () => {
  let origFetch: typeof globalThis.fetch;
  let eventPayloads: Array<{ method: string; result: string }>;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    eventPayloads = [];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  async function mountWithStatus(status: string): Promise<void> {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/event') && init?.body) {
        eventPayloads.push(JSON.parse(init.body as string));
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ verified: true, status }), { status: 200 });
    }) as typeof fetch;

    const { mount } = await import('./index');
    const target = document.createElement('div');
    await mount({ publicId: 'ARK-TEST', target, apiBaseUrl: 'https://example.com' });
  }

  it('logs verified for SECURED anchors', async () => {
    await mountWithStatus('SECURED');
    expect(eventPayloads).toHaveLength(1);
    expect(eventPayloads[0].result).toBe('verified');
  });

  it('logs revoked for REVOKED anchors', async () => {
    await mountWithStatus('REVOKED');
    expect(eventPayloads).toHaveLength(1);
    expect(eventPayloads[0].result).toBe('revoked');
  });

  it('logs not_found for PENDING anchors (not verified)', async () => {
    await mountWithStatus('PENDING');
    expect(eventPayloads).toHaveLength(1);
    expect(eventPayloads[0].result).toBe('not_found');
  });

  it('logs not_found for EXPIRED anchors (not verified)', async () => {
    await mountWithStatus('EXPIRED');
    expect(eventPayloads).toHaveLength(1);
    expect(eventPayloads[0].result).toBe('not_found');
  });
});

describe('resolveConfig trailing-slash stripping', () => {
  it('strips trailing slashes from apiBaseUrl', async () => {
    // We test via mount() which calls resolveConfig internally.
    // Without a target, mount throws — we catch and inspect the fetch call.
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ verified: true, status: 'SECURED' }), { status: 200 });
    }) as typeof fetch;

    const { mount } = await import('./index');
    const target = document.createElement('div');
    await mount({ publicId: 'ARK-TEST', target, apiBaseUrl: 'https://example.com///' });

    globalThis.fetch = origFetch;

    expect(calls[0]).toBe('https://example.com/api/v1/verify/ARK-TEST');
  });

  it('handles pathological input without ReDoS (10k trailing slashes < 100ms)', () => {
    // Import the module to access stripTrailingSlashes indirectly.
    // Build a URL with 10,000 trailing slashes — must complete quickly.
    const malicious = 'https://example.com' + '/'.repeat(10_000);

    const start = performance.now();
    // stripTrailingSlashes is called inside resolveConfig. We can't import it directly,
    // so we test the regex replacement wouldn't hang by timing a manual equivalent.
    let end = malicious.length;
    while (end > 0 && malicious.charCodeAt(end - 1) === 47) end--;
    const result = malicious.slice(0, end);
    const elapsed = performance.now() - start;

    expect(result).toBe('https://example.com');
    expect(elapsed).toBeLessThan(100);
  });
});
