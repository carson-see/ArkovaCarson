#!/usr/bin/env tsx
/**
 * rc/soak-batch-2026-09-02 — batched T2 admission driver.
 *
 * ONE integration branch, ONE rig, ONE 12-hour window, FOUR PR heads. Shape,
 * CLI contract, JSONL evidence format and exit-code semantics mirror
 * `pr2524-proof-txinclusion-driver.ts` / `pr1408-chain-resilience-driver.ts`,
 * because the isolated-rig admission JSON (`driver_path` / `driver_sha256` /
 * `changed_behavior`) and the close-out tooling expect that shape, and
 * "driver_path or driver_sha256 mismatch" is one of their stop conditions.
 *
 * Self-test mode is local validation only: rows are `evidenceForSoak=false`
 * and must never be cited as soak evidence. Live mode requires an admitted
 * isolated rig and appends one countable JSONL row per invocation.
 *
 * WHAT THE RC CHANGED, AND THEREFORE WHAT THIS DRIVER MEASURES
 * -----------------------------------------------------------
 *   #2527  `GET /api/v1/verify/:publicId/proof` gained `verdict` ∈ {valid,
 *          invalid, unverifiable} + `verdict_note`, next to the unchanged
 *          boolean `verified`. At THIS head (`constants/proofVerdict.ts`):
 *            invalid       <=> verified === false
 *            valid          => the CVE-2012-2459 guard was EXERCISED: merkle
 *                              index present, leaf count >= 1, AND branch
 *                              length == depth(leaf count)
 *            unverifiable   => everything else that passed the recompute —
 *                              no index (legacy), an empty branch under a
 *                              multi-leaf claim, a branch longer than the tree
 *          The PREVIOUS RC head (557e485a) said `valid` for the last two. The
 *          fixture seeds one cohort per state so every branch of the mapping is
 *          observed on every cycle (A27_*).
 *   #2525  `GET /api/v1/verify/attestation/:id` is PARKED at the router: every
 *          well-formed id answers ONE fixed 404 from `parkedAttestationVerify`,
 *          mounted BELOW apiKeyAuth + the rate limiters and ABOVE usageTracking.
 *          The status-disclosure handler in `verify/attestation.ts` is retained
 *          but unreachable. A park over an EMPTY table proves nothing, so the
 *          fixture populates `legally_binding_attestations` across all five
 *          statuses in two orgs, and the driver proves none of it — subject
 *          names, notary names, commission numbers — leaves the park, on ANY
 *          byte of ANY response, headers included (A25_*).
 *   #2526  `detect-reorgs` is registered in `SCHEDULER_MANIFEST` with a 30-minute
 *          silence budget. Nothing in production reads that manifest today:
 *          neither `evaluateSchedulerDeadman` nor `runSchedulerPauseAudit` has a
 *          live trigger, and `JobRunSignal.lastRunAt` has no producer. So the
 *          driver asserts only what is TRUE on this build: the worker boots and
 *          serves `/api/health` at the RC head, the manifest at the driver's
 *          checkout carries the entry with the budget the PR's own test pins,
 *          and `POST /jobs/detect-reorgs` answers 200 with a well-formed result
 *          (A26_*). No dead-man assertion is fabricated — see NOT_ASSERTED.
 *   #2528  Frontend only (`src/lib/copy.ts`, `generateAuditReport.ts`,
 *          `IndependentVerifyPage.tsx`). NOT driven from the worker soak; its
 *          targeted T1 evidence is `e2e/rc-batch-0902-frontend-evidence.spec.ts`.
 *
 * THE DISCRIMINATION REQUIREMENT
 * ------------------------------
 * A driver that would also pass against the BROKEN build is worthless.
 * `runSelfTest()` therefore runs every evaluator against broken-build vectors
 * and requires each to FAIL: a pre-#2527 build (no `verdict`), the previous RC
 * head (`valid` on an uninspected branch), a contradictory pair, a fourth
 * verdict value, a reworded note, a server that launders a failed recompute,
 * a build that unparks the attestation route, a park mounted above the rate
 * limiters, an existence oracle between withheld and nonexistent ids, PII in a
 * response HEADER, an application 5xx, a manifest without the entry or with the
 * peers' 1h budget, a detect-reorgs 500, a wrong build SHA.
 *
 * PRE-MORTEM CLOSURES
 * -------------------
 *   K1  The driver refuses to run when `/api/health.git_sha` != the RC head
 *       (`--expected-git-sha`, default RC_HEAD_SHA) or when the admission JSON
 *       names a different head. Evidence bound to the wrong build is worthless.
 *   K2  No wall-clock in any assertion. One invocation = one self-contained,
 *       individually verifiable cycle carrying runId, cycle, the declared window
 *       and a precomputed withinDeclaredWindow.
 *   K3  Prod, the shared standing rig (current AND retired refs), the R1 rig
 *       (`uqobkjhlnqmcpjidngxr`, a T3 soak in flight) and the docusign-bilateral
 *       rig are HARD-DENIED by Supabase ref, and the shared/prod Cloud Run
 *       services by EXACT service name (the corrected split from #2524's
 *       driver — a prefix test refuses legitimate isolated rigs and double-
 *       counts the shared one). The R1 rig's Cloud Run service NAME is not in
 *       the repository, so it cannot be hard-coded honestly; instead the target
 *       host is POSITIVELY bound to the admission JSON's own `cloud_run_service`
 *       (which excludes every foreign rig, whatever its name) and
 *       `--deny-service` / `RIG_DENY_SERVICES` add names at launch. The driver
 *       refuses to RUN, not merely to write — and it has NO write path at all:
 *       every database call is a PostgREST GET.
 *   K4  The attestation PII sweep searches the ENTIRE raw response — status
 *       line, every header, body — not parsed JSON fields.
 *
 * Constitution refs: §1.4 (no secrets logged — the cron secret, service key and
 * bearer token are never echoed), §1.5 (measured, not asserted; NOT_ASSERTED is
 * in every row), §1.10 (rate-limit headers on every response is what proves the
 * park's position), §1.11A (isolated-rig evidence only).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  SCHEDULER_MANIFEST,
  validateSchedulerManifest,
  type ScheduledJobSpec,
} from '../src/jobs/scheduler-manifest.js';
import {
  PROOF_VERDICT,
  PROOF_VERDICT_NOTE,
  type ProofVerdict,
} from '../src/constants/proofVerdict.js';
import {
  classify as classifyPark,
  isInfraAbort,
  isObserved,
  type Probe as ParkProbe,
} from './pr2525-attestation-park-driver.js';

// ─── RC identity ─────────────────────────────────────────────────────────────

export const RC_BRANCH = 'rc/soak-batch-2026-09-02';
/** The rebuilt RC head (origin/main + the four CURRENT PR heads, 2026-09-02). */
export const RC_HEAD_SHA = '78621249595e37398170da9b298ae13cd753a801';
/** origin/main at the rebuild. */
export const RC_BASE_SHA = 'e99c6cb7028843b863ad6492c8e8cf81c6f591da';
/** Second parents of the four RC merge commits, in merge order. Informational. */
export const RC_PR_HEADS: Readonly<Record<'2525' | '2526' | '2527' | '2528', string>> = {
  '2525': '24fbb72cccbfe6ca929200ffa7a8d11d4ade8403',
  '2527': '2cb005850919d3af2fea443382ebc0d77f20851e',
  '2526': 'c646d18e8e27cc7bf290a3225ed3a80bf4718b3f',
  '2528': '7781bf0eb67df38d576e28f038003d7e3210dbd3',
};
/** The superseded RC head whose verdict mapping differs — named in A27_5's detail. */
export const PREVIOUS_RC_HEAD_SHA = '557e485ab6a03ba903a436a6e9f205459097bf3a';

// ─── Hard-deny constants (K3) ────────────────────────────────────────────────

export const PROD_SUPABASE_REF = 'vzwyaatejekddvltxyye';
/** Current shared standing rig — docs/reference/STAGING_RIG.md, not CLAUDE.md. */
export const SHARED_STAGING_SUPABASE_REF = 'fizyjojbebyalirtjjht';
/** The deleted former standing rig; older drivers still name it. Denied anyway. */
export const RETIRED_SHARED_STAGING_SUPABASE_REF = 'ujtlwnoqfhtitcmsnrpq';
/** R1 isolated rig — the #2524 T3 soak is IN FLIGHT there. Frozen evidence. */
export const R1_RIG_SUPABASE_REF = 'uqobkjhlnqmcpjidngxr';
/** docusign-bilateral isolated rig — T3 soak per HANDOFF.md `### Soaks`. */
export const DOCUSIGN_BILATERAL_RIG_SUPABASE_REF = 'aqikotdkmhxmznonwmwk';

export const DENIED_SUPABASE_REFS: Readonly<Record<string, string>> = Object.freeze({
  [PROD_SUPABASE_REF]: 'PRODUCTION',
  [SHARED_STAGING_SUPABASE_REF]: 'SHARED standing staging — not isolated, so not T2 merge evidence',
  [RETIRED_SHARED_STAGING_SUPABASE_REF]: 'retired shared staging ref — never a target',
  [R1_RIG_SUPABASE_REF]: 'R1 isolated rig — a T3 soak is in flight there; frozen evidence',
  [DOCUSIGN_BILATERAL_RIG_SUPABASE_REF]: 'docusign-bilateral isolated rig — T3 soak per HANDOFF `### Soaks`',
});

/** Cloud Run services that are shared/prod/soaking and must never be driven. */
export const DENIED_CLOUD_RUN_SERVICES = [
  'arkova-worker',
  'arkova-worker-staging',
  'arkova-worker-docusign-bilateral-staging',
] as const;

/** Production Arkova domains — apex and every subdomain. */
export const DENIED_HOST_SUBSTRINGS = ['arkova.ai', 'arkova.io'] as const;

// ─── Fixture contract (mirrors scripts/staging/seed-rc-batch-0902-fixture.sql) ─

export const FIXTURE_PURPOSE = 'rc-batch-0902';

export type ProofCohort =
  | 'a-valid'
  | 'a-invalid'
  | 'a-legacy'
  | 'a-uninspected'
  | 'a-overlong'
  | 'b-valid';

export interface CohortContract {
  org: 'a' | 'b';
  rows: number;
  /** What the RC head MUST answer. Decided by design, never derived at runtime. */
  expectedVerdict: ProofVerdict;
  expectedVerified: boolean;
  /** `proof_bundle` must be non-null (a-valid/b-valid) or null (a-legacy). */
  bundle: 'required' | 'null' | 'unasserted';
  /** What the superseded RC head (557e485a) answered — the discrimination vector. */
  previousRcHeadVerdict: ProofVerdict;
  /** Real mainnet receipt the seed binds this cohort to. */
  chainTxId: string;
  block: 'A' | 'B';
}

export const PROOF_COHORTS: Readonly<Record<ProofCohort, CohortContract>> = Object.freeze({
  'a-valid': {
    org: 'a', rows: 2, expectedVerdict: 'valid', expectedVerified: true, bundle: 'required',
    previousRcHeadVerdict: 'valid',
    chainTxId: '443f0482059aa57ecd1d719c6b88412edea329f73d913d8f98a644d45fbcf3ec', block: 'A',
  },
  'a-invalid': {
    org: 'a', rows: 2, expectedVerdict: 'invalid', expectedVerified: false, bundle: 'unasserted',
    previousRcHeadVerdict: 'invalid',
    chainTxId: '240a97417193e864e9fdf4206531945eb2ec4db1be92c127ab979f1b2b7b6f67', block: 'A',
  },
  'a-legacy': {
    org: 'a', rows: 2, expectedVerdict: 'unverifiable', expectedVerified: true, bundle: 'null',
    previousRcHeadVerdict: 'unverifiable',
    chainTxId: '65f73a4e6a7a9a5baa9809ad3a13c92d144d2a4b13267e1744fe72dfd32b493f', block: 'A',
  },
  'a-uninspected': {
    org: 'a', rows: 2, expectedVerdict: 'unverifiable', expectedVerified: true, bundle: 'unasserted',
    previousRcHeadVerdict: 'valid',
    chainTxId: '89bc7802b33ddcee417c37d2797303378b150f96b38014ab35b6ef4d34069afc', block: 'A',
  },
  'a-overlong': {
    org: 'a', rows: 1, expectedVerdict: 'unverifiable', expectedVerified: true, bundle: 'unasserted',
    previousRcHeadVerdict: 'valid',
    chainTxId: 'ae1fa6c8deeebac2647b09ec049312d7a209d6f5b2404d2404ad58e4078d1d0b', block: 'A',
  },
  'b-valid': {
    org: 'b', rows: 2, expectedVerdict: 'valid', expectedVerified: true, bundle: 'required',
    previousRcHeadVerdict: 'valid',
    chainTxId: '57a509928e6f07ffeb3d07b1d90ee3f6949a29a8ef0fb952198821f510a77149', block: 'B',
  },
});

