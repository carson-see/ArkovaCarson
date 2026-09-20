/** Email/password signup policy mirrored by Supabase Auth configuration. */
export const SIGNUP_EMAIL_LINK_LIFETIME_SECONDS = 15 * 60;
export const SIGNUP_EMAIL_RESEND_COOLDOWN_SECONDS = 90;
export const PENDING_SIGNUP_EMAIL_STORAGE_KEY = 'arkova_pending_signup_email';

export function rememberPendingSignupEmail(email: string): void {
  try {
    sessionStorage.setItem(PENDING_SIGNUP_EMAIL_STORAGE_KEY, email.trim().toLowerCase());
  } catch {
    // Storage can be unavailable in restricted browser contexts. It is only a
    // callback-correlation hint and never an authorization decision.
  }
}

export function readPendingSignupEmail(): string | null {
  try {
    return sessionStorage.getItem(PENDING_SIGNUP_EMAIL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearPendingSignupEmail(): void {
  try {
    sessionStorage.removeItem(PENDING_SIGNUP_EMAIL_STORAGE_KEY);
  } catch {
    // See rememberPendingSignupEmail.
  }
}
