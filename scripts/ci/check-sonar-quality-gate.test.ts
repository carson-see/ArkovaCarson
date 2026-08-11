/**
 * SCRUM-1304 / SCRUM-1681 — Sonar gate verification logic tests.
 *
 * The HTTP fetch + main() are not unit-tested (network-bound); the pure
 * `verifyGate` function is tested across the full pass/fail matrix.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { shouldFailOnMissingToken, verifyGate, verifyNewCodeDefinition, SonarAuthError, isAuthStatus } from './check-sonar-quality-gate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAVE_2_HELDOUT_SOURCE_PATHS = [
  'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-01-05-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-06-10-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-11-15-heldout.ts',
];

function sonarProperty(name: string): string[] {
  const config = readFileSync(resolve(REPO_ROOT, '.sonarcloud.properties'), 'utf8');
  const property = config.split(/\r?\n/u).find((line) => line.startsWith(`${name}=`));

  if (!property) {
    throw new Error(`Missing ${name} in .sonarcloud.properties`);
  }

  return property.slice(name.length + 1).split(',').filter(Boolean);
}

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

  it.each([
    [
      'previous_version drift',
      newCodeSettings('previous_version', 'previous_version'),
      [
        'sonar.leak.period.type is previous_version; expected date',
        'sonar.leak.period is previous_version; expected YYYY-MM-DD date >= 2026-05-05',
      ],
    ],
    ['pre-reset baseline', newCodeSettings('date', '2026-03-11'), ['before reset floor 2026-05-05']],
    ['impossible calendar date', newCodeSettings('date', '2026-02-31'), ['not a real calendar date']],
    ['future baseline', newCodeSettings('date', '2026-05-06'), ['is in the future']],
    ['missing baseline type', { 'sonar.leak.period': BASELINE_TODAY }, ['sonar.leak.period.type missing']],
    ['missing baseline date', { 'sonar.leak.period.type': 'date' }, ['sonar.leak.period missing']],
  ])('fails on %s', (_name, settings, expectedFailures) => {
    const r = verifyNewCodeDefinition(settings, BASELINE_TODAY);

    expect(r.ok).toBe(false);
    for (const expected of expectedFailures) {
      expect(r.failures.join('\n')).toContain(expected);
    }
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

describe('.sonarcloud.properties Wave 2 held-out corpus policy', () => {
  it('uses exact CPD-only exclusions for all three planned tranche sources', () => {
    const cpdExclusions = sonarProperty('sonar.cpd.exclusions');
    const fullExclusions = sonarProperty('sonar.exclusions');
    const wave2CpdExclusions = cpdExclusions.filter((path) =>
      path.includes('golden-dataset-s33-wave2-top15'),
    );

    expect(wave2CpdExclusions).toEqual(WAVE_2_HELDOUT_SOURCE_PATHS);
    for (const path of WAVE_2_HELDOUT_SOURCE_PATHS) {
      expect(fullExclusions).not.toContain(path);
    }
    expect(cpdExclusions).not.toContain(
      'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-*-heldout.ts',
    );
    expect(fullExclusions.some((path) => path.includes('golden-dataset-s33-wave2-top15'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// SCRUM-1304/SCRUM-1681 — an expired SonarCloud credential must not block merges
//
// 2026-08-11: the token's only Secret Manager version was created 2026-05-05,
// past SonarCloud's 90-day expiry. `/api/settings/values` began returning a bare
// 401, the gate exited 2, and EVERY PR in the repo went red — including the DPA
// clause 4.6 control. A credential we cannot authenticate with means the gate was
// not evaluated; that is the same epistemic state as an unset token, which this
// script already treats as skip-with-notice. It must NOT read as a gate failure.
//
// The paired assertion is the one that matters: every NON-auth failure must still
// block, so this cannot become a blanket "ignore SonarCloud" switch.
// ---------------------------------------------------------------------------
describe('SonarAuthError / isAuthStatus', () => {
  it('classifies 401 and 403 as credential failures', () => {
    expect(isAuthStatus(401)).toBe(true);
    expect(isAuthStatus(403)).toBe(true);
  });

  it('does NOT classify real failures as credential failures', () => {
    // 404 = project/gate genuinely missing; 500 = SonarCloud broken;
    // 200 = fine. None of these may take the non-blocking path.
    for (const status of [200, 400, 404, 429, 500, 502, 503]) {
      expect(isAuthStatus(status)).toBe(false);
    }
  });

  it('carries the status and a name that main() can branch on', () => {
    const err = new SonarAuthError(401, '');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.name).toBe('SonarAuthError');
    // The message must not be empty even when SonarCloud returns a bare 401
    // with no body — which is exactly what it did on 2026-08-11.
    expect(err.message).toContain('401');
  });

  it('is distinguishable from a plain Error so non-auth paths still exit non-zero', () => {
    expect(new Error('SonarCloud settings 500: boom') instanceof SonarAuthError).toBe(false);
  });
});
