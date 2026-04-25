import { describe, it, expect } from 'vitest';
import { scopeSatisfies, API_V2_SCOPES, LEGACY_API_SCOPES } from './apiScopes.js';

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
});
