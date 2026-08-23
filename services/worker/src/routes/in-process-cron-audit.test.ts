/**
 * Ratchet for the in-process cron double-fire audit (SCRUM-3384).
 *
 * Three things are pinned here, and each one failed a human census before it
 * was a test:
 *
 *  1. EVERY job registered with `scheduleInProcess(...)` in `scheduled.ts` is
 *     classified in `IN_PROCESS_CRON_AUDIT`. Adding a 20th in-process cron
 *     without saying what stops a second instance from running it concurrently
 *     turns this suite red. The job list is read out of `scheduled.ts` SOURCE
 *     rather than captured from a `cron.schedule` spy on purpose: four of the
 *     registrations sit behind feature flags (`enableConfirmationProofBackfill`,
 *     `enableConnectorArtifactDrain`, `enableConnectorArtifactEnqueue`) or the
 *     `chainInitialized` argument, so a runtime capture silently under-counts
 *     exactly the jobs most likely to be forgotten.
 *
 *  2. A `guard: 'run-lease'` claim is checked against the named module. The
 *     audit records what a reader would otherwise have to take on faith, and
 *     the whole reason this audit exists is that `chain-maintenance.ts` shipped
 *     an `acquireLock()` that returns a hardcoded `true` while five jobs read
 *     as though they were lock-guarded. A claimed guard must be verifiable.
 *
 *  3. The retracted dormancy claim cannot come back. "node-cron is dormant
 *     under Cloud Run CPU throttling" was asserted across worker source and
 *     several agents.md files and is FALSE for this service: node-cron is
 *     dormant on a revision that has scaled to ZERO, and prod `arkova-worker`
 *     deploys `--min-instances 2 --max-instances 10`
 *     (`.github/workflows/deploy-worker.yml`), so every in-process cron fires
 *     on 2-10 warm instances concurrently. Several safety arguments rested on
 *     that sentence, so the sweep that removed it gets a guard.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  IN_PROCESS_CRON_AUDIT,
  unguardedInProcessCronJobs,
  validateInProcessCronAudit,
  type InProcessCronAuditEntry,
} from './in-process-cron-audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = resolve(__dirname, '..');

const scheduledSource = readFileSync(join(__dirname, 'scheduled.ts'), 'utf8');

/**
 * Job names as registered in `scheduled.ts`. The first argument of
 * `scheduleInProcess` is always a string literal — the helper's own signature
 * takes `jobName: string`, and the `ANCHOR_TABLE_IN_PROCESS_JOBS` allowlist
 * matches on it, so a computed name would already be un-allowlistable.
 */
