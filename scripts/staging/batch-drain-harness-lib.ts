/**
 * Pure, side-effect-free helpers for scripts/staging/batch-drain-harness.ts.
 *
 * Split out (mirrors load-harness-env.ts) so the safety guards can be unit
 * tested without importing the harness entrypoint, which runs main() on load
 * and needs live rig credentials. NOTHING here touches the network or a DB.
 */

import { createHash } from 'node:crypto';

export const PROD_PROJECT_REF = 'vzwyaatejekddvltxyye';
export const BATCH_SIZE = 10_000;

export interface RigTarget {
  url: string;
  ref: string;
}

/**
 * Validate that a Supabase URL points at a permitted, non-prod rig.
 *
 * Layered exactly like scripts/staging/seed.ts:
 *   1. Hard-block: the prod project ref must never appear anywhere in the URL.
 *   2. Format: host must be `<20-lowercase-letters>.supabase.co`.
 *   3. Allow-list: if ALLOWED_STAGING_PROJECT_REFS is set, the ref must be in
 *      it (and every entry is format-checked + prod-blocked).
 *
 * Throws on any violation; returns the resolved {url, ref} on success.
 */
export function resolveRigTarget(
  url: string | undefined,
  allowedRefsRaw?: string,
): RigTarget {
  const trimmed = url?.trim();
  if (!trimmed) throw new Error('STAGING_SUPABASE_URL is required.');

  if (new RegExp(PROD_PROJECT_REF, 'i').test(trimmed)) {
    throw new Error(`STAGING_SUPABASE_URL contains prod project ref ${PROD_PROJECT_REF}. Refusing to run.`);
  }

  let host: string;
  try {
    host = new URL(trimmed).hostname;
  } catch {
    throw new Error(`STAGING_SUPABASE_URL must be an absolute URL; received \`${trimmed}\`.`);
  }

  // Strict full-host match: ref is the leftmost label and the host must be
  // exactly `<ref>.supabase.co` (a leftmost-label-only check would accept
  // `<ref>.attacker.tld`).
  const suffix = '.supabase.co';
  if (!host.endsWith(suffix)) {
    throw new Error(`STAGING_SUPABASE_URL host \`${host}\` must be <ref>.supabase.co.`);
  }
  const ref = host.slice(0, host.length - suffix.length);
  if (!/^[a-z]{20}$/.test(ref)) {
    throw new Error(`STAGING_SUPABASE_URL host \`${host}\` does not carry a valid Supabase ref (20 lowercase letters).`);
  }
  if (ref === PROD_PROJECT_REF) {
    throw new Error('Refusing to run against the prod project ref.');
  }

  if (allowedRefsRaw?.trim()) {
    const allowed = allowedRefsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of allowed) {
      if (a === PROD_PROJECT_REF || !/^[a-z]{20}$/.test(a)) {
        throw new Error(`ALLOWED_STAGING_PROJECT_REFS entry '${a}' invalid (20 lowercase letters, not prod).`);
      }
    }
    if (!allowed.includes(ref)) {
      throw new Error(`Rig ref '${ref}' is not in ALLOWED_STAGING_PROJECT_REFS. Refusing to run.`);
    }
  }

  return { url: trimmed, ref };
}

/**
 * Deterministic synthetic org UUID for a run id, so re-invoking a phase (seed
 * then drain then cleanup) targets the same org. Not cryptographic — only
 * needs to be stable within a run and shaped like a v4 UUID.
 */
export function runOrgId(runId: string): string {
  if (!runId?.trim()) throw new Error('runId is required for runOrgId.');
  const hex = Buffer.from(`batch-drain-${runId}`).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic indexed org id for a multi-org run. Index zero deliberately
 * preserves the original runOrgId output so existing single-org fixtures stay
 * addressable. Later indexes use a digest to avoid the prefix collisions the
 * legacy UUID shaping can produce for long run ids.
 */
export function runOrgIdN(runId: string, index: number): string {
  if (!runId?.trim()) throw new Error('runId is required for runOrgIdN.');
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`index must be a non-negative integer; received ${index}.`);
  }
  if (index === 0) return runOrgId(runId);

  const hex = createHash('sha256')
    .update(`batch-drain-${runId}-org-${index}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type OrgCohort = 'healthy' | 'credit-starved' | 'bad-fingerprint';

export interface OrgDrainPlanRow {
  orgId: string;
  rank: number;
  anchors: number;
  cohort: OrgCohort;
}

export interface ZipfOrgPlanOptions {
  runId: string;
  orgs?: number;
  count: number;
  s?: number;
  whales?: number;
  whaleShare?: number;
  creditStarved?: number;
  badFingerprint?: number;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${value}.`);
  }
}