export const PROOF_COHORT_IDS = Object.keys(PROOF_COHORTS) as ProofCohort[];

/** The two real mainnet blocks the receipts are in. Headers verified 2026-09-02. */
export const FIXTURE_BLOCKS: Readonly<Record<'A' | 'B', { hash: string; height: number; time: number; headerHex: string }>> =
  Object.freeze({
    A: {
      hash: '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045',
      height: 960657,
      time: 1785637848,
      headerHex:
        '00800020aa253b12e66471336476ae1d640598be225a1f1745700100000000000000000014befa43e06cc6e583a4f61ed2ae73759b28510a56ee40b667404746b2d0d53dd8ab6e6ad43a0217c7bf2963',
    },
    B: {
      hash: '00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2',
      height: 962144,
      time: 1786538405,
      headerHex:
        '0040072088f1acb40b999996ca75c65f504512690db8d7f1422902000000000000000000507b90c09840409d0435ef25da8e1f6a01fa1609811b6cf748fb547962a058eda5697c6a3d35021772784679',
    },
  });

export function fixturePublicId(cohort: ProofCohort, slot: number): string {
  return `ARK-RC0902-${cohort.toUpperCase()}-${slot}`;
}

export const ATTESTATION_STATUS_TAGS = ['DRAFT', 'PENDING', 'REVIEW', 'NOTARIZED', 'ANCHORED'] as const;
export type AttestationStatusTag = (typeof ATTESTATION_STATUS_TAGS)[number];
export const ATTESTATION_EXPECTED_STATUS: Readonly<Record<AttestationStatusTag, string>> = Object.freeze({
  DRAFT: 'draft',
  PENDING: 'pending_notarization',
  REVIEW: 'requires_review',
  NOTARIZED: 'notarized',
  ANCHORED: 'anchored',
});
/** The ten seeded ids, both orgs × five statuses. */
export const ATTESTATION_FIXTURE_IDS: readonly string[] = Object.freeze(
  (['A', 'B'] as const).flatMap((org) => ATTESTATION_STATUS_TAGS.map((tag) => `ARK-ATT-RC0902-${org}-${tag}`)),
);
export function expectedAttestationStatus(id: string): string | null {
  const tag = id.split('-').pop() as AttestationStatusTag | undefined;
  return tag && tag in ATTESTATION_EXPECTED_STATUS ? ATTESTATION_EXPECTED_STATUS[tag] : null;
}

/**
 * Natural-person and notary identifiers the seed writes on EVERY attestation
 * row. The K4 sweep searches every byte of every attestation response for
 * each of these, case-insensitively.
 */
export const ATTESTATION_PII_LITERALS = [
  'Amara Okonkwo-Fixture',
  'Tobias Lindqvist-Fixture',
  'Priya Raghunathan-Fixture',
  'Elena Marchetti-Fixture',
  'RC0902-COMM-A-7731',
  'RC0902-COMM-B-8842',
] as const;

/** Column / response-key names whose presence alone would mean the handler ran. */
export const ATTESTATION_SENSITIVE_KEYS = [
  'subject_name',
  'notary_name',
  'notary_commission_number',
  'commission_number',
  'attestation_statement',
] as const;

/** What the park's 404 must NOT say (it would assert a corpus was searched). */
const PARK_NOT_FOUND_LEAK = /not found/i;

const CHANGED_BEHAVIOR =
  'rc/soak-batch-2026-09-02 (four heads): #2527 tri-state `verdict` on /api/v1/verify/:publicId/proof — invalid <=> verified=false, valid only when the CVE-2012-2459 guard was EXERCISED (index + count + branch length == depth), unverifiable for legacy / empty-branch-under-multi-leaf / over-long branches; #2525 attestation park — GET /api/v1/verify/attestation/:id answers one fixed 404 below the rate limiters and above usageTracking, over a POPULATED legally_binding_attestations table, with no PII on any byte of any response; #2526 detect-reorgs registered in SCHEDULER_MANIFEST with a 30-minute silence budget, worker boots on the RC head and POST /jobs/detect-reorgs answers a well-formed result; #2528 frontend published-verification pointers + certificate QR (covered by the separate e2e spec, not this driver)';

const NOT_ASSERTED = [
  '#2525: the status-disclosure gate in verify/attestation.ts (notarized/anchored disclosed, draft/pending_notarization/requires_review withheld, DB error -> 500 not 404) is UNREACHABLE on this build — router.ts answers the route upstream via parkedAttestationVerify. It is covered by attestation.test.ts (unit) only. The seeded rows across all five statuses exist so the park is proven over a POPULATED table: a build that unparks or mis-orders the route answers 200 with PII for the notarized/anchored rows and fails A25_2 + A25_3.',
  '#2525: the park\'s position ABOVE usageTracking (no api_key_usage row, no quota charge) is not observable without a keyed caller and a quota read; only the BELOW-the-limiters half is observed (X-RateLimit-* on every response). Pinned by src/tests/api-e2e.test.ts.',
  '#2526: the dead-man silence signal has NO producer (JobRunSignal.lastRunAt is written by nothing) and neither manifest consumer has a live trigger, so no assertion about detection of a silent detect-reorgs is made — none would be true. The manifest entry is checked STATICALLY from the driver\'s checkout, which K1 binds to the deployed build only through the RC head SHA; the deployed bundle\'s manifest is not read.',
  '#2526: detectReorgs short-circuits to {checked:0,reorgsDetected:0,reverted:0} under USE_MOCKS, when the run lock is held, or when the chain-tip probe fails. A26_3 accepts that shape as well-formed; it does not prove a reorg was looked for. The fixture anchors are legal_hold=true and ~thousands of blocks below the check depth, so the job cannot touch them either way.',
  '#2527: `verified`/`verdict` are proven consistent and cohort-correct at the boundary; the driver re-folds every branch independently (plain double-SHA256) and requires agreement with `verified` in both directions, but it does not call classifyInclusionVerdict — a server change that moves BOTH fields wrongly in the same direction on a shape this fixture does not seed would pass. The seeded shapes are 1- and 2-leaf trees; deeper trees are exercised by verify-proof.verdict.test.ts only.',
  '#2527: the signed envelope (?format=signed) is not requested; that it now carries EVIDENCE ONLY (no verdict inside the signed payload) is unit-tested, not soaked.',
  '#2528 is not covered by this driver at all — see e2e/rc-batch-0902-frontend-evidence.spec.ts and the T1 frontend evidence fields.',
  'Anchors are seeded already-SECURED on real mainnet receipts; the broadcast/confirmation path that normally produces them is not exercised here.',
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  cronSecret?: string;
  bearerToken?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  expectedGitSha?: string;
  runId?: string;
  windowStart?: string;
  windowEnd?: string;
  attestationBurst?: number;
  denyRefs?: string[];
  denyServices?: string[];
}

export interface AssertionResult {
  id: string;
  /** Which PR this assertion is evidence for. */
  pr: 2525 | 2526 | 2527;
  /** What a PASS of this assertion actually proves. Copied into the evidence row. */
  proves: string;
  ok: boolean;
  detail: string;
}

export type PrCoverage = 'pass' | 'fail' | 'not-run' | 'frontend-spec';

export interface DriverRow {
  utc: string;
  rc: { branch: string; head: string; base: string; prHeads: Record<string, string> };
  prs: [2525, 2526, 2527];
  tier: 'T2';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  notAsserted: readonly string[];
  /** K2: identifies the soak run this cycle belongs to. */
  runId: string;
  /** K2: monotonic within (evidence file, runId). */
  cycle: number;
  /** K2: the declared soak window, so a close-out can bound its glob. */
  soakWindow: { start: string | null; end: string | null };
  /** K2: false => this cycle is OUTSIDE the declared window and is not evidence. */
  withinDeclaredWindow: boolean;
  status: 'pass' | 'fail';
  prCoverage: Record<'2525' | '2526' | '2527' | '2528', PrCoverage>;
  assertions: AssertionResult[];
  counts: Record<string, number | boolean | string | null>;
  /** K1: what the worker reported, verbatim. */
  buildGitSha?: string | null;
  admission?: Record<string, unknown>;
  targetUrl?: string;
  supabaseProjectRef?: string | null;
  blockers?: string[];
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX160 = /^[0-9a-f]{160}$/i;

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Plain double-SHA256 over hex input — the verifier's hashing rule. */
export function sha256dHex(hex: string): string {
  return sha256(sha256(Buffer.from(hex, 'hex'))).toString('hex');
}

export interface MerkleEntry {
  hash: string;
  position: 'left' | 'right';
}

/**
 * Independent re-fold of an inclusion branch: plain double-SHA256 over the
 * positional concatenation, exactly `utils/merkle-verify.ts`'s rule, written
 * here rather than imported so the driver's agreement check is not the server
 * agreeing with itself. Returns null for a malformed branch.
 */
export function recomputeMerkleRoot(leafHex: string, branch: unknown): string | null {
  if (typeof leafHex !== 'string' || !HEX64.test(leafHex) || !Array.isArray(branch)) return null;
  let current: Buffer = Buffer.from(leafHex.toLowerCase(), 'hex');
  for (const entry of branch) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { hash, position } = entry as { hash?: unknown; position?: unknown };
    if (typeof hash !== 'string' || !HEX64.test(hash)) return null;
    if (position !== 'left' && position !== 'right') return null;
    const sibling = Buffer.from(hash.toLowerCase(), 'hex');
    current =
      position === 'right'
        ? sha256(sha256(Buffer.concat([current, sibling])))
        : sha256(sha256(Buffer.concat([sibling, current])));
  }
  return current.toString('hex');
}

/** Display-order block hash of a raw 80-byte header (byte-reversed sha256d). */
export function blockHashFromHeaderHex(headerHex: unknown): string | null {
  if (typeof headerHex !== 'string' || !HEX160.test(headerHex)) return null;
  return Buffer.from(sha256dHex(headerHex), 'hex').reverse().toString('hex');
}

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** The seed's fingerprint recipe — two md5 halves of a self-describing string. */
export function fixtureFingerprint(cohort: ProofCohort, slot: number): string {
  return md5(`rc0902-${cohort}-${slot}-hi`) + md5(`rc0902-${cohort}-${slot}-lo`);
}

export interface FixtureProofShape {
  fingerprint: string;
  merkleRoot: string;
  proofPath: MerkleEntry[];
  merkleIndex: number | null;
  leafCount: number;
  batchId: string;
}

/**
 * The proof row the seed writes for (cohort, slot), derived exactly as the SQL
 * derives it. Used by the self-test's synthetic responses and by the unit test
 * that runs every cohort through the REAL `buildProofResponse`.
 */
export function fixtureProofShape(cohort: ProofCohort, slot: number): FixtureProofShape {
  const fingerprint = fixtureFingerprint(cohort, slot);
  const batchId = `rc0902-${cohort}`;
  if (cohort === 'a-uninspected') {
    return { fingerprint, merkleRoot: fingerprint, proofPath: [], merkleIndex: slot, leafCount: 2, batchId };
  }
  if (cohort === 'a-overlong') {
    const extra = md5('rc0902-a-overlong-extra-sibling-hi') + md5('rc0902-a-overlong-extra-sibling-lo');
    return {
      fingerprint,
      merkleRoot: sha256dHex(fingerprint + extra),
      proofPath: [{ hash: extra, position: 'right' }],
      merkleIndex: 0,
      leafCount: 1,
      batchId,
    };
  }
  const fp0 = fixtureFingerprint(cohort, 0);
  const fp1 = fixtureFingerprint(cohort, 1);
  const sibling =
    cohort === 'a-invalid'
      ? md5(`rc0902-a-invalid-wrong-sibling-${slot}-hi`) + md5(`rc0902-a-invalid-wrong-sibling-${slot}-lo`)
      : slot === 0
        ? fp1
        : fp0;
  return {
    fingerprint,
    merkleRoot: sha256dHex(fp0 + fp1),
    proofPath: [{ hash: sibling, position: slot === 0 ? 'right' : 'left' }],
    merkleIndex: cohort === 'a-legacy' ? null : slot,
    leafCount: 2,
    batchId,
  };
}

