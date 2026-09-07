/**
 * UI assurance-cache identity, not token verification or server authorization.
 * GoTrue rotates a JWT during refresh while retaining its session_id and aal.
 * Treating every refresh as a new session unmounts an in-progress MFA setup.
 */
export function mfaAssuranceSessionKey(accessToken: string | null, userId: string | null): string | null {
  if (!accessToken) return null;
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) return accessToken;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    if (typeof claims !== 'object' || claims === null) return accessToken;
    const { sub, session_id: sessionId, aal } = claims as Record<string, unknown>;
    if (sub !== userId || typeof sessionId !== 'string' || !sessionId || (aal !== 'aal1' && aal !== 'aal2')) {
      return accessToken;
    }
    // New sign-ins and assurance downgrades invalidate this identity.
    // userId is independently part of useMfaAssurance's cache lookup.
    return JSON.stringify([sessionId, aal]);
  } catch {
    return accessToken;
  }
}
