import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../utils/gcp-auth.js', () => ({
  getGcpAccessToken: vi.fn(async () => 'mock-token'),
}));

import {
  buildAdobeSignRefreshTokenSecretName,
  resolveAdobeSignSecretManagerProjectId,
} from './adobe-sign-token-store.js';
import { buildDocusignRefreshTokenSecretName } from './docusign-token-store.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('buildAdobeSignRefreshTokenSecretName', () => {
  it('namespaces Adobe secrets away from DocuSign secrets for the same org + account', () => {
    // Both connectors hash the account id, so without the provider segment an
    // org that connected the same-numbered account on both providers would
    // collide onto one secret and each connect would clobber the other's
    // refresh token.
    const adobe = buildAdobeSignRefreshTokenSecretName({ projectId: 'arkova1', orgId: ORG_ID, accountId: 'acct-1' });
    const docusign = buildDocusignRefreshTokenSecretName({ projectId: 'arkova1', orgId: ORG_ID, accountId: 'acct-1' });
    expect(adobe).not.toBe(docusign);
    expect(adobe).toContain('arkova-adobe-sign-');
  });

  it('produces a valid projects/{p}/secrets/{s} resource name', () => {
    const name = buildAdobeSignRefreshTokenSecretName({ projectId: 'arkova1', orgId: ORG_ID, accountId: 'acct-1' });
    expect(name).toMatch(/^projects\/arkova1\/secrets\/[A-Za-z0-9_-]{1,255}$/);
  });

  it('hashes the account id instead of embedding it in the resource name', () => {
    const accountId = 'adobe-account-with/unsafe chars';
    const name = buildAdobeSignRefreshTokenSecretName({ projectId: 'arkova1', orgId: ORG_ID, accountId });
    expect(name).not.toContain(accountId);
    expect(name).toContain(createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 32));
  });

  it('is stable for the same inputs — a reconnect must reuse the same secret', () => {
    const args = { projectId: 'arkova1', orgId: ORG_ID, accountId: 'acct-1' };
    expect(buildAdobeSignRefreshTokenSecretName(args)).toBe(buildAdobeSignRefreshTokenSecretName(args));
  });

  it('rejects an org id that would escape the resource-name segment', () => {
    expect(() =>
      buildAdobeSignRefreshTokenSecretName({ projectId: 'arkova1', orgId: '../../etc', accountId: 'a' }),
    ).toThrow(/not safe/);
  });

  it('rejects a project id that would escape the resource-name segment', () => {
    expect(() =>
      buildAdobeSignRefreshTokenSecretName({ projectId: 'p/../q', orgId: ORG_ID, accountId: 'a' }),
    ).toThrow(/not safe/);
  });
});

describe('resolveAdobeSignSecretManagerProjectId', () => {
  it('resolves from the standard GCP project env vars', () => {
    expect(resolveAdobeSignSecretManagerProjectId({ GOOGLE_CLOUD_PROJECT: 'arkova1' })).toBe('arkova1');
  });

  it('falls back to the project embedded in the KMS key name', () => {
    expect(
      resolveAdobeSignSecretManagerProjectId({
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/arkova1/locations/us/keyRings/r/cryptoKeys/k',
      }),
    ).toBe('arkova1');
  });

  it('throws rather than silently writing secrets into an unknown project', () => {
    expect(() => resolveAdobeSignSecretManagerProjectId({})).toThrow(/GCP_SECRET_MANAGER_PROJECT_ID/);
  });
});
