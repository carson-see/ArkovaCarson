import { describe, expect, it } from 'vitest';

import {
  classifyPath,
  planClassifyRequests,
  interpretCensusOutcome,
  CLASSIFY_DRIVER,
} from './classify-backcatalog-driver';

/**
 * L2-S8 (Sprint 3.3) — red-first test for the #1410 back-catalog classifier
 * targeted soak driver, per the folder contract: pure plan*() logic is
 * unit-tested with no network, no env, no live rig.
 */

const BASE = 'https://pr-1410---arkova-worker-staging-x-uc.a.run.app';

describe('classify-backcatalog-driver: plan purity', () => {
  const plan = planClassifyRequests(BASE);

  it('is deterministic — same apiBase yields an identical plan (no env/clock/network input)', () => {
    expect(planClassifyRequests(BASE)).toEqual(plan);
  });

  it('every request is a POST on the classifier path with capture enabled', () => {
    expect(plan.length).toBeGreaterThan(0);
    for (const p of plan) {
      expect(p.method).toBe('POST');
      expect(p.endpoint).toMatch(/^\/jobs\/classify-proof-backcatalog/);
      expect(p.url).toBe(`${BASE}${p.endpoint}`);
      expect(p.capture).toBe(true);
    }
  });

  it('every census call is DRY-RUN — `execute` never appears in any query string', () => {
    // SAFETY invariant: the census must perform ZERO proof-catalogue writes.
    for (const p of plan) {
      expect(p.endpoint).not.toMatch(/[?&]execute=/);
    }
  });

  it('drives the three census branches: default dry-run, bounded cursor, restart', () => {
    const censusDryRun = plan.find((p) => p.label === 'census-dry-run');
    expect(censusDryRun).toBeDefined();
    expect(censusDryRun!.endpoint).toBe('/jobs/classify-proof-backcatalog');
    expect(censusDryRun!.allowedStatuses).toContain(200);

    const bounded = plan.find((p) => p.label === 'census-bounded');
    expect(bounded).toBeDefined();
    expect(bounded!.endpoint).toContain('batch_size=50');
    expect(bounded!.endpoint).toContain('max_batches=2');
    expect(bounded!.allowedStatuses).toContain(200);

    const restart = plan.find((p) => p.label === 'census-restart');
    expect(restart).toBeDefined();
    expect(restart!.endpoint).toContain('restart=true');
    expect(restart!.allowedStatuses).toContain(200);
  });
});

describe('classify-backcatalog-driver: the two 400 guards', () => {
  const plan = planClassifyRequests(BASE);

  it('drives the batch_size floor guard (below the 50 floor → 400 expected evidence)', () => {
    const guard = plan.find((p) => p.label === 'guard-bad-batch-size');
    expect(guard).toBeDefined();
    expect(guard!.endpoint).toContain('batch_size=1');
    // A 400 here IS the branch under test — expected evidence, not a failure.
    expect(guard!.allowedStatuses).toContain(400);
    expect(guard!.allowedStatuses).not.toContain(200);
  });

  it('drives the org_id uuid guard (malformed org_id → 400 expected evidence)', () => {
    const guard = plan.find((p) => p.label === 'guard-bad-org');
    expect(guard).toBeDefined();
    expect(guard!.endpoint).toContain('org_id=not-a-uuid');
    expect(guard!.allowedStatuses).toContain(400);
    expect(guard!.allowedStatuses).not.toContain(200);
  });
});

describe('classify-backcatalog-driver: classifyPath query building', () => {
  it('returns the bare endpoint with no query params', () => {
    expect(classifyPath()).toBe('/jobs/classify-proof-backcatalog');
    expect(classifyPath({})).toBe('/jobs/classify-proof-backcatalog');
  });

  it('URL-encodes query values', () => {
    expect(classifyPath({ org_id: 'a b' })).toBe('/jobs/classify-proof-backcatalog?org_id=a%20b');
  });

  it('joins multiple params with &', () => {
    expect(classifyPath({ batch_size: 50, max_batches: 2 })).toBe(
      '/jobs/classify-proof-backcatalog?batch_size=50&max_batches=2',
    );
  });
});

describe('classify-backcatalog-driver: census interpreter', () => {
  it('reads the honest per-class counts from a 200 census body, dropping unknown keys', () => {
    const out = interpretCensusOutcome({
      mode: 'census',
      dryRun: true,
      direct_anchored: 120,
      batch_provable: 45,
      already_complete: 6110,
      ambiguous: 3,
      some_unrelated_key: 'dropped',
    });
    expect(out).toEqual({
      mode: 'census',
      dryRun: true,
      direct_anchored: 120,
      batch_provable: 45,
      already_complete: 6110,
      ambiguous: 3,
    });
  });

  it('returns null for a body lacking the plan shape (e.g. a 400 guard error body)', () => {
    expect(interpretCensusOutcome({ error: 'batch_size must be >= 50' })).toBeNull();
  });

  it('returns null for non-object bodies rather than throwing', () => {
    expect(interpretCensusOutcome(null)).toBeNull();
    expect(interpretCensusOutcome('raw text')).toBeNull();
    expect(interpretCensusOutcome([1, 2, 3])).toBeNull();
  });
});

describe('classify-backcatalog-driver: metadata', () => {
  it('names PR #1410 and the driver', () => {
    expect(CLASSIFY_DRIVER.pr).toBe('#1410');
    expect(CLASSIFY_DRIVER.driver).toBe('classify-backcatalog');
  });
});
