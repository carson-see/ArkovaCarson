/**
 * SCRUM-1304 / SCRUM-1681 — Sonar gate verification logic tests.
 *
 * The HTTP fetch + main() are not unit-tested (network-bound); the pure
 * `verifyGate` function is tested across the full pass/fail matrix.
 */

import { describe, it, expect } from 'vitest';
import { shouldFailOnMissingToken, verifyGate, verifyNewCodeDefinition } from './check-sonar-quality-gate.js';

const COMPLETE_GATE = {
  id: 'gate-1',
  name: 'Sonar way',
  conditions: [
    { metric: 'new_coverage', op: 'LT' as const, error: '80' },
    { metric: 'new_duplicated_lines_density', op: 'GT' as const, error: '3' },
    { metric: 'new_security_rating', op: 'GT' as const, error: '1' },
    { metric: 'new_reliability_rating', op: 'GT' as const, error: '1' },
    { metric: 'new_maintainability_rating', op: 'GT' as const, error: '1' },
  ],
};

const BASELINE_TODAY = '2026-05-05';

function newCodeSettings(type: string, period: string) {
  return {
    'sonar.leak.period.type': type,
    'sonar.leak.period': period,
  };
}

describe('verifyGate (SCRUM-1304)', () => {
  it('passes on a complete Sonar way gate', () => {
    const r = verifyGate(COMPLETE_GATE);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.weak).toEqual([]);
  });

  it('fails when Coverage on New Code is missing entirely', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: COMPLETE_GATE.conditions.filter((c) => c.metric !== 'new_coverage'),
    });
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toContain('new_coverage');
  });

  it('fails when Coverage floor is below 80', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: [
        { metric: 'new_coverage', op: 'LT', error: '70' },
        ...COMPLETE_GATE.conditions.slice(1),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.weak[0]).toContain('new_coverage');
    expect(r.weak[0]).toContain('70');
  });

  it('fails when Duplications ceiling is above 3', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: COMPLETE_GATE.conditions.map((c) =>
        c.metric === 'new_duplicated_lines_density' ? { ...c, error: '5' } : c,
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.weak[0]).toContain('new_duplicated_lines_density');
  });

  it('fails when Security Rating ceiling is above A (1)', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: COMPLETE_GATE.conditions.map((c) =>
        c.metric === 'new_security_rating' ? { ...c, error: '2' } : c,
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.weak[0]).toContain('new_security_rating');
  });

  it('flags missing + weak conditions in the same response', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: [
        { metric: 'new_coverage', op: 'LT', error: '60' },
        { metric: 'new_duplicated_lines_density', op: 'GT', error: '3' },
        // missing: new_security_rating, new_reliability_rating, new_maintainability_rating
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(3);
    expect(r.weak).toHaveLength(1);
  });

  it('fails when the operator is wrong (defensive)', () => {
    const r = verifyGate({
      ...COMPLETE_GATE,
      conditions: COMPLETE_GATE.conditions.map((c) =>
        c.metric === 'new_coverage' ? { ...c, op: 'GT' as const, error: '80' } : c,
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.weak[0]).toContain('op');
  });
});

describe('verifyNewCodeDefinition (SCRUM-1681)', () => {
  it('passes on the 2026-05-05 manual baseline', () => {
    const r = verifyNewCodeDefinition(newCodeSettings('date', BASELINE_TODAY), BASELINE_TODAY);

    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails closed when SonarCloud drifts back to previous_version', () => {
    const r = verifyNewCodeDefinition(newCodeSettings('previous_version', 'previous_version'), BASELINE_TODAY);

    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      'sonar.leak.period.type is previous_version; expected date',
      'sonar.leak.period is previous_version; expected YYYY-MM-DD date >= 2026-05-05',
    ]);
  });

  it('fails when the baseline predates the 2026-05-05 reset', () => {
    const r = verifyNewCodeDefinition(newCodeSettings('date', '2026-03-11'), BASELINE_TODAY);

    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('before reset floor 2026-05-05');
  });

  it('fails when the baseline has an impossible calendar date', () => {
    const r = verifyNewCodeDefinition(newCodeSettings('date', '2026-02-31'), BASELINE_TODAY);

    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('not a real calendar date');
  });

  it('fails when a date baseline is set in the future', () => {
    const r = verifyNewCodeDefinition(newCodeSettings('date', '2026-05-06'), BASELINE_TODAY);

    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('is in the future');
  });
});

describe('shouldFailOnMissingToken (SCRUM-1681)', () => {
  it('fails closed when token is missing in GitHub Actions', () => {
    expect(shouldFailOnMissingToken({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(shouldFailOnMissingToken({ CI: 'true' })).toBe(true);
  });

  it('allows local tokenless runs to skip', () => {
    expect(shouldFailOnMissingToken({})).toBe(false);
  });
});