/** Allocate an exact integer total using weighted largest remainders and a floor of one. */
function allocateWeighted(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (total < weights.length) {
    throw new Error(`Cannot allocate ${total} anchors across ${weights.length} orgs with a floor of one.`);
  }

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    throw new Error('Zipf weights must have a positive finite sum.');
  }

  const distributable = total - weights.length;
  const raw = weights.map((weight) => (distributable * weight) / weightTotal);
  const allocated = raw.map((share) => 1 + Math.floor(share));
  let remainder = total - allocated.reduce((sum, count) => sum + count, 0);

  const byRemainder = raw
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let i = 0; i < remainder; i += 1) {
    allocated[byRemainder[i]!.index] += 1;
  }

  return allocated;
}

/**
 * Build a deterministic replayable whale/long-tail distribution. Poison orgs
 * are always assigned from the smallest tail ranks so healthy whales and
 * neighboring healthy tail orgs expose isolation failures clearly.
 */
export function zipfOrgPlan(options: ZipfOrgPlanOptions): OrgDrainPlanRow[] {
  const {
    runId,
    orgs = 30,
    count,
    s = 1,
    whales = 3,
    whaleShare = 0.5,
    creditStarved = 2,
    badFingerprint = 1,
  } = options;

  if (!runId?.trim()) throw new Error('runId is required for zipfOrgPlan.');
  requirePositiveInteger(orgs, 'orgs');
  requirePositiveInteger(count, 'count');
  requireNonNegativeInteger(whales, 'whales');
  requireNonNegativeInteger(creditStarved, 'creditStarved');
  requireNonNegativeInteger(badFingerprint, 'badFingerprint');
  if (count < orgs) throw new Error(`count must be at least orgs (${orgs}) so every org receives one anchor.`);
  if (whales > orgs) throw new Error(`whales must not exceed orgs (${orgs}).`);
  if (!Number.isFinite(s) || s <= 0) throw new Error(`s must be positive and finite; received ${s}.`);
  if (!Number.isFinite(whaleShare) || whaleShare < 0 || whaleShare > 1) {
    throw new Error(`whaleShare must be between 0 and 1; received ${whaleShare}.`);
  }
  if (creditStarved + badFingerprint > orgs - whales) {
    throw new Error('Poison orgs must fit wholly within the non-whale long tail.');
  }

  const weights = Array.from({ length: orgs }, (_, index) => (index + 1) ** -s);
  let anchors: number[];
  if (whales === 0 || whales === orgs) {
    anchors = allocateWeighted(count, weights);
  } else {
    const tailCount = orgs - whales;
    // Preserve the requested share when possible while retaining the one-row
    // floor on both sides for small synthetic test populations.
    const whaleTotal = Math.min(
      count - tailCount,
      Math.max(whales, Math.round(count * whaleShare)),
    );
    anchors = [
      ...allocateWeighted(whaleTotal, weights.slice(0, whales)),
      ...allocateWeighted(count - whaleTotal, weights.slice(whales)),
    ];
  }

  const creditStart = orgs - creditStarved;
  const fingerprintStart = creditStart - badFingerprint;
  return anchors.map((anchorCount, index) => {
    let cohort: OrgCohort = 'healthy';
    if (index >= creditStart) cohort = 'credit-starved';
    else if (index >= fingerprintStart) cohort = 'bad-fingerprint';
    return {
      orgId: runOrgIdN(runId, index),
      rank: index + 1,
      anchors: anchorCount,
      cohort,
    };
  });
}

export interface GlobalFlushPass {
  pass: number;
  transactions: 1;
  leaves: number;
  remainder: number;
}

export interface GlobalFlushExpectation {
  trigger: 'global-flush';
  initialPending: number;
  totalTransactions: number;
  passes: GlobalFlushPass[];
}

/** R3 Trigger D: one mixed-org transaction, capped at BATCH_SIZE, per tick. */
export function planGlobalFlush(
  totalPending: number,
  batchSize = BATCH_SIZE,
): GlobalFlushExpectation {
  requireNonNegativeInteger(totalPending, 'totalPending');
  requirePositiveInteger(batchSize, 'batchSize');

  const passes: GlobalFlushPass[] = [];
  let remainder = totalPending;
  while (remainder > 0) {
    const leaves = Math.min(remainder, batchSize);
    remainder -= leaves;
    passes.push({ pass: passes.length + 1, transactions: 1, leaves, remainder });
  }
  return {
    trigger: 'global-flush',
    initialPending: totalPending,
    totalTransactions: passes.length,
    passes,
  };
}

