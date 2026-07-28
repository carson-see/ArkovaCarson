/**
 * KPI-3 Haki bundle-verifier tests (Lane 1 — Trust & Chain).
 *
 * Proves the bridge routes an Arkova /api/v1/verify/:publicId/proof response
 * honestly:
 *   - batch proof_bundle  → REAL two-layer check: (a) app-tree recompute
 *     (double-SHA256 fold of merkle_proof over the fingerprint — the test
 *     builds a genuine 2-leaf tree so the recompute is real math, not a stub)
 *     then (b) full SPV on the chain layer with fingerprint := merkle_root
 *     (the committed 32 bytes at OP_RETURN [4:36] for a batch tx IS the root).
 *   - direct anchor (no bundle) → honest empty state: SPV on the fingerprint
 *     itself, `bundle: 'none_direct_anchor'`, merkle fields honestly absent.
 *   - neither → `unverifiable_missing_inputs`, never a fake pass.
 *
 * Deterministic + offline: chain layer uses injected path->response maps
 * (the #1611 fixtures for the direct path — a REAL mainnet block that meets its
 * own PoW; a synthetic single-tx block for the batch path, MINED to an easy
 * target (nBits 0x207fffff, ~2 nonce tries) so it genuinely satisfies the PoW
 * check, with the batch calls passing an accept-any `powLimit` since the
 * synthetic difficulty is below the mainnet floor). Full SPV, zero network.
 * Run: node --test scripts/kpi3/haki-bundle-verify.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeAppTreeRoot, verifyHakiBundle } from './haki-bundle-verify.mjs';
import { VALID_PROOF, TAMPERED_PROOF, fakeExplorer, CONSTANTS } from './fixtures.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const dsha256 = (buf) => sha256(sha256(buf));
const hex = (buf) => Buffer.from(buf).toString('hex');

// ── Build a REAL 2-leaf app tree (double-SHA256, mirrors utils/merkle.ts) ────
const LEAF_A = hex(sha256(Buffer.from('haki-doc-A'))); // our document fingerprint
const LEAF_B = hex(sha256(Buffer.from('haki-doc-B'))); // its sibling leaf
const APP_ROOT = hex(dsha256(Buffer.concat([Buffer.from(LEAF_A, 'hex'), Buffer.from(LEAF_B, 'hex')])));
// Inclusion branch for LEAF_A (index 0 of 2): sibling LEAF_B sits on the RIGHT.
const APP_BRANCH = [{ hash: LEAF_B, position: 'right' }];

// ── Build a synthetic single-tx Bitcoin block committing ARKV||APP_ROOT ──────
// Single-tx block: the Bitcoin merkle root IS the txid, so an empty Esplora
// merkle-proof ({merkle: [], pos: 0}) recomputes it — full SPV, zero network.
const BATCH_TXID = hex(dsha256(Buffer.from('haki-batch-tx')));
const BATCH_BLOCK = 960000;
// Accept-any PoW floor for the synthetic (below-mainnet-difficulty) batch block.
const ANY_POW = (1n << 256n) - 1n;
// nBits 0x207fffff (regtest max) → an easy but non-trivial target we can mine in
// ~2 tries, so the synthetic header genuinely satisfies its own PoW.
const EASY_BITS_LE = 'ffff7f20';
const EASY_TARGET = 0x7fffffn << 232n; // == compactToTarget(0x207fffff)
// 80-byte header: version(4) ‖ prev(32) ‖ merkle_root(32 = txid, internal LE
// byte order) ‖ time(4) ‖ bits(4) ‖ nonce(4). parseBlockHeader reads bytes
// [36:68] reversed → display-order root == BATCH_TXID. We grind the nonce until
// the header's double-SHA256 falls at or below EASY_TARGET (real, if tiny, PoW).
function mineHeader(merkleRootDisplay) {
  const prefix = Buffer.concat([
    Buffer.from('00c00520', 'hex'),
    Buffer.alloc(32),
    Buffer.from(merkleRootDisplay, 'hex').reverse(),
    Buffer.from('7aed1d6a', 'hex'),
    Buffer.from(EASY_BITS_LE, 'hex'),
  ]);
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const nb = Buffer.alloc(4);
    nb.writeUInt32LE(nonce);
    const header = Buffer.concat([prefix, nb]);
    if (BigInt('0x' + hex(Buffer.from(dsha256(header)).reverse())) <= EASY_TARGET) return hex(header);
  }
  throw new Error('mineHeader: no nonce satisfied the easy target (should be ~2 tries)');
}
const BATCH_HEADER = mineHeader(BATCH_TXID);
const BATCH_BLOCK_HASH = hex(Buffer.from(dsha256(Buffer.from(BATCH_HEADER, 'hex'))).reverse());
// Canonical batch commitment: OP_RETURN <push 36B: ARKV ‖ app-tree root>.
const BATCH_OP_RETURN = '6a24' + '41524b56' + APP_ROOT;
const BATCH_TREASURY = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

const BATCH_EXPLORER_PATHS = {
  [`tx/${BATCH_TXID}`]: {
    txid: BATCH_TXID,
    status: { confirmed: true, block_height: BATCH_BLOCK, block_hash: BATCH_BLOCK_HASH },
    vin: [{ prevout: { scriptpubkey_address: BATCH_TREASURY } }],
    vout: [
      { scriptpubkey: BATCH_OP_RETURN, scriptpubkey_type: 'op_return' },
      { scriptpubkey: '0014' + '00'.repeat(20), scriptpubkey_type: 'v0_p2wpkh', value: 546 },
    ],
  },
  [`tx/${BATCH_TXID}/merkle-proof`]: { block_height: BATCH_BLOCK, pos: 0, merkle: [] },
  [`block/${BATCH_BLOCK_HASH}/header`]: BATCH_HEADER,
  'blocks/tip/height': String(BATCH_BLOCK + 999),
};

/** A complete proof_bundle exactly as GET /verify/:publicId/proof emits it. */
function makeBundle(overrides = {}) {
  return {
    fingerprint: LEAF_A,
    merkle_root: APP_ROOT,
    merkle_proof: APP_BRANCH,
    merkle_index: 0,
    leaf_count: 2,
    tx_id: BATCH_TXID,
    block_height: BATCH_BLOCK,
    block_hash: BATCH_BLOCK_HASH,
    block_header: BATCH_HEADER,
    op_return_payload: '41524b56' + APP_ROOT,
    block_timestamp: '2026-07-19T03:00:00Z',
    proof_schema_version: 1,
    signature: null,
    ...overrides,
  };
}