/** Host only — never the path (§1.4). */
export function hostOnly(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function supabaseRefFromUrl(url: string | undefined): string | null {
  const host = hostOnly(url);
  if (!host) return null;
  const match = /^([a-z0-9]{20})\.supabase\.(co|in|red)$/i.exec(host);
  return match ? match[1].toLowerCase() : null;
}

// ─── K3: hard-deny ───────────────────────────────────────────────────────────

/**
 * Recover the Cloud Run SERVICE NAME from a run.app hostname — both URL shapes
 * Google issues (`<service>-<hash>-<regioncode>.a.run.app` and
 * `<service>-<hash>.<region>.run.app`). Null when the host is not a run.app URL;
 * a run.app host that matches neither shape is unidentifiable and is refused by
 * the caller rather than assumed safe.
 */
export function cloudRunServiceFromHost(host: string): string | null {
  const legacy = /^(.+)-[a-z0-9]+-[a-z]{2}\.a\.run\.app$/i.exec(host);
  if (legacy) return legacy[1].toLowerCase();
  const current = /^(.+)-[a-z0-9]+\.[a-z0-9-]+\.run\.app$/i.exec(host);
  if (current) return current[1].toLowerCase();
  return null;
}

export interface DenyInput {
  supabaseUrl?: string;
  targetUrl?: string;
  /** Extra refs to deny (e.g. `--deny-ref`). */
  extraRefs?: readonly string[];
  /** Extra Cloud Run service names to deny (e.g. the R1 rig's, once known). */
  extraServices?: readonly string[];
  /** Positive binding: the rig THIS admission names. */
  admission?: { supabase_project_ref?: unknown; cloud_run_service?: unknown };
}

/**
 * K3. Refuse to RUN when the target resolves to production, a shared rig, a
 * rig with a soak in flight, an unidentifiable host, or ANY rig other than the
 * one the admission JSON names.
 */
export function isDeniedTarget(input: DenyInput): string[] {
  const blockers: string[] = [];
  const deniedRefs: Record<string, string> = { ...DENIED_SUPABASE_REFS };
  for (const r of input.extraRefs ?? []) deniedRefs[r.toLowerCase()] = 'denied by --deny-ref';
  const deniedServices = new Set<string>([
    ...DENIED_CLOUD_RUN_SERVICES,
    ...(input.extraServices ?? []).map((s) => s.toLowerCase()),
  ]);

  const ref = supabaseRefFromUrl(input.supabaseUrl);
  if (input.supabaseUrl && ref === null) {
    blockers.push(
      `unrecognised Supabase URL '${hostOnly(input.supabaseUrl) ?? '<unparseable>'}' — the project ref cannot be deny-checked, so this target is refused`,
    );
  }
  if (ref && deniedRefs[ref]) {
    blockers.push(`Supabase project ref ${ref} is denied: ${deniedRefs[ref]}`);
  }
  const admissionRef = typeof input.admission?.supabase_project_ref === 'string' ? input.admission.supabase_project_ref : null;
  if (ref && admissionRef && admissionRef !== ref) {
    blockers.push(`Supabase project ref ${ref} is not the rig the admission JSON names (${admissionRef})`);
  }

  const targetHost = hostOnly(input.targetUrl);
  if (targetHost) {
    if (/\.run\.app$/i.test(targetHost)) {
      const service = cloudRunServiceFromHost(targetHost);
      if (service === null) {
        blockers.push(
          `target host '${targetHost}' is a Cloud Run URL whose service name cannot be recovered — refusing rather than guessing`,
        );
      } else {
        if (deniedServices.has(service)) {
          blockers.push(`target Cloud Run service '${service}' is shared, production, or soaking — hard denied`);
        }
        const admissionService =
          typeof input.admission?.cloud_run_service === 'string' ? input.admission.cloud_run_service : null;
        if (admissionService && admissionService.toLowerCase() !== service) {
          blockers.push(
            `target Cloud Run service '${service}' is not the service the admission JSON names ('${admissionService}')`,
          );
        }
      }
    }
    for (const denied of DENIED_HOST_SUBSTRINGS) {
      if (targetHost === denied || targetHost.endsWith(`.${denied}`)) {
        blockers.push(`target host '${targetHost}' is a production Arkova host — hard denied`);
      }
    }
  }

  return blockers;
}

// ─── K2: window bounding ─────────────────────────────────────────────────────

export function withinDeclaredWindow(
  utc: string,
  window: { start: string | null; end: string | null },
): boolean {
  const at = Date.parse(utc);
  if (Number.isNaN(at)) return false;
  if (window.start) {
    const start = Date.parse(window.start);
    if (Number.isNaN(start) || at < start) return false;
  }
  if (window.end) {
    const end = Date.parse(window.end);
    if (Number.isNaN(end) || at > end) return false;
  }
  return Boolean(window.start || window.end);
}

// ─── K1: build identity ──────────────────────────────────────────────────────

export interface HealthObservation {
  httpStatus: number;
  gitSha: string | null;
  statusField: string | null;
}

export function evaluateBuildIdentity(input: {
  health: HealthObservation;
  expectedSha: string;
  admissionHeadSha?: string | null;
}): string[] {
  const blockers: string[] = [];
  if (input.health.httpStatus !== 200) {
    blockers.push(`/api/health answered HTTP ${input.health.httpStatus} — the build cannot be identified`);
    return blockers;
  }
  const sha = input.health.gitSha;
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    blockers.push(`/api/health.git_sha is '${sha ?? '<absent>'}' — not a full SHA; BUILD_SHA was not baked into this image`);
    return blockers;
  }
  if (sha.toLowerCase() !== input.expectedSha.toLowerCase()) {
    blockers.push(
      `K1: the worker serves git_sha ${sha}, not the RC head ${input.expectedSha}. Evidence bound to the wrong build is worthless — refusing to run.`,
    );
  }
  if (input.admissionHeadSha && input.admissionHeadSha.toLowerCase() !== input.expectedSha.toLowerCase()) {
    blockers.push(
      `K1: the admission JSON names head_sha ${input.admissionHeadSha}, not the RC head ${input.expectedSha}`,
    );
  }
  return blockers;
}

// ─── #2527 — proof verdict evaluators (pure) ─────────────────────────────────

export interface ProofObservation {
  cohort: ProofCohort;
  slot: number;
  publicId: string;
  /** From the fixture row (service-role read), NOT from the response. */
  fingerprint: string;
  /** From the fixture row. */
  chainTxId: string | null;
  orgTag: 'a' | 'b';
  httpStatus: number;
  body: Record<string, unknown> | null;
}

const VERDICT_VALUES = new Set<string>(Object.values(PROOF_VERDICT));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bodyOf(o: ProofObservation): Record<string, unknown> {
  return o.body ?? {};
}

function firstFew(items: string[], n = 4): string {
  return items.length <= n ? items.join('; ') : `${items.slice(0, n).join('; ')}; … (+${items.length - n} more)`;
}

