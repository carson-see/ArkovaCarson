/**
 * API Scope Vocabulary (frontend)
 *
 * Mirrors `services/worker/src/api/apiScopes.ts`. The worker keeps its own copy
 * because it ships in a different runtime (Node + Express, no browser bundling).
 * If you change one, change the other — both must agree on the wire-format.
 *
 * Use this module from any UI surface that lets a customer pick scopes or
 * displays the scopes attached to an existing key. Do NOT inline the strings.
 */
import { API_KEY_LABELS } from '@/lib/copy';

export const API_V2_SCOPES = [
  'read:records',
  'read:orgs',
  'read:search',
  'write:anchors',
  'admin:rules',
] as const;

// Legacy v1 scopes still accepted by the worker for backward compatibility.
// `usage:read` and `keys:manage` are enforced by routes in
// services/worker/src/api/v1/router.ts (see :218, :221).
// `batch` / `usage` are short-form aliases the v1 schema has accepted since
// before the colon-prefixed canonical names existed.
export const LEGACY_API_SCOPES = [
  'verify',
  'verify:batch',
  'batch',
  'usage:read',
  'usage',
  'keys:manage',
] as const;

export const API_KEY_SCOPES = [
  ...API_V2_SCOPES,
  ...LEGACY_API_SCOPES,
] as const;

export type ApiV2Scope = (typeof API_V2_SCOPES)[number];
export type LegacyApiScope = (typeof LEGACY_API_SCOPES)[number];
export type ApiScope = (typeof API_KEY_SCOPES)[number];

export const DEFAULT_API_KEY_SCOPES: ApiV2Scope[] = ['read:search'];

export interface ScopeDescriptor {
  id: ApiScope;
  label: string;
  className?: string;
}

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  'read:records': API_KEY_LABELS.SCOPE_READ_RECORDS,
  'read:orgs': API_KEY_LABELS.SCOPE_READ_ORGS,
  'read:search': API_KEY_LABELS.SCOPE_READ_SEARCH,
  'write:anchors': API_KEY_LABELS.SCOPE_WRITE_ANCHORS,
  'admin:rules': API_KEY_LABELS.SCOPE_ADMIN_RULES,
  verify: API_KEY_LABELS.SCOPE_VERIFY,
  'verify:batch': API_KEY_LABELS.SCOPE_BATCH,
  batch: API_KEY_LABELS.SCOPE_BATCH,
  'usage:read': API_KEY_LABELS.SCOPE_USAGE,
  usage: API_KEY_LABELS.SCOPE_USAGE,
  'keys:manage': API_KEY_LABELS.SCOPE_USAGE,
};

// Tailwind class names per scope, used by ApiKeyScopeDisplay badges.
export const API_SCOPE_BADGE_CLASSES: Record<ApiScope, string> = {
  'read:search': 'bg-sky-50 text-sky-700 border-sky-200',
  'read:records': 'bg-teal-50 text-teal-700 border-teal-200',
  'read:orgs': 'bg-cyan-50 text-cyan-700 border-cyan-200',
  'write:anchors': 'bg-amber-50 text-amber-700 border-amber-200',
  'admin:rules': 'bg-rose-50 text-rose-700 border-rose-200',
  verify: 'bg-blue-50 text-blue-700 border-blue-200',
  'verify:batch': 'bg-violet-50 text-violet-700 border-violet-200',
  batch: 'bg-violet-50 text-violet-700 border-violet-200',
  'usage:read': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  usage: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'keys:manage': 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

// Scopes shown in the "create API key" picker. Legacy scopes are accepted on
// the wire but not surfaced as choices for new keys.
export const SELECTABLE_API_SCOPES: ScopeDescriptor[] = API_V2_SCOPES.map((id) => ({
  id,
  label: API_SCOPE_LABELS[id],
  className: API_SCOPE_BADGE_CLASSES[id],
}));

export function isApiV2Scope(scope: string): scope is ApiV2Scope {
  return (API_V2_SCOPES as readonly string[]).includes(scope);
}

export function isApiScope(scope: string): scope is ApiScope {
  return (API_KEY_SCOPES as readonly string[]).includes(scope);
}
