import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { appendOAuthResult, readSignedOAuthState, requestOrigin, sameOriginReturnTo, signOAuthState, toPostgresBytea } from './oauth-primitives.js';

const secret = 'dedicated-test-oauth-state-secret';
const payload = { orgId: 'org-1', userId: 'user-1', nonce: 'nonce-1', iat: 1000, returnTo: 'https://app.test/settings' };

describe('shared OAuth wire primitives', () => {
  it('preserves the existing base64url JSON + HMAC wire representation', () => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
    expect(signOAuthState(payload, secret)).toBe(`${encoded}.${signature}`);
    expect(readSignedOAuthState(signOAuthState(payload, secret), secret, () => true)).toEqual(payload);
  });

  it('rejects tampering, a wrong signing secret and malformed signed JSON', () => {
    const state = signOAuthState(payload, secret);
    expect(readSignedOAuthState(state.replace('ey', 'ex'), secret, () => true)).toBeNull();
    expect(readSignedOAuthState(state, 'wrong-secret', () => true)).toBeNull();
    const encoded = Buffer.from('{broken').toString('base64url');
    const signed = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
    expect(readSignedOAuthState(signed, secret, () => true)).toBeNull();
    expect(readSignedOAuthState('missing-signature', secret, () => true)).toBeNull();
  });

  it('leaves member scope and personal-Drive org policy with the provider', () => {
    const state = signOAuthState({ ...payload, orgId: null, scope: 'member' }, secret);
    expect(readSignedOAuthState<{ orgId: string | null }>(state, secret, value => value.orgId !== null)).toBeNull();
    expect(readSignedOAuthState<{ orgId: string | null }>(state, secret, value => value.orgId === null)).toMatchObject({ orgId: null });
    expect(readSignedOAuthState<{ scope: string }>(state, secret, value => value.scope === 'member')).not.toBeNull();
    expect(readSignedOAuthState<{ scope: string }>(state, secret, value => value.scope === 'org')).toBeNull();
  });

  it('fails closed when a provider validator rejects or cannot read a payload', () => {
    expect(readSignedOAuthState(signOAuthState(payload, secret), secret, () => false)).toBeNull();
    expect(readSignedOAuthState(signOAuthState(null, secret), secret, value => Boolean((value as typeof payload).orgId))).toBeNull();
  });

  it('preserves same-origin redirects and provider-specific fallback paths', () => {
    expect(sameOriginReturnTo('https://app.test/path?q=1', 'https://app.test', 'fallback')).toBe('https://app.test/path?q=1');
    for (const value of [undefined, 'https://evil.test/path', 'javascript:alert(1)', 'broken']) {
      expect(sameOriginReturnTo(value, 'https://app.test', 'https://app.test/account?tab=settings')).toBe('https://app.test/account?tab=settings');
    }
  });

  it('keeps forwarded origin, result parameters and bytea values unchanged', () => {
    const req = { protocol: 'http', headers: { 'x-forwarded-proto': 'https,http', 'x-forwarded-host': 'api.test', host: 'internal.test' } } satisfies Pick<Request, 'protocol' | 'headers'>;
    expect(requestOrigin(req)).toBe('https://api.test');
    const result = new URL(appendOAuthResult('https://app.test/return?keep=yes', 'adobe_sign_error', 'missing_code'));
    expect(Object.fromEntries(result.searchParams)).toEqual({ keep: 'yes', tab: 'settings', adobe_sign_error: 'missing_code' });
    expect(toPostgresBytea(Buffer.from([0, 127, 255]))).toBe('\\x007fff');
  });
});
