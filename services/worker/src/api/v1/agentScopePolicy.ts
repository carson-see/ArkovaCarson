import type { ApiKeyScope } from '../apiScopes.js';
/** Scopes a ComputeID passport-admitted agent may hold. */
export const PASSPORT_AGENT_SCOPE_ALLOWLIST: readonly ApiKeyScope[] = [
  'verify', 'verify:batch', 'anchor:write', 'write:anchors',
  'anchor:read', 'read:records', 'read:search',
];
