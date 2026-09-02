/**
 * Tests for the rc/soak-batch-2026-09-02 batched T2 driver.
 *
 * The driver decides what counts as merge-grade evidence for four PR heads at
 * once, so its own failure modes are evidence-integrity bugs. Three things are
 * pinned here:
 *
 *   1. DISCRIMINATION — every evaluator FAILS the broken-build vector it exists
 *      for (a pre-#2527 build, the superseded RC head, an unparked attestation
 *      route, a park above the rate limiters, a wrong build SHA, …), not merely
 *      passes the healthy one.
 *   2. FIXTURE CONTRACT — the cohorts, ids, receipts, headers and PII literals
 *      the driver asserts against are the ones the seed writes (read from the
 *      SQL file), and every cohort produces its expected verdict through the
 *      REAL `buildProofResponse` — the shipped classifier, not a copy.
 *   3. PLUMBING — `runLive` against a fake rig: refuses the wrong SHA, refuses a
 *      recipe-drifted fixture, and produces a passing, window-bound row on a
 *      healthy rig with NO write request ever issued.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ATTESTATION_FIXTURE_IDS,
  ATTESTATION_PII_LITERALS,
  DENIED_CLOUD_RUN_SERVICES,
  DOCUSIGN_BILATERAL_RIG_SUPABASE_REF,
  FIXTURE_BLOCKS,
  FIXTURE_PURPOSE,
  PREVIOUS_RC_HEAD_SHA,
  PROD_SUPABASE_REF,
  PROOF_COHORTS,
  PROOF_COHORT_IDS,
  R1_RIG_SUPABASE_REF,
  RC_HEAD_SHA,
  RETIRED_SHARED_STAGING_SUPABASE_REF,
  SHARED_STAGING_SUPABASE_REF,
  applyEnvDefaults,
  blockHashFromHeaderHex,
  cloudRunServiceFromHost,
  disclosedAttestationBody,
  evaluateAttestationPark,
  evaluateBuildIdentity,
  evaluateDetectReorgs,
  evaluateProofVerdicts,
  expectedAttestationStatus,
  fixtureFingerprint,
  fixtureProofShape,
  fixturePublicId,
  healthyAttestationFixture,
  healthyAttestationObservations,
  healthyHealth,
  healthyJob,
  healthyProofBody,
  healthyProofObservations,
  isDeniedTarget,
  mutateProofObservations,
  nextCycleNumber,
  parseArgs,
  rawResponseText,
  recomputeMerkleRoot,
  runDriver,
  runLive,
  runSelfTest,
  sha256dHex,
  supabaseRefFromUrl,
  validateFixtureAnchors,
  validateLiveArgs,
  withinDeclaredWindow,
  type AssertionResult,
  type ProofCohort,
} from './rc-batch-0902-driver.js';
import { SCHEDULER_MANIFEST } from '../src/jobs/scheduler-manifest.js';
import { PROOF_VERDICT, PROOF_VERDICT_NOTE } from '../src/constants/proofVerdict.js';
import { buildProofResponse, type ProofAnchorData, type ProofRecordData } from '../src/api/v1/verify-proof.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, '../../../scripts/staging/seed-rc-batch-0902-fixture.sql');
const seedSql = readFileSync(SEED_PATH, 'utf8');

const ok = (list: AssertionResult[], id: string): boolean => list.find((a) => a.id === id)?.ok === true;
const find = (list: AssertionResult[], id: string): AssertionResult => {
  const a = list.find((x) => x.id === id);
  if (!a) throw new Error(`assertion ${id} missing`);
  return a;
};

// ─── CLI contract ────────────────────────────────────────────────────────────

describe('rc-batch-0902-driver — CLI contract', () => {
  it('defaults to local self-test mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'self-test' });
  });

  it('parses live admission arguments including repeatable deny flags', () => {
    expect(
      parseArgs([
        '--live',
        '--target-url', 'https://worker.example',
        '--admission-json', '/tmp/admission.json',
        '--evidence-jsonl', '/tmp/evidence.jsonl',
        '--cron-secret', 's',
        '--supabase-url', 'https://abcdefghijklmnopqrst.supabase.co',
        '--supabase-service-key', 'k',
        '--expected-git-sha', RC_HEAD_SHA,
        '--run-id', 'run-1',
        '--attestation-burst', '4',
        '--deny-ref', 'aaaaaaaaaaaaaaaaaaaa',
        '--deny-service', 'arkova-worker-r1-staging',
        '--deny-service', 'arkova-worker-other-staging',
      ]),
    ).toEqual({
      mode: 'live',
      targetUrl: 'https://worker.example',
      admissionJson: '/tmp/admission.json',
      evidenceJsonl: '/tmp/evidence.jsonl',
      cronSecret: 's',
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseServiceKey: 'k',
      expectedGitSha: RC_HEAD_SHA,
      runId: 'run-1',
      attestationBurst: 4,
      denyRefs: ['aaaaaaaaaaaaaaaaaaaa'],
      denyServices: ['arkova-worker-r1-staging', 'arkova-worker-other-staging'],
    });
  });

  it('rejects an unknown argument rather than silently ignoring it', () => {
    expect(() => parseArgs(['--not-a-flag'])).toThrow(/Unknown argument/);
  });

  it('fills secrets and deny lists from the environment, flags winning', () => {
    const args = applyEnvDefaults(parseArgs(['--live', '--cron-secret', 'flag']), {
      RIG_CRON_SECRET: 'env',
      RIG_BEARER_TOKEN: 'bearer',
      RIG_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      RIG_SUPABASE_SERVICE_ROLE_KEY: 'key',
      RIG_DENY_REFS: 'aaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb',
      RIG_DENY_SERVICES: 'arkova-worker-r1-staging',
    } as NodeJS.ProcessEnv);
    expect(args.cronSecret).toBe('flag');
    expect(args.bearerToken).toBe('bearer');
    expect(args.supabaseUrl).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(args.denyRefs).toEqual(['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb']);
    expect(args.denyServices).toEqual(['arkova-worker-r1-staging']);
  });

  it('live mode fails closed when admission inputs are missing', async () => {
    const row = await runDriver({ mode: 'live' });
    expect(row.status).toBe('fail');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.blockers).toEqual([
      'missing --target-url',
      'missing --admission-json',
      'missing --evidence-jsonl',
      'missing --cron-secret or --bearer-token (POST /jobs/detect-reorgs needs a cron credential)',
      'missing --supabase-url (or RIG_SUPABASE_URL)',
      'missing --supabase-service-key (or RIG_SUPABASE_SERVICE_ROLE_KEY)',
    ]);
    expect(validateLiveArgs({ mode: 'live' })).toHaveLength(6);
  });
});

// ─── K3 — hard deny ──────────────────────────────────────────────────────────

describe('K3 — prod, shared staging, soaking rigs and foreign rigs are refused', () => {
  it('extracts a Supabase project ref from a project URL', () => {
    expect(supabaseRefFromUrl(`https://${PROD_SUPABASE_REF}.supabase.co`)).toBe(PROD_SUPABASE_REF);
    expect(supabaseRefFromUrl('https://db.example.com')).toBeNull();
    expect(supabaseRefFromUrl(undefined)).toBeNull();
  });

  it.each([
    [PROD_SUPABASE_REF, /PRODUCTION/],
    [SHARED_STAGING_SUPABASE_REF, /SHARED standing staging/],
    [RETIRED_SHARED_STAGING_SUPABASE_REF, /retired/],
    [R1_RIG_SUPABASE_REF, /R1 isolated rig/],
    [DOCUSIGN_BILATERAL_RIG_SUPABASE_REF, /docusign-bilateral/],
  ])('denies Supabase ref %s by name with its reason', (ref, reason) => {
    expect(isDeniedTarget({ supabaseUrl: `https://${ref}.supabase.co` }).join(' ')).toMatch(reason);
  });

  it('denies the shared/prod/soaking Cloud Run services by EXACT service name, not by prefix', () => {
    for (const service of DENIED_CLOUD_RUN_SERVICES) {
      expect(isDeniedTarget({ targetUrl: `https://${service}-abc123-uc.a.run.app` })).toHaveLength(1);
    }
    // A prefix test would refuse this legitimate isolated rig.
    expect(isDeniedTarget({ targetUrl: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app' })).toEqual([]);
  });

  it('recovers the service name from both URL shapes Google issues', () => {
    expect(cloudRunServiceFromHost('arkova-worker-staging-abc123-uc.a.run.app')).toBe('arkova-worker-staging');
    expect(cloudRunServiceFromHost('arkova-worker-staging-abc123.us-central1.run.app')).toBe('arkova-worker-staging');
    expect(cloudRunServiceFromHost('rig.example.com')).toBeNull();
  });

  it('adds launch-time refs and services to the deny list (the R1 service name is not in the repo)', () => {
    expect(isDeniedTarget({ targetUrl: 'https://arkova-worker-r1-staging-abc123-uc.a.run.app' })).toEqual([]);
    expect(
      isDeniedTarget({ targetUrl: 'https://arkova-worker-r1-staging-abc123-uc.a.run.app', extraServices: ['arkova-worker-r1-staging'] }).join(' '),
    ).toMatch(/hard denied/);
    expect(isDeniedTarget({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', extraRefs: ['abcdefghijklmnopqrst'] }).join(' ')).toMatch(/--deny-ref/);
  });

  it('positively binds the target to the rig the admission JSON names — a foreign rig is refused whatever its name', () => {
    const admission = { supabase_project_ref: 'abcdefghijklmnopqrst', cloud_run_service: 'arkova-worker-rc0902-staging' };
    expect(
      isDeniedTarget({ supabaseUrl: 'https://zyxwvutsrqponmlkjihg.supabase.co', targetUrl: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app', admission }).join(' '),
    ).toMatch(/not the rig the admission JSON names/);
    expect(
      isDeniedTarget({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', targetUrl: 'https://arkova-worker-other-staging-abc123-uc.a.run.app', admission }).join(' '),
    ).toMatch(/not the service the admission JSON names/);
    expect(
      isDeniedTarget({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', targetUrl: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app', admission }),
    ).toEqual([]);
  });

  it('refuses an unidentifiable run.app host and an unrecognised Supabase host rather than assuming safety', () => {
    expect(isDeniedTarget({ targetUrl: 'https://something.run.app' }).join(' ')).toMatch(/cannot be recovered/);
    expect(isDeniedTarget({ supabaseUrl: 'https://internal-db.corp.example' }).join(' ')).toMatch(/cannot be deny-checked/);
  });

  it('denies production Arkova hosts, apex and subdomains', () => {
    expect(isDeniedTarget({ targetUrl: 'https://api.arkova.ai' })).toHaveLength(1);
    expect(isDeniedTarget({ targetUrl: 'https://arkova.io' })).toHaveLength(1);
  });
});

// ─── K2 — window bounding ────────────────────────────────────────────────────

describe('K2 — cycle rows are bounded to the declared soak window', () => {
  const window = { start: '2026-09-03T00:00:00Z', end: '2026-09-03T12:00:00Z' };
  it('accepts inside, rejects before/after/undeclared/unparseable', () => {
    expect(withinDeclaredWindow('2026-09-03T06:00:00Z', window)).toBe(true);
    expect(withinDeclaredWindow('2026-09-03T12:00:01Z', window)).toBe(false);
    expect(withinDeclaredWindow('2026-09-02T23:59:59Z', window)).toBe(false);
    expect(withinDeclaredWindow('2026-09-03T06:00:00Z', { start: null, end: null })).toBe(false);
    expect(withinDeclaredWindow('not-a-date', window)).toBe(false);
  });

  it('numbers cycles per (evidence file, runId) with no state file', () => {
    expect(nextCycleNumber(undefined, 'r')).toBe(1);
    expect(nextCycleNumber('/nonexistent/evidence.jsonl', 'r')).toBe(1);
  });
});

// ─── K1 — build identity ─────────────────────────────────────────────────────

describe('K1 — evidence is bound to the RC head', () => {
  it('accepts the RC head and refuses everything else', () => {
    expect(evaluateBuildIdentity({ health: healthyHealth(), expectedSha: RC_HEAD_SHA, admissionHeadSha: RC_HEAD_SHA })).toEqual([]);
    expect(evaluateBuildIdentity({ health: { httpStatus: 200, gitSha: PREVIOUS_RC_HEAD_SHA, statusField: 'healthy' }, expectedSha: RC_HEAD_SHA }).join(' ')).toMatch(/K1: the worker serves git_sha/);
    expect(evaluateBuildIdentity({ health: { httpStatus: 200, gitSha: 'unknown', statusField: 'healthy' }, expectedSha: RC_HEAD_SHA }).join(' ')).toMatch(/not a full SHA/);
    expect(evaluateBuildIdentity({ health: { httpStatus: 503, gitSha: null, statusField: null }, expectedSha: RC_HEAD_SHA }).join(' ')).toMatch(/HTTP 503/);
    expect(evaluateBuildIdentity({ health: healthyHealth(), expectedSha: RC_HEAD_SHA, admissionHeadSha: PREVIOUS_RC_HEAD_SHA }).join(' ')).toMatch(/admission JSON names head_sha/);
  });
});

// ─── Fixture recipe / cryptographic helpers ──────────────────────────────────

describe('fixture recipe and helpers', () => {
  it('the embedded 80-byte headers hash to the real block hashes (byte-reversed sha256d)', () => {
    expect(blockHashFromHeaderHex(FIXTURE_BLOCKS.A.headerHex)).toBe(FIXTURE_BLOCKS.A.hash);
    expect(blockHashFromHeaderHex(FIXTURE_BLOCKS.B.headerHex)).toBe(FIXTURE_BLOCKS.B.hash);
    expect(blockHashFromHeaderHex('ab'.repeat(80))).not.toBe(FIXTURE_BLOCKS.A.hash);
    expect(blockHashFromHeaderHex('abcd')).toBeNull();
  });

  it('re-folds a 2-leaf branch to the root and refuses a malformed one', () => {
    const shape = fixtureProofShape('a-valid', 0);
    expect(recomputeMerkleRoot(shape.fingerprint, shape.proofPath)).toBe(shape.merkleRoot);
    expect(recomputeMerkleRoot(shape.fingerprint, [{ hash: 'zz', position: 'right' }])).toBeNull();
    expect(recomputeMerkleRoot(shape.fingerprint, [{ hash: 'a'.repeat(64), position: 'up' }])).toBeNull();
    expect(recomputeMerkleRoot(shape.fingerprint, 'not-an-array')).toBeNull();
    expect(recomputeMerkleRoot('short', [])).toBeNull();
    // Empty branch: the leaf IS the root.
    expect(recomputeMerkleRoot(shape.fingerprint, [])).toBe(shape.fingerprint);
  });

  it('sha256dHex is plain double-SHA256 over the hex bytes', () => {
    // Known vector: sha256d of an empty byte string.
    expect(sha256dHex('')).toBe('5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');
  });

  it('each cohort produces its expected verdict through the REAL buildProofResponse (the shipped classifier)', () => {
    for (const cohort of PROOF_COHORT_IDS) {
      const contract = PROOF_COHORTS[cohort];
      for (let slot = 0; slot < contract.rows; slot += 1) {
        const shape = fixtureProofShape(cohort, slot);
        const block = FIXTURE_BLOCKS[contract.block];
        const anchor: ProofAnchorData = {
          public_id: fixturePublicId(cohort, slot),
          fingerprint: shape.fingerprint,
          status: 'SECURED',
          chain_tx_id: contract.chainTxId,
          chain_block_height: block.height,
          chain_timestamp: new Date(block.time * 1000).toISOString(),
          metadata: null,
        };
        const proof: ProofRecordData = {
          merkle_root: shape.merkleRoot,
          proof_path: shape.proofPath,
          batch_id: shape.batchId,
          merkle_index: shape.merkleIndex,
          block_header: `\\x${block.headerHex}`,
          block_hash: block.hash,
          op_return_payload: `\\x41524b56${shape.merkleRoot}`,
          proof_schema_version: 1,
        };
        const result = buildProofResponse(anchor, proof, shape.leafCount, false);
        expect(result, `${cohort}:${slot} produced no response`).not.toBeNull();
        if (!result || 'error' in result) throw new Error(`${cohort}:${slot} answered an error body`);
        expect(result.verdict, `${cohort}:${slot} verdict`).toBe(contract.expectedVerdict);
        expect(result.verified, `${cohort}:${slot} verified`).toBe(contract.expectedVerified);
        expect(result.verdict_note).toBe(PROOF_VERDICT_NOTE[contract.expectedVerdict]);
        if (contract.bundle === 'required') expect(result.proof_bundle, `${cohort}:${slot} bundle`).not.toBeNull();
        if (contract.bundle === 'null') expect(result.proof_bundle, `${cohort}:${slot} bundle`).toBeNull();
        // The synthetic healthy body the self-test uses must be what the real reader would publish.
        const synthetic = healthyProofBody(cohort, slot);
        expect(synthetic.verdict).toBe(result.verdict);
        expect(synthetic.verified).toBe(result.verified);
        expect(synthetic.proof_bundle === null).toBe(result.proof_bundle === null);
      }
    }
  });

  it('the superseded RC head (557e485a) would have said `valid` for the two uninspected cohorts — the discrimination vector is real', () => {
    // Under the old rule (guard "armed" = index + count >= 1, ignoring branch length)
    // a passing recompute was `valid`. Both cohorts pass the recompute with an armed guard.
    for (const cohort of ['a-uninspected', 'a-overlong'] as const) {
      expect(PROOF_COHORTS[cohort].previousRcHeadVerdict).toBe('valid');
      expect(PROOF_COHORTS[cohort].expectedVerdict).toBe('unverifiable');
      const shape = fixtureProofShape(cohort, 0);
      expect(recomputeMerkleRoot(shape.fingerprint, shape.proofPath)).toBe(shape.merkleRoot);
      expect(shape.merkleIndex).not.toBeNull();
      expect(shape.leafCount).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── Seed ↔ driver contract (read from the SQL file) ─────────────────────────

describe('seed-rc-batch-0902-fixture.sql matches the driver\'s fixture contract', () => {
  it('stamps every cohort, slot, public id and expected verdict the driver asserts on', () => {
    for (const cohort of PROOF_COHORT_IDS) {
      const contract = PROOF_COHORTS[cohort];
      for (let slot = 0; slot < contract.rows; slot += 1) {
        expect(seedSql).toContain(`'${fixturePublicId(cohort, slot)}'`);
        expect(seedSql).toMatch(new RegExp(`\\('${cohort}',\\s*${slot},\\s*'${contract.org}',[^\\n]*\\n[^\\n]*'${contract.chainTxId}',\\s*'${contract.block}',\\s*'${contract.expectedVerdict}'\\)`));
      }
    }
    expect(seedSql).toContain(`'_purpose', '${FIXTURE_PURPOSE}'`);
  });

  it('embeds the same real block headers, hashes and heights', () => {
    for (const block of Object.values(FIXTURE_BLOCKS)) {
      expect(seedSql).toContain(`'${block.hash}', ${block.height}, ${block.time},`);
      expect(seedSql).toContain(`'${block.headerHex}'`);
    }
  });

  it('writes every attestation id and every PII literal the K4 sweep searches for', () => {
    for (const id of ATTESTATION_FIXTURE_IDS) expect(seedSql).toContain(`'${id}'`);
    for (const literal of ATTESTATION_PII_LITERALS) expect(seedSql).toContain(`'${literal}'`);
    expect(ATTESTATION_FIXTURE_IDS).toHaveLength(10);
    expect(expectedAttestationStatus('ARK-ATT-RC0902-A-REVIEW')).toBe('requires_review');
    expect(expectedAttestationStatus('ARK-ATT-RC0902-B-ANCHORED')).toBe('anchored');
    expect(expectedAttestationStatus('ARK-ATT-RC0902-B-BOGUS')).toBeNull();
  });

  it('derives fingerprints and the wrong/extra siblings by the recipe the driver reimplements', () => {
    expect(seedSql).toContain("md5('rc0902-' || p.cohort || '-' || p.slot || '-hi')");
    expect(seedSql).toContain("md5('rc0902-' || p.cohort || '-' || p.slot || '-lo')");
    expect(seedSql).toContain("md5('rc0902-a-invalid-wrong-sibling-' || r.slot || '-hi')");
    expect(seedSql).toContain("md5('rc0902-a-overlong-extra-sibling-hi')");
  });
});

// ─── #2527 evaluators — discrimination ───────────────────────────────────────

describe('A27_* — the verdict assertions DISCRIMINATE the broken builds', () => {
  const healthy = healthyProofObservations();

  it('passes every assertion on the RC-head shape', () => {
    const results = evaluateProofVerdicts(healthy);
    expect(results.map((r) => r.id)).toEqual([
      'A27_0_fixture_rows_served',
      'A27_1_verdict_invariant',
      'A27_2_valid_cohorts_valid_with_complete_bundle',
      'A27_3_wrong_sibling_invalid',
      'A27_4_legacy_unverifiable_not_valid',
      'A27_5_uninspected_branch_unverifiable',
      'A27_6_independent_recompute_agrees',
      'A27_7_per_org_attribution',
    ]);
    expect(results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`).join('\n')).toBe(true);
  });

  it('FAILS A27_1 on a pre-#2527 build (verified:true, no verdict)', () => {
    const results = evaluateProofVerdicts(
      mutateProofObservations(healthy, 'all', (b) => {
        delete b.verdict;
        delete b.verdict_note;
        return b;
      }),
    );
    expect(ok(results, 'A27_1_verdict_invariant')).toBe(false);
    expect(find(results, 'A27_1_verdict_invariant').detail).toMatch(/ABSENT \(pre-#2527 build\)/);
  });

  it('FAILS A27_5 — and ONLY the cohort assertion — on the superseded RC head that says `valid` for uninspected branches', () => {
    const results = evaluateProofVerdicts(
      mutateProofObservations(healthy, ['a-uninspected', 'a-overlong'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })),
    );
    // That build is internally consistent, so the invariant still holds…
    expect(ok(results, 'A27_1_verdict_invariant')).toBe(true);
    // …which is exactly why A27_5 exists.
    expect(ok(results, 'A27_5_uninspected_branch_unverifiable')).toBe(false);
    expect(find(results, 'A27_5_uninspected_branch_unverifiable').detail).toContain(PREVIOUS_RC_HEAD_SHA.slice(0, 8));
  });

  it('FAILS A27_1 on contradictions in either direction, a fourth value, and a reworded note', () => {
    const falseValid = evaluateProofVerdicts(mutateProofObservations(healthy, ['a-invalid'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })));
    const trueInvalid = evaluateProofVerdicts(mutateProofObservations(healthy, ['b-valid'], (b) => ({ ...b, verdict: 'invalid', verdict_note: PROOF_VERDICT_NOTE.invalid })));
    const fourth = evaluateProofVerdicts(mutateProofObservations(healthy, ['a-legacy'], (b) => ({ ...b, verdict: 'unknown' })));
    const reworded = evaluateProofVerdicts(mutateProofObservations(healthy, ['a-valid'], (b) => ({ ...b, verdict_note: 'Verified.' })));
    expect(ok(falseValid, 'A27_1_verdict_invariant')).toBe(false);
    expect(ok(trueInvalid, 'A27_1_verdict_invariant')).toBe(false);
    expect(ok(fourth, 'A27_1_verdict_invariant')).toBe(false);
    expect(ok(reworded, 'A27_1_verdict_invariant')).toBe(false);
  });

  it('FAILS A27_4 when a legacy row is upgraded to `valid`', () => {
    const results = evaluateProofVerdicts(mutateProofObservations(healthy, ['a-legacy'], (b) => ({ ...b, verdict: 'valid', verdict_note: PROOF_VERDICT_NOTE.valid })));
    expect(ok(results, 'A27_4_legacy_unverifiable_not_valid')).toBe(false);
  });

  it('FAILS A27_3 AND A27_6 when the server launders a failed recompute as verified:true/unverifiable', () => {
    const results = evaluateProofVerdicts(
      mutateProofObservations(healthy, ['a-invalid'], (b) => ({ ...b, verified: true, verdict: 'unverifiable', verdict_note: PROOF_VERDICT_NOTE.unverifiable })),
    );
    expect(ok(results, 'A27_3_wrong_sibling_invalid')).toBe(false);
    expect(ok(results, 'A27_6_independent_recompute_agrees')).toBe(false);
    expect(find(results, 'A27_6_independent_recompute_agrees').detail).toMatch(/driver's re-fold says false/);
  });

  it('FAILS A27_0 on a NO_BATCH_PROOF 404 for a row that holds a proof', () => {
    const results = evaluateProofVerdicts(
      mutateProofObservations(healthy, ['a-valid'], () => ({ error: 'No Merkle proof available for this record.', proof_error_code: 'NO_BATCH_PROOF' }), 404),
    );
    expect(ok(results, 'A27_0_fixture_rows_served')).toBe(false);
    expect(find(results, 'A27_0_fixture_rows_served').detail).toMatch(/NO_BATCH_PROOF/);
  });

  it('FAILS A27_2 when the published header is not the block the receipt is in', () => {
    const results = evaluateProofVerdicts(
      mutateProofObservations(healthy, ['a-valid'], (b) => ({ ...b, proof_bundle: { ...(b.proof_bundle as Record<string, unknown>), block_header: 'ab'.repeat(80) } })),
    );
    expect(ok(results, 'A27_2_valid_cohorts_valid_with_complete_bundle')).toBe(false);
    expect(find(results, 'A27_2_valid_cohorts_valid_with_complete_bundle').detail).toMatch(/sha256d\(block_header\)/);
  });

  it('FAILS A27_2 when a valid row publishes no bundle', () => {
    const results = evaluateProofVerdicts(mutateProofObservations(healthy, ['b-valid'], (b) => ({ ...b, proof_bundle: null })));
    expect(ok(results, 'A27_2_valid_cohorts_valid_with_complete_bundle')).toBe(false);
  });

  it('FAILS A27_6/A27_7 when org-B public ids answer with org-A fingerprints', () => {
    const results = evaluateProofVerdicts(mutateProofObservations(healthy, ['b-valid'], (b, o) => ({ ...b, fingerprint: fixtureFingerprint('a-valid', o.slot) })));
    expect(ok(results, 'A27_6_independent_recompute_agrees')).toBe(false);
    expect(ok(results, 'A27_7_per_org_attribution')).toBe(false);
  });

  it('FAILS A27_0 when a cohort row is missing from the observations', () => {
    const results = evaluateProofVerdicts(healthy.filter((o) => !(o.cohort === 'a-overlong')));
    expect(ok(results, 'A27_0_fixture_rows_served')).toBe(false);
    expect(ok(results, 'A27_5_uninspected_branch_unverifiable')).toBe(false);
  });

  it('FAILS everything when nothing was served', () => {
    const results = evaluateProofVerdicts([]);
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

// ─── #2525 evaluators — discrimination ───────────────────────────────────────

describe('A25_* — the park assertions DISCRIMINATE the broken builds', () => {
  const park = healthyAttestationObservations();
  const fixture = healthyAttestationFixture();

  it('passes every assertion on the parked RC-head shape over a populated table', () => {
    const results = evaluateAttestationPark(park, fixture);
    expect(results.map((r) => r.id)).toEqual([
      'A25_0_attestation_fixture_populated',
      'A25_1_park_contract',
      'A25_2_no_existence_oracle',
      'A25_3_pii_never_leaves_any_byte',
      'A25_4_rate_limit_headers_on_every_response',
      'A25_5_never_application_5xx',
    ]);
    expect(results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`).join('\n')).toBe(true);
  });

  it('FAILS A25_2 and A25_3 on a build that unparks the route (notarized/anchored disclosed with PII)', () => {
    const results = evaluateAttestationPark(
      park.map((o) => (o.kind === 'seeded' && (o.id.endsWith('-NOTARIZED') || o.id.endsWith('-ANCHORED')) ? { ...o, status: 200, body: disclosedAttestationBody(o.id) } : o)),
      fixture,
    );
    expect(ok(results, 'A25_2_no_existence_oracle')).toBe(false);
    expect(find(results, 'A25_2_no_existence_oracle').detail).toMatch(/answered 200/);
    expect(ok(results, 'A25_3_pii_never_leaves_any_byte')).toBe(false);
    expect(find(results, 'A25_3_pii_never_leaves_any_byte').detail).toMatch(/Okonkwo|Lindqvist/);
  });

  it('FAILS A25_2 on an existence oracle (withheld rows answer a different 404 body than a nonexistent id)', () => {
    const results = evaluateAttestationPark(
      park.map((o) => (o.kind === 'seeded' && o.id.endsWith('-DRAFT') ? { ...o, body: JSON.stringify({ verified: false, error: 'Attestation not found' }) } : o)),
      fixture,
    );
    expect(ok(results, 'A25_2_no_existence_oracle')).toBe(false);
    expect(find(results, 'A25_2_no_existence_oracle').detail).toMatch(/distinct 404 bodies/);
  });

  it('FAILS A25_1 and A25_4 when the park sits ABOVE the rate limiters (no X-RateLimit-* headers)', () => {
    const results = evaluateAttestationPark(park.map((o) => ({ ...o, headers: { 'content-type': 'application/json' } })), fixture);
    expect(ok(results, 'A25_1_park_contract')).toBe(false);
    expect(ok(results, 'A25_4_rate_limit_headers_on_every_response')).toBe(false);
  });

  it('FAILS A25_5 on an application 5xx but does NOT blame a Cloud Run capacity refusal', () => {
    const app = evaluateAttestationPark(park.map((o) => (o.id.endsWith('-A-DRAFT') ? { ...o, status: 500, body: '{"error":"Internal server error"}' } : o)), fixture);
    expect(ok(app, 'A25_5_never_application_5xx')).toBe(false);
    const infra = evaluateAttestationPark(
      park.map((o) => (o.kind === 'burst' && o.id.endsWith('3') ? { ...o, status: 500, headers: {}, body: 'The request was aborted because there was no available instance.' } : o)),
      fixture,
    );
    expect(infra.every((r) => r.ok)).toBe(true);
    expect(find(infra, 'A25_5_never_application_5xx').detail).toMatch(/1 infra aborts/);
  });

  it('K4: FAILS A25_3 when PII rides in a response HEADER while every body is clean', () => {
    const results = evaluateAttestationPark(
      park.map((o) => (o.id.endsWith('-B-REVIEW') ? { ...o, headers: { ...o.headers, 'x-debug-subject': 'tobias lindqvist-fixture' } } : o)),
      fixture,
    );
    expect(ok(results, 'A25_3_pii_never_leaves_any_byte')).toBe(false);
    expect(ok(results, 'A25_2_no_existence_oracle')).toBe(true); // bodies are identical — only the header leaked
    expect(rawResponseText(park[0])).toMatch(/^HTTP 404\n/);
  });

  it('FAILS A25_3 when a sensitive key name appears even without a value', () => {
    const results = evaluateAttestationPark(
      park.map((o) => (o.id.endsWith('-A-PENDING') ? { ...o, body: '{"verified":false,"error":"…","notary_commission_number":null}' } : o)),
      fixture,
    );
    expect(ok(results, 'A25_3_pii_never_leaves_any_byte')).toBe(false);
  });

  it('FAILS A25_0 when the table is empty — a park over nothing proves nothing', () => {
    const results = evaluateAttestationPark(park, { statuses: {} });
    expect(ok(results, 'A25_0_attestation_fixture_populated')).toBe(false);
    const drifted = evaluateAttestationPark(park, { statuses: { ...healthyAttestationFixture().statuses, 'ARK-ATT-RC0902-A-ANCHORED': 'draft' } });
    expect(find(drifted, 'A25_0_attestation_fixture_populated').detail).toMatch(/status draft, expected anchored/);
  });

  it('FAILS loudly, not vacuously, when the rig is unreachable', () => {
    const results = evaluateAttestationPark(park.map((o) => ({ ...o, status: 0, headers: {}, body: 'transport failure' })), fixture);
    expect(ok(results, 'A25_2_no_existence_oracle')).toBe(false);
    expect(ok(results, 'A25_3_pii_never_leaves_any_byte')).toBe(false);
    expect(ok(results, 'A25_5_never_application_5xx')).toBe(false);
  });
});

// ─── #2526 evaluators — discrimination ───────────────────────────────────────

describe('A26_* — the detect-reorgs assertions DISCRIMINATE the broken builds', () => {
  const healthyInput = { health: healthyHealth(), expectedSha: RC_HEAD_SHA, manifest: SCHEDULER_MANIFEST, job: healthyJob() };

  it('passes on the RC-head manifest with a well-formed job result', () => {
    const results = evaluateDetectReorgs(healthyInput);
    expect(results.map((r) => r.id)).toEqual([
      'A26_1_worker_serves_health_on_rc_head',
      'A26_2_manifest_registers_detect_reorgs',
      'A26_3_detect_reorgs_endpoint_answers',
    ]);
    expect(results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`).join('\n')).toBe(true);
  });

  it('FAILS A26_2 when the manifest lacks the entry or carries the peers\' 1h budget', () => {
    const missing = evaluateDetectReorgs({ ...healthyInput, manifest: SCHEDULER_MANIFEST.filter((j) => j.id !== 'detect-reorgs') });
    expect(ok(missing, 'A26_2_manifest_registers_detect_reorgs')).toBe(false);
    const peer = evaluateDetectReorgs({ ...healthyInput, manifest: SCHEDULER_MANIFEST.map((j) => (j.id === 'detect-reorgs' ? { ...j, maxSilenceMs: 60 * 60 * 1000 } : j)) });
    expect(ok(peer, 'A26_2_manifest_registers_detect_reorgs')).toBe(false);
    expect(find(peer, 'A26_2_manifest_registers_detect_reorgs').detail).toMatch(/maxSilenceMs 3600000/);
    const paused = evaluateDetectReorgs({ ...healthyInput, manifest: SCHEDULER_MANIFEST.map((j) => (j.id === 'detect-reorgs' ? { ...j, enabled: false } : j)) });
    expect(ok(paused, 'A26_2_manifest_registers_detect_reorgs')).toBe(false);
  });

  it('FAILS A26_3 on a 500, a 401 (cron auth), and a malformed 200', () => {
    expect(ok(evaluateDetectReorgs({ ...healthyInput, job: { status: 500, body: { error: 'Processing failed' }, bodyText: '' } }), 'A26_3_detect_reorgs_endpoint_answers')).toBe(false);
    const unauth = evaluateDetectReorgs({ ...healthyInput, job: { status: 401, body: {}, bodyText: '' } });
    expect(find(unauth, 'A26_3_detect_reorgs_endpoint_answers').detail).toMatch(/cron auth rejected/);
    expect(ok(evaluateDetectReorgs({ ...healthyInput, job: { status: 200, body: { checked: 0 }, bodyText: '{"checked":0}' } }), 'A26_3_detect_reorgs_endpoint_answers')).toBe(false);
    expect(ok(evaluateDetectReorgs({ ...healthyInput, job: { status: 200, body: { checked: -1, reorgsDetected: 0, reverted: 0 }, bodyText: '' } }), 'A26_3_detect_reorgs_endpoint_answers')).toBe(false);
  });

  it('FAILS A26_1 when the worker serves a different SHA', () => {
    const results = evaluateDetectReorgs({ ...healthyInput, health: { httpStatus: 200, gitSha: PREVIOUS_RC_HEAD_SHA, statusField: 'healthy' } });
    expect(ok(results, 'A26_1_worker_serves_health_on_rc_head')).toBe(false);
  });
});

// ─── Self-test row ───────────────────────────────────────────────────────────

describe('self-test row', () => {
  it('proves every discrimination vector and is explicitly not soak evidence', async () => {
    const row = await runSelfTest();
    expect(row.prs).toEqual([2525, 2526, 2527]);
    expect(row.tier).toBe('T2');
    expect(row.mode).toBe('self-test');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.withinDeclaredWindow).toBe(false);
    expect(row.rc.head).toBe(RC_HEAD_SHA);
    expect(row.prCoverage['2528']).toBe('frontend-spec');
    const failing = Object.entries(row.counts).filter(([, v]) => v !== true);
    expect(failing, failing.map(([k]) => k).join(', ')).toEqual([]);
    expect(row.status).toBe('pass');
  });

  it('states what it does NOT assert, in the row itself', async () => {
    const row = await runSelfTest();
    expect(row.notAsserted.join(' ')).toMatch(/UNREACHABLE on this build/);
    expect(row.notAsserted.join(' ')).toMatch(/JobRunSignal\.lastRunAt/);
    expect(row.notAsserted.join(' ')).toMatch(/#2528 is not covered by this driver/);
  });
});

// ─── runLive against a fake rig ──────────────────────────────────────────────

type FakeRigOptions = {
  gitSha?: string;
  unpark?: boolean;
  previousHeadVerdicts?: boolean;
  driftFixture?: boolean;
  jobStatus?: number;
};

function fakeRig(opts: FakeRigOptions = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const anchorsRows = PROOF_COHORT_IDS.flatMap((cohort) =>
    Array.from({ length: PROOF_COHORTS[cohort].rows }, (_, slot) => ({
      id: `0902c000-0000-4000-8000-0000000000${cohort.length}${slot}`,
      public_id: fixturePublicId(cohort, slot),
      fingerprint: opts.driftFixture && cohort === 'a-valid' ? 'ab'.repeat(32) : fixtureFingerprint(cohort, slot),
      org_id: PROOF_COHORTS[cohort].org === 'a' ? '09020000-0000-4000-8000-0000000000b1' : '09020000-0000-4000-8000-0000000000b2',
      chain_tx_id: PROOF_COHORTS[cohort].chainTxId,
      metadata: { _purpose: FIXTURE_PURPOSE, _cohort: cohort, _slot: slot, _org: PROOF_COHORTS[cohort].org, _expected_verdict: PROOF_COHORTS[cohort].expectedVerdict },
    })),
  );
  const attRows = ATTESTATION_FIXTURE_IDS.map((id) => ({ attestation_id: id, status: expectedAttestationStatus(id) }));
  const byPublicId = new Map<string, { cohort: ProofCohort; slot: number }>();
  for (const cohort of PROOF_COHORT_IDS) for (let s = 0; s < PROOF_COHORTS[cohort].rows; s += 1) byPublicId.set(fixturePublicId(cohort, s), { cohort, slot: s });

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const rl = { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '90' };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const u = new URL(url);
    if (u.pathname === '/api/health') return json(200, { status: 'healthy', git_sha: opts.gitSha ?? RC_HEAD_SHA, uptime: 10 });
    if (u.pathname === '/rest/v1/anchors') return json(200, anchorsRows);
    if (u.pathname === '/rest/v1/legally_binding_attestations') return json(200, attRows);
    const proof = /^\/api\/v1\/verify\/([^/]+)\/proof$/.exec(u.pathname);
    if (proof) {
      const hit = byPublicId.get(decodeURIComponent(proof[1]));
      if (!hit) return json(404, { error: 'Record not found', proof_error_code: 'RECORD_NOT_FOUND' }, rl);
      const body = healthyProofBody(hit.cohort, hit.slot);
      if (opts.previousHeadVerdicts && (hit.cohort === 'a-uninspected' || hit.cohort === 'a-overlong')) {
        body.verdict = PROOF_VERDICT.VALID;
        body.verdict_note = PROOF_VERDICT_NOTE.valid;
      }
      return json(200, body, rl);
    }
    const att = /^\/api\/v1\/verify\/attestation\/([^/]+)$/.exec(u.pathname);
    if (att) {
      const id = decodeURIComponent(att[1]);
      if (!/^ARK-ATT-[A-Za-z0-9_-]{1,64}$/.test(id)) return json(400, { verified: false, error: 'Invalid attestation ID format — expected ARK-ATT-* prefix' }, rl);
      if (opts.unpark && (id.endsWith('-NOTARIZED') || id.endsWith('-ANCHORED'))) return new Response(disclosedAttestationBody(id), { status: 200, headers: { 'content-type': 'application/json', ...rl } });
      return json(404, { verified: false, error: 'Legally binding attestation verification is not implemented — no attestation records exist' }, rl);
    }
    if (u.pathname === '/jobs/detect-reorgs' && method === 'POST') {
      if (opts.jobStatus && opts.jobStatus !== 200) return json(opts.jobStatus, { error: 'Processing failed' });
      return json(200, { checked: 0, reorgsDetected: 0, reverted: 0 });
    }
    return json(404, { error: 'unrouted in fake rig' });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const LIVE_ARGS = {
  mode: 'live' as const,
  targetUrl: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app',
  admissionJson: resolve(here, 'rc-batch-0902-driver.test.ts'), // overridden below by a temp file when needed
  evidenceJsonl: '/nonexistent/rc0902-evidence.jsonl',
  cronSecret: 'secret',
  supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  supabaseServiceKey: 'service-key',
  windowStart: '2026-09-03T00:00:00Z',
  windowEnd: '2026-09-03T12:00:00Z',
  attestationBurst: 3,
};

function admissionFile(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'rc0902-admission-'));
  const path = resolve(dir, 'admission.json');
  writeFileSync(
    path,
    JSON.stringify({
      rig_name: 'rc0902',
      head_sha: RC_HEAD_SHA,
      supabase_project_ref: 'abcdefghijklmnopqrst',
      cloud_run_service: 'arkova-worker-rc0902-staging',
      soak_start: '2026-09-03T00:00:00Z',
      soak_end: '2026-09-03T12:00:00Z',
      ...extra,
    }),
  );
  return path;
}

describe('runLive against a fake rig', () => {
  const now = () => new Date('2026-09-03T06:00:00Z');

  it('produces a passing, window-bound row on a healthy RC-head rig and never issues a write', async () => {
    const rig = fakeRig();
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now, randomHex: () => 'deadbeef' });
    expect(row.blockers ?? []).toEqual([]);
    expect(row.assertions.filter((a) => !a.ok).map((a) => `${a.id}: ${a.detail}`)).toEqual([]);
    expect(row.status).toBe('pass');
    expect(row.evidenceForSoak).toBe(true);
    expect(row.withinDeclaredWindow).toBe(true);
    expect(row.buildGitSha).toBe(RC_HEAD_SHA);
    expect(row.prCoverage).toEqual({ '2525': 'pass', '2526': 'pass', '2527': 'pass', '2528': 'frontend-spec' });
    expect(row.assertions).toHaveLength(8 + 6 + 3);
    expect(row.counts.proofRowsServed).toBe(11);
    expect(row.counts.fixtureAttestations).toBe(10);
    expect(row.counts.attestationBurst).toBe(3);
    // Read-only: the only non-GET request is the cron POST the manifest entry names.
    const nonGet = rig.calls.filter((c) => c.method !== 'GET');
    expect(nonGet).toEqual([{ method: 'POST', url: 'https://arkova-worker-rc0902-staging-abc123-uc.a.run.app/jobs/detect-reorgs' }]);
    expect(rig.calls.filter((c) => c.url.includes('/rest/v1/')).every((c) => c.method === 'GET')).toBe(true);
    // No secret is echoed into the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('service-key');
    expect(serialized).not.toContain('"secret"');
  });

  it('K1: refuses to run when the worker serves a different SHA — no assertion is even attempted', async () => {
    const rig = fakeRig({ gitSha: PREVIOUS_RC_HEAD_SHA });
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.blockers?.join(' ')).toMatch(/K1: the worker serves git_sha/);
    expect(row.assertions).toEqual([]);
    expect(row.buildGitSha).toBe(PREVIOUS_RC_HEAD_SHA);
    expect(rig.calls.some((c) => c.url.includes('/rest/v1/'))).toBe(false);
  });

  it('K1: refuses when the admission JSON names a different head than the driver expects', async () => {
    const rig = fakeRig();
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile({ head_sha: PREVIOUS_RC_HEAD_SHA }) }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.blockers?.join(' ')).toMatch(/admission JSON names head_sha/);
  });

  it('K3: refuses a rig the admission JSON does not name, before any request', async () => {
    const rig = fakeRig();
    const row = await runLive(
      { ...LIVE_ARGS, admissionJson: admissionFile({ cloud_run_service: 'arkova-worker-elsewhere-staging' }) },
      { fetchImpl: rig.fetchImpl, now },
    );
    expect(row.status).toBe('fail');
    expect(row.blockers?.join(' ')).toMatch(/not the service the admission JSON names/);
    expect(rig.calls).toEqual([]);
  });

  it('refuses a fixture that does not match the seed recipe instead of asserting on it', async () => {
    const rig = fakeRig({ driftFixture: true });
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.blockers?.join(' ')).toMatch(/does not match scripts\/staging\/seed-rc-batch-0902-fixture\.sql/);
    expect(row.blockers?.join(' ')).toMatch(/fingerprint does not match the seed recipe/);
  });

  it('fails the row (not the run) when the rig unparks the attestation route', async () => {
    const rig = fakeRig({ unpark: true });
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.prCoverage['2525']).toBe('fail');
    expect(row.prCoverage['2527']).toBe('pass');
    expect(row.prCoverage['2526']).toBe('pass');
    expect(ok(row.assertions, 'A25_3_pii_never_leaves_any_byte')).toBe(false);
  });

  it('fails the row when the rig serves the superseded RC head\'s verdicts', async () => {
    const rig = fakeRig({ previousHeadVerdicts: true });
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.prCoverage['2527']).toBe('fail');
    expect(ok(row.assertions, 'A27_5_uninspected_branch_unverifiable')).toBe(false);
  });

  it('fails the row when detect-reorgs answers 500', async () => {
    const rig = fakeRig({ jobStatus: 500 });
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now });
    expect(row.status).toBe('fail');
    expect(row.prCoverage['2526']).toBe('fail');
  });

  it('marks a cycle outside the declared window as not-evidence even when every assertion passes', async () => {
    const rig = fakeRig();
    const row = await runLive({ ...LIVE_ARGS, admissionJson: admissionFile() }, { fetchImpl: rig.fetchImpl, now: () => new Date('2026-09-04T06:00:00Z') });
    expect(row.status).toBe('pass');
    expect(row.withinDeclaredWindow).toBe(false);
    expect(row.evidenceForSoak).toBe(false);
  });

  it('validateFixtureAnchors reports every kind of drift by name', () => {
    const good = validateFixtureAnchors([
      { id: 'x', public_id: fixturePublicId('a-overlong', 0), fingerprint: fixtureFingerprint('a-overlong', 0), org_id: null, chain_tx_id: PROOF_COHORTS['a-overlong'].chainTxId, metadata: { _cohort: 'a-overlong', _slot: 0, _expected_verdict: 'unverifiable' } },
    ]);
    expect(good.blockers.filter((b) => b.startsWith('a-overlong'))).toEqual([]);
    const bad = validateFixtureAnchors([
      { id: 'x', public_id: 'WRONG', fingerprint: 'ab'.repeat(32), org_id: null, chain_tx_id: 'deadbeef', metadata: { _cohort: 'a-overlong', _slot: 0, _expected_verdict: 'valid' } },
      { id: 'y', public_id: null, fingerprint: 'ab'.repeat(32), org_id: null, chain_tx_id: null, metadata: { _cohort: 'nope', _slot: 0 } },
    ]);
    expect(bad.blockers.join('\n')).toMatch(/public_id WRONG/);
    expect(bad.blockers.join('\n')).toMatch(/fingerprint does not match the seed recipe/);
    expect(bad.blockers.join('\n')).toMatch(/not the cohort's real receipt/);
    expect(bad.blockers.join('\n')).toMatch(/fixture\/driver contract drift/);
    expect(bad.blockers.join('\n')).toMatch(/unrecognised cohort/);
  });
});