function makeResponse(bundle) {
  return {
    public_id: 'ARK-2026-BATCH0001',
    fingerprint: LEAF_A,
    merkle_root: APP_ROOT,
    merkle_proof: APP_BRANCH,
    tx_id: BATCH_TXID,
    block_height: BATCH_BLOCK,
    block_timestamp: '2026-07-19T03:00:00Z',
    batch_id: 'b-0001',
    verified: true,
    proof_bundle: bundle,
  };
}

/** The endpoint's honest 404 body for a record with no batch proof. */
const NO_BATCH_PROOF_404 = {
  error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
  proof_error_code: 'NO_BATCH_PROOF',
};

// ── Unit: app-tree recompute is real double-SHA256 math ──────────────────────
test('computeAppTreeRoot recomputes a real 2-leaf tree (sibling right)', () => {
  const r = computeAppTreeRoot(LEAF_A, APP_BRANCH);
  assert.equal(r.root, APP_ROOT);
});

test('computeAppTreeRoot: sibling-left ordering is respected', () => {
  // LEAF_B at index 1: sibling LEAF_A sits on the LEFT — same root.
  const r = computeAppTreeRoot(LEAF_B, [{ hash: LEAF_A, position: 'left' }]);
  assert.equal(r.root, APP_ROOT);
});

test('computeAppTreeRoot: empty branch means single-leaf tree (root == leaf)', () => {
  const r = computeAppTreeRoot(LEAF_A, []);
  assert.equal(r.root, LEAF_A);
});

test('computeAppTreeRoot: malformed sibling hex fails closed', () => {
  const r = computeAppTreeRoot(LEAF_A, [{ hash: 'zz'.repeat(32), position: 'right' }]);
  assert.equal(r.root, null);
});

