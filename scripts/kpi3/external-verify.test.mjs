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
import { createHash } from 'node:crypto';
import {
  verifyAnchorProof,
  computeMerkleRoot,
  extractCanonicalFingerprint,
  parseBlockHeader,
  compactToTarget,
  MAINNET_POW_LIMIT,
  blockstreamFetch,
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

// ── Unit: proof-of-work (SCRUM-2917 review — forge-resistance) ────────────────
test('compactToTarget decodes nBits (0x1d00ffff -> mainnet floor; sign bit -> null)', () => {
  assert.equal(compactToTarget(0x1d00ffff), MAINNET_POW_LIMIT);
  assert.equal(compactToTarget(0x00800000), null); // negative sign bit
  // A real, harder mainnet target is strictly below the floor.
  const realTarget = compactToTarget(Buffer.from(CONSTANTS.REAL_BLOCK_HEADER, 'hex').readUInt32LE(72));
  assert.ok(realTarget > 0n && realTarget < MAINNET_POW_LIMIT, 'real block target below the floor');
});

test('parseBlockHeader: the REAL mainnet header satisfies its own PoW', () => {
  assert.equal(parseBlockHeader(CONSTANTS.REAL_BLOCK_HEADER).powValid, true);
});

// Build an 80-byte header (hex) committing a chosen merkle root (display order),
// with a chosen nBits (stored little-endian) — an attacker's forging primitive.
function buildHeader({ merkleRootDisplay, nbitsLE, version = '00000020', prev = '00'.repeat(32), time = '00000000', nonce = '00000000' }) {
  const mrLE = Buffer.from(merkleRootDisplay, 'hex').reverse().toString('hex');
  return version + prev + mrLE + time + nbitsLE + nonce;
}
const dsha = (hex) => createHash('sha256').update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest();
// A fake explorer built entirely around an attacker-forged header + merkle proof.
function forgedExplorer(headerHex, { fingerprint, txid, height = 800000, tipGap = 10 } = {}) {
  const blockHash = Buffer.from(dsha(headerHex)).reverse().toString('hex');
  const map = {
    [`tx/${txid}`]: {
      txid,
      status: { confirmed: true, block_height: height, block_hash: blockHash },
      vout: [{ scriptpubkey: '6a24' + '41524b56' + fingerprint, scriptpubkey_type: 'op_return' }],
    },
    [`tx/${txid}/merkle-proof`]: { block_height: height, pos: 0, merkle: [] }, // pos 0, no siblings -> root == txid
    [`block/${blockHash}/header`]: headerHex,
    'blocks/tip/height': String(height + tipGap),
  };
  return { fetchPath: async (p) => { if (!(p in map)) { const e = new Error('404'); e.status = 404; throw e; } return map[p]; }, blockHash };
}

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
  assert.equal(r.checks.powValid, true);
  assert.equal(r.checks.blockMatch, true);
  assert.equal(r.checks.issuerMatch, true);
  assert.equal(r.reason, null);
});

test('FORGERY (SCRUM-2917): self-consistent header with a TRIVIAL target is REJECTED', async () => {
  // The zero-cost attack: mint a header committing an attacker-chosen merkle
  // root (== the fake txid, via a pos-0 empty-branch proof) with an absurdly
  // easy nBits (0x207fffff, regtest max) so no mining is needed. Hash + merkle
  // + commit + depth all self-check — only the PoW floor stops it.
  const fingerprint = CONSTANTS.REAL_FINGERPRINT;
  const txid = 'ab'.repeat(32);
  const header = buildHeader({ merkleRootDisplay: txid, nbitsLE: 'ffff7f20' }); // 0x207fffff
  const { fetchPath } = forgedExplorer(header, { fingerprint, txid });
  const r = await verifyAnchorProof({ fingerprint, txid }, fetchPath);
  assert.equal(r.checks.headerBinds, true, 'the forged header IS self-consistent (hash matches)');
  assert.equal(r.checks.powValid, false);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'header_pow_insufficient');
});

