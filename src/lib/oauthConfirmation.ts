/** UI routing only; worker and data services enforce the signed role independently. */
export function isEmailConfirmationPending(session: { access_token?: string } | null | undefined): boolean {
  try {
    const payload = session?.access_token?.split('.')[1];
    if (!payload) return false;
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role === 'arkova_email_pending';
  } catch { return false; }
}

/** Capture before Supabase/telemetry start. Proof remains in memory, never browser storage. */
export function captureEmailConfirmationToken(): string | null {
  if (typeof window === 'undefined') return null;
  const searchParams = new URLSearchParams(window.location.hash.slice(1));
  if (searchParams.get('type') !== 'oauth_confirmation') return null;
  const token = searchParams.get('token');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}
let confirmationToken = captureEmailConfirmationToken();
export function getEmailConfirmationToken(): string | null { return confirmationToken; }
export function clearEmailConfirmationToken(): void { confirmationToken = null; }
