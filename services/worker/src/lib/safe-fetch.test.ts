/**
 * SCRUM-2483 — safeFetch IP-pinned egress primitive.
 *
 * RED-first tests (TDD §0.1). These cover the four adversary scenarios the
 * primitive must defeat, driven entirely through injected seams so no real
 * network or DNS is touched:
 *
 *   (a) DNS-rebind: the resolver returns a PUBLIC IP at resolve-time, then a
 *       PRIVATE/link-local IP if it were re-resolved at connect-time. safeFetch
 *       must PIN the resolve-time IP and CONNECT only to it — so a rebind flip
 *       cannot reach the private target. We assert the connect target equals the
 *       exact validated IP, never a re-resolution.
 *   (b) Redirect (3xx Location) to a private IP must be REFUSED per-hop: every
 *       hop is re-validated against the guard before it is followed.
 *   (c) A direct hit on 169.254.169.254 (cloud metadata) is REFUSED.
 *   (d) A legitimate public host is ALLOWED and its body returned.
 *
 * The primitive takes injectable deps:
 *   - resolve(host): Promise<string[]>  — DNS A/AAAA resolution
 *   - dispatch(pinnedIp, url, init): Promise<SafeFetchResponse> — performs the
 *     actual connect to the PINNED ip (in prod: an undici Agent whose connect
 *     forces the resolved ip; in tests: a stub that records the pinned ip).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  safeFetch,
  safeFetchSingleHop,
  createSafeFetchImpl,
  SafeFetchError,
  type SafeFetchDeps,
  type SafeFetchResponse,
} from './safe-fetch.js';

function stubResponse(overrides: Partial<SafeFetchResponse> = {}): SafeFetchResponse {
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    url: 'https://public.example.com/',
    async arrayBuffer() {
      return new TextEncoder().encode('{"ok":true}').buffer;
    },
    ...overrides,
  };
}

describe('safeFetch (SCRUM-2483 IP-pinned egress primitive)', () => {
  it('(a) DNS-rebind: pins the resolve-time IP and connects ONLY to it', async () => {
    // Resolver returns a public IP at resolve time. A naive fetch would
    // re-resolve at connect and could get 169.254.169.254 (the rebind). The
    // primitive must pass the ALREADY-VALIDATED public ip to dispatch and
    // never re-resolve.
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async (pinnedIp: string) => {
      // Fail the test loudly if the primitive ever hands dispatch a private ip.
      expect(pinnedIp).toBe('203.0.113.10');
      return stubResponse();
    });
    const deps: SafeFetchDeps = { resolve, dispatch };

    const res = await safeFetch('https://rebind.example.com/creds', {}, deps);

    expect(res.status).toBe(200);
    // resolve happened once (resolve-time), dispatch pinned exactly that ip.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toBe('203.0.113.10');
  });

  it('(a2) DNS-rebind: if resolve yields ANY private ip, REFUSE before dispatch', async () => {
    // Multi-record answer where one record is the rebind target. Must fail
    // closed and never dispatch.
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10', '169.254.169.254']);
    const dispatch = vi.fn(async () => stubResponse());
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(safeFetch('https://rebind.example.com/', {}, deps)).rejects.toMatchObject({
      code: 'private_target',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('(b) redirect to a private IP is REFUSED per-hop', async () => {
    // First hop: public host, 302 -> http://169.254.169.254/. The second hop
    // target must be re-validated and rejected.
    const resolve = vi.fn(async (host: string) => {
      if (host === 'public.example.com') return ['203.0.113.10'];
      if (host === '169.254.169.254') return ['169.254.169.254'];
      throw new Error(`unexpected host ${host}`);
    });
    const dispatch = vi.fn(async () =>
      stubResponse({
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      }),
    );
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('https://public.example.com/redirect', {}, deps),
    ).rejects.toMatchObject({ code: 'private_target' });

    // Only the first hop was dispatched; the private redirect target was
    // never connected to.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('(c) a direct hit on 169.254.169.254 metadata is REFUSED', async () => {
    const resolve = vi.fn().mockResolvedValue(['169.254.169.254']);
    const dispatch = vi.fn(async () => stubResponse());
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/', {}, deps),
    ).rejects.toMatchObject({ code: 'private_target' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('(d) a legitimate public host is ALLOWED and returns the body', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () => stubResponse());
    const deps: SafeFetchDeps = { resolve, dispatch };

    const res = await safeFetch('https://public.example.com/creds', {}, deps);
    const body = Buffer.from(await res.arrayBuffer()).toString('utf8');

    expect(res.status).toBe(200);
    expect(body).toBe('{"ok":true}');
  });

  it('rejects non-http(s) schemes without resolving', async () => {
    const resolve = vi.fn();
    const dispatch = vi.fn();
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(safeFetch('file:///etc/passwd', {}, deps)).rejects.toMatchObject({
      code: 'scheme_not_allowed',
    });
    await expect(safeFetch('gopher://x/', {}, deps)).rejects.toMatchObject({
      code: 'scheme_not_allowed',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('enforces the max-redirect depth', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    // Always redirect to another public host -> depth exhaustion.
    let hop = 0;
    const dispatch = vi.fn(async () => {
      hop += 1;
      return stubResponse({
        status: 302,
        headers: new Headers({ location: `https://public.example.com/hop${hop}` }),
      });
    });
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('https://public.example.com/', {}, deps, { maxRedirects: 2 }),
    ).rejects.toMatchObject({ code: 'too_many_redirects' });
    // initial + 2 redirects = 3 dispatches, then refuse the 4th.
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('re-validates a redirect hop that flips to a private host mid-chain', async () => {
    const resolve = vi.fn(async (host: string) => {
      if (host === 'a.example.com') return ['203.0.113.10'];
      if (host === 'b.example.com') return ['10.0.0.5']; // private after resolve
      throw new Error(`unexpected host ${host}`);
    });
    const dispatch = vi.fn(async (_pinnedIp: string, url: string) => {
      if (url.includes('a.example.com')) {
        return stubResponse({
          status: 302,
          headers: new Headers({ location: 'https://b.example.com/next' }),
        });
      }
      return stubResponse();
    });
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('https://a.example.com/', {}, deps),
    ).rejects.toMatchObject({ code: 'private_target' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a resolver failure as a SafeFetchError (fail closed)', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const dispatch = vi.fn();
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(safeFetch('https://nx.example.com/', {}, deps)).rejects.toBeInstanceOf(
      SafeFetchError,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed when the resolver returns zero IPs', async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const dispatch = vi.fn();
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(safeFetch('https://empty.example.com/', {}, deps)).rejects.toMatchObject({
      code: 'unresolvable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('enforces the response-size cap on the body even with no content-length', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () =>
      stubResponse({
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        async arrayBuffer() {
          return new Uint8Array(64).buffer;
        },
      }),
    );
    const deps: SafeFetchDeps = { resolve, dispatch };

    const res = await safeFetch('https://big.example.com/', {}, deps, { maxResponseBytes: 16 });
    await expect(res.arrayBuffer()).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('enforces the total deadline across hops', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    // Each hop redirects to a fresh public host but the dispatch is slow enough
    // that the second hop starts after the deadline.
    const dispatch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return stubResponse({
        status: 302,
        headers: new Headers({ location: 'https://public.example.com/next' }),
      });
    });
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('https://public.example.com/', {}, deps, {
        totalTimeoutMs: 1,
        maxRedirects: 5,
      }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () =>
      stubResponse({ headers: new Headers({ 'content-length': '9999999' }) }),
    );
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetch('https://big.example.com/', {}, deps, { maxResponseBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });
});

describe('safeFetchSingleHop (manual-redirect callers)', () => {
  it('returns a 3xx response as-is without following it', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () =>
      stubResponse({
        status: 302,
        headers: new Headers({ location: 'https://elsewhere.example.com/' }),
      }),
    );
    const deps: SafeFetchDeps = { resolve, dispatch };

    const res = await safeFetchSingleHop('https://public.example.com/', {}, deps);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://elsewhere.example.com/');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('still refuses a private target on the single hop', async () => {
    const resolve = vi.fn().mockResolvedValue(['10.0.0.5']);
    const dispatch = vi.fn(async () => stubResponse());
    const deps: SafeFetchDeps = { resolve, dispatch };

    await expect(
      safeFetchSingleHop('https://rebind.example.com/', {}, deps),
    ).rejects.toMatchObject({ code: 'private_target' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('createSafeFetchImpl (fetch-shaped adapter)', () => {
  it('produces a fetch-shaped fn that pins the IP and returns a Response', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () => stubResponse());
    const impl = createSafeFetchImpl({ resolve, dispatch });

    const res = await impl('https://public.example.com/creds', { method: 'GET' });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe('{"ok":true}');
  });

  it('surfaces a 3xx Response with a null body so the caller can follow it', async () => {
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const dispatch = vi.fn(async () =>
      stubResponse({
        status: 301,
        headers: new Headers({ location: 'https://next.example.com/' }),
      }),
    );
    const impl = createSafeFetchImpl({ resolve, dispatch });

    const res = await impl('https://public.example.com/');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://next.example.com/');
  });
});
