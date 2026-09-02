import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural contract tests for the rc/soak-batch-2026-09-02 fixture.
 *
 * The fixture is declarative SQL and CI has no Postgres for this path, so these
 * pin the invariants that make it (a) mean what the batched driver assumes —
 * one cohort per verdict state, both orgs, all five attestation statuses, real
 * receipts with verified headers — and (b) stay §1.11A-compliant: data-only,
 * idempotent, clearly synthetic, refusing a non-fresh database. The SQL was
 * executed end-to-end (twice, plus with the SECURED-proof GUC on, plus both
 * negative guards) against a throwaway postgres:17 container during authoring;
 * the driver's own test (services/worker/scripts/rc-batch-0902-driver.test.ts)
 * pins the same literals from the other side and runs every cohort through the
 * real buildProofResponse.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(here, 'seed-rc-batch-0902-fixture.sql');
const BASELINE_PATH = resolve(here, 'seed-baseline-fixture.sql');

const sql = readFileSync(SQL_PATH, 'utf8');
const baseline = readFileSync(BASELINE_PATH, 'utf8');

/** SQL with `-- line comments` stripped, so ledger assertions inspect executable SQL only. */
const sqlNoComments = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const COHORTS: Array<[string, number, string]> = [
  ['a-valid', 2, 'valid'],
  ['a-invalid', 2, 'invalid'],
  ['a-legacy', 2, 'unverifiable'],
  ['a-uninspected', 2, 'unverifiable'],
  ['a-overlong', 1, 'unverifiable'],
  ['b-valid', 2, 'valid'],
];