test('computeAppTreeRoot: CVE-2012-2459 forged self-pair rejected when index+count known', () => {
  // Sibling == running hash at index 0 of an even (2-leaf) level: never a
  // legitimate Bitcoin-convention duplication.
  const r = computeAppTreeRoot(LEAF_A, [{ hash: LEAF_A, position: 'right' }], { leafIndex: 0, leafCount: 2 });
  assert.equal(r.root, null);
  assert.match(r.reason, /self-pair/);
});

// ── Batch bundle: two-layer verification ─────────────────────────────────────
test('BATCH happy path: app-tree recompute + full SPV on merkle_root both pass', async () => {
  const r = await verifyHakiBundle(makeResponse(makeBundle()), { powLimit: ANY_POW }, fakeExplorer(BATCH_EXPLORER_PATHS));
  assert.equal(r.verified, true, `expected verified, got verdict=${r.verdict} reason=${JSON.stringify(r)}`);
  assert.equal(r.verdict, 'verified');
  assert.equal(r.mode, 'batch_bundle');
  assert.equal(r.bundle, 'batch');
  assert.equal(r.failed_layer, null);
  assert.equal(r.app_tree.match, true);
  assert.equal(r.app_tree.recomputed_root, APP_ROOT);
  // Chain layer ran real SPV with fingerprint := merkle_root.
  assert.equal(r.chain.verified, true);
  assert.equal(r.chain.checks.fingerprintCommitted, true);
  assert.equal(r.chain.checks.merkleIncluded, true);
  assert.equal(r.chain.checks.headerBinds, true);
});

test('BATCH: app-tree mismatch fails layer (a); chain layer not evaluated', async () => {
  // Tamper the branch sibling — recomputed root will not match merkle_root.
  const bundle = makeBundle({ merkle_proof: [{ hash: 'f'.repeat(64), position: 'right' }] });
  const r = await verifyHakiBundle(makeResponse(bundle), {}, fakeExplorer(BATCH_EXPLORER_PATHS));
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'failed_app_tree');
  assert.equal(r.failed_layer, 'app_tree');
  assert.equal(r.app_tree.match, false);
  assert.equal(r.chain, null, 'chain layer must not run when the app-tree layer already failed');
});

test('BATCH: tampered fingerprint fails the app-tree layer', async () => {
  const bundle = makeBundle({ fingerprint: LEAF_A.slice(0, -1) + (LEAF_A.endsWith('0') ? '1' : '0') });
  const r = await verifyHakiBundle(makeResponse(bundle), {}, fakeExplorer(BATCH_EXPLORER_PATHS));
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'failed_app_tree');
});

test('BATCH: chain-layer failure surfaces as failed_chain with the SPV reason', async () => {
  // App tree is intact; the on-chain block height disagrees with the bundle.
  const bundle = makeBundle({ block_height: BATCH_BLOCK + 1 });
  const r = await verifyHakiBundle(makeResponse(bundle), { powLimit: ANY_POW }, fakeExplorer(BATCH_EXPLORER_PATHS));
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'failed_chain');
  assert.equal(r.failed_layer, 'chain');
  assert.equal(r.app_tree.match, true, 'app-tree layer passed; only the chain layer failed');
  assert.equal(r.chain.reason, 'block_height_mismatch');
});

test('BATCH: on-chain commitment of a DIFFERENT root fails the chain layer', async () => {
  // The explorer serves a tx committing ARKV||other-root: layer (b) must reject.
  const paths = structuredClone(BATCH_EXPLORER_PATHS);
  paths[`tx/${BATCH_TXID}`].vout[0].scriptpubkey = '6a24' + '41524b56' + 'a'.repeat(64);
  const r = await verifyHakiBundle(makeResponse(makeBundle()), {}, fakeExplorer(paths));
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'failed_chain');
  assert.equal(r.chain.reason, 'fingerprint_not_committed_in_op_return');
});

