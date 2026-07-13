import { describe, expect, it } from 'vitest';

import {
  BATCH_SIZE,
  buildR3AcceptancePlan,
  planGlobalFlushForOrgs,
  planOrgScheduler,
  resolveRigTarget,
  runOrgId,
  runOrgIdN,
  zipfOrgPlan,
  PROD_PROJECT_REF,
} from './batch-drain-harness-lib';

describe('resolveRigTarget — prod is hard-blocked, only real staging refs pass', () => {
  const CLEAN = 'https://ujtlwnoqfhtitcmsnrpq.supabase.co';

  it('requires STAGING_SUPABASE_URL', () => {
    expect(() => resolveRigTarget(undefined)).toThrow(/STAGING_SUPABASE_URL is required/);
    expect(() => resolveRigTarget('   ')).toThrow(/STAGING_SUPABASE_URL is required/);
  });

  it('HARD-BLOCKS the prod project ref anywhere in the URL', () => {
    expect(() => resolveRigTarget(`https://${PROD_PROJECT_REF}.supabase.co`)).toThrow(/prod project ref/);
    // even if smuggled into a path or query
    expect(() => resolveRigTarget(`https://ujtlwnoqfhtitcmsnrpq.supabase.co/${PROD_PROJECT_REF}`)).toThrow(/prod project ref/);
  });

  it('rejects non-absolute URLs', () => {
    expect(() => resolveRigTarget('ujtlwnoqfhtitcmsnrpq.supabase.co')).toThrow(/absolute URL/);
  });

  it('rejects an attacker-controlled host that merely prefixes a valid ref label', () => {
    // full-host match closes the `<ref>.attacker.tld` hole
    expect(() => resolveRigTarget('https://ujtlwnoqfhtitcmsnrpq.attacker.tld')).toThrow(/must be <ref>\.supabase\.co/);
  });

  it('rejects a host whose leftmost label is not a 20-lowercase-letter ref', () => {
    expect(() => resolveRigTarget('https://short.supabase.co')).toThrow(/valid Supabase ref/);
    expect(() => resolveRigTarget('https://ujtlwnoqfht1tcmsnrpq.supabase.co')).toThrow(/valid Supabase ref/); // digit
    expect(() => resolveRigTarget('https://ujtlwnoqfhtitcmsnrpqx.supabase.co')).toThrow(/valid Supabase ref/); // 21 chars
  });

  it('accepts a clean isolated staging ref', () => {
    const t = resolveRigTarget(CLEAN);
    expect(t.ref).toBe('ujtlwnoqfhtitcmsnrpq');
    expect(t.url).toBe(CLEAN);
  });

  it('honors ALLOWED_STAGING_PROJECT_REFS as a positive allow-list', () => {
    // ref present → ok
    expect(resolveRigTarget(CLEAN, 'ujtlwnoqfhtitcmsnrpq,abcdefghijklmnopqrst').ref).toBe('ujtlwnoqfhtitcmsnrpq');
    // ref absent → refused
    expect(() => resolveRigTarget(CLEAN, 'abcdefghijklmnopqrst')).toThrow(/not in ALLOWED_STAGING_PROJECT_REFS/);
  });

  it('rejects an allow-list that itself contains the prod ref or a malformed entry', () => {
    expect(() => resolveRigTarget(CLEAN, PROD_PROJECT_REF)).toThrow(/invalid/);
    expect(() => resolveRigTarget(CLEAN, 'notavalidref')).toThrow(/invalid/);
  });
});

