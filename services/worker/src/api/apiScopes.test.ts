import { describe, it, expect } from 'vitest';
import {
  scopeSatisfies,
  API_V2_SCOPES,
  LEGACY_API_SCOPES,
  COMPLIANCE_API_SCOPES,
  isComplianceScope,
} from './apiScopes.js';

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
});
