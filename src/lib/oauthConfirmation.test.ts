import { describe, expect, it } from 'vitest';
import { isEmailConfirmationPending, captureEmailConfirmationToken } from './oauthConfirmation';

describe('OAuth confirmation routing and credential capture', () => {
  it('uses the session token role instead of provider email or mutable metadata', () => {
    const access_token = `header.${btoa(JSON.stringify({ role: 'arkova_email_pending' }))}.signature`;
    expect(isEmailConfirmationPending({ access_token })).toBe(true);
    expect(isEmailConfirmationPending({ access_token: 'invalid' })).toBe(false);
  });
  it('removes the proof from browser history before returning it', () => {
    history.replaceState(null, '', '/signup?keep=yes#token=provider-nonhex-proof& type=bad');
    expect(captureEmailConfirmationToken()).toBeNull();
    history.replaceState(null, '', '/signup?keep=yes#token=provider-nonhex-proof&type=oauth_confirmation');
    expect(captureEmailConfirmationToken()).toBe('provider-nonhex-proof');
    expect(location.href).not.toContain('proof');
    expect(location.search).toBe('?keep=yes');
  });
});
