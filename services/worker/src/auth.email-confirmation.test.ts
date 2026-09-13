import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import * as auth from './auth.js';

const { getUser, jwks } = vi.hoisted(() => ({ getUser: vi.fn(), jwks: vi.fn() }));
vi.mock('jose', async (original) => ({ ...await original<typeof import('jose')>(), createRemoteJWKSet: () => jwks }));
vi.mock('./utils/db.js', () => ({ getDb: () => ({ auth: { getUser } }) }));
const secret = 'uat03-pending-role-test-key-that-is-not-a-real-secret';
const userId = 'ce69b21d-d188-433f-a9eb-450bff79101e';
const logger = { warn: vi.fn(), error: vi.fn() };
async function token(role: string, aal: 'aal1' | 'aal2' = 'aal1') {
  return new SignJWT({ sub: userId, role, aal })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('SCRUM-4035 pending email identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: userId, role: 'authenticated' } }, error: null });
  });
  it.each([true, false])('denies product access terminally, local verification=%s', async (local) => {
    const result = await auth.verifyAuthToken(await token('arkova_email_pending'),
      { supabaseJwtSecret: local ? secret : undefined }, logger);
    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });
  it('denies ES256 product access and verifies ES256 identity only for confirmation', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    jwks.mockResolvedValue(publicKey);
    const bearer = await new SignJWT({ sub: userId, role: 'arkova_email_pending' })
      .setProtectedHeader({ alg: 'ES256' }).setIssuer('https://fixture.supabase.co/auth/v1')
      .setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const config = { supabaseUrl: 'https://fixture.supabase.co' };
    expect(await auth.verifyAuthToken(bearer, config, logger)).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
    expect(jwks).not.toHaveBeenCalled();
    expect(await auth.verifyEmailConfirmationToken(bearer, config, logger)).toBe(userId);
    expect(jwks).toHaveBeenCalled();
  });
  it('requires AAL2 for normal authenticated product access', async () => {
    expect(await auth.verifyAuthToken(await token('authenticated', 'aal1'), { supabaseJwtSecret: secret }, logger)).toBeNull();
    expect(await auth.verifyAuthToken(await token('authenticated', 'aal2'), { supabaseJwtSecret: secret }, logger)).toBe(userId);
  });
  it('rejects a custom-hook MFA-pending token even if it carries AAL2', async () => {
    expect(await auth.verifyAuthToken(await token('arkova_mfa_pending', 'aal2'),
      { supabaseJwtSecret: secret }, logger)).toBeNull();
  });
  it('allows the separately named confirmation verifier to identify a pending caller', async () => {
    expect(await auth.verifyEmailConfirmationToken(await token('arkova_email_pending'),
      { supabaseJwtSecret: secret }, logger)).toBe(userId);
  });
  it('does not authorize a forged pending token at the confirmation endpoint', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    expect(await auth.verifyEmailConfirmationToken(await token('arkova_email_pending'),
      { supabaseJwtSecret: 'different-key' }, logger)).toBeNull();
  });
});
