import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPr1455AdmissionDriver } from './pr1455-chain-primitives-driver.js';

describe('pr1455 chain primitives admission driver', () => {
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
});