// ── Direct anchors: the honest empty state ───────────────────────────────────
test('DIRECT: --direct with fingerprint+txid passes via SPV; bundle is honestly none', async () => {
  const r = await verifyHakiBundle(
    null,
    { direct: true, fingerprint: VALID_PROOF.fingerprint, txid: VALID_PROOF.txid, expectedBlockHeight: VALID_PROOF.expectedBlockHeight },
    fakeExplorer(),
  );
  assert.equal(r.verified, true, `expected verified, got ${JSON.stringify(r)}`);
  assert.equal(r.mode, 'direct_anchor');
  assert.equal(r.bundle, 'none_direct_anchor');
  assert.equal(r.app_tree, null, 'merkle fields are honestly absent for a direct anchor');
  assert.equal(r.chain.checks.fingerprintCommitted, true);
  assert.ok(r.notes.some((n) => /honestly absent/.test(n)), 'output must state the empty state is honest');
});

test('DIRECT: NO_BATCH_PROOF 404 + fingerprint + txid routes to the direct path', async () => {
  const r = await verifyHakiBundle(
    NO_BATCH_PROOF_404,
    { fingerprint: VALID_PROOF.fingerprint, txid: VALID_PROOF.txid },
    fakeExplorer(),
  );
  assert.equal(r.verified, true);
  assert.equal(r.mode, 'direct_anchor');
  assert.equal(r.bundle, 'none_direct_anchor');
});

test('DIRECT: response with null proof_bundle + inputs routes to the direct path', async () => {
  const resp = makeResponse(null);
  resp.fingerprint = VALID_PROOF.fingerprint;
  resp.tx_id = VALID_PROOF.txid;
  resp.block_height = VALID_PROOF.expectedBlockHeight; // response fields must be self-consistent
  const r = await verifyHakiBundle(resp, {}, fakeExplorer());
  assert.equal(r.mode, 'direct_anchor');
  assert.equal(r.bundle, 'none_direct_anchor');
  assert.equal(r.verified, true);
});

test('DIRECT NEGATIVE CONTROL: tampered fingerprint is REJECTED', async () => {
  const r = await verifyHakiBundle(
    NO_BATCH_PROOF_404,
    { fingerprint: TAMPERED_PROOF.fingerprint, txid: TAMPERED_PROOF.txid },
    fakeExplorer(),
  );
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'failed_chain');
  assert.equal(r.chain.reason, 'fingerprint_not_committed_in_op_return');
});

// ── Missing inputs: never a fake pass ────────────────────────────────────────
test('UNVERIFIABLE: no bundle and no fingerprint/txid — precise missing list, no fabrication', async () => {
  const r = await verifyHakiBundle(NO_BATCH_PROOF_404, {}, fakeExplorer());
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'unverifiable_missing_inputs');
  assert.equal(r.bundle, null);
  assert.deepEqual(r.missing.sort(), ['fingerprint', 'txid']);
  assert.ok(r.notes.some((n) => /NOT asserted/.test(n)), 'must state that nothing is asserted');
});

test('UNVERIFIABLE: fingerprint without txid lists exactly what is missing', async () => {
  const r = await verifyHakiBundle(NO_BATCH_PROOF_404, { fingerprint: VALID_PROOF.fingerprint }, fakeExplorer());
  assert.equal(r.verdict, 'unverifiable_missing_inputs');
  assert.deepEqual(r.missing, ['txid']);
});

test('UNVERIFIABLE: malformed (non-64-hex) inputs are missing, not "close enough"', async () => {
  const r = await verifyHakiBundle(
    NO_BATCH_PROOF_404,
    { fingerprint: 'not-hex', txid: '../../evil' },
    fakeExplorer(),
  );
  assert.equal(r.verdict, 'unverifiable_missing_inputs');
  assert.deepEqual(r.missing.sort(), ['fingerprint', 'txid']);
});

test('UNVERIFIABLE: incomplete bundle (null tx_id) does not fake a chain layer', async () => {
  // The endpoint never emits a bundle without tx_id, but the bridge must still
  // fail closed if handed one — no synthesized receipt.
  const r = await verifyHakiBundle(makeResponse(makeBundle({ tx_id: null })), {}, fakeExplorer(BATCH_EXPLORER_PATHS));
  assert.equal(r.verified, false);
  assert.equal(r.verdict, 'unverifiable_missing_inputs');
  assert.ok(r.missing.includes('txid'));
});
