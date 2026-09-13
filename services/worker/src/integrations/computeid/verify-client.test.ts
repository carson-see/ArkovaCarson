/**
 * The one outbound ComputeID call. What matters here is not that a happy path
 * parses — it is that the request cannot be steered anywhere but the configured
 * origin, that a hostile or broken response cannot become an exception carrying
 * partner bytes, and that a hung partner cannot hold the hourly job open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = {
  computeidApiKey: 'partner-key-abc',
  computeidApiBaseUrl: 'https://api.aicomputeid.com',
};
vi.mock('../../config.js', () => ({ config: configMock }));

const { fetchPassportVerification, isVerifyClientConfigured, VERIFY_MAX_RESPONSE_BYTES } =
  await import('./verify-client.js');

const PASSPORT = 'b390e5e6-c79d-4f02-9a42-212494b1fd44';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  configMock.computeidApiKey = 'partner-key-abc';
  configMock.computeidApiBaseUrl = 'https://api.aicomputeid.com';
});

describe('fetchPassportVerification', () => {
  it('requests the configured origin with the partner API key, and nothing else', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ passport_id: PASSPORT, status: 'active' }));
    const out = await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://api.aicomputeid.com/v1/agents/${PASSPORT}/verify`);
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('partner-key-abc');
    expect(init.method).toBe('GET');
  });

  it('follows the configured base origin, not a hardcoded host', async () => {
    configMock.computeidApiBaseUrl = 'https://staging.example.test';
    const fetchImpl = vi.fn(async () => jsonResponse({ passport_id: PASSPORT, status: 'active' }));
    await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(String((fetchImpl.mock.calls[0] as unknown as [URL])[0])).toBe(
      `https://staging.example.test/v1/agents/${PASSPORT}/verify`,
    );
  });

  it('refuses a passport id that is not a UUID — the only caller-supplied part of the URL', async () => {
    const fetchImpl = vi.fn();
    for (const bad of ['../../v1/ca/cert', 'http://evil.test/x', '..', 'not-a-uuid', `${PASSPORT}/../../x`]) {
      await expect(fetchPassportVerification(bad, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .resolves.toEqual({ ok: false, reason: 'invalid_passport_id' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call the partner at all when no API key is provisioned', async () => {
    configMock.computeidApiKey = '';
    const fetchImpl = vi.fn();
    expect(isVerifyClientConfigured()).toBe(false);
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects (an off-origin redirect is surfaced, never a request we make)', async () => {
    // `manual`, not `error`: the safe-fetch impl surfaces the 3xx so we can
    // report its status, rather than collapsing it into an opaque throw. The
    // behavioural assertion — that the redirect is never followed — is the
    // "does not follow a redirect" test below, which counts dispatch calls.
    const fetchImpl = vi.fn(async () => jsonResponse({ passport_id: PASSPORT, status: 'active' }));
    await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('passes an abort signal so a hung partner cannot hold the hourly job open', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ passport_id: PASSPORT, status: 'active' }));
    await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 25 });
    expect((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout distinctly from a transport failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: (async () => { throw timeout; }) as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'timeout' });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'request_failed' });
  });

  it('surfaces an HTTP error as a status number only — never a body', async () => {
    const fetchImpl = async () => new Response('upstream said: secret-ish detail', { status: 503 });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'http_error', status: 503 });
  });

  it('rejects a non-JSON body without echoing it', async () => {
    const fetchImpl = async () => new Response('<html>not json</html>', { status: 200 });
    const out = await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ ok: false, reason: 'malformed_response' });
    expect(JSON.stringify(out)).not.toContain('html');
  });

  it('rejects a JSON body that is not a verify response', async () => {
    const fetchImpl = async () => jsonResponse({ unexpected: true });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'malformed_response' });
  });

  it('caps the response size', async () => {
    const fetchImpl = async () => new Response('x'.repeat(VERIFY_MAX_RESPONSE_BYTES + 1), { status: 200 });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'response_too_large' });
  });

  it('refuses an oversized body on its DECLARED length, without reading it', async () => {
    let read = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(VERIFY_MAX_RESPONSE_BYTES + 1) }),
      text: async () => { read = true; return 'x'; },
    });
    await expect(fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, reason: 'response_too_large' });
    expect(read).toBe(false);
  });

  it('refuses a partner base URL that resolves to the cloud metadata IP', async () => {
    // `computeidApiBaseUrl` is env-tunable, and even when it is not, the
    // hostname is resolved by DNS we do not control. Without an IP-pinned
    // egress primitive a rebind sends Arkova's partner API key — and the reply
    // — to 169.254.169.254. This is the residual SSRF the raw global `fetch`
    // left open (lib/agents.md: all worker egress goes through safe-fetch).
    configMock.computeidApiBaseUrl = 'https://partner.rebind.test';
    const dispatch = vi.fn();
    const out = await fetchPassportVerification(PASSPORT, {
      safeFetchDeps: { resolve: async () => ['169.254.169.254'], dispatch },
    });
    expect(out).toEqual({ ok: false, reason: 'request_failed' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('connects to the PINNED resolved IP, not a re-resolved one', async () => {
    configMock.computeidApiBaseUrl = 'https://partner.example.test';
    const dispatch = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      url: `https://partner.example.test/v1/agents/${PASSPORT}/verify`,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ passport_id: PASSPORT, status: 'active' })).buffer,
    }));
    const out = await fetchPassportVerification(PASSPORT, {
      safeFetchDeps: { resolve: async () => ['203.0.113.7'], dispatch },
    });
    expect(out).toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledWith('203.0.113.7', expect.stringContaining('/v1/agents/'), expect.anything());
  });

  it('does not follow a redirect — a 3xx is an http_error, never another request', async () => {
    configMock.computeidApiBaseUrl = 'https://partner.example.test';
    const dispatch = vi.fn(async () => ({
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      url: 'https://partner.example.test/v1/agents/x/verify',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const out = await fetchPassportVerification(PASSPORT, {
      safeFetchDeps: { resolve: async () => ['203.0.113.7'], dispatch },
    });
    expect(out).toEqual({ ok: false, reason: 'http_error', status: 302 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not park forever on a partner that sends headers and then stalls the body', async () => {
    // `AbortSignal.timeout` bounds the REQUEST; the body read is its own await
    // with no deadline of its own (F-D0-5). One parked read inside this job
    // holds the whole hourly reconciliation open.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      text: () => new Promise<string>(() => {}),
    });
    await expect(
      fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 25 }),
    ).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('keeps the full verification_receipt so the caller can verify its signature', async () => {
    const receipt = {
      passport_id: PASSPORT,
      status: 'active',
      issued_at: '2026-09-07T18:54:36.786Z',
      expires_at: '2026-09-07T18:59:36.786Z',
      key_id: 'ebb276c2f18ed34f',
      receipt_signature: 'AAAA',
      receipt_algorithm: 'RSA-SHA256',
      receipt_payload: '{"passport_id":"x"}',
    };
    const fetchImpl = async () => jsonResponse({ passport_id: PASSPORT, status: 'active', verification_receipt: receipt });
    const out = await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok && out.response.verification_receipt?.receipt_payload).toBe('{"passport_id":"x"}');
  });
});
