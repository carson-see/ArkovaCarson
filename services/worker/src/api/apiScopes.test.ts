import { describe, it, expect } from 'vitest';
import {
  API_KEY_SCOPES,
  API_V2_SCOPES,
  isApiV2Scope,
  scopeSatisfies,
} from './apiScopes.js';

describe('scopeSatisfies', () => {
  it('returns true on exact scope match', () => {
    expect(scopeSatisfies(['verify'], 'verify')).toBe(true);
    expect(scopeSatisfies(['read:records', 'verify'], 'verify')).toBe(true);
  });

  it('returns false when the required scope is not granted', () => {
    expect(scopeSatisfies([], 'verify')).toBe(false);
    expect(scopeSatisfies(['usage:read'], 'verify')).toBe(false);
  });

  it('SCRUM-1223: read:records does NOT satisfy verify or verify:batch', () => {
    // The previous implementation aliased verify ← read:records, letting a
    // read-only key call billable verification endpoints. Strict-only now.
    expect(scopeSatisfies(['read:records'], 'verify')).toBe(false);
    expect(scopeSatisfies(['read:records'], 'verify:batch')).toBe(false);
  });

  it('SCRUM-1223: read:records still satisfies itself', () => {
    expect(scopeSatisfies(['read:records'], 'read:records')).toBe(true);
  });
});

describe('isApiV2Scope', () => {
  it('recognizes every entry in API_V2_SCOPES', () => {
    for (const scope of API_V2_SCOPES) {
      expect(isApiV2Scope(scope)).toBe(true);
    }
  });

  it('rejects legacy and arbitrary scopes', () => {
    expect(isApiV2Scope('verify')).toBe(false);
    expect(isApiV2Scope('keys:manage')).toBe(false);
    expect(isApiV2Scope('arbitrary:nonsense')).toBe(false);
  });
});

describe('API_KEY_SCOPES', () => {
  it('contains every v2 scope and every legacy scope, no duplicates', () => {
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
  });
});
