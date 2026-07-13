/**
 * S3-B frozen reason enum + verdict semantics (TDD).
 *
 *  - Machine reason codes: every failure maps to exactly one frozen code; the
 *    report carries `reasonCode` (null on VERIFIED) and per-step `code`.
 *  - Schema gate: an unsupported proof_schema_version fails closed BEFORE any
 *    cryptographic interpretation (UNSUPPORTED_SCHEMA_VERSION).
 *  - Signature semantics (hardened): a PASSING signature still NEVER
 *    substitutes for recomputation, but when a signature check was EXPLICITLY
 *    requested and fails, the verdict fails closed (SIG_INVALID), and an
 *    unresolvable signing key id fails closed (DID_UNRESOLVED).
 */

import { describe, it, expect } from 'vitest';
import { verifyProof } from '../src/verify.js';
import {
  REASON_CODES,
  recomputeReasonCode,
  chainReasonCode,
} from '../src/lib/reason-codes.js';
import { loadAdversarialFixtures, loadSyntheticFixtures, offlineNode, readFixtureFile } from './helpers.js';
import type { ProofPacket, SignedProofBundle } from '../src/types.js';

const adversarial = loadAdversarialFixtures();
const synthetic = loadSyntheticFixtures();

function adv(name: string) {
  const f = adversarial.find((x) => x.name === name);
  if (!f) throw new Error(`missing adversarial fixture ${name}`);
  return f;
}

describe('frozen reason enum', () => {
  it('has exactly the 18 frozen codes, in stable order', () => {
    expect(REASON_CODES).toEqual([
      'MALFORMED_BUNDLE',
      'UNSUPPORTED_SCHEMA_VERSION',
      'EMPTY_BRANCH_UNVERIFIABLE',
      'MERKLE_MISMATCH',
      'FORGED_SELF_PAIR',
      'LEAF_INDEX_OUT_OF_RANGE',
      'TX_NOT_FOUND',
      'NOT_IN_BLOCK',
      'TXID_MISMATCH',
      'NO_ANCHOR_OUTPUT',
      'PAYLOAD_MISMATCH',
      'HEIGHT_MISMATCH',
      'BLOCK_HASH_MISMATCH',
      'HEADER_INVALID',
      'ROOT_NOT_IN_HEADER',
      'TIMESTAMP_MISMATCH',
      'SIG_INVALID',
      'DID_UNRESOLVED',
    ]);
  });

  it('maps every vendored recompute reason to a frozen code', () => {
    expect(recomputeReasonCode('leaf is not 64-hex (32-byte) — invalid leaf format')).toBe('MALFORMED_BUNDLE');
    expect(recomputeReasonCode('root is not 64-hex (32-byte) — invalid root format')).toBe('MALFORMED_BUNDLE');
    expect(recomputeReasonCode('branch is not an array')).toBe('MALFORMED_BUNDLE');
    expect(recomputeReasonCode('branch[0] sibling is not 64-hex (32-byte) — invalid sibling format')).toBe('MALFORMED_BUNDLE');
    expect(recomputeReasonCode('branch[1] has invalid position')).toBe('MALFORMED_BUNDLE');
    expect(recomputeReasonCode('leafIndex 9 out of range for leafCount 4')).toBe('LEAF_INDEX_OUT_OF_RANGE');
    expect(recomputeReasonCode('empty branch (single-leaf tree) but root != leaf')).toBe('EMPTY_BRANCH_UNVERIFIABLE');
    expect(
      recomputeReasonCode(
        'branch[0] sibling equals running hash at a non-duplicated position — forged self-pair rejected (CVE-2012-2459)',
      ),
    ).toBe('FORGED_SELF_PAIR');
    expect(recomputeReasonCode('recomputed root does not match committed merkle_root')).toBe('MERKLE_MISMATCH');
    // Unknown reason strings fail closed to the malformed bucket, never to a pass.
    expect(recomputeReasonCode(undefined)).toBe('MERKLE_MISMATCH');
  });

  it('maps every independent-node status to a frozen code', () => {
    expect(chainReasonCode('bad_request')).toBe('MALFORMED_BUNDLE');
    expect(chainReasonCode('tx_not_found')).toBe('TX_NOT_FOUND');
    expect(chainReasonCode('txid_mismatch')).toBe('TXID_MISMATCH');
    expect(chainReasonCode('not_in_block')).toBe('NOT_IN_BLOCK');
    expect(chainReasonCode('no_anchor_output')).toBe('NO_ANCHOR_OUTPUT');
    expect(chainReasonCode('payload_mismatch')).toBe('PAYLOAD_MISMATCH');
    expect(chainReasonCode('height_mismatch')).toBe('HEIGHT_MISMATCH');
    expect(chainReasonCode('block_hash_mismatch')).toBe('BLOCK_HASH_MISMATCH');
    expect(chainReasonCode('header_unavailable')).toBe('HEADER_INVALID');
    expect(chainReasonCode('inclusion_failed')).toBe('ROOT_NOT_IN_HEADER');
  });
});

