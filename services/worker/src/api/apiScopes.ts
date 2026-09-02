// SCRUM-1272 (R2-9) — authoritative scope vocabulary for v1 API keys.
// The legacy `verify` / `verify:batch` / `usage:read` / `keys:manage` set is
// retained for backward compatibility; new keys should be granted from the
// V2 set or the compliance/anchor/oracle/agents/attestations/webhooks set.
//
// FERPA, HIPAA, emergency-access, and directory-opt-out routes use JWT auth
// (not API keys), so `apiKeyAuth.requireScope` is a no-op there. As of
// SCRUM-3514 they are gated by `middleware/requireScopeAnyAuth.ts` instead,
// which resolves a grant for either auth mode and has no pass-through branch.
// Do not "restore" a `requireScope` mount on those routes — it would read as
// enforcement and enforce nothing.

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

export const COMPLIANCE_API_SCOPES = [
  'compliance:read',
  'compliance:write',
  'oracle:read',
  'oracle:write',
  'anchor:write',
  'anchor:read',
  'attestations:write',
  'attestations:read',
  'webhooks:manage',
  'agents:manage',
  'keys:read',
] as const;

export const API_KEY_SCOPES = [
  ...API_V2_SCOPES,
  ...LEGACY_API_SCOPES,
  ...COMPLIANCE_API_SCOPES,
] as const;

export type ApiV2Scope = typeof API_V2_SCOPES[number];
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export const DEFAULT_API_KEY_SCOPES: ApiV2Scope[] = ['read:search'];

export function isApiV2Scope(scope: string): scope is ApiV2Scope {
  return (API_V2_SCOPES as readonly string[]).includes(scope);
}

export function isComplianceScope(scope: string): boolean {
  return (COMPLIANCE_API_SCOPES as readonly string[]).includes(scope);
}

const ANCHOR_WRITE_SCOPES = new Set(['anchor:write', 'write:anchors']);

export function scopeSatisfies(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  if (ANCHOR_WRITE_SCOPES.has(required)) {
    return granted.some((scope) => ANCHOR_WRITE_SCOPES.has(scope));
  }
  // Legacy `verify` is a superset of `anchor:read` + `oracle:read` for keys
  // issued before SCRUM-1272. Treat the back-compat case explicitly so that
  // the old grants don't quietly stop working when handlers pivot to the new
  // scope names.
  if (required === 'anchor:read' || required === 'oracle:read') {
    return granted.includes('verify');
  }
  if (required === 'attestations:read') {
    return granted.includes('verify');
  }
  return false;
}