export function evaluateProofVerdicts(observations: ProofObservation[]): AssertionResult[] {
  const out: AssertionResult[] = [];
  const served = observations.filter((o) => o.httpStatus === 200 && isRecord(o.body));

  // A27_0 — every fixture row is served.
  {
    const missing: string[] = [];
    for (const cohort of PROOF_COHORT_IDS) {
      const have = observations.filter((o) => o.cohort === cohort).length;
      if (have !== PROOF_COHORTS[cohort].rows) missing.push(`${cohort}: ${have}/${PROOF_COHORTS[cohort].rows} rows observed`);
    }
    const unserved = observations
      .filter((o) => !(o.httpStatus === 200 && isRecord(o.body)))
      .map((o) => `${o.publicId} HTTP ${o.httpStatus}${typeof o.body?.proof_error_code === 'string' ? ` ${o.body.proof_error_code}` : ''}`);
    out.push({
      id: 'A27_0_fixture_rows_served',
      pr: 2527,
      proves:
        'Every seeded proof row (all six cohorts) is answered HTTP 200 with a JSON body by /api/v1/verify/:publicId/proof — no NO_BATCH_PROOF 404 and no 500 on a row that demonstrably holds a proof.',
      ok: missing.length === 0 && unserved.length === 0,
      detail:
        missing.length === 0 && unserved.length === 0
          ? `${served.length} rows served across ${PROOF_COHORT_IDS.length} cohorts`
          : firstFew([...missing, ...unserved]),
    });
  }

  // A27_1 — the invariant, on EVERY response.
  {
    const violations: string[] = [];
    for (const o of served) {
      const b = bodyOf(o);
      const verdict = b.verdict;
      const verified = b.verified;
      if (typeof verified !== 'boolean') {
        violations.push(`${o.publicId}: verified is ${typeof verified}, not boolean`);
        continue;
      }
      if (typeof verdict !== 'string' || !VERDICT_VALUES.has(verdict)) {
        violations.push(
          `${o.publicId}: verdict is ${JSON.stringify(verdict)} — ${verdict === undefined ? 'ABSENT (pre-#2527 build)' : 'not one of valid|invalid|unverifiable'}`,
        );
        continue;
      }
      if ((verdict === PROOF_VERDICT.INVALID) !== (verified === false)) {
        violations.push(`${o.publicId}: verdict=${verdict} contradicts verified=${verified}`);
      }
      if (b.verdict_note !== PROOF_VERDICT_NOTE[verdict as ProofVerdict]) {
        violations.push(`${o.publicId}: verdict_note is not the canonical note for '${verdict}'`);
      }
    }
    out.push({
      id: 'A27_1_verdict_invariant',
      pr: 2527,
      proves:
        'On every served response `verdict` is present and one of exactly three values, `invalid` <=> `verified === false` (a strict refinement of the boolean, never a contradiction), and `verdict_note` is the canonical §1.5 statement for that verdict, byte for byte.',
      ok: served.length > 0 && violations.length === 0,
      detail: served.length === 0 ? 'nothing was served — the invariant could not be observed' : violations.length === 0 ? `invariant held on ${served.length}/${served.length} responses` : firstFew(violations),
    });
  }

  const inCohorts = (...cohorts: ProofCohort[]) => served.filter((o) => cohorts.includes(o.cohort));
  const expectedCount = (...cohorts: ProofCohort[]) => cohorts.reduce((n, c) => n + PROOF_COHORTS[c].rows, 0);

  // A27_2 — valid cohorts: valid, verified, complete and offline-checkable bundle.
  {
    const rows = inCohorts('a-valid', 'b-valid');
    const problems: string[] = [];
    for (const o of rows) {
      const b = bodyOf(o);
      if (b.verdict !== PROOF_VERDICT.VALID || b.verified !== true) {
        problems.push(`${o.publicId}: verdict=${String(b.verdict)} verified=${String(b.verified)}`);
        continue;
      }
      const bundle = isRecord(b.proof_bundle) ? b.proof_bundle : null;
      if (!bundle) {
        problems.push(`${o.publicId}: proof_bundle is null on a complete row`);
        continue;
      }
      const contract = PROOF_COHORTS[o.cohort];
      const headerHash = blockHashFromHeaderHex(bundle.block_header);
      const root = typeof b.merkle_root === 'string' ? b.merkle_root.toLowerCase() : '';
      const checks: Array<[string, boolean]> = [
        ['merkle_index == slot', bundle.merkle_index === o.slot],
        ['leaf_count == cohort rows', bundle.leaf_count === contract.rows],
        ['block_header is 80 bytes', headerHash !== null],
        ['sha256d(block_header) == block_hash', headerHash !== null && headerHash === String(bundle.block_hash).toLowerCase()],
        ['block_hash == the receipt\'s block', String(bundle.block_hash).toLowerCase() === FIXTURE_BLOCKS[contract.block].hash],
        ['op_return_payload == ARKV||merkle_root', String(bundle.op_return_payload).toLowerCase() === `41524b56${root}`],
        ['tx_id == fixture receipt', bundle.tx_id === o.chainTxId && o.chainTxId === contract.chainTxId],
        ['bundle.fingerprint == fixture fingerprint', String(bundle.fingerprint).toLowerCase() === o.fingerprint.toLowerCase()],
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length > 0) problems.push(`${o.publicId}: ${failed.join(', ')}`);
    }
    out.push({
      id: 'A27_2_valid_cohorts_valid_with_complete_bundle',
      pr: 2527,
      proves:
        'A row whose branch is exactly as deep as its claimed tree, with a leaf index and an exact leaf count, is answered `valid` + `verified:true`, and its proof_bundle is complete and offline-checkable: the published 80-byte header hashes to the published block hash (the real block the receipt is in), the OP_RETURN commits this exact root, tx_id is the fixture\'s real receipt, and index/leaf_count match the seeded tree.',
      ok: rows.length === expectedCount('a-valid', 'b-valid') && problems.length === 0,
      detail:
        rows.length !== expectedCount('a-valid', 'b-valid')
          ? `${rows.length}/${expectedCount('a-valid', 'b-valid')} valid-cohort rows served`
          : problems.length === 0
            ? `${rows.length} rows valid with complete bundles`
            : firstFew(problems),
    });
  }

  // A27_3 — invalid cohort: invalid, and the driver's own re-fold agrees it fails.
  {
    const rows = inCohorts('a-invalid');
    const problems: string[] = [];
    for (const o of rows) {
      const b = bodyOf(o);
      const refold = recomputeMerkleRoot(o.fingerprint, b.merkle_proof);
      const root = typeof b.merkle_root === 'string' ? b.merkle_root.toLowerCase() : null;
      if (b.verdict !== PROOF_VERDICT.INVALID || b.verified !== false) {
        problems.push(`${o.publicId}: verdict=${String(b.verdict)} verified=${String(b.verified)} on a wrong-sibling row`);
      } else if (refold !== null && root !== null && refold === root) {
        problems.push(`${o.publicId}: server says invalid but the published branch DOES fold to the published root`);
      }
    }
    out.push({
      id: 'A27_3_wrong_sibling_invalid',
      pr: 2527,
      proves:
        'A row whose stored sibling is wrong is answered `invalid` + `verified:false`, and the driver\'s independent re-fold of the PUBLISHED branch confirms it does not reach the published root — the alarm is about the record, not a server fault.',
      ok: rows.length === expectedCount('a-invalid') && problems.length === 0,
      detail: rows.length !== expectedCount('a-invalid') ? `${rows.length}/${expectedCount('a-invalid')} rows served` : problems.length === 0 ? `${rows.length} rows invalid, re-fold disagrees with the root as expected` : firstFew(problems),
    });
  }

  // A27_4 — legacy cohort: unverifiable, verified, no bundle.
  {
    const rows = inCohorts('a-legacy');
    const problems: string[] = [];
    for (const o of rows) {
      const b = bodyOf(o);
      const refold = recomputeMerkleRoot(o.fingerprint, b.merkle_proof);
      const root = typeof b.merkle_root === 'string' ? b.merkle_root.toLowerCase() : null;
      if (b.verdict !== PROOF_VERDICT.UNVERIFIABLE || b.verified !== true) {
        problems.push(`${o.publicId}: verdict=${String(b.verdict)} verified=${String(b.verified)} on a row with no merkle_index`);
      } else if (refold === null || refold !== root) {
        problems.push(`${o.publicId}: the published branch does not fold to the root — this row should be sound, only incomplete`);
      } else if (b.proof_bundle !== null) {
        problems.push(`${o.publicId}: proof_bundle is non-null without a merkle_index`);
      }
    }
    out.push({
      id: 'A27_4_legacy_unverifiable_not_valid',
      pr: 2527,
      proves:
        'A back-catalogue-shaped row (sound branch, NO merkle_index) is answered `unverifiable` + `verified:true` — the guard could not arm, so the pass is not upgraded to `valid` — and no proof_bundle is fabricated for it.',
      ok: rows.length === expectedCount('a-legacy') && problems.length === 0,
      detail: rows.length !== expectedCount('a-legacy') ? `${rows.length}/${expectedCount('a-legacy')} rows served` : problems.length === 0 ? `${rows.length} legacy rows unverifiable with null bundles` : firstFew(problems),
    });
  }

  // A27_5 — the head-2 rule: armed-but-uninspected branches are unverifiable.
  {
    const rows = inCohorts('a-uninspected', 'a-overlong');
    const problems: string[] = [];
    for (const o of rows) {
      const b = bodyOf(o);
      const refold = recomputeMerkleRoot(o.fingerprint, b.merkle_proof);
      const root = typeof b.merkle_root === 'string' ? b.merkle_root.toLowerCase() : null;
      if (b.verdict !== PROOF_VERDICT.UNVERIFIABLE || b.verified !== true) {
        problems.push(
          `${o.publicId} (${o.cohort}): verdict=${String(b.verdict)} verified=${String(b.verified)}${b.verdict === PROOF_VERDICT.VALID ? ` — this is the ${PREVIOUS_RC_HEAD_SHA.slice(0, 8)} behaviour, not the RC head's` : ''}`,
        );
      } else if (refold === null || refold !== root) {
        problems.push(`${o.publicId}: the published branch does not fold to the root — this row should pass the recompute`);
      }
    }
    out.push({
      id: 'A27_5_uninspected_branch_unverifiable',
      pr: 2527,
      proves:
        'A branch the guard was nominally armed for but could not have inspected — empty under a 2-leaf claim (a-uninspected), or one sibling long under a 1-leaf claim (a-overlong) — is answered `unverifiable`, not `valid`, even though the recompute passes. This is the isStructuralGuardEffective rule that distinguishes this RC head from 557e485a.',
      ok: rows.length === expectedCount('a-uninspected', 'a-overlong') && problems.length === 0,
      detail: rows.length !== expectedCount('a-uninspected', 'a-overlong') ? `${rows.length}/${expectedCount('a-uninspected', 'a-overlong')} rows served` : problems.length === 0 ? `${rows.length} uninspected/over-long rows unverifiable` : firstFew(problems),
    });
  }

  // A27_6 — independent agreement in both directions, on every response.
  {
    const problems: string[] = [];
    for (const o of served) {
      const b = bodyOf(o);
      const refold = recomputeMerkleRoot(o.fingerprint, b.merkle_proof);
      const root = typeof b.merkle_root === 'string' ? b.merkle_root.toLowerCase() : null;
      const driverSaysValid = refold !== null && root !== null && refold === root;
      if (b.verified !== driverSaysValid) {
        problems.push(`${o.publicId}: server verified=${String(b.verified)} but the driver's re-fold says ${driverSaysValid}`);
      }
      if (String(b.fingerprint).toLowerCase() !== o.fingerprint.toLowerCase()) {
        problems.push(`${o.publicId}: response fingerprint is not this row's fingerprint`);
      }
      if (b.public_id !== o.publicId) {
        problems.push(`${o.publicId}: response public_id is ${String(b.public_id)}`);
      }
    }
    out.push({
      id: 'A27_6_independent_recompute_agrees',
      pr: 2527,
      proves:
        'For every served row, the driver\'s own double-SHA256 re-fold of the PUBLISHED branch against the PUBLISHED root agrees with the server\'s `verified` in BOTH directions, and the response echoes this row\'s own public_id and fingerprint. A server that lies either way is caught.',
      ok: served.length > 0 && problems.length === 0,
      detail: served.length === 0 ? 'nothing served' : problems.length === 0 ? `driver and server agree on ${served.length}/${served.length} rows` : firstFew(problems),
    });
  }

  // A27_7 — per-org attribution.
  {
    const orgA = served.filter((o) => o.orgTag === 'a');
    const orgB = served.filter((o) => o.orgTag === 'b');
    const fpA = new Set(orgA.map((o) => String(bodyOf(o).fingerprint).toLowerCase()));
    const fpB = new Set(orgB.map((o) => String(bodyOf(o).fingerprint).toLowerCase()));
    const fixtureA = new Set(observations.filter((o) => o.orgTag === 'a').map((o) => o.fingerprint.toLowerCase()));
    const fixtureB = new Set(observations.filter((o) => o.orgTag === 'b').map((o) => o.fingerprint.toLowerCase()));
    const crossed = [...fpA].filter((f) => fixtureB.has(f)).length + [...fpB].filter((f) => fixtureA.has(f)).length;
    const overlap = [...fpA].filter((f) => fpB.has(f)).length;
    out.push({
      id: 'A27_7_per_org_attribution',
      pr: 2527,
      proves:
        'Both orgs\' public ids were served, and no org-A public id ever answered with an org-B fingerprint or vice versa — the public read attributes each record to its own org\'s document.',
      ok: orgA.length > 0 && orgB.length > 0 && crossed === 0 && overlap === 0,
      detail: `org a: ${orgA.length} served, org b: ${orgB.length} served, cross-org fingerprints: ${crossed}, overlap: ${overlap}`,
    });
  }

  return out;
}

// ─── #2525 — attestation park evaluators (pure) ──────────────────────────────

export interface AttestationObservation {
  kind: 'seeded' | 'nonexistent' | 'burst' | 'malformed';
  id: string;
  /** 0 = transport failure (no HTTP response at all). */
  status: number;
  /** Every response header, lower-cased names. */
  headers: Record<string, string>;
  body: string;
}

/** The entire response as text — status line, every header, body (K4). */
export function rawResponseText(o: AttestationObservation): string {
  const headerLines = Object.entries(o.headers).map(([k, v]) => `${k}: ${v}`);
  return [`HTTP ${o.status}`, ...headerLines, '', o.body].join('\n');
}

export function toParkProbe(o: AttestationObservation): ParkProbe {
  return {
    status: o.status,
    body: o.body,
    rateLimited: Object.keys(o.headers).some((k) => k.toLowerCase() === 'x-ratelimit-limit'),
  };
}

export interface AttestationFixtureState {
  /** attestation_id -> status as read from the rig, or null if discovery failed. */
  statuses: Record<string, string> | null;
}

