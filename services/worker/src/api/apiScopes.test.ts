import { describe, it, expect } from 'vitest';
import {
  scopeSatisfies,
  API_V2_SCOPES,
  LEGACY_API_SCOPES,
  SENSITIVE_V1_SCOPES,
  isSensitiveV1Scope,
  API_KEY_SCOPES,
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

  it('exports all SCRUM-1272 sensitive v1 scopes', () => {
    expect(SENSITIVE_V1_SCOPES).toContain('compliance:read');
    expect(SENSITIVE_V1_SCOPES).toContain('compliance:write');
    expect(SENSITIVE_V1_SCOPES).toContain('oracle:read');
    expect(SENSITIVE_V1_SCOPES).toContain('oracle:write');
    expect(SENSITIVE_V1_SCOPES).toContain('anchor:read');
    expect(SENSITIVE_V1_SCOPES).toContain('anchor:write');
    expect(SENSITIVE_V1_SCOPES).toContain('attestations:read');
    expect(SENSITIVE_V1_SCOPES).toContain('attestations:write');
    expect(SENSITIVE_V1_SCOPES).toContain('webhooks:manage');
    expect(SENSITIVE_V1_SCOPES).toContain('agents:manage');
    expect(SENSITIVE_V1_SCOPES).toContain('keys:read');
  });

  it('isSensitiveV1Scope narrows correctly', () => {
    expect(isSensitiveV1Scope('compliance:read')).toBe(true);
    expect(isSensitiveV1Scope('write:anchors')).toBe(false);
    expect(isSensitiveV1Scope('not-a-scope')).toBe(false);
  });

  it('API_KEY_SCOPES bundles legacy + v2 + sensitive', () => {
    for (const s of API_V2_SCOPES) expect(API_KEY_SCOPES).toContain(s);
    for (const s of LEGACY_API_SCOPES) expect(API_KEY_SCOPES).toContain(s);
    for (const s of SENSITIVE_V1_SCOPES) expect(API_KEY_SCOPES).toContain(s);
  });

  it('does NOT let read:records satisfy compliance:read', () => {
    expect(scopeSatisfies(['read:records'], 'compliance:read')).toBe(false);
  });

  it('lets compliance:read satisfy compliance:read directly', () => {
    expect(scopeSatisfies(['compliance:read'], 'compliance:read')).toBe(true);
  });
});
