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

  it('refuses to follow redirects (an off-origin redirect is an error, never a request we make)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ passport_id: PASSPORT, status: 'active' }));
    await fetchPassportVerification(PASSPORT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('error');
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