describe('seed-rc-batch-0902-fixture.sql — what it builds', () => {
  it('is a separate, additive file that never writes the switchboard row the baseline owns', () => {
    expect(sqlNoComments).not.toMatch(/insert\s+into\s+public\.switchboard_flags/i);
    expect(sql).toMatch(/ENABLE_VERIFICATION_API is %/); // asserted, not written
    expect(baseline).toMatch(/insert\s+into\s+public\.switchboard_flags/i); // the owner
  });

  it('plans exactly the six cohorts, eleven rows, with the expected verdict stamped per row', () => {
    for (const [cohort, rows, verdict] of COHORTS) {
      for (let slot = 0; slot < rows; slot += 1) {
        const publicId = `ARK-RC0902-${cohort.toUpperCase()}-${slot}`;
        const line = new RegExp(`\\('${cohort}',\\s*${slot},\\s*'[ab]',\\s*'0902c000-0000-4000-8000-\\d{12}',\\s*'${publicId}',`);
        expect(sql, `${cohort}:${slot} plan line`).toMatch(line);
      }
      // The verdict stamp travels on the same plan row as the receipt.
      expect(sql).toMatch(new RegExp(`'${cohort}',[\\s\\S]{0,200}?'${verdict}'\\)`));
    }
    expect(sql.match(/'ARK-RC0902-[A-Z-]+-\d'/g)).toHaveLength(11);
    expect(sql).toContain("'_expected_verdict', r.expected_verdict");
  });

  it('seeds two orgs — one VERIFIED (notarized type), one UNVERIFIED (witnessed type)', () => {
    expect(sql).toMatch(/'Meridian Notarial Fixture Org LLC'[\s\S]{0,120}'VERIFIED'/);
    expect(sql).toMatch(/'Halcyon Witness Fixture Org LLC'[\s\S]{0,120}'UNVERIFIED'/);
    expect(sql).toContain("CASE v.org_tag WHEN 'a' THEN 'notarized' ELSE 'witnessed' END");
  });

  it('shapes each cohort the way the verdict rule reads it', () => {
    // a-uninspected: empty branch, root == own leaf.
    expect(sql).toMatch(/WHEN 'a-uninspected' THEN '\[\]'::jsonb/);
    expect(sql).toMatch(/WHEN 'a-uninspected' THEN r\.fingerprint/);
    // a-overlong: one extra sibling, root computed over leaf||sibling.
    expect(sql).toContain("md5('rc0902-a-overlong-extra-sibling-hi')");
    // a-invalid: wrong sibling per slot.
    expect(sql).toContain("md5('rc0902-a-invalid-wrong-sibling-' || r.slot || '-hi')");
    // a-legacy: no merkle_index.
    expect(sql).toMatch(/WHEN 'a-legacy' THEN NULL/);
    // 2-leaf roots by the verifier's rule: plain double-SHA256 over positional concatenation.
    expect(sql).toContain('pg_temp.rc0902_sha256d(decode(r0.fingerprint || r1.fingerprint, \'hex\'))');
    expect(sql).toMatch(/extensions\.digest\(extensions\.digest\(payload, 'sha256'\), 'sha256'\)/);
  });

  it('binds every row to a real mainnet receipt and embeds the two real 80-byte headers', () => {
    const txids = sql.match(/'[0-9a-f]{64}',\s*'[AB]',\s*'(?:valid|invalid|unverifiable)'/g) ?? [];
    expect(txids).toHaveLength(11);
    expect(new Set(txids.map((t) => t.slice(1, 65))).size).toBe(6);
    expect(sql).toContain("'000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960657, 1785637848,");
    expect(sql).toContain("'00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2', 962144, 1786538405,");
    expect(sql.match(/'[0-9a-f]{160}'/g)).toHaveLength(2);
    // The post-condition proves the headers hash to the block hashes (byte-reversed sha256d).
    expect(sql).toMatch(/rc0902_reverse_hex\(pg_temp\.rc0902_sha256d\(decode\(blk\.header_hex, 'hex'\)\)\) <> blk\.block_hash/);
    expect(sql).toMatch(/chain_timestamp\s*=\s*to_timestamp\(r\.block_time\)/);
  });

  it('seeds all five attestation statuses in both orgs, inserted at draft and walked by guarded UPDATEs', () => {
    for (const org of ['A', 'B']) {
      for (const tag of ['DRAFT', 'PENDING', 'REVIEW', 'NOTARIZED', 'ANCHORED']) {
        expect(sql).toContain(`'ARK-ATT-RC0902-${org}-${tag}'`);
      }
    }
    expect(sql).toMatch(/\n\s+'draft'\nFROM \(VALUES/);
    // Every status UPDATE is guarded by the status it moves FROM, so a re-run is a no-op
    // and an anchored (immutable) row is never touched.
    expect(sql).toMatch(/SET status = 'requires_review'[\s\S]*?AND status = 'draft'/);
    expect(sql).toMatch(/SET status = 'pending_notarization'[\s\S]*?AND status = 'draft'/);
    expect(sql).toMatch(/SET status = 'notarized'[\s\S]*?AND status = 'pending_notarization'/);
    expect(sql).toMatch(/SET status = 'anchored'[\s\S]*?AND t\.status = 'notarized'/);
    const updates = sqlNoComments.match(/UPDATE public\.legally_binding_attestations/g) ?? [];
    expect(updates).toHaveLength(4);
  });

  it('gives every attestation row the natural-person and notary PII the driver sweeps for', () => {
    for (const literal of [
      'Amara Okonkwo-Fixture',
      'Tobias Lindqvist-Fixture',
      'Priya Raghunathan-Fixture',
      'Elena Marchetti-Fixture',
      'RC0902-COMM-A-7731',
      'RC0902-COMM-B-8842',
    ]) {
      expect(sql).toContain(`'${literal}'`);
    }
    expect(sql).toMatch(/t\.subject_name LIKE '%-Fixture'/);
    expect(sql).toMatch(/t\.notary_commission_number LIKE 'RC0902-COMM-%'/);
  });

  it('links each anchored attestation to its OWN org\'s valid anchor (per-org attribution)', () => {
    expect(sql).toMatch(/t\.attestation_id = 'ARK-ATT-RC0902-A-ANCHORED' AND r\.cohort = 'a-valid'/);
    expect(sql).toMatch(/t\.attestation_id = 'ARK-ATT-RC0902-B-ANCHORED' AND r\.cohort = 'b-valid'/);
    expect(sql).toMatch(/a\.org_id IS DISTINCT FROM t\.attesting_org_id/);
  });
});

describe('seed-rc-batch-0902-fixture.sql — §1.11A compliance', () => {
  it('writes only data rows — no migration-ledger writes, no repair', () => {
    expect(sqlNoComments).not.toMatch(/schema_migrations/i);
    expect(sqlNoComments).not.toMatch(/migration\s+repair/i);
    expect(sqlNoComments).not.toMatch(/soak_artifact/i);
  });

  it('refuses a production-scale anchor population and any foreign attestation row', () => {
    expect(sql).toMatch(/IF existing_anchors > 10000 THEN/);
    expect(sql).toMatch(/WHERE attestation_id NOT LIKE 'ARK-ATT-RC0902-%'/);
    expect(sql).toMatch(/IF foreign_attestations > 0 THEN/);
  });

  it('is idempotent: stable synthetic ids with ON CONFLICT on every insert', () => {
    // Real tables only — the two `rc0902_*` temp-table plan inserts are ON COMMIT DROP.
    const inserts = sqlNoComments.match(/INSERT INTO (?:auth|public)\.[a-z_]+/gi) ?? [];
    const conflicts = sqlNoComments.match(/ON CONFLICT/gi) ?? [];
    // auth.users, auth.identities, organizations, profiles, anchors, anchor_proofs, attestations
    expect(inserts).toHaveLength(7);
    expect(conflicts).toHaveLength(7);
    expect(sql).toMatch(/'09020000-0000-4000-8000-0000000000a1'/);
    expect(sql).toMatch(/'0902c000-0000-4000-8000-000000000001'/);
    expect(sql).toContain("'_purpose', 'rc-batch-0902'");
    expect(sql).toContain('@seed-fixture.invalid');
  });

  it('takes the service_role fast-path transaction-locally and promotes only after the proof rows exist', () => {
    expect(sql).toMatch(/SELECT set_config\('request\.jwt\.claims', '\{"role":"service_role"\}', true\);/);
    const insertAnchors = sqlNoComments.indexOf('INSERT INTO public.anchors');
    const insertProofs = sqlNoComments.indexOf('INSERT INTO public.anchor_proofs');
    const promote = sqlNoComments.indexOf("SET status              = 'SECURED'");
    expect(insertAnchors).toBeGreaterThan(0);
    expect(insertProofs).toBeGreaterThan(insertAnchors);
    expect(promote).toBeGreaterThan(insertProofs);
    expect(sql).toMatch(/'PENDING',\n\s+4096/);
  });

  it('keeps every fixture anchor durable against the rig\'s own crons: SECURED, real txid, legal_hold', () => {
    expect(sql).toMatch(/legal_hold\s*=\s*true/);
    expect(sql).toMatch(/AND status = 'SECURED' AND legal_hold = true AND deleted_at IS NULL/);
    expect(sql).toMatch(/a\.chain_tx_id !~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it('carries no credential literal (the bcrypt hash is derived from a throwaway random value)', () => {
    expect(sql).toMatch(/extensions\.crypt\(gen_random_uuid\(\)::text, extensions\.gen_salt\('bf'\)\)/);
    expect(sql).not.toMatch(/password\s*=\s*'/i);
  });

  it('enforces its post-conditions in-transaction so a doomed fixture aborts the seed', () => {
    const doBlocks = sql.match(/DO \$\$/g) ?? [];
    expect(doBlocks.length).toBeGreaterThanOrEqual(2);
    for (const msg of [
      'of them SECURED+legal_hold (expected 11/11)',
      'header does not hash to its block hash',
      'valid-cohort rows recompute to their stored root',
      'a-invalid rows fail the recompute',
      'a-legacy rows have a verifying branch with NULL merkle_index',
      'a-uninspected rows have the empty-branch / 2-row-batch shape',
      'single-row-batch / 1-sibling / recomputing shape',
      'does not commit their own merkle_root',
      'attestation rows sit at their target status',
      'reference another org',
    ]) {
      expect(sql, msg).toMatch(new RegExp(msg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