export interface OrgSchedulerTransaction {
  orgId: string;
  leaves: number;
}

export interface OrgSchedulerPass {
  pass: number;
  transactions: OrgSchedulerTransaction[];
}

export interface PoisonExpectation {
  orgId: string;
  cohort: Exclude<OrgCohort, 'healthy'>;
  anchorsRemaining: number;
  schedulerOutcome: 'succeeded-no-broadcast' | 'failed-contained';
}

export interface OrgSchedulerExpectation {
  trigger: 'org-scheduler';
  totalTransactions: number;
  passes: OrgSchedulerPass[];
  poisons: PoisonExpectation[];
}

function validatePlanRows(rows: OrgDrainPlanRow[]): void {
  const orgIds = new Set<string>();
  const ranks = new Set<number>();
  for (const row of rows) {
    if (!row.orgId?.trim()) throw new Error('Every org scheduler row requires an orgId.');
    requirePositiveInteger(row.rank, 'rank');
    requirePositiveInteger(row.anchors, 'anchors');
    if (orgIds.has(row.orgId)) throw new Error(`Duplicate orgId in scheduler plan: ${row.orgId}.`);
    if (ranks.has(row.rank)) throw new Error(`Duplicate rank in scheduler plan: ${row.rank}.`);
    orgIds.add(row.orgId);
    ranks.add(row.rank);
  }
}

/** R3 org scheduler: at most one transaction for each healthy org per pass. */
export function planOrgScheduler(
  rows: OrgDrainPlanRow[],
  batchSize = BATCH_SIZE,
): OrgSchedulerExpectation {
  requirePositiveInteger(batchSize, 'batchSize');
  validatePlanRows(rows);

  const healthy = rows.filter((row) => row.cohort === 'healthy');
  const passCount = healthy.reduce(
    (max, row) => Math.max(max, Math.ceil(row.anchors / batchSize)),
    0,
  );
  const passes = Array.from({ length: passCount }, (_, passIndex): OrgSchedulerPass => ({
    pass: passIndex + 1,
    transactions: healthy.flatMap((row) => {
      const before = passIndex * batchSize;
      const leaves = Math.min(batchSize, Math.max(0, row.anchors - before));
      return leaves > 0 ? [{ orgId: row.orgId, leaves }] : [];
    }),
  }));
  const poisons: PoisonExpectation[] = rows.flatMap((row) => {
    if (row.cohort === 'healthy') return [];
    return [{
      orgId: row.orgId,
      cohort: row.cohort,
      anchorsRemaining: row.anchors,
      schedulerOutcome: row.cohort === 'credit-starved'
        ? 'succeeded-no-broadcast'
        : 'failed-contained',
    }];
  });

  return {
    trigger: 'org-scheduler',
    totalTransactions: passes.reduce((sum, pass) => sum + pass.transactions.length, 0),
    passes,
    poisons,
  };
}

export interface BuildR3AcceptancePlanOptions {
  runId: string;
  orgs?: number;
  multiOrgCount?: number;
}

export interface R3AcceptancePlan {
  batchSize: number;
  distribution: OrgDrainPlanRow[];
  orgScheduler: OrgSchedulerExpectation;
  global10k: GlobalFlushExpectation;
  global12500: GlobalFlushExpectation;
  singleOrgCrossPass: OrgSchedulerExpectation;
}

/** Complete offline oracle for the two R3 trigger invariants and cross-pass case. */
export function buildR3AcceptancePlan(
  options: BuildR3AcceptancePlanOptions,
): R3AcceptancePlan {
  const orgs = options.orgs ?? 30;
  if (orgs < 30) throw new Error(`R3 acceptance requires at least 30 orgs; received ${orgs}.`);

  const distribution = zipfOrgPlan({
    runId: options.runId,
    orgs,
    count: options.multiOrgCount ?? 12_500,
  });
  const singleOrgId = runOrgIdN(`${options.runId}-single-org-cross-pass`, 0);
  return {
    batchSize: BATCH_SIZE,
    distribution,
    orgScheduler: planOrgScheduler(distribution),
    global10k: planGlobalFlush(10_000),
    global12500: planGlobalFlush(12_500),
    singleOrgCrossPass: planOrgScheduler([
      { orgId: singleOrgId, rank: 1, anchors: 12_500, cohort: 'healthy' },
    ]),
  };
}
