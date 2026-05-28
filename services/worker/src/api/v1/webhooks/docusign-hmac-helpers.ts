/**
 * SCRUM-2043 — HMAC key resolution helpers for the DocuSign webhook handler.
 *
 * Resolves which HMAC keys to use for verification:
 *   1. If the integration row has hmac_keys (JSONB array), use those.
 *   2. Otherwise fall back to the global DOCUSIGN_CONNECT_HMAC_SECRET env var.
 */

export interface HmacKeyEntry {
  key: string;
  created_at: string;
  label?: string;
}

export function resolveHmacKeys(
  hmacKeys: HmacKeyEntry[] | null | undefined,
  envSecret: string | undefined,
): string[] {
  if (hmacKeys && hmacKeys.length > 0) {
    const valid = hmacKeys
      .map((entry) => entry.key)
      .filter((k) => typeof k === 'string' && k.length > 0);
    if (valid.length > 0) return valid;
  }
  if (envSecret) return [envSecret];
  return [];
}
