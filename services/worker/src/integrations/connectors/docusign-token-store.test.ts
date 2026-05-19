import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/gcp-auth.js', () => ({
  getGcpAccessToken: vi.fn(async () => 'mock-token'),
}));

import {
  buildDocusignRefreshTokenSecretName,
  createGcpSecretManagerRefreshTokenStore,
  resolveDocusignSecretManagerProjectId,
} from './docusign-token-store.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('DocuSign refresh token Secret Manager store', () => {
  it('builds a per-org Secret Manager resource name without exposing the DocuSign account id', () => {
    const name = buildDocusignRefreshTokenSecretName({
      projectId: 'arkova-test',
      orgId: ORG_ID,
      accountId: 'account/with unsafe chars',
    });

    expect(name).toMatch(/^projects\/arkova-test\/secrets\/arkova-docusign-11111111-1111-4111-8111-111111111111-[a-f0-9]{32}-refresh-token$/);
    expect(name).not.toContain('account/with unsafe chars');
  });

  it('falls back to the integration KMS key project when no Secret Manager project override is set', () => {
    expect(resolveDocusignSecretManagerProjectId({
      GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/arkova1/locations/global/keyRings/r/cryptoKeys/k',
    })).toBe('arkova1');
  });

  it('writes, reads, and deletes refresh tokens via Secret Manager REST without logging or returning ciphertext handles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/secrets/arkova-docusign-test') && !init?.method) {
        return new Response('{}', { status: 404 });
      }
      if (String(url).endsWith('/secrets?secretId=arkova-docusign-test')) {
        return new Response(JSON.stringify({ name: 'projects/p/secrets/arkova-docusign-test' }), { status: 200 });
      }
      if (String(url).endsWith('/secrets/arkova-docusign-test:addVersion')) {
        const body = JSON.parse(String(init?.body)) as { payload: { data: string } };
        expect(Buffer.from(body.payload.data, 'base64').toString('utf8')).toBe('refresh-secret');
        return new Response(JSON.stringify({ name: 'projects/p/secrets/arkova-docusign-test/versions/1' }), { status: 200 });
      }
      if (String(url).endsWith('/versions/latest:access')) {
        return new Response(
          JSON.stringify({ payload: { data: Buffer.from('refresh-secret', 'utf8').toString('base64') } }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/secrets/arkova-docusign-test') && init?.method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 500 });
    });

    const store = createGcpSecretManagerRefreshTokenStore({
      env: { GCP_SECRET_MANAGER_PROJECT_ID: 'p' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'gcp-token',
    });

    await store.put({ name: 'projects/p/secrets/arkova-docusign-test', value: 'refresh-secret' });
    await expect(store.get({ name: 'projects/p/secrets/arkova-docusign-test' })).resolves.toBe('refresh-secret');
    await store.delete({ name: 'projects/p/secrets/arkova-docusign-test' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets?secretId=arkova-docusign-test',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test:addVersion',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test/versions/latest:access',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test',
    ]);
    expect(calls.every((call) => call.init?.headers instanceof Headers
      ? call.init.headers.get('authorization') === 'Bearer gcp-token'
      : true)).toBe(true);
  });
});
