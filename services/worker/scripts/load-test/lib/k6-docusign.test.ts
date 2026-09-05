import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  get: vi.fn((url, options) => ({ method: 'GET', url, options })),
  post: vi.fn((url, body, options) => ({ method: 'POST', url, body, options })),
}));

const k6Crypto = vi.hoisted(() => ({
  hmac: vi.fn((_algorithm, _key, _body, _encoding) => 'signature-base64'),
}));

const k6Core = vi.hoisted(() => ({
  sleep: vi.fn(),
}));

vi.mock('k6/http', () => ({ default: http }), { virtual: true });
vi.mock('k6/crypto', () => ({ default: k6Crypto }), { virtual: true });
vi.mock('k6', () => ({ sleep: k6Core.sleep }), { virtual: true });

import {
  buildSignedConnectPost,
  executeScenario,
  signConnectBase64,
  executeBilateralStep,
  executeBilateralRequest,
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

// docusign-bilateral-2026-08 (CTO Decision Record, R9) — the bilateral soak
// glue layered on top of the same k6/http + k6/crypto mocks above.
describe('k6 DocuSign bilateral glue', () => {
  const keys = { workerUrl: 'https://worker.test', orgKey: 'org-real-key', sharedKey: 'shared-fallback-key' };

  beforeEach(() => {
    vi.clearAllMocks();
    k6Crypto.hmac.mockReturnValue('signature-base64');
  });

  it('executeBilateralStep signs an object payload with the org key by default and posts with the family label tag', () => {
    const step = {
      label: 'outbound_no_signers',
      payload: { event: 'envelope-completed', envelopeId: 'e1', accountId: 'acct-1' },
      signAs: 'org' as const,
    };
    executeBilateralStep(step, keys);

    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = http.post.mock.calls[0];
    expect(url).toBe('https://worker.test/webhooks/docusign');
    expect(JSON.parse(body)).toEqual(step.payload);
    expect(k6Crypto.hmac).toHaveBeenCalledWith('sha256', 'org-real-key', body, 'base64');
    expect(options).toEqual({
      headers: { 'content-type': 'application/json', 'X-DocuSign-Signature-1': 'signature-base64' },
      tags: { scenario: 'docusign', family: 'outbound_no_signers' },
    });
  });

  it('executeBilateralStep signs with the SHARED key when signAs="shared"', () => {
    executeBilateralStep(
      { label: 'unknown_account_orphan', payload: { event: 'envelope-completed' }, signAs: 'shared' as const },
      keys,
    );
    expect(k6Crypto.hmac).toHaveBeenCalledWith('sha256', 'shared-fallback-key', expect.any(String), 'base64');
  });

  it('executeBilateralStep signs with a key DISTINCT from the real org key when signAs="wrong"', () => {
    executeBilateralStep(
      { label: 'wrong_hmac', payload: { event: 'envelope-completed' }, signAs: 'wrong' as const },
      keys,
    );
    const [, signingKey] = k6Crypto.hmac.mock.calls[0];
    expect(signingKey).not.toBe('org-real-key');
    expect(signingKey).toContain('org-real-key'); // still derived from it, deliberately never equal
  });

  it('executeBilateralStep appends ?customrecipient=true only when the step requests it', () => {
    executeBilateralStep(
      { label: 'inbound_declared_hash', payload: { event: 'envelope-completed' }, signAs: 'org' as const, customrecipient: true },
      keys,
    );
    expect(http.post.mock.calls[0][0]).toBe('https://worker.test/webhooks/docusign?customrecipient=true');
  });

  it('executeBilateralStep accepts an already-serialized string payload as-is (malformed families)', () => {
    executeBilateralStep(
      { label: 'malformed_not_json', payload: 'not valid json {{{', signAs: 'org' as const },
      keys,
    );
    expect(http.post.mock.calls[0][1]).toBe('not valid json {{{');
  });

  it('executeBilateralRequest fires every step of a multi-step family and sleeps for delayMs between them', () => {
    const results = executeBilateralRequest('self_forgery_provenance_conflict', {
      vu: 1,
      iter: 1,
      generatedDateTime: '2026-08-29T00:00:00.000Z',
      ownAccountId: 'org-a',
      foreignAccountId: 'org-b',
      orphanAccountId: 'orphan',
      ...keys,
    });

    expect(results).toHaveLength(2);
    expect(http.post).toHaveBeenCalledTimes(2);
    // Step 2 (the forged inbound) carries a delayMs — confirm the driver
    // actually slept for it (converted to seconds, k6's sleep() unit).
    expect(k6Core.sleep).toHaveBeenCalledWith(results[1].step.delayMs / 1000);
    expect(results[0].step.label).toContain('real_outbound');
    expect(results[1].step.label).toContain('forged_inbound');
  });

  it('executeBilateralRequest does NOT sleep for a family whose steps have no delayMs', () => {
    executeBilateralRequest('outbound_no_signers', {
      vu: 1,
      iter: 1,
      generatedDateTime: '2026-08-29T00:00:00.000Z',
      ownAccountId: 'org-a',
      foreignAccountId: 'org-b',
      orphanAccountId: 'orphan',
      ...keys,
    });
    expect(k6Core.sleep).not.toHaveBeenCalled();
  });
});
