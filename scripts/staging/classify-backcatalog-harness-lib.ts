/**
 * Pure, side-effect-free helpers for classify-backcatalog-harness.ts (#1410/#1427).
 *
 * Split out so the phase-plan + census-assertion helpers unit-test without the
 * harness entrypoint (rig creds). NOTHING here touches the network or a DB.
 *
 * The rig harness drives the REAL /jobs|/cron/classify-proof-backcatalog against
 * an isolated rig with migration 0354 applied (the #1427 requirement) and
 * exercises the five behavioral invariants the unit driver
 * (services/worker/src/jobs/classify-backcatalog-driver.ts) proves in memory:
 * census / resume-checkpoint / mutex / GUC guard / per-org scoping.
 */

/** The phases the classifier rig harness runs, in order. */
export type ClassifyPhase =
  | 'seed' //   insert a mixed back-catalogue (all four proof classes) for a synth org
  | 'guc-off' // drive with the GUC unset → assert ZERO rows censused
  | 'census' //  flip GUC on, drive to completion → assert tallies sum + match seed
  | 'resume' //  drive with a small page cap, kill mid-pass, re-drive → no double/skip
  | 'mutex' //   fire two overlapping drives → assert exactly one censuses
  | 'scope' //   drive org-scoped → assert only that org's rows counted
  | 'cleanup'
  | 'all';

export const CLASSIFY_PHASES: ClassifyPhase[] = [
  'seed',
  'guc-off',
  'census',
  'resume',
  'mutex',
  'scope',
  'cleanup',
];

export function isClassifyPhase(v: string): v is ClassifyPhase {
  return (CLASSIFY_PHASES as string[]).includes(v) || v === 'all';
}

/** The seed mix the harness inserts, keyed by proof class → count. */
export interface SeedMix {
  fully_proven: number;
  header_missing: number;
  index_unreconstructable: number;
  no_app_tree: number;
}

export function seedMixTotal(mix: SeedMix): number {
  return mix.fully_proven + mix.header_missing + mix.index_unreconstructable + mix.no_app_tree;
}

/**
 * The default seed mix — deliberately uneven so a census that silently collapses
 * two classes (or drops one) is caught: no two counts are equal.
 */
export function defaultSeedMix(scale = 1): SeedMix {
  return {
    fully_proven: 7 * scale,
    header_missing: 5 * scale,
    index_unreconstructable: 3 * scale,
    no_app_tree: 2 * scale,
  };
}

/**
 * Assert an observed census matches the seed mix exactly AND is internally
 * consistent (per-class tallies sum to the reported scanned total). Returns a
 * structured verdict; never throws.
 */
export function assertCensusMatches(
  seed: SeedMix,
  observed: Partial<SeedMix> & { rowsScanned?: number },
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const classes: (keyof SeedMix)[] = [
    'fully_proven',
    'header_missing',
    'index_unreconstructable',
    'no_app_tree',
  ];
  let sum = 0;
  for (const c of classes) {
    const got = observed[c] ?? 0;
    sum += got;
    if (got !== seed[c]) reasons.push(`${c}: expected ${seed[c]}, got ${got}`);
  }
  if (observed.rowsScanned !== undefined && observed.rowsScanned !== sum) {
    reasons.push(`rowsScanned ${observed.rowsScanned} != sum of classes ${sum}`);
  }
  if (sum !== seedMixTotal(seed)) {
    reasons.push(`census total ${sum} != seed total ${seedMixTotal(seed)}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Per-org advisory scope key the classifier must serialize on. The unit driver
 * documents the requirement that org scopes have INDEPENDENT keys; this mirrors
 * the format the SQL classifier's `pg_advisory_lock(hashtext(...))` must use so
 * an orgA pass never blocks an orgB pass.
 */
export function classifyScopeKey(orgId?: string): string {
  return `classify_proof_backcatalog:${orgId ?? 'ALL'}`;
}