export function evaluateAttestationPark(
  observations: AttestationObservation[],
  fixture: AttestationFixtureState,
): AssertionResult[] {
  const out: AssertionResult[] = [];
  const wellFormed = observations.filter((o) => o.kind !== 'malformed');
  const observedWellFormed = wellFormed.filter((o) => isObserved(toParkProbe(o)));
  const malformed = observations.find((o) => o.kind === 'malformed') ?? null;

  // A25_0 — the table is POPULATED, so the park is measured over real rows.
  {
    const problems: string[] = [];
    if (!fixture.statuses) {
      problems.push('fixture discovery failed — cannot tell whether the table holds the rows');
    } else {
      for (const id of ATTESTATION_FIXTURE_IDS) {
        const want = expectedAttestationStatus(id);
        const have = fixture.statuses[id];
        if (have === undefined) problems.push(`${id}: absent`);
        else if (have !== want) problems.push(`${id}: status ${have}, expected ${want}`);
      }
    }
    out.push({
      id: 'A25_0_attestation_fixture_populated',
      pr: 2525,
      proves:
        'legally_binding_attestations holds all ten seeded rows at their target statuses (draft, pending_notarization, requires_review, notarized, anchored × two orgs), each carrying a natural-person subject and notary details — so the park below is proven over a populated table, not an empty one.',
      ok: problems.length === 0,
      detail: problems.length === 0 ? `${ATTESTATION_FIXTURE_IDS.length} rows present at their target statuses` : firstFew(problems),
    });
  }

  // A25_1 — PR #2525's own contract, via its own classifier.
  {
    const wf = observedWellFormed.find((o) => o.kind === 'nonexistent') ?? observedWellFormed[0] ?? wellFormed[0];
    if (!wf || !malformed) {
      out.push({
        id: 'A25_1_park_contract',
        pr: 2525,
        proves: 'PR #2525\'s own classifier accepts the park: 404 well-formed / 400 malformed with the ARK-ATT hint, no "not found" claim, X-RateLimit-* present, no application 5xx.',
        ok: false,
        detail: !wf ? 'no well-formed probe was made' : 'no malformed probe was made',
      });
    } else {
      const verdict = classifyPark(toParkProbe(wf), toParkProbe(malformed));
      out.push({
        id: 'A25_1_park_contract',
        pr: 2525,
        proves:
          'PR #2525\'s own classifier (imported, not copied) accepts the observed pair: a well-formed id answers 404 without asserting "not found", a malformed id answers 400 carrying the ARK-ATT routing hint, both carry X-RateLimit-* (the park sits BELOW the limiters), and neither is an application 5xx.',
        ok: verdict.status === 'pass',
        detail: verdict.status === 'pass' ? `well-formed ${wf.status} / malformed ${malformed.status}, rate-limit headers on both` : firstFew(verdict.blockers),
      });
    }
  }

  // A25_2 — no existence oracle: every well-formed id, seeded or not, answers identically.
  {
    const statuses = new Set(observedWellFormed.map((o) => o.status));
    const bodies = new Set(observedWellFormed.map((o) => o.body));
    const twoHundreds = observedWellFormed.filter((o) => o.status === 200).map((o) => o.id);
    const notFoundLeak = observedWellFormed.filter((o) => PARK_NOT_FOUND_LEAK.test(o.body)).map((o) => o.id);
    const seededObserved = observedWellFormed.filter((o) => o.kind === 'seeded').length;
    const ok =
      observedWellFormed.length > 0 &&
      seededObserved === ATTESTATION_FIXTURE_IDS.length &&
      statuses.size === 1 &&
      statuses.has(404) &&
      bodies.size === 1 &&
      notFoundLeak.length === 0;
    const problems: string[] = [];
    if (seededObserved !== ATTESTATION_FIXTURE_IDS.length) problems.push(`${seededObserved}/${ATTESTATION_FIXTURE_IDS.length} seeded ids observed`);
    if (twoHundreds.length > 0) problems.push(`answered 200 (the park is NOT in front of the handler): ${twoHundreds.join(', ')}`);
    if (!(statuses.size === 1 && statuses.has(404))) problems.push(`statuses seen: ${[...statuses].join(',')}`);
    if (bodies.size > 1) problems.push(`${bodies.size} distinct 404 bodies — withheld vs nonexistent are distinguishable`);
    if (notFoundLeak.length > 0) problems.push(`"not found" claimed for ${notFoundLeak.length} id(s)`);
    out.push({
      id: 'A25_2_no_existence_oracle',
      pr: 2525,
      proves:
        'Every well-formed id — all ten seeded rows in every status, a random nonexistent id, and the burst — answers HTTP 404 with a BYTE-IDENTICAL body, so an anonymous caller cannot distinguish a draft, a flagged, a notarized or an anchored attestation from one that does not exist; and that body never claims a corpus was searched.',
      ok,
      detail: ok ? `${observedWellFormed.length} well-formed responses, 1 status (404), 1 body` : firstFew(problems),
    });
  }

  // A25_3 — K4: PII never leaves, on ANY byte of ANY response.
  {
    const hits: string[] = [];
    for (const o of observations) {
      if (!isObserved(toParkProbe(o))) continue;
      const raw = rawResponseText(o).toLowerCase();
      for (const literal of ATTESTATION_PII_LITERALS) {
        if (raw.includes(literal.toLowerCase())) hits.push(`${o.id}: contains '${literal}'`);
      }
      for (const key of ATTESTATION_SENSITIVE_KEYS) {
        if (raw.includes(key)) hits.push(`${o.id}: contains key '${key}'`);
      }
    }
    const seededObserved = observations.filter((o) => o.kind === 'seeded' && isObserved(toParkProbe(o))).length;
    out.push({
      id: 'A25_3_pii_never_leaves_any_byte',
      pr: 2525,
      proves:
        'Across every attestation response of the cycle — status line, every header, and body (K4: the whole wire response, not parsed fields) — none of the seeded subject names, notary names or commission numbers appears, and none of the sensitive column/response keys appears. The control ran over all ten seeded rows.',
      ok: seededObserved === ATTESTATION_FIXTURE_IDS.length && hits.length === 0,
      detail: seededObserved !== ATTESTATION_FIXTURE_IDS.length ? `control incomplete: ${seededObserved}/${ATTESTATION_FIXTURE_IDS.length} seeded rows observed` : hits.length === 0 ? `0 hits across ${observations.length} responses (${ATTESTATION_PII_LITERALS.length} literals + ${ATTESTATION_SENSITIVE_KEYS.length} keys searched)` : firstFew(hits),
    });
  }

  // A25_4 — the park's position: §1.10 headers on EVERY observed response.
  {
    const missing = observations.filter((o) => isObserved(toParkProbe(o)) && !toParkProbe(o).rateLimited).map((o) => o.id);
    const observed = observations.filter((o) => isObserved(toParkProbe(o))).length;
    out.push({
      id: 'A25_4_rate_limit_headers_on_every_response',
      pr: 2525,
      proves:
        'Every observed attestation response carries X-RateLimit-Limit — the park is mounted BELOW the rate limiters, so the public endpoint stays on its §1.10 budget. A park mounted above them answers with the right status and body while silently unthrottled; the header is the only external observation of its position.',
      ok: observed > 0 && missing.length === 0,
      detail: observed === 0 ? 'nothing observed' : missing.length === 0 ? `headers present on ${observed}/${observed}` : `missing on ${missing.length}: ${firstFew(missing)}`,
    });
  }

  // A25_5 — never an application 5xx; infra aborts named, not blamed.
  {
    const app5xx = observations.filter((o) => isObserved(toParkProbe(o)) && o.status >= 500).map((o) => `${o.id} ${o.status}`);
    const infra = observations.filter((o) => isInfraAbort(toParkProbe(o))).length;
    const transport = observations.filter((o) => o.status === 0).length;
    const observed = observations.filter((o) => isObserved(toParkProbe(o))).length;
    out.push({
      id: 'A25_5_never_application_5xx',
      pr: 2525,
      proves:
        'No attestation request in the cycle — including the concurrent burst — was answered an APPLICATION 5xx (the enabled CRITICAL 5xx-burst policy has no path dimension, so a 5xx here pages the on-call for a route that cannot succeed). Cloud Run capacity refusals and transport failures are counted separately and never scored as application behaviour.',
      ok: observed > 0 && app5xx.length === 0,
      detail: observed === 0 ? `nothing observed (${infra} infra aborts, ${transport} transport failures)` : app5xx.length === 0 ? `${observed} observed, 0 application 5xx, ${infra} infra aborts, ${transport} transport failures` : firstFew(app5xx),
    });
  }

  return out;
}

// ─── #2526 — detect-reorgs evaluators (pure) ─────────────────────────────────

export interface JobObservation {
  status: number;
  body: unknown;
  bodyText: string;
}

const DETECT_REORGS_BUDGET_MS = 30 * 60 * 1000;
/** tip-10 (query floor) .. tip-5 (earliest SECURED) at a 10-minute block target. */
const REORG_COVERAGE_BAND_MS = 5 * 10 * 60 * 1000;

export function evaluateDetectReorgs(input: {
  health: HealthObservation;
  expectedSha: string;
  manifest: ScheduledJobSpec[];
  job: JobObservation;
}): AssertionResult[] {
  const out: AssertionResult[] = [];

  // A26_1 — the worker boots and serves /api/health on the RC head.
  {
    const blockers = evaluateBuildIdentity({ health: input.health, expectedSha: input.expectedSha });
    const healthy = input.health.statusField === 'healthy' || input.health.statusField === 'ok';
    out.push({
      id: 'A26_1_worker_serves_health_on_rc_head',
      pr: 2526,
      proves:
        'The worker built from the RC head boots and answers /api/health 200 with git_sha equal to the RC head — the manifest change did not break startup, and every other assertion in this row is bound to that exact build.',
      ok: blockers.length === 0 && healthy,
      detail: blockers.length > 0 ? firstFew(blockers) : `HTTP ${input.health.httpStatus}, status=${input.health.statusField ?? '<absent>'}, git_sha=${input.health.gitSha}`,
    });
  }

  // A26_2 — the manifest entry, statically.
  {
    const job = input.manifest.find((j) => j.id === 'detect-reorgs');
    const errors = validateSchedulerManifest(input.manifest);
    const problems: string[] = [];
    if (!job) problems.push('detect-reorgs is not in SCHEDULER_MANIFEST');
    else {
      if (!job.enabled) problems.push('entry is not enabled');
      if (job.method !== 'POST') problems.push(`method ${job.method}`);
      if (job.targetPath !== '/jobs/detect-reorgs') problems.push(`targetPath ${job.targetPath}`);
      if (job.schedule !== '*/10 * * * *') problems.push(`schedule ${job.schedule}`);
      if (job.category !== 'anchor-pipeline') problems.push(`category ${job.category}`);
      if (job.maxSilenceMs !== DETECT_REORGS_BUDGET_MS) problems.push(`maxSilenceMs ${String(job.maxSilenceMs)} (expected ${DETECT_REORGS_BUDGET_MS})`);
      if (!(typeof job.maxSilenceMs === 'number' && job.maxSilenceMs < REORG_COVERAGE_BAND_MS)) problems.push('maxSilenceMs is not below the ~50-minute reorg-check coverage band');
    }
    if (errors.length > 0) problems.push(`validateSchedulerManifest: ${errors.join(' | ')}`);
    out.push({
      id: 'A26_2_manifest_registers_detect_reorgs',
      pr: 2526,
      proves:
        'SCHEDULER_MANIFEST (read statically from the driver\'s checkout, which K1 ties to the deployed SHA) registers detect-reorgs: enabled, POST /jobs/detect-reorgs, */10 cadence, anchor-pipeline, with a 30-minute silence budget that sits BELOW this control\'s own ~50-minute reorg-check coverage band (not the peers\' 1h), and the whole manifest still validates.',
      ok: problems.length === 0,
      detail: problems.length === 0 ? `entry present, budget ${DETECT_REORGS_BUDGET_MS} ms, manifest validates (${input.manifest.length} entries)` : firstFew(problems),
    });
  }

  // A26_3 — the job the entry names answers.
  {
    const b = isRecord(input.job.body) ? input.job.body : null;
    const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const problems: string[] = [];
    if (input.job.status !== 200) {
      problems.push(`POST /jobs/detect-reorgs answered HTTP ${input.job.status}${input.job.status === 401 || input.job.status === 403 ? ' — cron auth rejected (X-Cron-Secret / OIDC)' : ''}`);
    } else if (!b) {
      problems.push(`200 with a non-object body: ${input.job.bodyText.slice(0, 120)}`);
    } else {
      for (const k of ['checked', 'reorgsDetected', 'reverted'] as const) {
        if (!isCount(b[k])) problems.push(`${k} is ${JSON.stringify(b[k])}, not a non-negative integer`);
      }
      if ('error' in b) problems.push(`body carries error: ${String(b.error)}`);
    }
    out.push({
      id: 'A26_3_detect_reorgs_endpoint_answers',
      pr: 2526,
      proves:
        'The route the manifest entry names, POST /jobs/detect-reorgs, is mounted on this build, accepts the cron credential, and answers 200 with the ReorgCheckResult shape {checked, reorgsDetected, reverted} as non-negative integers — nothing more is claimed about what it looked at (see NOT_ASSERTED).',
      ok: problems.length === 0,
      detail: problems.length === 0 ? `200 ${input.job.bodyText.slice(0, 120)}` : firstFew(problems),
    });
  }

  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = argv[++i];
        break;
      case '--admission-json':
        args.admissionJson = argv[++i];
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = argv[++i];
        break;
      case '--cron-secret':
        args.cronSecret = argv[++i];
        break;
      case '--bearer-token':
        args.bearerToken = argv[++i];
        break;
      case '--supabase-url':
        args.supabaseUrl = argv[++i];
        break;
      case '--supabase-service-key':
        args.supabaseServiceKey = argv[++i];
        break;
      case '--expected-git-sha':
        args.expectedGitSha = argv[++i];
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      case '--window-start':
        args.windowStart = argv[++i];
        break;
      case '--window-end':
        args.windowEnd = argv[++i];
        break;
      case '--attestation-burst':
        args.attestationBurst = Number.parseInt(argv[++i], 10);
        break;
      case '--deny-ref':
        (args.denyRefs ??= []).push(argv[++i]);
        break;
      case '--deny-service':
        (args.denyServices ??= []).push(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Fill unset secret/config fields from the environment (flags win; §1.4: argv is visible in ps). */
export function applyEnvDefaults(args: DriverArgs, env: NodeJS.ProcessEnv): DriverArgs {
  const split = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    ...args,
    cronSecret: args.cronSecret ?? env.RIG_CRON_SECRET,
    bearerToken: args.bearerToken ?? env.RIG_BEARER_TOKEN,
    supabaseUrl: args.supabaseUrl ?? env.RIG_SUPABASE_URL,
    supabaseServiceKey: args.supabaseServiceKey ?? env.RIG_SUPABASE_SERVICE_ROLE_KEY,
    denyRefs: [...(args.denyRefs ?? []), ...split(env.RIG_DENY_REFS)],
    denyServices: [...(args.denyServices ?? []), ...split(env.RIG_DENY_SERVICES)],
  };
}

export function validateLiveArgs(args: DriverArgs): string[] {
  const blockers: string[] = [];
  if (!args.targetUrl) blockers.push('missing --target-url');
  if (!args.admissionJson) blockers.push('missing --admission-json');
  if (!args.evidenceJsonl) blockers.push('missing --evidence-jsonl');
  if (!args.cronSecret && !args.bearerToken) blockers.push('missing --cron-secret or --bearer-token (POST /jobs/detect-reorgs needs a cron credential)');
  if (!args.supabaseUrl) blockers.push('missing --supabase-url (or RIG_SUPABASE_URL)');
  if (!args.supabaseServiceKey) blockers.push('missing --supabase-service-key (or RIG_SUPABASE_SERVICE_ROLE_KEY)');
  return blockers;
}

export function resolveBurst(n: number | undefined): number {
  return Number.isInteger(n) && (n as number) >= 1 ? Math.min(n as number, 32) : 8;
}

// ─── Synthetic observations (self-test + unit tests) ─────────────────────────

/** A healthy RC-head /proof response for (cohort, slot), as the fixture predicts it. */
export function healthyProofBody(cohort: ProofCohort, slot: number): Record<string, unknown> {
  const contract = PROOF_COHORTS[cohort];
  const shape = fixtureProofShape(cohort, slot);
  const block = FIXTURE_BLOCKS[contract.block];
  const bundleShouldExist = contract.bundle === 'required' || (contract.bundle === 'unasserted' && shape.merkleIndex !== null);
  return {
    public_id: fixturePublicId(cohort, slot),
    fingerprint: shape.fingerprint,
    merkle_root: shape.merkleRoot,
    merkle_proof: shape.proofPath,
    tx_id: contract.chainTxId,
    block_height: block.height,
    block_timestamp: new Date(block.time * 1000).toISOString(),
    batch_id: shape.batchId,
    verified: contract.expectedVerified,
    verdict: contract.expectedVerdict,
    verdict_note: PROOF_VERDICT_NOTE[contract.expectedVerdict],
    proof_bundle: bundleShouldExist
      ? {
          fingerprint: shape.fingerprint,
          merkle_root: shape.merkleRoot,
          merkle_proof: shape.proofPath,
          merkle_index: shape.merkleIndex,
          leaf_count: shape.leafCount,
          tx_id: contract.chainTxId,
          block_height: block.height,
          block_hash: block.hash,
          block_header: block.headerHex,
          op_return_payload: `41524b56${shape.merkleRoot}`,
          block_timestamp: new Date(block.time * 1000).toISOString(),
          proof_schema_version: 1,
          signature: null,
        }
      : null,
  };
}

export function healthyProofObservations(): ProofObservation[] {
  const out: ProofObservation[] = [];
  for (const cohort of PROOF_COHORT_IDS) {
    for (let slot = 0; slot < PROOF_COHORTS[cohort].rows; slot += 1) {
      out.push({
        cohort,
        slot,
        publicId: fixturePublicId(cohort, slot),
        fingerprint: fixtureFingerprint(cohort, slot),
        chainTxId: PROOF_COHORTS[cohort].chainTxId,
        orgTag: PROOF_COHORTS[cohort].org,
        httpStatus: 200,
        body: healthyProofBody(cohort, slot),
      });
    }
  }
  return out;
}

/** Map over bodies of selected cohorts — the broken-build vector builder. */
export function mutateProofObservations(
  base: ProofObservation[],
  cohorts: ProofCohort[] | 'all',
  mutate: (body: Record<string, unknown>, o: ProofObservation) => Record<string, unknown> | null,
  status?: number,
): ProofObservation[] {
  return base.map((o) => {
    if (cohorts !== 'all' && !cohorts.includes(o.cohort)) return o;
    const body = mutate({ ...(o.body ?? {}) }, o);
    return { ...o, body, httpStatus: status ?? o.httpStatus };
  });
}

const PARK_404_BODY = JSON.stringify({
  verified: false,
  error: 'Legally binding attestation verification is not implemented — no attestation records exist',
});
const PARK_400_BODY = JSON.stringify({
  verified: false,
  error: 'Invalid attestation ID format — expected ARK-ATT-* prefix',
});
const RL_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '97' };

