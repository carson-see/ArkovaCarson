import { describe, expect, it } from 'vitest';
import { mfaAssuranceSessionKey, sessionHasAal2 } from './mfaSessionKey';

const token = (claims: unknown) => `header.${btoa(JSON.stringify(claims))}.signature`;
describe('MFA session cache identity', () => {
  it('isolates new sign-ins and assurance downgrades, while preserving refresh identity', () => {
    const claims = { sub: 'user-a', session_id: 'login-one', aal: 'aal2', iat: 1 };
    const key = mfaAssuranceSessionKey(token(claims), 'user-a');
    expect(mfaAssuranceSessionKey(token({ ...claims, iat: 2 }), 'user-a')).toBe(key);
    expect(mfaAssuranceSessionKey(token({ ...claims, aal: 'aal1' }), 'user-a')).not.toBe(key);
    expect(mfaAssuranceSessionKey(token({ ...claims, session_id: 'login-two' }), 'user-a')).not.toBe(key);
  });
  it.each([
    'malformed', 'a.not-base64.c', token(null), token({}),
    token({ sub: 'user-b', session_id: 'login-one', aal: 'aal2' }),
    token({ sub: 'user-a', session_id: '', aal: 'aal2' }),
    token({ sub: 'user-a', session_id: 'login-one', aal: 'unexpected' }),
  ])('keeps unsupported token identity isolated: %s', (accessToken) => {
    expect(mfaAssuranceSessionKey(accessToken, 'user-a')).toBe(accessToken);
  });
  it('does not cache an absent token', () => {
    expect(mfaAssuranceSessionKey(null, 'user-a')).toBeNull();
  });
});

describe('MFA product authority routing hint', () => {
  it('accepts only a same-user authenticated AAL2 token', () => {
    expect(sessionHasAal2(token({ sub: 'user-a', role: 'authenticated', aal: 'aal2' }), 'user-a')).toBe(true);
  });

  it.each([
    token({ sub: 'user-a', role: 'authenticated', aal: 'aal1' }),
    token({ sub: 'user-a', role: 'arkova_mfa_pending', aal: 'aal2' }),
    token({ sub: 'user-a', role: 'arkova_email_pending', aal: 'aal2' }),
    token({ sub: 'user-b', role: 'authenticated', aal: 'aal2' }),
    'malformed',
  ])('rejects a token without exact human product authority', (accessToken) => {
    expect(sessionHasAal2(accessToken, 'user-a')).toBe(false);
  });
});
