/**
 * KAU-05 (SCRUM-753) — golden scenario generator tests.
 *
 * Pure functions; no network. Enforces the AC coverage bar of ≥20
 * scenarios per jurisdiction and confirms every generated scenario
 * points at a real credential id in the canonical registry.
 */

import { describe, expect, it } from 'vitest';
import { KAU_CREDENTIAL_TYPES } from './credentials';
import {
  balancedKauScenarios,
  kauGoldenScenarios,
  validateKauGoldenCoverage,
} from './golden-scenarios';

describe('KAU golden scenarios', () => {
  it('validates clean at the 20-per-jurisdiction acceptance bar', () => {
    expect(validateKauGoldenCoverage(20)).toEqual([]);
  });

  it('produces ≥20 Kenya scenarios', () => {
    const ke = kauGoldenScenarios().filter((s) => s.jurisdiction === 'KE');
    expect(ke.length).toBeGreaterThanOrEqual(20);
  });

  it('produces ≥20 Australia scenarios', () => {
    const au = kauGoldenScenarios().filter((s) => s.jurisdiction === 'AU');
    expect(au.length).toBeGreaterThanOrEqual(20);
  });

  it('every scenario points at a real credential id', () => {
    const ids = new Set(KAU_CREDENTIAL_TYPES.map((c) => c.id));
    for (const s of kauGoldenScenarios()) {
      expect(ids.has(s.expected.subType)).toBe(true);
    }
  });

  it('every scenario id is unique', () => {
    const seen = new Set<string>();
    for (const s of kauGoldenScenarios()) {
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
    }
  });

  it('confidence is always within [0.5, 0.99]', () => {
    for (const s of kauGoldenScenarios()) {
      expect(s.expected.confidence).toBeGreaterThan(0.5);
      expect(s.expected.confidence).toBeLessThanOrEqual(0.99);
    }
  });

  it('balancedKauScenarios returns exactly N per jurisdiction', () => {
    const got = balancedKauScenarios(10);
    expect(got.filter((s) => s.jurisdiction === 'KE')).toHaveLength(10);
    expect(got.filter((s) => s.jurisdiction === 'AU')).toHaveLength(10);
  });

  it('validateKauGoldenCoverage surfaces shortage when bar raised above available supply', () => {
    const errs = validateKauGoldenCoverage(100);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('Kenya'))).toBe(true);
    expect(errs.some((e) => e.includes('Australia'))).toBe(true);
  });
});