describe('runOrgId — stable, v4-shaped synthetic org per run', () => {
  it('is deterministic for a given run id', () => {
    expect(runOrgId('r1')).toBe(runOrgId('r1'));
    expect(runOrgId('r1')).not.toBe(runOrgId('r2'));
  });

  it('is shaped like a v4 UUID', () => {
    expect(runOrgId('anything')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('requires a run id', () => {
    expect(() => runOrgId('')).toThrow(/runId is required/);
  });
});

describe('zipfOrgPlan — deterministic multi-org population', () => {
  it('builds a 30-org whale/long-tail plan whose counts sum exactly', () => {
    const plan = zipfOrgPlan({
      runId: 's33-wave',
      orgs: 30,
      count: 12_500,
      s: 1,
      whales: 3,
      whaleShare: 0.5,
      creditStarved: 2,
      badFingerprint: 0,
    });

    expect(plan).toHaveLength(30);
    expect(plan.reduce((sum, row) => sum + row.anchors, 0)).toBe(12_500);
    expect(plan.every((row) => row.anchors >= 1)).toBe(true);
    expect(plan.map((row) => row.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(plan.map((row) => row.orgId)).size).toBe(30);
    expect(plan.map((row) => row.anchors)).toEqual([...plan].map((row) => row.anchors).sort((a, b) => b - a));

    const whaleShare = plan.slice(0, 3).reduce((sum, row) => sum + row.anchors, 0) / 12_500;
    expect(whaleShare).toBeCloseTo(0.5, 2);
  });

  it('assigns deterministic seedable credit-starved orgs and rejects DB-unseedable fingerprints', () => {
    const input = {
      runId: 's33-poison',
      orgs: 30,
      count: 10_000,
      s: 1,
      whales: 3,
      whaleShare: 0.5,
      creditStarved: 2,
      badFingerprint: 0,
    } as const;
    const first = zipfOrgPlan(input);
    const second = zipfOrgPlan(input);

    expect(second).toEqual(first);
    expect(first.filter((row) => row.cohort === 'credit-starved').map((row) => row.rank)).toEqual([29, 30]);
    expect(first.filter((row) => row.cohort === 'healthy')).toHaveLength(28);
    expect(() => zipfOrgPlan({ ...input, badFingerprint: 1 })).toThrow(/DB-unseedable/);
  });

  it('keeps index zero backward-compatible and creates unique v4-shaped org ids', () => {
    expect(runOrgIdN('r1', 0)).toBe(runOrgId('r1'));
    expect(runOrgIdN('r1', 1)).not.toBe(runOrgIdN('r1', 2));
    expect(runOrgIdN('r1', 29)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() => runOrgIdN('r1', -1)).toThrow(/index/);
  });
});

describe('R3 trigger expectations — org scheduler and global flush stay distinct', () => {
  it('models claim-before-credit-gate from deterministic ordered rows', () => {
    const rows = [
      { orgId: runOrgIdN('global-poison', 0), rank: 1, anchors: 11_500, cohort: 'healthy' as const },
      { orgId: runOrgIdN('global-poison', 1), rank: 2, anchors: 1_000, cohort: 'credit-starved' as const },
    ];
    const expected = planGlobalFlushForOrgs(rows);

    expect(expected.initialPending).toBe(12_500);
    expect(expected.orderedRows).toHaveLength(12_500);
    expect(new Set(expected.orderedRows.map((row) => row.rowId)).size).toBe(12_500);
    expect(expected.orderedRows.map((row) => row.claimOrder)).toEqual(
      Array.from({ length: 12_500 }, (_, index) => index + 1),
    );
    expect(expected.passes[0]).toMatchObject({
      pass: 1,
      claimedLeaves: 10_000,
      transactions: 1,
    });
    expect(expected.passes[0]!.eligibleLeaves).toBeLessThan(10_000);
    expect(expected.passes[0]!.excludedLeaves).toBeGreaterThan(0);
    expect(expected.passes[0]!.leaves).toBe(expected.passes[0]!.eligibleLeaves);
    expect(expected.passes[0]!.pendingRemainder).toBe(
      expected.initialPending - expected.passes[0]!.eligibleLeaves,
    );
    expect(expected.passes[expected.passes.length - 1]).toMatchObject({
      transactions: 0,
      eligibleLeaves: 0,
      pendingRemainder: 1_000,
    });
    expect(expected.stalledOnPoison).toBe(true);
    expect(expected.poisons).toEqual([
      {
        orgId: rows[1]!.orgId,
        cohort: 'credit-starved',
        anchorsRemaining: 1_000,
        globalOutcome: 'credit-gate-excluded',
      },
    ]);
  });

  it('fails closed on empty or unknown-cohort global org inputs', () => {
    expect(() => planGlobalFlushForOrgs([])).toThrow(/at least one org input/);
    expect(() => planGlobalFlushForOrgs([{
      orgId: runOrgIdN('unknown-cohort', 0),
      rank: 1,
      anchors: 1,
      cohort: 'unknown' as never,
    }])).toThrow(/cohort/);
    expect(() => planGlobalFlushForOrgs([{
      orgId: runOrgIdN('bad-fingerprint', 0),
      rank: 1,
      anchors: 1,
      cohort: 'bad-fingerprint',
    }])).toThrow(/DB-unseedable/);
  });

  it('models a >10k org as exactly one tx per scheduler pass', () => {
    const orgId = runOrgIdN('single-org-cross-pass', 0);
    const expected = planOrgScheduler([{ orgId, rank: 1, anchors: 12_500, cohort: 'healthy' }]);

    expect(expected.totalTransactions).toBe(2);
    expect(expected.passes).toEqual([
      { pass: 1, transactions: [{ orgId, leaves: BATCH_SIZE }] },
      { pass: 2, transactions: [{ orgId, leaves: 2_500 }] },
    ]);
    expect(expected.passes.every((pass) => pass.transactions.filter((tx) => tx.orgId === orgId).length === 1)).toBe(true);
  });

  it('keeps poison orgs pending while healthy neighbors retain one tx per pass', () => {
    const rows = zipfOrgPlan({
      runId: 's33-r3',
      orgs: 30,
      count: 12_500,
      creditStarved: 2,
      badFingerprint: 0,
    });
    const expected = planOrgScheduler(rows);

    expect(expected.poisons).toHaveLength(2);
    expect(expected.poisons.filter((row) => row.schedulerOutcome === 'succeeded-no-broadcast')).toHaveLength(2);
    for (const pass of expected.passes) {
      expect(new Set(pass.transactions.map((tx) => tx.orgId)).size).toBe(pass.transactions.length);
    }
  });

  it('builds the complete bounded acceptance plan and fails closed below 30 orgs', () => {
    const expected = buildR3AcceptancePlan({ runId: 's33-acceptance' });

    expect(expected.batchSize).toBe(10_000);
    expect(expected.distribution).toHaveLength(30);
    expect(expected.globalEligible10000.initialPending).toBe(10_000);
    expect(expected.globalEligible10000.poisons).toHaveLength(0);
    expect(expected.globalEligible10000.passes.map((pass) => ({
      leaves: pass.leaves,
      pendingRemainder: pass.pendingRemainder,
    }))).toEqual([{ leaves: 10_000, pendingRemainder: 0 }]);
    expect(expected.globalEligible12500.initialPending).toBe(12_500);
    expect(expected.globalEligible12500.poisons).toHaveLength(0);
    expect(expected.globalEligible12500.passes.map((pass) => ({
      leaves: pass.leaves,
      pendingRemainder: pass.pendingRemainder,
    }))).toEqual([
      { leaves: 10_000, pendingRemainder: 2_500 },
      { leaves: 2_500, pendingRemainder: 0 },
    ]);
    expect(expected.poisonIsolation.poisons).toHaveLength(2);
    expect(expected.singleOrgCrossPass.totalTransactions).toBe(2);
    const scenarioRankOneOrgIds = [
      expected.distribution[0]!.orgId,
      expected.globalEligible10000.orgInputs[0]!.orgId,
      expected.globalEligible12500.orgInputs[0]!.orgId,
      expected.poisonIsolation.orgInputs[0]!.orgId,
      expected.singleOrgCrossPass.passes[0]!.transactions[0]!.orgId,
    ];
    expect(new Set(scenarioRankOneOrgIds).size).toBe(scenarioRankOneOrgIds.length);
    expect(() => buildR3AcceptancePlan({ runId: 'too-small', orgs: 29 })).toThrow(/at least 30 orgs/);
  });
});