describe('report.reasonCode', () => {
  it('is null on a fully VERIFIED report', async () => {
    const f = adv('adv-valid-even-tree-pass');
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(true);
    expect(report.reasonCode).toBeNull();
  });

  it('is the FIRST failing step code when multiple steps fail', async () => {
    // Tampered fingerprint over a fully valid chain: recompute fails first even
    // though the chain confirms fine — reasonCode must be the recompute code.
    const f = adv('adv-tampered-fingerprint-byte');
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MERKLE_MISMATCH');
  });

  it('failing steps carry their machine code; passing steps carry none', async () => {
    const f = adv('adv-wrong-marker-arkx');
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    const recompute = report.steps.find((s) => s.id === 'recompute')!;
    const opReturn = report.steps.find((s) => s.id === 'op_return')!;
    expect(recompute.status).toBe('pass');
    expect(recompute.code).toBeUndefined();
    expect(opReturn.status).toBe('fail');
    expect(opReturn.code).toBe('NO_ANCHOR_OUTPUT');
  });
});

describe('schema gate (UNSUPPORTED_SCHEMA_VERSION)', () => {
  it('fails closed on an unknown proof_schema_version and skips interpretation', async () => {
    const f = adv('adv-unsupported-schema-version');
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('UNSUPPORTED_SCHEMA_VERSION');
    const schema = report.steps.find((s) => s.id === 'schema')!;
    expect(schema.status).toBe('fail');
    expect(schema.detail).toContain('schema version');
    // The verifier must not pretend to interpret a format it does not know.
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('skipped');
    expect(report.steps.find((s) => s.id === 'op_return')?.status).toBe('skipped');
    expect(report.steps.find((s) => s.id === 'block_confirm')?.status).toBe('skipped');
  });

  it('fails closed when proof_schema_version is a non-numeric JSON value (e.g. true)', async () => {
    // JSON `true` never equals 1 in JS — pinned here because the Python
    // verifier had to guard the same document against `True == 1` (parity).
    const good = adv('adv-valid-even-tree-pass');
    const packet = { ...good.packet, proof_schema_version: true as unknown as number };
    const report = await verifyProof(packet, {});
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('UNSUPPORTED_SCHEMA_VERSION');
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('skipped');
  });

  it('passes schema version 1 explicitly and a legacy packet with no version', async () => {
    const withV1 = adv('adv-valid-even-tree-pass');
    const r1 = await verifyProof(withV1.packet, { chain: offlineNode(withV1) });
    expect(r1.steps.find((s) => s.id === 'schema')?.status).toBe('pass');

    const legacy = synthetic.find((f) => f.name === 'odd-leaf-pass')!;
    expect(legacy.packet.proof_schema_version).toBeUndefined();
    const r2 = await verifyProof(legacy.packet, { chain: offlineNode(legacy) });
    expect(r2.steps.find((s) => s.id === 'schema')?.status).toBe('pass');
    expect(r2.ok).toBe(true);
  });
});

describe('signature semantics (hardened, S3-B)', () => {
  it('an explicitly requested signature check that FAILS fails the verdict closed (SIG_INVALID)', async () => {
    const f = adv('adv-forged-signature');
    const report = await verifyProof(f.packet, {
      signedBundle: f.signedBundle,
      publishedKeys: f.publishedKeys,
    });
    expect(report.signature.status).toBe('failed');
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('SIG_INVALID');
  });

  it('an unresolvable signing key id fails closed (DID_UNRESOLVED) — the verifier never guesses a key', async () => {
    const f = adv('adv-unknown-signing-key-id');
    const report = await verifyProof(f.packet, {
      signedBundle: f.signedBundle,
      publishedKeys: f.publishedKeys,
    });
    expect(report.signature.status).toBe('failed');
    expect(report.signature.reason).toContain('key');
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('DID_UNRESOLVED');
  });

  it('a VALID signature resolved by key id verifies and the verdict passes', async () => {
    const f = adv('adv-valid-signed-bundle');
    const report = await verifyProof(f.packet, {
      signedBundle: f.signedBundle,
      publishedKeys: f.publishedKeys,
    });
    expect(report.signature.status).toBe('verified');
    expect(report.ok).toBe(true);
    expect(report.reasonCode).toBeNull();
  });

  it('a PASSING signature still never substitutes for recomputation (unchanged hard rule)', async () => {
    const bundle = JSON.parse(readFixtureFile('signed-bundle.json')) as SignedProofBundle;
    const pem = (JSON.parse(readFixtureFile('published-keys.json')) as { keys: { pem: string }[] })
      .keys[0].pem;
    const fail = synthetic.find((f) => f.name === 'tampered-fingerprint-fail')!;
    const report = await verifyProof(fail.packet, {
      chain: offlineNode(fail),
      signedBundle: bundle,
      publicKeyPem: pem,
    });
    expect(report.ok).toBe(false);
    // Recompute failure outranks the (passing) signature — code is the crypto one.
    expect(report.reasonCode).toBe('MERKLE_MISMATCH');
  });

  it('no signature material supplied → skipped, verdict unaffected (back-compat)', async () => {
    const f = adv('adv-valid-even-tree-pass');
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.signature.status).toBe('skipped');
    expect(report.ok).toBe(true);
  });
});

describe('malformed packets fail closed as MALFORMED_BUNDLE', () => {
  it('a 63-hex fingerprint is refused before any walk', async () => {
    const f = adv('adv-malformed-fingerprint');
    const report = await verifyProof(f.packet, {});
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
  });

  it('a malformed receipt id in the packet is refused at the chain step', async () => {
    const good = adv('adv-valid-even-tree-pass');
    const packet: ProofPacket = { ...good.packet, tx_id: 'zz-not-hex' };
    const report = await verifyProof(packet, { chain: offlineNode(good) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
  });
});