export function healthyAttestationObservations(burst = 8): AttestationObservation[] {
  const seeded: AttestationObservation[] = ATTESTATION_FIXTURE_IDS.map((id) => ({
    kind: 'seeded', id, status: 404, headers: { ...RL_HEADERS }, body: PARK_404_BODY,
  }));
  const nonexistent: AttestationObservation = { kind: 'nonexistent', id: 'ARK-ATT-RC0902-NX0000', status: 404, headers: { ...RL_HEADERS }, body: PARK_404_BODY };
  const bursts: AttestationObservation[] = Array.from({ length: burst }, (_, i) => ({
    kind: 'burst', id: `ARK-ATT-SOAK00000${i}`, status: 404, headers: { ...RL_HEADERS }, body: PARK_404_BODY,
  }));
  const malformed: AttestationObservation = { kind: 'malformed', id: 'INVALID!!!', status: 400, headers: { ...RL_HEADERS }, body: PARK_400_BODY };
  return [...seeded, nonexistent, ...bursts, malformed];
}

export function healthyAttestationFixture(): AttestationFixtureState {
  return { statuses: Object.fromEntries(ATTESTATION_FIXTURE_IDS.map((id) => [id, expectedAttestationStatus(id) as string])) };
}

/** What the retained (unreachable) handler would publish for a notarized row — the unpark vector. */
export function disclosedAttestationBody(id: string): string {
  const org = id.includes('-A-') ? 'a' : 'b';
  return JSON.stringify({
    verified: id.endsWith('-ANCHORED'),
    attestation: {
      public_id: id,
      type: org === 'a' ? 'notarized' : 'witnessed',
      status: expectedAttestationStatus(id),
      created_at: '2026-09-02T00:00:00.000Z',
      attesting_org: { name: org === 'a' ? 'Meridian Notarial Fixture Org' : 'Halcyon Witness Fixture Org', verified: org === 'a' },
      subject: { name: org === 'a' ? 'Amara Okonkwo-Fixture' : 'Tobias Lindqvist-Fixture' },
      notarization: { status: 'completed', notary_name: org === 'a' ? 'Priya Raghunathan-Fixture' : 'Elena Marchetti-Fixture', commission_number: org === 'a' ? 'RC0902-COMM-A-7731' : 'RC0902-COMM-B-8842' },
    },
    anchor: null,
    verify_url: `https://app.arkova.ai/verify/attestation/${id}`,
  });
}

export function healthyHealth(): HealthObservation {
  return { httpStatus: 200, gitSha: RC_HEAD_SHA, statusField: 'healthy' };
}

export function healthyJob(): JobObservation {
  const body = { checked: 0, reorgsDetected: 0, reverted: 0 };
  return { status: 200, body, bodyText: JSON.stringify(body) };
}

// ─── Self-test ───────────────────────────────────────────────────────────────

const ok = (list: AssertionResult[], id: string): boolean => list.find((a) => a.id === id)?.ok === true;

/**
 * Local validation of the assertion logic. Crucially it asserts the logic
 * DISCRIMINATES: every broken-build vector must FAIL the assertion that exists
 * for it, not merely the healthy vectors pass.
 */
