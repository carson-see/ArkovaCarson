/**
 * API key scope vocabulary.
 *
 * SCRUM-1272 (R2-9) — extended to cover sensitive v1 routes (FERPA, HIPAA,
 * compliance, oracle, anchor, attestations, webhooks, agents) so that a key
 * granted only `read:search` cannot pull PHI/PII out of compliance endpoints
 * just by virtue of being authenticated.
 *
 * Backwards compatibility: `requireScope()` (middleware/apiKeyAuth.ts) falls
 * through when no API key is attached. Browser callers using Supabase JWT auth
 * are not affected — those routes still honour `requireAuth`. The new scopes
 * tighten the door for API-key callers without re-permissioning JWT users.
 */

export const API_V2_SCOPES = [
  'read:records',
  'read:orgs',
  'read:search',
  'write:anchors',
  'admin:rules',
] as const;

export const LEGACY_API_SCOPES = [
  'verify',
  'verify:batch',
  'usage:read',
  'keys:manage',
] as const;

/**
 * SCRUM-1272 (R2-9) — sensitive v1 route scopes.
 *
 * Added so FERPA/HIPAA/compliance and the agents/oracle/anchor/attestations/
 * webhooks routes can be guarded with `requireScope()` even when an API key
 * holder hits them. Browser (JWT) callers fall through `requireScope()`
 * unchanged; the gate only fires when `req.apiKey` is populated.
 */
export const SENSITIVE_V1_SCOPES = [
  'compliance:read',
  'compliance:write',
  'oracle:read',
  'oracle:write',
  'anchor:read',
  'anchor:write',
  'attestations:read',
  'attestations:write',
  'webhooks:manage',
  'agents:manage',
  'keys:read',
] as const;

export const API_KEY_SCOPES = [
  ...API_V2_SCOPES,
  ...LEGACY_API_SCOPES,
  ...SENSITIVE_V1_SCOPES,
] as const;

export type ApiV2Scope = typeof API_V2_SCOPES[number];
export type SensitiveV1Scope = typeof SENSITIVE_V1_SCOPES[number];
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export const DEFAULT_API_KEY_SCOPES: ApiV2Scope[] = ['read:search'];

export function isApiV2Scope(scope: string): scope is ApiV2Scope {
  return (API_V2_SCOPES as readonly string[]).includes(scope);
}

export function isSensitiveV1Scope(scope: string): scope is SensitiveV1Scope {
  return (SENSITIVE_V1_SCOPES as readonly string[]).includes(scope);
}

export function scopeSatisfies(granted: string[], required: string): boolean {
  return granted.includes(required);
}
