import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  scopeSatisfies,
  API_V2_SCOPES,
  LEGACY_API_SCOPES,
  COMPLIANCE_API_SCOPES,
  API_KEY_SCOPES,
  SELECTABLE_API_SCOPES,
  isComplianceScope,
} from './apiScopes.js';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
}

describe('scopeSatisfies', () => {
  it('returns true when the required scope is directly present', () => {
    expect(scopeSatisfies(['read:records'], 'read:records')).toBe(true);
  });

  it('returns false when the required scope is absent', () => {
    expect(scopeSatisfies(['read:search'], 'read:records')).toBe(false);
  });

  it('does NOT let read:records satisfy verify', () => {
    expect(scopeSatisfies(['read:records'], 'verify')).toBe(false);
  });

  it('does NOT let read:records satisfy verify:batch', () => {
    expect(scopeSatisfies(['read:records'], 'verify:batch')).toBe(false);
  });

  it('lets verify satisfy verify directly', () => {
    expect(scopeSatisfies(['verify'], 'verify')).toBe(true);
  });

  it('lets verify:batch satisfy verify:batch directly', () => {
    expect(scopeSatisfies(['verify:batch'], 'verify:batch')).toBe(true);
  });

  it('returns false for empty granted array', () => {
    expect(scopeSatisfies([], 'read:records')).toBe(false);
  });

  it('exports all expected v2 scopes', () => {
    expect(API_V2_SCOPES).toContain('read:records');
    expect(API_V2_SCOPES).toContain('read:orgs');
    expect(API_V2_SCOPES).toContain('read:search');
    expect(API_V2_SCOPES).toContain('write:anchors');
    expect(API_V2_SCOPES).toContain('admin:rules');
  });

  it('exports all expected legacy scopes', () => {
    expect(LEGACY_API_SCOPES).toContain('verify');
    expect(LEGACY_API_SCOPES).toContain('verify:batch');
    expect(LEGACY_API_SCOPES).toContain('usage:read');
    expect(LEGACY_API_SCOPES).toContain('keys:manage');
    expect(LEGACY_API_SCOPES).not.toContain('batch');
    expect(LEGACY_API_SCOPES).not.toContain('usage');
  });

  // SCRUM-1272 (R2-9) — compliance scope vocabulary + back-compat semantics.
  it('exports the compliance scope set', () => {
    for (const scope of [
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
    ]) {
      expect(COMPLIANCE_API_SCOPES).toContain(scope);
      expect(isComplianceScope(scope)).toBe(true);
    }
  });

  it('treats legacy `verify` as a superset of anchor:read / oracle:read / attestations:read', () => {
    expect(scopeSatisfies(['verify'], 'anchor:read')).toBe(true);
    expect(scopeSatisfies(['verify'], 'oracle:read')).toBe(true);
    expect(scopeSatisfies(['verify'], 'attestations:read')).toBe(true);
  });

  it('does not let `verify` satisfy a write scope', () => {
    expect(scopeSatisfies(['verify'], 'anchor:write')).toBe(false);
    expect(scopeSatisfies(['verify'], 'oracle:write')).toBe(false);
    expect(scopeSatisfies(['verify'], 'attestations:write')).toBe(false);
    expect(scopeSatisfies(['verify'], 'compliance:read')).toBe(false);
  });

  it('keeps the frontend vocabulary imported from the worker source of truth', () => {
    const frontendSource = readRepoFile('src/lib/apiScopes.ts');

    expect(frontendSource).toContain("from '../../services/worker/src/api/apiScopes'");
    expect(frontendSource).not.toContain("export const API_V2_SCOPES = [");
    expect(frontendSource).not.toContain("'batch'");
    expect(frontendSource).not.toContain("'usage'");
  });

  it('keeps the database scope CHECK constraint aligned with the canonical vocabulary', () => {
    const migration = readRepoFile('supabase/migrations/0285_api_key_scope_vocabulary.sql');

    for (const scope of API_KEY_SCOPES) {
      expect(migration).toContain(`'${scope}'`);
    }
    expect(migration).toContain('api_keys_scopes_known_values');
    expect(migration).toContain('agents_allowed_scopes_known_values');
    expect(migration).toContain("WHEN 'attest' THEN 'attestations:write'");
    expect(migration).toContain("WHEN 'oracle' THEN 'oracle:read'");
    expect(migration).toContain("WHEN 'batch' THEN 'verify:batch'");
    expect(migration).toContain("WHEN 'usage' THEN 'usage:read'");
  });

  it('keeps new-key picker choices restricted to API v2 scopes', () => {
    expect(SELECTABLE_API_SCOPES).toEqual(API_V2_SCOPES);
  });

  it('keeps agent delegation schemas on the API key vocabulary', () => {
    const agentsSource = readRepoFile('services/worker/src/api/v1/agentSchemas.ts');

    expect(agentsSource).toContain("import { API_KEY_SCOPES } from '../apiScopes.js'");
    expect(agentsSource).toContain('z.enum(API_KEY_SCOPES)');
    expect(agentsSource).not.toContain("['verify', 'verify:batch', 'usage:read', 'attest', 'oracle']");
  });
});
