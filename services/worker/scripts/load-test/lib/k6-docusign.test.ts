import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  get: vi.fn((url, options) => ({ method: 'GET', url, options })),
  post: vi.fn((url, body, options) => ({ method: 'POST', url, body, options })),
}));

const k6Crypto = vi.hoisted(() => ({
  hmac: vi.fn((_algorithm, _key, _body, _encoding) => 'signature-base64'),
}));

vi.mock('k6/http', () => ({ default: http }), { virtual: true });
vi.mock('k6/crypto', () => ({ default: k6Crypto }), { virtual: true });

import {
  buildSignedConnectPost,
  executeScenario,
  signConnectBase64,
} from './k6-docusign.js';

describe('k6 DocuSign glue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    k6Crypto.hmac.mockReturnValue('signature-base64');
  });

  it('signConnectBase64 delegates to k6 HMAC-SHA256 base64', () => {
    expect(signConnectBase64('{"ok":true}', 'secret')).toBe('signature-base64');
    expect(k6Crypto.hmac).toHaveBeenCalledWith('sha256', 'secret', '{"ok":true}', 'base64');
  });

  it('buildSignedConnectPost signs the exact serialized body and emits webhook headers', () => {
    const post = buildSignedConnectPost({
      accountId: 'acct-1',
      key: 'secret',
      vu: 3,
      iter: 9,
      withNotary: true,
    });

    expect(post.headers).toEqual({
      'content-type': 'application/json',
      'X-DocuSign-Signature-1': 'signature-base64',
    });
    expect(k6Crypto.hmac).toHaveBeenCalledWith('sha256', 'secret', post.body, 'base64');

    const body = JSON.parse(post.body);
    expect(body.accountId).toBe('acct-1');
    expect(body.envelopeId).toBe('loadtest-env-3-9');
    expect(body.eventId).toBe('loadtest-evt-3-9');
    expect(body.recipients.notaries).toHaveLength(1);
  });

  it('executeScenario routes health checks with stable tags and load-test headers', () => {
    const res = executeScenario('health', {
      workerUrl: 'https://worker.test',
      key: 'secret',
      accountId: 'acct',
      vu: 1,
      iter: 2,
    });

    expect(res).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(http.get).toHaveBeenCalledWith('https://worker.test/health', {
      headers: { 'x-arkova-loadtest': '1' },
      tags: { scenario: 'health' },
    });
  });

  it('executeScenario routes verify checks with stable tags and load-test headers', () => {
    executeScenario('verify', {
      workerUrl: 'https://worker.test',
      key: 'secret',
      accountId: 'acct',
      vu: 1,
      iter: 2,
    });

    expect(http.get).toHaveBeenCalledWith(
      'https://worker.test/api/v1/verify/anchor/00000000-0000-0000-0000-000000000000',
      {
        headers: { 'x-arkova-loadtest': '1' },
        tags: { scenario: 'verify' },
      },
    );
  });

  it('executeScenario routes docusign POSTs with signed body, headers, and tags', () => {
    executeScenario('docusign', {
      workerUrl: 'https://worker.test',
      key: 'secret',
      accountId: 'acct',
      vu: 4,
      iter: 5,
      withNotary: true,
    });

    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = http.post.mock.calls[0];
    expect(url).toBe('https://worker.test/webhooks/docusign');
    expect(JSON.parse(body).envelopeId).toBe('loadtest-env-4-5');
    expect(options).toEqual({
      headers: {
        'content-type': 'application/json',
        'X-DocuSign-Signature-1': 'signature-base64',
      },
      tags: { scenario: 'docusign' },
    });
  });
});
