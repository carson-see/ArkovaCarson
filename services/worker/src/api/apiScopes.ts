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

export const API_KEY_SCOPES = [
  ...API_V2_SCOPES,
  ...LEGACY_API_SCOPES,
] as const;

export type ApiV2Scope = typeof API_V2_SCOPES[number];
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export const DEFAULT_API_KEY_SCOPES: ApiV2Scope[] = ['read:search'];

export function isApiV2Scope(scope: string): scope is ApiV2Scope {
  return (API_V2_SCOPES as readonly string[]).includes(scope);
}

export function scopeSatisfies(granted: string[], required: string): boolean {
  // Strict-only: each grant must be explicit. The previous alias map let a
  // `read:records` (passive lookup) key satisfy `verify` / `verify:batch`
  // (active verification, billable) — keys provisioned for read-only access
  // could call billable verify endpoints. Customers who relied on the alias
  // need a re-issued key with the correct scope.
  return granted.includes(required);
}
