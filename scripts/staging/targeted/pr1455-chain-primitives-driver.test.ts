import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPr1455AdmissionDriver } from './pr1455-chain-primitives-driver.js';

describe('pr1455 chain primitives admission driver', () => {
  const headSha = '3184256703a4dae451fc9bcd317f48cd02b04d0d';
  const projectRef = 'nwbrkwjkoyabazfpxjbt';
  const tagUrl = 'https://pr-1455---arkova-worker-s3-chain-resil-staging-kvojbeutfa-uc.a.run.app';

  it('passes the PR-specific pure changed-behavior checks', async () => {
    const result = await runPr1455AdmissionDriver({ now: '2026-07-09T00:00:00.000Z' });

    expect(result.pr).toBe(1455);
    expect(result.tier).toBe('T3');
    expect(result.status).toBe('pass');
    expect(result.evidenceForSoak).toBe(false);
    expect(result.changedBehavior).toContain('canonical Base anchor calldata decode');
    expect(result.changedBehavior).toContain('dynamic batch fee ceiling');
    expect(result.changedBehavior).toContain('0357');
    expect(result.checks.map((item) => item.name)).toEqual([
      'canonical_base_anchor_calldata_decode',
      'dynamic_batch_fee_ceiling_and_scheduler',
      'ctid_invariance_fail_closed',
      'secured_chain_receipt_trigger_design',
    ]);
    expect(result.checks.every((item) => item.ok)).toBe(true);
  });

  it('keeps self-test output honest: not countable T3 soak evidence', async () => {
    const result = await runPr1455AdmissionDriver();

    expect(result.evidenceForSoak).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('No exact-head isolated deploy/admission JSON'),
      expect.stringContaining('clean isolated DB apply'),
    ]));
    expect(result.checks.find((item) => item.name === 'secured_chain_receipt_trigger_design')?.details)
      .toMatchObject({
        requiresIsolatedDbForCountableEvidence: true,
        gatedByGuc: 'arkova.secured_enforce_chain_present',
      });
  });

  it('can append one JSONL row for later admission packet assembly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr1455-driver-'));
    const evidenceJsonl = join(dir, 'evidence.jsonl');

    const result = await runPr1455AdmissionDriver({
      now: '2026-07-09T00:00:00.000Z',
      evidenceJsonl,
    });
    const rows = readFileSync(evidenceJsonl, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: 1455,
      tier: 'T3',
      status: 'pass',
      evidenceForSoak: false,
      at: '2026-07-09T00:00:00.000Z',
    });
    expect(rows[0].checks).toHaveLength(result.checks.length);
  });

  it('admits countable soak evidence only with exact-head admission, clean preflight, and live 0357 trigger proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr1455-driver-live-'));
    const admissionJson = join(dir, 'admission.json');
    const preflightJson = join(dir, 'preflight.json');
    const triggerProofJson = join(dir, 'trigger-proof.json');
    writeFileSync(admissionJson, JSON.stringify({
      pr: 1455,
      tier: 'T3',
      headSha,
      buildSha: headSha,
      projectRef,
      tagUrl,
      imageDigest: 'sha256:cfef3752e89ede2d5cd82bc81184df9406a09893e67060838de9cc99b207217a',
    }));
    writeFileSync(preflightJson, JSON.stringify({
      environment_type: 'clean_mirror',
      staging_project_ref: projectRef,
      checks: [{ name: 'prod_divergence', passed: true }],
    }));
    writeFileSync(triggerProofJson, JSON.stringify({
      pr: 1455,
      migration: '0357',
      projectRef,
      environmentType: 'clean_mirror',
      triggerInstalled: true,
      gucEnabled: true,
      invalidSecuredRejected: true,
      validSecuredAccepted: true,
      nonSecuredUnaffected: true,
      evidenceForSoak: true,
    }));

    const result = await runPr1455AdmissionDriver({
      mode: 'live-trigger-proof',
      admissionJson,
      preflightJson,
      triggerProofJson,
      expectedSha: headSha,
      expectedProjectRef: projectRef,
      expectedTagUrl: tagUrl,
      now: '2026-07-09T00:00:00.000Z',
    });

    expect(result.status).toBe('pass');
    expect(result.evidenceForSoak).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.checks.map((item) => item.name)).toContain('exact_head_admission_and_clean_preflight');
    expect(result.checks.map((item) => item.name)).toContain('live_0357_secured_trigger_proof');
  });

  it('rejects live soak evidence when preflight is not clean_mirror', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr1455-driver-dirty-'));
    const admissionJson = join(dir, 'admission.json');
    const preflightJson = join(dir, 'preflight.json');
    const triggerProofJson = join(dir, 'trigger-proof.json');
    writeFileSync(admissionJson, JSON.stringify({
      headSha,
      buildSha: headSha,
      projectRef,
      tagUrl,
      imageDigest: 'sha256:cfef3752e89ede2d5cd82bc81184df9406a09893e67060838de9cc99b207217a',
    }));
    writeFileSync(preflightJson, JSON.stringify({
      environment_type: 'soak_artifact',
      staging_project_ref: projectRef,
      checks: [{ name: 'prod_divergence', passed: false, details: 'Repo migrations missing from rig: [0357]' }],
    }));
    writeFileSync(triggerProofJson, JSON.stringify({
      pr: 1455,
      migration: '0357',
      projectRef,
      environmentType: 'clean_mirror',
      triggerInstalled: true,
      gucEnabled: true,
      invalidSecuredRejected: true,
      validSecuredAccepted: true,
      evidenceForSoak: true,
    }));

    const result = await runPr1455AdmissionDriver({
      mode: 'live-trigger-proof',
      admissionJson,
      preflightJson,
      triggerProofJson,
      expectedSha: headSha,
      expectedProjectRef: projectRef,
      expectedTagUrl: tagUrl,
    });

    expect(result.status).toBe('fail');
    expect(result.evidenceForSoak).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'Required live evidence check failed: exact_head_admission_and_clean_preflight',
    ]));
    expect(result.checks.find((item) => item.name === 'exact_head_admission_and_clean_preflight')?.details)
      .toMatchObject({ preflightCleanMirror: false });
  });
});
