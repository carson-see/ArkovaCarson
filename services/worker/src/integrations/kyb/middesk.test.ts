/**
 * Middesk KYB client tests (SCRUM-1162)
 *
 * Unit tests cover:
 *   - submitBusiness: happy path + schema failure + HTTP error + missing API key
 *   - verifyMiddeskSignature: match / mismatch / missing signature / bad hex
 *   - parseMiddeskWebhookPayload: happy path + malformed JSON + schema violation
 *   - mapMiddeskEventToStatus: all known + unknown
 *   - getMiddeskBaseUrl: sandbox default + prod flip
 *
 * No real network calls — fetch is stubbed via dep injection.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  submitBusiness,
  verifyMiddeskSignature,
  parseMiddeskWebhookPayload,
  mapMiddeskEventToStatus,
  getMiddeskBaseUrl,
  MiddeskApiError,
  MiddeskConfigError,
} from './middesk.js';

describe('getMiddeskBaseUrl', () => {
  it('defaults to sandbox when MIDDESK_SANDBOX is unset', () => {
    expect(getMiddeskBaseUrl({})).toBe('https://api-sandbox.middesk.com');
  });

  it('stays sandbox when MIDDESK_SANDBOX is "true"', () => {
    expect(getMiddeskBaseUrl({ MIDDESK_SANDBOX: 'true' })).toBe(
      'https://api-sandbox.middesk.com',
    );
  });

  it('flips to prod when MIDDESK_SANDBOX is "false"', () => {
    expect(getMiddeskBaseUrl({ MIDDESK_SANDBOX: 'false' })).toBe('https://api.middesk.com');
  });

  it('stays sandbox when MIDDESK_SANDBOX is a typo', () => {
    // The comparison is lower-cased exact, so "FALSE " with the space is NOT
    // "false" — it should stay on sandbox (fail-safe default).
    expect(getMiddeskBaseUrl({ MIDDESK_SANDBOX: 'FALSE ' })).toBe(
      'https://api-sandbox.middesk.com',
    );
    expect(getMiddeskBaseUrl({ MIDDESK_SANDBOX: 'disabled' })).toBe(
      'https://api-sandbox.middesk.com',
    );
  });
});

describe('submitBusiness', () => {
  const validInput = {
    name: 'Arkova Inc',
    ein: '123456789',
    address: {
      line1: '1 Market St',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94105',
    },
    external_id: 'org-uuid-1',
  };

  it('throws MiddeskConfigError when MIDDESK_API_KEY is missing', async () => {
    await expect(submitBusiness(validInput, { env: {} })).rejects.toBeInstanceOf(
      MiddeskConfigError,
    );
  });

  it('throws MiddeskConfigError on empty API key', async () => {
    await expect(
      submitBusiness(validInput, { env: { MIDDESK_API_KEY: '   ' } }),
    ).rejects.toBeInstanceOf(MiddeskConfigError);
  });

  it('returns parsed response on happy path', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          object: 'business',
          id: 'biz_123',
          status: 'pending',
          external_id: 'org-uuid-1',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );

    const res = await submitBusiness(validInput, {
      env: { MIDDESK_API_KEY: 'sk_test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.id).toBe('biz_123');
    expect(res.external_id).toBe('org-uuid-1');
  });

  it('throws MiddeskApiError on non-2xx', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'invalid_ein' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });

    const err = await submitBusiness(validInput, {
      env: { MIDDESK_API_KEY: 'sk_test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MiddeskApiError);
    expect((err as MiddeskApiError).status).toBe(422);
  });

  it('throws MiddeskApiError on schema failure', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ garbage: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });

    const err = await submitBusiness(validInput, {
      env: { MIDDESK_API_KEY: 'sk_test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MiddeskApiError);
    expect((err as MiddeskApiError).status).toBe(502);
  });

  it('sends correct request body', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({ id: 'biz_x', external_id: 'org-uuid-1' }),
        { status: 201 },
      );
    };
    await submitBusiness(validInput, {
      env: { MIDDESK_API_KEY: 'sk_test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.name).toBe('Arkova Inc');
    expect(body.tax_id).toBe('123456789');
    expect(body.external_id).toBe('org-uuid-1');
    expect(body.addresses[0].address_line1).toBe('1 Market St');
  });

  it('does not include secret EIN in thrown error message', async () => {
    const fetchImpl = async () =>
      new Response('nope', { status: 500 });
    const err = await submitBusiness(validInput, {
      env: { MIDDESK_API_KEY: 'sk_test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(String(err.message)).not.toContain('123456789');
  });
});

describe('verifyMiddeskSignature', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ hello: 'world' });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('returns true on matching signature', () => {
    expect(verifyMiddeskSignature({ rawBody: body, signature, secret })).toBe(true);
  });

  it('returns true when rawBody is a Buffer', () => {
    expect(
      verifyMiddeskSignature({ rawBody: Buffer.from(body), signature, secret }),
    ).toBe(true);
  });

  it('returns false on mismatched signature', () => {
    expect(
      verifyMiddeskSignature({
        rawBody: body,
        signature: 'a'.repeat(signature.length),
        secret,
      }),
    ).toBe(false);
  });

  it('returns false on missing signature', () => {
    expect(verifyMiddeskSignature({ rawBody: body, signature: undefined, secret })).toBe(
      false,
    );
  });

  it('returns false on missing secret', () => {
    expect(verifyMiddeskSignature({ rawBody: body, signature, secret: '' })).toBe(false);
  });

  it('returns false on malformed hex signature', () => {
    expect(
      verifyMiddeskSignature({ rawBody: body, signature: 'not-hex-zz', secret }),
    ).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(verifyMiddeskSignature({ rawBody: body, signature: 'ab', secret })).toBe(
      false,
    );
  });
});

describe('parseMiddeskWebhookPayload', () => {
  const valid = {
    object: 'event',
    id: 'evt_1',
    type: 'business.updated',
    data: {
      object: {
        id: 'biz_123',
        external_id: 'org-uuid-1',
        status: 'pending',
      },
    },
  };

  it('parses a well-formed event', () => {
    const parsed = parseMiddeskWebhookPayload(JSON.stringify(valid));
    expect(parsed.type).toBe('business.updated');
    expect(parsed.data.object.id).toBe('biz_123');
  });

  it('accepts a Buffer rawBody', () => {
    const parsed = parseMiddeskWebhookPayload(Buffer.from(JSON.stringify(valid)));
    expect(parsed.id).toBe('evt_1');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseMiddeskWebhookPayload('not json')).toThrow();
  });

  it('throws on schema violation (missing type)', () => {
    const bad = { ...valid, type: undefined } as unknown;
    expect(() => parseMiddeskWebhookPayload(JSON.stringify(bad))).toThrow();
  });

  it('preserves unknown fields via passthrough', () => {
    const withExtra = { ...valid, custom_field: 'yes' };
    const parsed = parseMiddeskWebhookPayload(JSON.stringify(withExtra));
    expect(parsed.type).toBe('business.updated');
  });
});

describe('mapMiddeskEventToStatus', () => {
  it.each([
    ['business.updated', 'pending'],
    ['business.verified', 'verified'],
    ['business.requires_review', 'requires_input'],
    ['business.manual_review', 'requires_input'],
    ['business.rejected', 'rejected'],
    ['business.failed', 'rejected'],
    ['business.mystery_event', 'error'],
    ['', 'error'],
  ])('%s → %s', (input, expected) => {
    expect(mapMiddeskEventToStatus(input)).toBe(expected);
  });
});
