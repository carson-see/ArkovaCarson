/**
 * KPI-3 external-verifier tests (SCRUM-2912 / SCRUM-2986) — hardened after the
 * Bitcoin-engineer specialist review. Proves the verifier does genuine SPV
 * (canonical fixed-offset commit + merkle inclusion + header binding + depth +
 * optional issuer), not explorer-trust, and that every tamper class is rejected.
 *
 * Deterministic + offline: the explorer is an injected path->response map.
 * Run: node --test scripts/kpi3/external-verify.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAnchorProof,
  computeMerkleRoot,
  extractCanonicalFingerprint,
  parseBlockHeader,
} from './external-verify.mjs';
import {
  VALID_PROOF,
  TAMPERED_PROOF,
  FAKE_EXPLORER_PATHS,
  fakeExplorer,
  CONSTANTS,
} from './fixtures.mjs';

const clone = (o) => structuredClone(o);
const TX = CONSTANTS.REAL_TXID;

// ── Unit: merkle + header + canonical decode ─────────────────────────────────
test('computeMerkleRoot reproduces the real block merkle_root', () => {
  const root = computeMerkleRoot(TX, CONSTANTS.REAL_MERKLE_PROOF.merkle, CONSTANTS.REAL_MERKLE_PROOF.pos);
  assert.equal(root, CONSTANTS.REAL_MERKLE_ROOT);
});

test('parseBlockHeader binds header -> block hash and merkle_root', () => {
  const h = parseBlockHeader(CONSTANTS.REAL_BLOCK_HEADER);
  assert.equal(h.blockHash, CONSTANTS.REAL_BLOCK_HASH);
  assert.equal(h.merkleRoot, CONSTANTS.REAL_MERKLE_ROOT);
});

test('extractCanonicalFingerprint: canonical anchor -> fingerprint at offset [4:36]', () => {
  assert.equal(extractCanonicalFingerprint(CONSTANTS.REAL_OP_RETURN_SCRIPT), CONSTANTS.REAL_FINGERPRINT);
});

test('extractCanonicalFingerprint: junk-then-ARKV is NOT a substring match (BUG-2026-06-24-004)', () => {
  // OP_RETURN pushing 00 || ARKV || fp : magic is NOT at offset 0 -> reject.
  const fp = CONSTANTS.REAL_FINGERPRINT;
  const payload = '00' + '41524b56' + fp; // 1 + 4 + 32 = 37 bytes
  const script = '6a' + '25' + payload; // 0x25 = 37
  assert.equal(extractCanonicalFingerprint(script), null);
});

test('extractCanonicalFingerprint: extra trailing pushes/junk rejected (not single-push)', () => {
  // Valid push then trailing bytes -> length mismatch -> reject.
  const script = CONSTANTS.REAL_OP_RETURN_SCRIPT + 'deadbeef';
  assert.equal(extractCanonicalFingerprint(script), null);
});

// ── Integration: verifyAnchorProof happy path + negative controls ────────────
test('VALID direct-anchor proof passes full SPV (commit+depth+merkle+header+issuer)', async () => {
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer());
  assert.equal(r.verified, true, `expected verified, got reason=${r.reason}`);
  assert.equal(r.checks.fingerprintCommitted, true);
  assert.equal(r.checks.depthOk, true);
  assert.equal(r.checks.merkleIncluded, true);
  assert.equal(r.checks.headerBinds, true);
  assert.equal(r.checks.blockMatch, true);
  assert.equal(r.checks.issuerMatch, true);
  assert.equal(r.reason, null);
});

test('NEGATIVE CONTROL: tampered fingerprint is REJECTED', async () => {
  const r = await verifyAnchorProof(TAMPERED_PROOF, fakeExplorer());
  assert.equal(r.verified, false, 'a tampered proof MUST fail');
  assert.equal(r.checks.fingerprintCommitted, false);
  assert.equal(r.reason, 'fingerprint_not_committed_in_op_return');
});

test('C1 regression: crafted OP_RETURN (ARKV+other-fp+presented-fp) is REJECTED', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  const otherFp = 'a'.repeat(64);
  const presented = VALID_PROOF.fingerprint;
  // ARKV + otherFp(32B) + presentedFp(32B) = 4+32+32 = 68 bytes -> pushbyte 0x44.
  const payload = '41524b56' + otherFp + presented;
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].vout = [{ scriptpubkey: '6a44' + payload, scriptpubkey_type: 'op_return' }];
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  // canonical decode returns otherFp (offset 0), so the presented fp is NOT committed.
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'fingerprint_not_committed_in_op_return');
});

test('M1: a junk OP_RETURN before the real one does not cause a false negative', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].vout = [
    { scriptpubkey: '6a04deadbeef', scriptpubkey_type: 'op_return' }, // junk first
    { scriptpubkey: CONSTANTS.REAL_OP_RETURN_SCRIPT, scriptpubkey_type: 'op_return' },
    { scriptpubkey: '0014' + '00'.repeat(20), scriptpubkey_type: 'v0_p2wpkh' },
  ];
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.verified, true, `expected verified, got ${r.reason}`);
});

test('REJECT: tx not found', async () => {
  const r = await verifyAnchorProof({ ...VALID_PROOF, txid: 'de'.repeat(32) }, fakeExplorer());
  assert.equal(r.reason, 'tx_not_found');
});

test('REJECT: tx unconfirmed', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].status = { ...paths[`tx/${TX}`].status, confirmed: false };
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'tx_unconfirmed');
});

test('REJECT: no OP_RETURN output', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].vout = paths[`tx/${TX}`].vout.filter((v) => v.scriptpubkey_type !== 'op_return');
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'no_op_return');
});

test('REJECT: OP_RETURN present but not a canonical ARKV anchor', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].vout = [{ scriptpubkey: '6a0400000000', scriptpubkey_type: 'op_return' }];
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'no_canonical_arkv_op_return');
});

test('REJECT: insufficient confirmations (reorg floor)', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths['blocks/tip/height'] = String(CONSTANTS.REAL_BLOCK + 2); // only 3 confs
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths), { minConfirmations: 6 });
  assert.equal(r.checks.confirmations, 3);
  assert.equal(r.reason, 'insufficient_confirmations');
});

test('REJECT: merkle proof does not reconstruct the block root (not in block)', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  const mp = clone(FAKE_EXPLORER_PATHS[`tx/${TX}/merkle-proof`]);
  mp.merkle = [...mp.merkle];
  mp.merkle[0] = 'f'.repeat(64); // corrupt a sibling
  paths[`tx/${TX}/merkle-proof`] = mp;
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.checks.merkleIncluded, false);
  assert.equal(r.reason, 'tx_not_in_block');
});

test('REJECT: block header does not hash to the stated block hash', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  // Flip the final nibble of the header nonce (keep length 160) -> different hash.
  const hdr = CONSTANTS.REAL_BLOCK_HEADER.slice(0, -1) + (CONSTANTS.REAL_BLOCK_HEADER.endsWith('4') ? '5' : '4');
  paths[`block/${CONSTANTS.REAL_BLOCK_HASH}/header`] = hdr;
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.checks.headerBinds, false);
  assert.equal(r.reason, 'header_hash_mismatch');
});

test('REJECT: block height mismatch when asserted', async () => {
  const r = await verifyAnchorProof({ ...VALID_PROOF, expectedBlockHeight: 999999 }, fakeExplorer());
  assert.equal(r.reason, 'block_height_mismatch');
});

test('REJECT: unexpected issuer (treasury binding)', async () => {
  const r = await verifyAnchorProof(
    { ...VALID_PROOF, expectedIssuerAddress: 'bc1qWRONGWRONGWRONG' },
    fakeExplorer(),
  );
  assert.equal(r.checks.issuerMatch, false);
  assert.equal(r.reason, 'unexpected_issuer');
});