test('FORGERY (SCRUM-2917): floor-difficulty header that was never mined is REJECTED', async () => {
  // Harder attack: set nBits to the mainnet floor (0x1d00ffff) so the target is
  // valid, but present an unmined header whose dsha256 does NOT meet the target.
  const fingerprint = CONSTANTS.REAL_FINGERPRINT;
  const txid = 'cd'.repeat(32);
  const header = buildHeader({ merkleRootDisplay: txid, nbitsLE: 'ffff001d', nonce: '2a000000' }); // 0x1d00ffff
  // Sanity: this header does NOT satisfy the floor target (essentially certain).
  assert.equal(parseBlockHeader(header).powValid, false);
  const { fetchPath } = forgedExplorer(header, { fingerprint, txid });
  const r = await verifyAnchorProof({ fingerprint, txid }, fetchPath);
  assert.equal(r.checks.powValid, false);
  assert.equal(r.reason, 'header_pow_insufficient');
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

test('REJECT: malformed txid is rejected before any explorer request', async () => {
  let called = false;
  const spy = async () => { called = true; throw Object.assign(new Error('x'), { status: 404 }); };
  const r = await verifyAnchorProof({ ...VALID_PROOF, txid: '../../evil' }, spy);
  assert.equal(r.reason, 'bad_txid_format');
  assert.equal(called, false, 'must not hit the explorer with a malformed txid');
});

test('REJECT: malformed block_hash from the explorer is rejected before header fetch', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  paths[`tx/${TX}`] = clone(FAKE_EXPLORER_PATHS[`tx/${TX}`]);
  paths[`tx/${TX}`].status = { ...paths[`tx/${TX}`].status, block_hash: 'not-a-hash' };
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'bad_block_hash');
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

test('REJECT: merkle proof reports a different block than the tx status', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  const mp = clone(FAKE_EXPLORER_PATHS[`tx/${TX}/merkle-proof`]);
  mp.block_height = CONSTANTS.REAL_BLOCK + 1; // disagree with status.block_height
  paths[`tx/${TX}/merkle-proof`] = mp;
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'merkle_proof_block_mismatch');
});

test('REJECT: malformed merkle sibling hex fails closed', async () => {
  const paths = clone(FAKE_EXPLORER_PATHS);
  const mp = clone(FAKE_EXPLORER_PATHS[`tx/${TX}/merkle-proof`]);
  mp.merkle = [...mp.merkle];
  mp.merkle[0] = 'zz' + mp.merkle[0].slice(2); // non-hex
  paths[`tx/${TX}/merkle-proof`] = mp;
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(paths));
  assert.equal(r.reason, 'malformed_merkle_proof');
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

// ── blockstreamFetch path allow-list ────────────────────────────────────────
// `blockstreamFetch` is an exported sink: it interpolates its `path` argument
// straight into a network URL. verifyAnchorProof validates txid/block hash
// before calling it, but the sink must also defend itself — any other caller
// (or a future refactor of verifyAnchorProof) could otherwise walk the path
// out of the Esplora API namespace and turn "verify this proof" into a request
// at an attacker-chosen URL. SonarCloud flags exactly this
// (jssecurity:S7044 / S8476).

test('blockstreamFetch: accepts exactly the Esplora paths the verifier uses', async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  const hex64 = 'a'.repeat(64);
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  try {
    const f = blockstreamFetch('https://explorer.test/api');
    await f(`tx/${hex64}`);
    await f(`tx/${hex64}/merkle-proof`);
    await f(`block/${hex64}/header`);
    await f('blocks/tip/height');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [
    `https://explorer.test/api/tx/${hex64}`,
    `https://explorer.test/api/tx/${hex64}/merkle-proof`,
    `https://explorer.test/api/block/${hex64}/header`,
    'https://explorer.test/api/blocks/tip/height',
  ]);
});

test('blockstreamFetch: refuses any path outside the allow-list without issuing a request', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    throw new Error('should never be reached');
  };
  try {
    const f = blockstreamFetch('https://explorer.test/api');
    const bad = [
      'tx/../../../../etc/passwd',
      `tx/${'a'.repeat(63)}`,
      `tx/${'g'.repeat(64)}`,
      `tx/${'A'.repeat(64)}`,
      'https://evil.test/steal',
      '//evil.test/steal',
      'blocks/tip/height?x=1',
      `block/${'a'.repeat(64)}/header/../../evil`,
      '',
    ];
    for (const path of bad) {
      await assert.rejects(
        () => f(path),
        (err) => err instanceof Error && /unsupported explorer path/i.test(err.message),
        `expected rejection for ${JSON.stringify(path)}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, 0, 'no network request may be issued for a rejected path');
});