function registeredJobNames(source: string): string[] {
  return [...source.matchAll(/scheduleInProcess\(\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * The retracted claim, in every phrasing it was written in across the repo:
 * "dormant under Cloud Run CPU throttling", "dormant under CPU throttling",
 * "dormant under Cloud Run throttling", "CPU throttling leaves node-cron
 * dormant". Deliberately narrow — `docusign-envelope-completed.ts` and
 * `docusign-queue-reconciliation.ts` legitimately describe a flag-gated
 * "dormant path", which is a different word used correctly.
 */
const DORMANCY_CLAIM = /dormant\s+(?:under|while|when)\s+(?:Cloud\s+Run\s+)?(?:CPU\s+)?throttl|throttling\s+leaves\s+node-cron\s+dormant|node-cron\s+(?:is\s+)?dormant\s+(?:under|on)\s+Cloud\s+Run/i;

/**
 * Collapse JSDoc/line-comment continuations before matching. Without this the
 * detector has a hole exactly where the claim is most likely to live: the
 * sentence is long, so it wraps, and `* ` at the start of the next line breaks
 * any `\s+` in the pattern. `jobs/scheduler-manifest.ts` wrapped it that way
 * and slipped past the first version of this test.
 */
function flattenComments(source: string): string {
  return source.replace(/\n\s*(?:\*|\/\/)?[ \t]*/g, ' ');
}

const REPO_ROOT = resolve(WORKER_SRC, '../../..');

/**
 * Where the claim was asserted, so where it has to stay retracted: the worker
 * itself plus the two script trees that repeat the same reasoning about why
 * Cloud Scheduler is the production trigger.
 *
 * `walkScannableFiles` tolerates a missing root so the walk cannot throw, but
 * the sanity test below then FAILS on any root that produced no files. That is
 * deliberate: a ratchet that silently scans nothing is worse than no ratchet,
 * so extracting this package out of the monorepo must break this test loudly
 * and force a decision about where the claim is still allowed to live.
 */
const RETRACTION_SCAN_ROOTS = [
  'services/worker/src',
  'services/worker/agents.md',
  'services/worker/agents-changelog.md',
  'scripts/ci',
  'scripts/gcp-setup',
];

/** Files that are allowed to quote the retracted claim in order to retract it. */
const RETRACTION_DOC_ALLOWLIST = new Set([
  'services/worker/src/routes/in-process-cron-audit.ts',
  'services/worker/src/routes/in-process-cron-audit.test.ts',
]);

const SCANNED_EXTENSIONS = ['.ts', '.md', '.sh'];

function walkScannableFiles(target: string, acc: string[] = []): string[] {
  if (!existsSync(target)) return acc;
  if (!statSync(target).isDirectory()) {
    if (SCANNED_EXTENSIONS.some((ext) => target.endsWith(ext))) acc.push(target);
    return acc;
  }
  for (const entry of readdirSync(target)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    walkScannableFiles(join(target, entry), acc);
  }
  return acc;
}

describe('in-process cron audit — coverage ratchet (SCRUM-3384)', () => {
  it('sanity: scheduled.ts still registers jobs through scheduleInProcess', () => {
    expect(registeredJobNames(scheduledSource).length).toBeGreaterThan(0);
  });

  it('classifies every job registered in scheduled.ts', () => {
    const registered = registeredJobNames(scheduledSource);
    const audited = IN_PROCESS_CRON_AUDIT.map((entry) => entry.jobName);

    const unclassified = registered.filter((name) => !audited.includes(name));
    expect(
      unclassified,
      'a new in-process cron must declare its concurrency guard in IN_PROCESS_CRON_AUDIT',
    ).toEqual([]);
  });

  it('has no audit entry for a job that is no longer registered', () => {
    const registered = registeredJobNames(scheduledSource);
    const stale = IN_PROCESS_CRON_AUDIT
      .map((entry) => entry.jobName)
      .filter((name) => !registered.includes(name));

    expect(stale, 'audit entry for a job scheduled.ts no longer registers').toEqual([]);
  });

  it('carries exactly one entry per job (no duplicate classifications)', () => {
    const names = IN_PROCESS_CRON_AUDIT.map((entry) => entry.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('passes its own structural validator', () => {
    expect(validateInProcessCronAudit(IN_PROCESS_CRON_AUDIT)).toEqual([]);
  });
});

describe('in-process cron audit — a claimed guard must be verifiable', () => {
  const leased: InProcessCronAuditEntry[] = IN_PROCESS_CRON_AUDIT.filter(
    (entry) => entry.guard === 'run-lease',
  );

  it('records at least one lease-guarded job (else the check below is vacuous)', () => {
    expect(leased.length).toBeGreaterThan(0);
  });

  it.each(leased.map((entry) => [entry.jobName, entry.entrypointModule] as const))(
    "'%s' claims a run lease, and %s really wraps withRunLease",
    (_jobName, entrypointModule) => {
      const source = readFileSync(resolve(WORKER_SRC, entrypointModule), 'utf8');
      expect(source).toMatch(/withRunLease\s*\(/);
    },
  );

  it('never marks a job concurrency-safe while leaving its guard unguarded', () => {
    const contradictions = IN_PROCESS_CRON_AUDIT.filter(
      (entry) => entry.guard === 'unguarded' && entry.doubleFireImpact === 'none',
    );
    expect(contradictions.map((entry) => entry.jobName)).toEqual([]);
  });

  it('names the still-exposed jobs explicitly rather than by omission', () => {
    // The audit's finding, pinned. This is not a passing grade — it is the
    // list a reader is entitled to see without re-deriving it, and it moves
    // only when a job is actually guarded (or a new unguarded one lands).
    expect(unguardedInProcessCronJobs().map((entry) => entry.jobName).sort()).toEqual([
      'cleanup-expired-data',
      'consolidate-utxos',
      'monitor-fee-rates',
      'process-monthly-credits',
      'process-revoked-anchors',
      'process-webhook-retries',
      'rebroadcast-dropped-transactions',
    ]);
  });
});

describe('in-process cron audit — the dormancy claim stays retracted', () => {
  const files = RETRACTION_SCAN_ROOTS
    .flatMap((root) => walkScannableFiles(resolve(REPO_ROOT, root)))
    .map((full) => [relative(REPO_ROOT, full), full] as const)
    .filter(([rel]) => !RETRACTION_DOC_ALLOWLIST.has(rel));

  it('sanity: the sweep actually walked every scan root', () => {
    expect(files.length).toBeGreaterThan(50);
    for (const root of RETRACTION_SCAN_ROOTS) {
      expect(
        files.some(([rel]) => rel.startsWith(root)),
        `scan root produced no files: ${root}`,
      ).toBe(true);
    }
  });

  it('no scanned file asserts node-cron is dormant under CPU throttling', () => {
    const offenders = files
      .filter(([, full]) => DORMANCY_CLAIM.test(flattenComments(readFileSync(full, 'utf8'))))
      .map(([rel]) => rel);

    expect(
      offenders,
      'in-process node-cron fires on every warm instance; prod runs --min-instances 2',
    ).toEqual([]);
  });

  it('sanity: the detector matches the sentence it was written to catch', () => {
    expect(DORMANCY_CLAIM.test('node-cron is dormant under Cloud Run CPU throttling')).toBe(true);
    expect(DORMANCY_CLAIM.test('it is dormant under CPU throttling (PROOF-03 finding)')).toBe(true);
    expect(DORMANCY_CLAIM.test('CPU throttling leaves node-cron dormant')).toBe(true);
    // Must NOT catch the unrelated, correct use of "dormant".
    expect(DORMANCY_CLAIM.test('a dormant connector path is a graceful no-op')).toBe(false);
    expect(DORMANCY_CLAIM.test('the drain is intentionally dormant until the flag ships')).toBe(false);
  });

  it('sanity: a line-wrapped assertion of the claim is still caught', () => {
    const wrapped = '/**\n * binding lives in Cloud Scheduler (node-cron is dormant\n'
      + ' * under Cloud Run CPU throttling — see routes/scheduled.ts).\n */';
    expect(DORMANCY_CLAIM.test(wrapped)).toBe(false);
    expect(DORMANCY_CLAIM.test(flattenComments(wrapped))).toBe(true);
  });
});
