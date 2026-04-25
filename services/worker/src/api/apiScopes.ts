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
  if (granted.includes(required)) return true;

  const equivalents: Record<string, readonly string[]> = {
    verify: ['read:records'],
    'verify:batch': ['read:records'],
  };

  return equivalents[required]?.some(scope => granted.includes(scope)) ?? false;
}