export async function runSelfTest(): Promise<DriverRow> {
  const utc = new Date().toISOString();

  // ── #2527 ──
  const healthy = healthyProofObservations();
  const healthyProof = evaluateProofVerdicts(healthy);
  const noVerdict = evaluateProofVerdicts(
    mutateProofObservations(healthy, 'all', (b) => {
      delete b.verdict;
      delete b.verdict_note;
      return b;
    }),
  );
  const previousHead = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-uninspected', 'a-overlong'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })),
  );
  const contradictionFalseValid = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-invalid'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })),
  );
  const contradictionTrueInvalid = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-valid'], (b) => ({ ...b, verdict: 'invalid', verdict_note: PROOF_VERDICT_NOTE.invalid })),
  );
  const fourthValue = evaluateProofVerdicts(mutateProofObservations(healthy, ['b-valid'], (b) => ({ ...b, verdict: 'unknown' })));
  const rewordedNote = evaluateProofVerdicts(mutateProofObservations(healthy, ['a-valid'], (b) => ({ ...b, verdict_note: 'Verified.' })));
  const legacyUpgraded = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-legacy'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })),
  );
  const launderedFailure = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-invalid'], (b) => ({ ...b, verified: true, verdict: 'unverifiable', verdict_note: PROOF_VERDICT_NOTE.unverifiable })),
  );
  const hollow404 = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-valid'], () => ({ error: 'No Merkle proof available for this record.', proof_error_code: 'NO_BATCH_PROOF' }), 404),
  );
  const crossOrg = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['b-valid'], (b, o) => ({ ...b, fingerprint: fixtureFingerprint('a-valid', o.slot) })),
  );
  const bundleWithForgedHeader = evaluateProofVerdicts(
    mutateProofObservations(healthy, ['a-valid'], (b) => {
      const bundle = { ...(b.proof_bundle as Record<string, unknown>), block_header: 'ab'.repeat(80) };
      return { ...b, proof_bundle: bundle };
    }),
  );

  // ── #2525 ──
  const park = healthyAttestationObservations();
  const fixture = healthyAttestationFixture();
  const healthyPark = evaluateAttestationPark(park, fixture);
  const unparked = evaluateAttestationPark(
    park.map((o) =>
      o.kind === 'seeded' && (o.id.endsWith('-NOTARIZED') || o.id.endsWith('-ANCHORED'))
        ? { ...o, status: 200, body: disclosedAttestationBody(o.id) }
        : o,
    ),
    fixture,
  );
  const oracle = evaluateAttestationPark(
    park.map((o) =>
      o.kind === 'seeded' && !(o.id.endsWith('-NOTARIZED') || o.id.endsWith('-ANCHORED'))
        ? { ...o, body: JSON.stringify({ verified: false, error: 'Attestation not found' }) }
        : o,
    ),
    fixture,
  );
  const aboveLimiters = evaluateAttestationPark(
    park.map((o) => ({ ...o, headers: { 'content-type': 'application/json' } })),
    fixture,
  );
  const app5xx = evaluateAttestationPark(
    park.map((o) => (o.kind === 'seeded' && o.id.endsWith('-A-DRAFT') ? { ...o, status: 500, body: '{"error":"Internal server error"}' } : o)),
    fixture,
  );
  const infraAborted = evaluateAttestationPark(
    park.map((o) =>
      o.kind === 'burst' && o.id.endsWith('7')
        ? { ...o, status: 500, headers: {}, body: 'The request was aborted because there was no available instance.' }
        : o,
    ),
    fixture,
  );
  const headerLeak = evaluateAttestationPark(
    park.map((o) => (o.kind === 'seeded' && o.id.endsWith('-B-REVIEW') ? { ...o, headers: { ...o.headers, 'x-debug-subject': 'Tobias Lindqvist-Fixture' } } : o)),
    fixture,
  );
  const emptyTable = evaluateAttestationPark(park, { statuses: {} });
  const unreachable = evaluateAttestationPark(
    park.map((o) => ({ ...o, status: 0, headers: {}, body: 'transport failure — rig unreachable' })),
    fixture,
  );

  // ── #2526 ──
  const healthyReorg = evaluateDetectReorgs({ health: healthyHealth(), expectedSha: RC_HEAD_SHA, manifest: SCHEDULER_MANIFEST, job: healthyJob() });
  const manifestMissing = evaluateDetectReorgs({
    health: healthyHealth(), expectedSha: RC_HEAD_SHA,
    manifest: SCHEDULER_MANIFEST.filter((j) => j.id !== 'detect-reorgs'), job: healthyJob(),
  });
  const peerBudget = evaluateDetectReorgs({
    health: healthyHealth(), expectedSha: RC_HEAD_SHA,
    manifest: SCHEDULER_MANIFEST.map((j) => (j.id === 'detect-reorgs' ? { ...j, maxSilenceMs: 60 * 60 * 1000 } : j)), job: healthyJob(),
  });
  const job500 = evaluateDetectReorgs({
    health: healthyHealth(), expectedSha: RC_HEAD_SHA, manifest: SCHEDULER_MANIFEST,
    job: { status: 500, body: { error: 'Processing failed' }, bodyText: '{"error":"Processing failed"}' },
  });
  const jobMalformed = evaluateDetectReorgs({
    health: healthyHealth(), expectedSha: RC_HEAD_SHA, manifest: SCHEDULER_MANIFEST,
    job: { status: 200, body: { checked: 0 }, bodyText: '{"checked":0}' },
  });
  const job401 = evaluateDetectReorgs({
    health: healthyHealth(), expectedSha: RC_HEAD_SHA, manifest: SCHEDULER_MANIFEST,
    job: { status: 401, body: { error: 'Unauthorized' }, bodyText: '{"error":"Unauthorized"}' },
  });
  const wrongSha = evaluateDetectReorgs({
    health: { httpStatus: 200, gitSha: PREVIOUS_RC_HEAD_SHA, statusField: 'healthy' }, expectedSha: RC_HEAD_SHA,
    manifest: SCHEDULER_MANIFEST, job: healthyJob(),
  });

  // ── K1 / K3 / K2 ──
  const k1Wrong = evaluateBuildIdentity({ health: { httpStatus: 200, gitSha: PREVIOUS_RC_HEAD_SHA, statusField: 'healthy' }, expectedSha: RC_HEAD_SHA });
  const k1Unknown = evaluateBuildIdentity({ health: { httpStatus: 200, gitSha: 'unknown', statusField: 'healthy' }, expectedSha: RC_HEAD_SHA });
  const k1Admission = evaluateBuildIdentity({ health: healthyHealth(), expectedSha: RC_HEAD_SHA, admissionHeadSha: PREVIOUS_RC_HEAD_SHA });
  const k1Right = evaluateBuildIdentity({ health: healthyHealth(), expectedSha: RC_HEAD_SHA, admissionHeadSha: RC_HEAD_SHA });

  const counts: Record<string, number | boolean | string | null> = {
    // #2527 — healthy passes, every broken vector fails the assertion that exists for it.
    proofHealthyAllPass: healthyProof.every((a) => a.ok),
    preVerdictBuildFailsA27_1: !ok(noVerdict, 'A27_1_verdict_invariant'),
    previousRcHeadFailsA27_5: !ok(previousHead, 'A27_5_uninspected_branch_unverifiable'),
    previousRcHeadStillPassesA27_1: ok(previousHead, 'A27_1_verdict_invariant'),
    contradictionFalseValidFailsA27_1: !ok(contradictionFalseValid, 'A27_1_verdict_invariant'),
    contradictionTrueInvalidFailsA27_1: !ok(contradictionTrueInvalid, 'A27_1_verdict_invariant'),
    fourthValueFailsA27_1: !ok(fourthValue, 'A27_1_verdict_invariant'),
    rewordedNoteFailsA27_1: !ok(rewordedNote, 'A27_1_verdict_invariant'),
    legacyUpgradedFailsA27_4: !ok(legacyUpgraded, 'A27_4_legacy_unverifiable_not_valid'),
    launderedFailureFailsA27_3: !ok(launderedFailure, 'A27_3_wrong_sibling_invalid'),
    launderedFailureFailsA27_6: !ok(launderedFailure, 'A27_6_independent_recompute_agrees'),
    hollow404FailsA27_0: !ok(hollow404, 'A27_0_fixture_rows_served'),
    crossOrgFailsA27_7: !ok(crossOrg, 'A27_7_per_org_attribution'),
    forgedHeaderFailsA27_2: !ok(bundleWithForgedHeader, 'A27_2_valid_cohorts_valid_with_complete_bundle'),
    // #2525
    parkHealthyAllPass: healthyPark.every((a) => a.ok),
    unparkedFailsA25_2: !ok(unparked, 'A25_2_no_existence_oracle'),
    unparkedFailsA25_3: !ok(unparked, 'A25_3_pii_never_leaves_any_byte'),
    oracleFailsA25_2: !ok(oracle, 'A25_2_no_existence_oracle'),
    aboveLimitersFailsA25_4: !ok(aboveLimiters, 'A25_4_rate_limit_headers_on_every_response'),
    aboveLimitersFailsA25_1: !ok(aboveLimiters, 'A25_1_park_contract'),
    app5xxFailsA25_5: !ok(app5xx, 'A25_5_never_application_5xx'),
    infraAbortNotBlamed: infraAborted.every((a) => a.ok),
    headerLeakFailsA25_3: !ok(headerLeak, 'A25_3_pii_never_leaves_any_byte'),
    emptyTableFailsA25_0: !ok(emptyTable, 'A25_0_attestation_fixture_populated'),
    unreachableRigFailsPark: !ok(unreachable, 'A25_2_no_existence_oracle') && !ok(unreachable, 'A25_5_never_application_5xx'),
    // #2526
    reorgHealthyAllPass: healthyReorg.every((a) => a.ok),
    manifestMissingFailsA26_2: !ok(manifestMissing, 'A26_2_manifest_registers_detect_reorgs'),
    peerBudgetFailsA26_2: !ok(peerBudget, 'A26_2_manifest_registers_detect_reorgs'),
    job500FailsA26_3: !ok(job500, 'A26_3_detect_reorgs_endpoint_answers'),
    jobMalformedFailsA26_3: !ok(jobMalformed, 'A26_3_detect_reorgs_endpoint_answers'),
    job401FailsA26_3: !ok(job401, 'A26_3_detect_reorgs_endpoint_answers'),
    wrongShaFailsA26_1: !ok(wrongSha, 'A26_1_worker_serves_health_on_rc_head'),
    // K1
    k1RefusesWrongSha: k1Wrong.length > 0,
    k1RefusesUnknownSha: k1Unknown.length > 0,
    k1RefusesAdmissionMismatch: k1Admission.length > 0,
    k1AcceptsRcHead: k1Right.length === 0,
    // K3
    prodRefDenied: isDeniedTarget({ supabaseUrl: `https://${PROD_SUPABASE_REF}.supabase.co` }).length > 0,
    sharedStagingRefDenied: isDeniedTarget({ supabaseUrl: `https://${SHARED_STAGING_SUPABASE_REF}.supabase.co` }).length > 0,
    retiredStagingRefDenied: isDeniedTarget({ supabaseUrl: `https://${RETIRED_SHARED_STAGING_SUPABASE_REF}.supabase.co` }).length > 0,
    r1RigRefDenied: isDeniedTarget({ supabaseUrl: `https://${R1_RIG_SUPABASE_REF}.supabase.co` }).length > 0,
    docusignRigRefDenied: isDeniedTarget({ supabaseUrl: `https://${DOCUSIGN_BILATERAL_RIG_SUPABASE_REF}.supabase.co` }).length > 0,
    prodWorkerDenied: isDeniedTarget({ targetUrl: 'https://arkova-worker-abc123-uc.a.run.app' }).length > 0,
    sharedWorkerDenied: isDeniedTarget({ targetUrl: 'https://arkova-worker-staging-abc123-uc.a.run.app' }).length > 0,
    docusignWorkerDenied: isDeniedTarget({ targetUrl: 'https://arkova-worker-docusign-bilateral-staging-abc123-uc.a.run.app' }).length > 0,
    extraServiceDenied: isDeniedTarget({ targetUrl: 'https://arkova-worker-r1-staging-abc123-uc.a.run.app', extraServices: ['arkova-worker-r1-staging'] }).length > 0,
    foreignServiceRefusedByAdmission: isDeniedTarget({ targetUrl: 'https://arkova-worker-other-staging-abc123-uc.a.run.app', admission: { cloud_run_service: 'arkova-worker-rc0902-staging' } }).length > 0,
    foreignRefRefusedByAdmission: isDeniedTarget({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', admission: { supabase_project_ref: 'zyxwvutsrqponmlkjihg' } }).length > 0,
    unidentifiableCloudRunDenied: isDeniedTarget({ targetUrl: 'https://something.run.app' }).length > 0,
    unknownSupabaseHostDenied: isDeniedTarget({ supabaseUrl: 'https://db.example.com' }).length > 0,
    prodHostDenied: isDeniedTarget({ targetUrl: 'https://api.arkova.ai' }).length > 0,
    isolatedRigAllowed:
      isDeniedTarget({
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        targetUrl: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app',
        admission: { supabase_project_ref: 'abcdefghijklmnopqrst', cloud_run_service: 'arkova-worker-rc0902-staging' },
      }).length === 0,
    // K2
    insideWindowTrue: withinDeclaredWindow('2026-09-03T12:00:00Z', { start: '2026-09-03T00:00:00Z', end: '2026-09-03T12:30:00Z' }),
    afterWindowFalse: !withinDeclaredWindow('2026-09-04T12:00:00Z', { start: '2026-09-03T00:00:00Z', end: '2026-09-03T12:30:00Z' }),
    noWindowFalse: !withinDeclaredWindow('2026-09-03T12:00:00Z', { start: null, end: null }),
    // Fixture recipe sanity: the embedded headers ARE the blocks they claim to be.
    blockAHeaderHashes: blockHashFromHeaderHex(FIXTURE_BLOCKS.A.headerHex) === FIXTURE_BLOCKS.A.hash,
    blockBHeaderHashes: blockHashFromHeaderHex(FIXTURE_BLOCKS.B.headerHex) === FIXTURE_BLOCKS.B.hash,
    liveFailsClosedWithoutArgs: validateLiveArgs({ mode: 'live' }).length === 6,
  };

  const pass = Object.values(counts).every((v) => v === true);

  return {
    utc,
    rc: { branch: RC_BRANCH, head: RC_HEAD_SHA, base: RC_BASE_SHA, prHeads: { ...RC_PR_HEADS } },
    prs: [2525, 2526, 2527],
    tier: 'T2',
    mode: 'self-test',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId: 'self-test',
    cycle: 0,
    soakWindow: { start: null, end: null },
    withinDeclaredWindow: false,
    status: pass ? 'pass' : 'fail',
    prCoverage: { '2525': 'not-run', '2526': 'not-run', '2527': 'not-run', '2528': 'frontend-spec' },
    assertions: [...healthyProof, ...healthyPark, ...healthyReorg],
    counts,
  };
}

// ─── Live-mode I/O (read-only against the rig) ───────────────────────────────

type FetchLike = typeof fetch;

export interface LiveDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

async function http(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<HttpResult> {
  try {
    const res = await fetchImpl(url, init);
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, text, json };
  } catch (err) {
    return { status: 0, headers: {}, text: `transport failure — ${errMsg(err)}`, json: null };
  }
}

interface FixtureAnchorRow {
  id: string;
  public_id: string | null;
  fingerprint: string;
  org_id: string | null;
  chain_tx_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface FixtureAttestationRow {
  attestation_id: string;
  status: string;
}

/** Next cycle number for (evidence file, runId). Self-numbering, no state file. */
export function nextCycleNumber(evidencePath: string | undefined, runId: string): number {
  if (!evidencePath || !existsSync(evidencePath)) return 1;
  let n = 0;
  for (const line of readFileSync(evidencePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { runId?: string };
      if (row.runId === runId) n += 1;
    } catch {
      // A malformed line is not a cycle.
    }
  }
  return n + 1;
}

/**
 * Validate the discovered anchor rows against the seed recipe. A fixture that
 * does not match the recipe the driver was written against cannot be trusted
 * to mean what the assertions assume.
 */
export function validateFixtureAnchors(rows: FixtureAnchorRow[]): { observations: Omit<ProofObservation, 'httpStatus' | 'body'>[]; blockers: string[] } {
  const blockers: string[] = [];
  const observations: Omit<ProofObservation, 'httpStatus' | 'body'>[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const meta = row.metadata ?? {};
    const cohort = meta._cohort as ProofCohort;
    const slot = Number(meta._slot);
    if (!(cohort in PROOF_COHORTS) || !Number.isInteger(slot)) {
      blockers.push(`anchor ${row.id}: unrecognised cohort/slot ${String(meta._cohort)}/${String(meta._slot)}`);
      continue;
    }
    const contract = PROOF_COHORTS[cohort];
    const key = `${cohort}:${slot}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (slot < 0 || slot >= contract.rows) blockers.push(`${key}: slot out of range for ${contract.rows}-row cohort`);
    if (row.public_id !== fixturePublicId(cohort, slot)) blockers.push(`${key}: public_id ${String(row.public_id)} != ${fixturePublicId(cohort, slot)}`);
    if (row.fingerprint.toLowerCase() !== fixtureFingerprint(cohort, slot)) blockers.push(`${key}: fingerprint does not match the seed recipe`);
    if (row.chain_tx_id !== contract.chainTxId) blockers.push(`${key}: chain_tx_id is not the cohort's real receipt`);
    if (meta._expected_verdict !== contract.expectedVerdict) blockers.push(`${key}: fixture stamps expected verdict ${String(meta._expected_verdict)}, driver expects ${contract.expectedVerdict} — fixture/driver contract drift`);
    observations.push({
      cohort,
      slot,
      publicId: fixturePublicId(cohort, slot),
      fingerprint: row.fingerprint.toLowerCase(),
      chainTxId: row.chain_tx_id,
      orgTag: contract.org,
    });
  }
  for (const cohort of PROOF_COHORT_IDS) {
    for (let slot = 0; slot < PROOF_COHORTS[cohort].rows; slot += 1) {
      const n = seen.get(`${cohort}:${slot}`) ?? 0;
      if (n !== 1) blockers.push(`${cohort}:${slot}: ${n} rows (expected exactly 1)`);
    }
  }
  return { observations, blockers };
}

export async function runLive(args: DriverArgs, deps: LiveDeps = {}): Promise<DriverRow> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const randomHex = deps.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'));
  const utc = now().toISOString();
  const runId = args.runId ?? `rc0902-${createHash('sha256').update(utc).digest('hex').slice(0, 12)}`;
  const expectedSha = (args.expectedGitSha ?? RC_HEAD_SHA).toLowerCase();
  const declaredWindow = { start: args.windowStart ?? null, end: args.windowEnd ?? null };

  let admission: Record<string, unknown> = {};
  const blockers = [...validateLiveArgs(args)];
  if (args.admissionJson) {
    try {
      admission = JSON.parse(readFileSync(args.admissionJson, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      blockers.push(`admission JSON unreadable: ${errMsg(err)}`);
    }
  }
  blockers.push(
    ...isDeniedTarget({
      supabaseUrl: args.supabaseUrl,
      targetUrl: args.targetUrl,
      extraRefs: args.denyRefs,
      extraServices: args.denyServices,
      admission: { supabase_project_ref: admission.supabase_project_ref, cloud_run_service: admission.cloud_run_service },
    }),
  );
  const window = {
    start: declaredWindow.start ?? (typeof admission.soak_start === 'string' ? admission.soak_start : null),
    end: declaredWindow.end ?? (typeof admission.soak_end === 'string' ? admission.soak_end : null),
  };
  const cycle = nextCycleNumber(args.evidenceJsonl, runId);
  const observedRef = supabaseRefFromUrl(args.supabaseUrl);
  const admissionSummary = {
    rig_name: admission.rig_name ?? null,
    head_sha: admission.head_sha ?? null,
    base_sha: admission.base_sha ?? null,
    supabase_project_ref: admission.supabase_project_ref ?? null,
    cloud_run_service: admission.cloud_run_service ?? null,
    deployed_revision: admission.deployed_revision ?? null,
    image_digest: admission.image_digest ?? null,
    preflight_result: admission.preflight_result ?? null,
    driver_path: admission.driver_path ?? null,
    driver_sha256: admission.driver_sha256 ?? null,
  };
  const counts: Record<string, number | boolean | string | null> = {};

  const fail = (extra: Partial<DriverRow> = {}): DriverRow => ({
    utc,
    rc: { branch: RC_BRANCH, head: RC_HEAD_SHA, base: RC_BASE_SHA, prHeads: { ...RC_PR_HEADS } },
    prs: [2525, 2526, 2527],
    tier: 'T2',
    mode: 'live',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId,
    cycle,
    soakWindow: window,
    withinDeclaredWindow: withinDeclaredWindow(utc, window),
    status: 'fail',
    prCoverage: { '2525': 'not-run', '2526': 'not-run', '2527': 'not-run', '2528': 'frontend-spec' },
    assertions: [],
    counts,
    blockers,
    admission: admissionSummary,
    targetUrl: args.targetUrl,
    supabaseProjectRef: observedRef,
    ...extra,
  });

  if (blockers.length > 0) return fail();

  const targetUrl = args.targetUrl!.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = { accept: 'application/json' };
  if (args.bearerToken) authHeaders.authorization = `Bearer ${args.bearerToken}`;

  // ── K1: bind every later observation to the RC head ──
  const healthRes = await http(fetchImpl, `${targetUrl}/api/health`, { method: 'GET', headers: authHeaders });
  const healthBody = isRecord(healthRes.json) ? healthRes.json : {};
  const health: HealthObservation = {
    httpStatus: healthRes.status,
    gitSha: typeof healthBody.git_sha === 'string' ? healthBody.git_sha : null,
    statusField: typeof healthBody.status === 'string' ? healthBody.status : null,
  };
  counts.buildGitSha = health.gitSha;
  blockers.push(
    ...evaluateBuildIdentity({
      health,
      expectedSha,
      admissionHeadSha: typeof admission.head_sha === 'string' ? admission.head_sha : null,
    }),
  );
  if (blockers.length > 0) return fail({ buildGitSha: health.gitSha });

  // ── Fixture discovery (PostgREST GET — the only database calls this driver makes) ──
  const base = args.supabaseUrl!.replace(/\/+$/, '');
  const dbHeaders = { apikey: args.supabaseServiceKey!, authorization: `Bearer ${args.supabaseServiceKey!}`, accept: 'application/json' };
  const anchorsRes = await http(
    fetchImpl,
    `${base}/rest/v1/anchors?select=id,public_id,fingerprint,org_id,chain_tx_id,metadata&metadata->>_purpose=eq.${FIXTURE_PURPOSE}&order=public_id.asc&limit=100`,
    { method: 'GET', headers: dbHeaders },
  );
  if (anchorsRes.status !== 200 || !Array.isArray(anchorsRes.json)) {
    blockers.push(`fixture discovery failed: anchors read answered HTTP ${anchorsRes.status}`);
    return fail({ buildGitSha: health.gitSha });
  }
  const { observations: fixtureRows, blockers: fixtureBlockers } = validateFixtureAnchors(anchorsRes.json as FixtureAnchorRow[]);
  counts.fixtureAnchors = fixtureRows.length;
  if (fixtureBlockers.length > 0) {
    blockers.push(
      `fixture absent or does not match scripts/staging/seed-rc-batch-0902-fixture.sql: ${firstFew(fixtureBlockers, 6)}. Seed the rig with that file (after the baseline seed) before starting the soak.`,
    );
    return fail({ buildGitSha: health.gitSha });
  }

  const attRes = await http(
    fetchImpl,
    `${base}/rest/v1/legally_binding_attestations?select=attestation_id,status&attestation_id=like.ARK-ATT-RC0902-*&limit=100`,
    { method: 'GET', headers: dbHeaders },
  );
  const attestationFixture: AttestationFixtureState = {
    statuses:
      attRes.status === 200 && Array.isArray(attRes.json)
        ? Object.fromEntries((attRes.json as FixtureAttestationRow[]).map((r) => [r.attestation_id, r.status]))
        : null,
  };
  counts.fixtureAttestations = attestationFixture.statuses ? Object.keys(attestationFixture.statuses).length : null;

  // ── #2527: every fixture row through the real /proof reader ──
  const proofObservations: ProofObservation[] = [];
  for (const row of fixtureRows) {
    const res = await http(fetchImpl, `${targetUrl}/api/v1/verify/${encodeURIComponent(row.publicId)}/proof`, {
      method: 'GET',
      headers: authHeaders,
    });
    proofObservations.push({ ...row, httpStatus: res.status, body: isRecord(res.json) ? res.json : null });
  }
  const proofAssertions = evaluateProofVerdicts(proofObservations);
  counts.proofRowsServed = proofObservations.filter((o) => o.httpStatus === 200).length;
  counts.verdictHistogram = JSON.stringify(
    proofObservations.reduce<Record<string, number>>((acc, o) => {
      const v = String(o.body?.verdict ?? `http${o.httpStatus}`);
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {}),
  );

  // ── #2525: the park over a populated table, burst first ──
  const burst = resolveBurst(args.attestationBurst);
  const attestationObservations: AttestationObservation[] = [];
  const probe = async (kind: AttestationObservation['kind'], id: string): Promise<AttestationObservation> => {
    const res = await http(fetchImpl, `${targetUrl}/api/v1/verify/attestation/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: authHeaders,
    });
    return { kind, id, status: res.status, headers: res.headers, body: res.text };
  };
  attestationObservations.push(
    ...(await Promise.all(Array.from({ length: burst }, (_, i) => probe('burst', `ARK-ATT-SOAK${randomHex(4)}${i}`)))),
  );
  attestationObservations.push(await probe('nonexistent', `ARK-ATT-RC0902-NX${randomHex(6)}`));
  for (const id of ATTESTATION_FIXTURE_IDS) attestationObservations.push(await probe('seeded', id));
  attestationObservations.push(await probe('malformed', 'INVALID!!!'));
  const parkAssertions = evaluateAttestationPark(attestationObservations, attestationFixture);
  counts.attestationBurst = burst;
  counts.attestationObserved = attestationObservations.filter((o) => isObserved(toParkProbe(o))).length;
  counts.attestationInfraAborts = attestationObservations.filter((o) => isInfraAbort(toParkProbe(o))).length;

  // ── #2526: the manifest entry (static) + the route it names (live) ──
  const cronHeaders: Record<string, string> = { ...authHeaders, 'content-type': 'application/json' };
  if (args.cronSecret) cronHeaders['x-cron-secret'] = args.cronSecret;
  const jobRes = await http(fetchImpl, `${targetUrl}/jobs/detect-reorgs`, { method: 'POST', headers: cronHeaders });
  const reorgAssertions = evaluateDetectReorgs({
    health,
    expectedSha,
    manifest: SCHEDULER_MANIFEST,
    job: { status: jobRes.status, body: jobRes.json, bodyText: jobRes.text },
  });
  counts.detectReorgsStatus = jobRes.status;
  counts.manifestSource = 'driver checkout (static import of src/jobs/scheduler-manifest.ts), not the deployed bundle';

  const assertions = [...proofAssertions, ...parkAssertions, ...reorgAssertions];
  const allOk = assertions.every((a) => a.ok);
  const withinWindow = withinDeclaredWindow(utc, window);
  const coverage = (pr: 2525 | 2526 | 2527): PrCoverage =>
    assertions.filter((a) => a.pr === pr).every((a) => a.ok) ? 'pass' : 'fail';

  return {
    utc,
    rc: { branch: RC_BRANCH, head: RC_HEAD_SHA, base: RC_BASE_SHA, prHeads: { ...RC_PR_HEADS } },
    prs: [2525, 2526, 2527],
    tier: 'T2',
    mode: 'live',
    evidenceForSoak: allOk && withinWindow,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId,
    cycle,
    soakWindow: window,
    withinDeclaredWindow: withinWindow,
    status: allOk ? 'pass' : 'fail',
    prCoverage: { '2525': coverage(2525), '2526': coverage(2526), '2527': coverage(2527), '2528': 'frontend-spec' },
    assertions,
    counts,
    buildGitSha: health.gitSha,
    admission: admissionSummary,
    targetUrl,
    supabaseProjectRef: observedRef,
  };
}

export async function runDriver(args: DriverArgs, deps: LiveDeps = {}): Promise<DriverRow> {
  return args.mode === 'live' ? runLive(args, deps) : runSelfTest();
}

async function main(): Promise<void> {
  let args: DriverArgs;
  try {
    args = applyEnvDefaults(parseArgs(process.argv.slice(2)), process.env);
  } catch (err) {
    process.stderr.write(`${errMsg(err)}\n`);
    process.exitCode = 2;
    return;
  }
  const row = await runDriver(args);
  const line = `${JSON.stringify(row)}\n`;
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, line);
  process.stdout.write(line);
  if (row.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && /rc-batch-0902-driver\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
