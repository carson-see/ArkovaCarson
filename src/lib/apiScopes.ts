/**
 * API Scope Vocabulary (frontend)
 *
 * The wire-format vocabulary is imported from the worker source of truth.
 *
 * Use this module from any UI surface that lets a customer pick scopes or
 * displays the scopes attached to an existing key. Do NOT inline the strings.
 */
import { API_KEY_LABELS } from '@/lib/copy';
export {
  API_KEY_SCOPES,
  API_V2_SCOPES,
  COMPLIANCE_API_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  LEGACY_API_SCOPES,
  SELECTABLE_API_SCOPES as SELECTABLE_API_SCOPE_IDS,
  isApiV2Scope,
  isComplianceScope,
  scopeSatisfies,
  type ApiKeyScope as ApiScope,
  type ApiV2Scope,
} from '../../services/worker/src/api/apiScopes';
import {
  API_KEY_SCOPES,
  SELECTABLE_API_SCOPES as SELECTABLE_API_SCOPE_IDS,
  type ApiKeyScope as ApiScope,
} from '../../services/worker/src/api/apiScopes';

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
  'usage:read': API_KEY_LABELS.SCOPE_USAGE,
  'keys:manage': API_KEY_LABELS.SCOPE_KEYS_MANAGE,
  'compliance:read': API_KEY_LABELS.SCOPE_COMPLIANCE_READ,
  'compliance:write': API_KEY_LABELS.SCOPE_COMPLIANCE_WRITE,
  'oracle:read': API_KEY_LABELS.SCOPE_ORACLE_READ,
  'oracle:write': API_KEY_LABELS.SCOPE_ORACLE_WRITE,
  'anchor:read': API_KEY_LABELS.SCOPE_ANCHOR_READ,
  'anchor:write': API_KEY_LABELS.SCOPE_ANCHOR_WRITE,
  'attestations:read': API_KEY_LABELS.SCOPE_ATTESTATIONS_READ,
  'attestations:write': API_KEY_LABELS.SCOPE_ATTESTATIONS_WRITE,
  'webhooks:manage': API_KEY_LABELS.SCOPE_WEBHOOKS_MANAGE,
  'agents:manage': API_KEY_LABELS.SCOPE_AGENTS_MANAGE,
  'keys:read': API_KEY_LABELS.SCOPE_KEYS_READ,
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
  'usage:read': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'keys:manage': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'compliance:read': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'compliance:write': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'oracle:read': 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  'oracle:write': 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  'anchor:read': 'bg-amber-50 text-amber-700 border-amber-200',
  'anchor:write': 'bg-amber-50 text-amber-700 border-amber-200',
  'attestations:read': 'bg-lime-50 text-lime-700 border-lime-200',
  'attestations:write': 'bg-lime-50 text-lime-700 border-lime-200',
  'webhooks:manage': 'bg-purple-50 text-purple-700 border-purple-200',
  'agents:manage': 'bg-slate-50 text-slate-700 border-slate-200',
  'keys:read': 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

// Scopes shown in the "create API key" picker. Legacy scopes are accepted on
// the wire but not surfaced as choices for new keys.
export const SELECTABLE_API_SCOPES: ScopeDescriptor[] = SELECTABLE_API_SCOPE_IDS.map((id) => ({
  id,
  label: API_SCOPE_LABELS[id],
  className: API_SCOPE_BADGE_CLASSES[id],
}));

export function isApiScope(scope: string): scope is ApiScope {
  return (API_KEY_SCOPES as readonly string[]).includes(scope);
}
