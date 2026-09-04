import { describe, it, expect } from 'vitest';
import {
  planRederivabilityRequests,
  claimsFetchTimeMeasurement,
  judgeRederivability,
  DECLARED_PUBLIC_ID,
  MEASURED_PUBLIC_ID,
} from './declared-hash-rederivability-driver';

const BASE = 'https://arkova-worker-decl2499-staging.example.invalid';
const ok = (body: unknown) => ({ status: 200, body: body as never });

/** A post-fix body for the declared row: the claim is simply absent. */
const declaredFixed = { public_id: DECLARED_PUBLIC_ID, verified: true };
/** A pre-fix body: the exact over-claim #2499 removes. */
const declaredUnfixed = {
  public_id: DECLARED_PUBLIC_ID,
  verified: true,
  fingerprint_rederivability: 'fetch_time_snapshot',
  fingerprint_rederivability_note: 'Measured: this record is marked as connector-sourced…',
};
const measured = {
  public_id: MEASURED_PUBLIC_ID,
  verified: true,
  fingerprint_rederivability: 'fetch_time_snapshot',
};

describe('planRederivabilityRequests', () => {
  it('drives the controlled pair, the proof surface, and a cache re-read', () => {
    const plan = planRederivabilityRequests(BASE);
    expect(plan.map((p) => p.label)).toEqual([
      'declared-hash', 'measured', 'declared-proof-surface', 'cached-declared',
    ]);
    expect(plan.every((p) => p.url.startsWith(BASE))).toBe(true);
    expect(plan.every((p) => p.allowedStatuses.includes(200))).toBe(true);
  });

  it('re-reads the SAME declared id for the cache label, so a stale body is a label DIFFERENCE', () => {
    const plan = planRederivabilityRequests(BASE);
    const declared = plan.find((p) => p.label === 'declared-hash');
    const cached = plan.find((p) => p.label === 'cached-declared');
    expect(cached?.endpoint).toBe(declared?.endpoint);
  });
});

describe('claimsFetchTimeMeasurement', () => {
  it('detects the claim via either field', () => {
    expect(claimsFetchTimeMeasurement(declaredUnfixed as never)).toBe(true);
    expect(claimsFetchTimeMeasurement({ fingerprint_rederivability_note: 'x' } as never)).toBe(true);
  });
  it('is false for a clean body and for non-objects', () => {
    expect(claimsFetchTimeMeasurement(declaredFixed as never)).toBe(false);
    expect(claimsFetchTimeMeasurement(null)).toBe(false);
    expect(claimsFetchTimeMeasurement('boom' as never)).toBe(false);
  });
});

describe('judgeRederivability', () => {
  it('passes clean on fixed code', () => {
    const v = judgeRederivability({
      'declared-hash': ok(declaredFixed),
      measured: ok(measured),
      'cached-declared': ok(declaredFixed),
      'declared-proof-surface': ok(declaredFixed),
    });
    expect(v.deviations).toEqual([]);
    expect(v.claimed).toEqual(['measured']);
  });

  // THE POINT OF THE DRIVER: it must fail against the unfixed build.
  it('FAILS against pre-#2499 code, naming the over-claim', () => {
    const v = judgeRederivability({
      'declared-hash': ok(declaredUnfixed),
      measured: ok(measured),
      'cached-declared': ok(declaredUnfixed),
    });
    expect(v.deviations.length).toBeGreaterThan(0);
    expect(v.deviations.join(' ')).toContain('must not claim a measured');
  });

  it('FAILS when a stale verify cache re-serves the old shape on the cached read only', () => {
    const v = judgeRederivability({
      'declared-hash': ok(declaredFixed),
      measured: ok(measured),
      'cached-declared': ok(declaredUnfixed),
    });
    expect(v.deviations.some((d) => d.startsWith('cached-declared'))).toBe(true);
  });

  it('FAILS on over-suppression — a build that hides the claim everywhere', () => {
    const v = judgeRederivability({
      'declared-hash': ok(declaredFixed),
      measured: ok({ public_id: MEASURED_PUBLIC_ID, verified: true }),
      'cached-declared': ok(declaredFixed),
      'declared-proof-surface': ok(declaredFixed),
    });
    expect(v.deviations.join(' ')).toContain('over-suppression');
    expect(v.deviations.join(' ')).toContain('DISCRIMINATOR FAILED');
  });

  it('FAILS loudly rather than passing vacuously when the fixture is missing', () => {
    const v = judgeRederivability({
      'declared-hash': { status: 404, body: null },
      measured: { status: 404, body: null },
    });
    expect(v.declaredResolved).toBe(false);
    expect(v.deviations.join(' ')).toContain('POSITIVE CONTROL FAILED');
  });
});


describe('proof and cache positive controls', () => {
  const clean = () => ({
    'declared-hash': ok(declaredFixed),
    measured: ok(measured),
    'cached-declared': ok(declaredFixed),
    'declared-proof-surface': ok(declaredFixed),
  });
  it.each(['declared-proof-surface', 'cached-declared'] as const)(
    'rejects a missing or errored %s instead of counting absence as success', (label) => {
      for (const outcome of [undefined, { status: 404, body: null }, ok(null), ok({ error: 'missing' })]) {
        const bodies: Parameters<typeof judgeRederivability>[0] = clean();
        if (outcome === undefined) delete bodies[label];
        else bodies[label] = outcome;
        expect(judgeRederivability(bodies).deviations.join(' ')).toContain(label);
      }
    },
  );
  it('rejects a fetch-time claim on the proof endpoint', () => {
    expect(judgeRederivability({ ...clean(), 'declared-proof-surface': ok(declaredUnfixed) })
      .deviations.join(' ')).toContain('declared-proof-surface carried');
  });
});
