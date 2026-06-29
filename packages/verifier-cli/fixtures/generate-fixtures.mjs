#!/usr/bin/env node
/**
 * Generate `synthetic-vectors.json` — self-describing conformance fixtures for
 * the standalone verifier CLI. PROOF-08's real golden vectors land separately;
 * these local synthetic vectors keep the suite green and fully offline.
 *
 * Each fixture carries:
 *   - a proof packet (canonical bundle shape: fingerprint, merkle_root,
 *     merkle_proof[{hash,position}], tx_id, block_height, block_timestamp,
 *     merkle_index, leaf_count, op_return_payload = ARKV‖root no version byte),
 *   - the EXACT independent-node REST responses `@arkova/verifier`'s
 *     confirmInclusion requests (`/tx/:txid`, `/block-height/:h`,
 *     `/block/:hash/header`, `/tx/:txid/merkle-proof`), built with REAL
 *     double-SHA256 headers + inclusion proofs so the on-chain path is exercised
 *     for real (not stubbed),
 *   - the expected verdict.
 *
 * The OP_RETURN is the canonical `OP_RETURN <push> ARKV(4)‖root(32)` — the same
 * structure services/worker/src/chain/signet.ts writes and #1349 decodes at a
 * fixed byte offset. NO `6a20<root>` (the old, wrong, prefix-less form).
 *
 * Run: `node fixtures/generate-fixtures.mjs` (re-emits synthetic-vectors.json).
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ARKV = Buffer.from('ARKV');

const sha256 = (b) => createHash('sha256').update(b).digest();
const dsha256 = (b) => sha256(sha256(b));

/** 32-byte value as 64-char display hex, deterministic from a seed string. */
function h32(seed) {
  return sha256(Buffer.from(seed)).toString('hex');
}

/** Canonical OP_RETURN scriptPubKey hex: OP_RETURN <push len> ARKV‖root[‖meta]. */
function opReturnScript(rootHex, metaHex = '') {
  const payload = Buffer.concat([
    ARKV,
    Buffer.from(rootHex, 'hex'),
    metaHex ? Buffer.from(metaHex, 'hex') : Buffer.alloc(0),
  ]);
  return Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString('hex');
}

/** The canonical published op_return_payload (ARKV‖root, display hex, no version byte). */
function opReturnPayload(rootHex) {
  return Buffer.concat([ARKV, Buffer.from(rootHex, 'hex')]).toString('hex');
}

// ── App Merkle tree (fingerprint → root), matching services/worker/src/utils/merkle.ts:
//    plain double-SHA256 over positional concat, last node duplicated on odd levels. ──
function buildAppTree(leavesHex) {
  const levels = [leavesHex.map((h) => Buffer.from(h, 'hex'))];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : cur[i]; // odd → duplicate last
      next.push(dsha256(Buffer.concat([left, right])));
    }
    levels.push(next);
  }
  return levels;
}

/** Inclusion branch for leaf `index`: [{ hash, position }] from leaf up to root. */
function appProof(levels, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = sibIdx < level.length ? level[sibIdx] : level[idx]; // self-pair on odd tail
    // position = where the SIBLING sits relative to the running hash.
    proof.push({ hash: sibling.toString('hex'), position: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ── Bitcoin block merkle tree over txids (display hex), Esplora proof shape. ──
function buildTxTree(txidsHex, targetIndex) {
  let level = txidsHex.map((h) => Buffer.from(Buffer.from(h, 'hex').reverse())); // → internal LE
  const merkle = [];
  let idx = targetIndex;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      if (i === idx - (idx % 2)) {
        const sibling = idx % 2 === 0 ? right : left;
        merkle.push(Buffer.from(sibling).reverse().toString('hex')); // → display hex
      }
      next.push(dsha256(Buffer.concat([left, right])));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  const rootHex = Buffer.from(level[0]).reverse().toString('hex');
  return { rootHex, merkle, pos: targetIndex };
}

/** Real 80-byte header committing to `txMerkleRootHex` (display hex). */
function buildHeader(txMerkleRootHex, time, nonce = 0) {
  const header = Buffer.alloc(80);
  header.writeInt32LE(0x20000000, 0);
  Buffer.from(txMerkleRootHex, 'hex').reverse().copy(header, 36);
  header.writeUInt32LE(time, 68);
  header.writeUInt32LE(0x1d00ffff, 72);
  header.writeUInt32LE(nonce, 76);
  return header.toString('hex');
}
const blockHashOf = (headerHex) =>
  Buffer.from(dsha256(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');

/**
 * Build the independent-node REST responses for an anchor tx carrying
 * `opReturnRootHex` in its OP_RETURN, mined at `targetIndex` among `otherTxids`
 * at `height` / `time`. Returns { node, blockHash }.
 */
function buildNode({ txId, opReturnRootHex, otherTxids, targetIndex, height, time }) {
  const txids = [...otherTxids];
  txids.splice(targetIndex, 0, txId);
  const { rootHex: txMerkleRoot, merkle, pos } = buildTxTree(txids, targetIndex);
  const headerHex = buildHeader(txMerkleRoot, time);
  const blockHash = blockHashOf(headerHex);

  const tx = {
    txid: txId,
    status: { confirmed: true, block_height: height, block_hash: blockHash },
    vout: [
      { scriptpubkey: '0014' + '11'.repeat(20), scriptpubkey_type: 'v0_p2wpkh' },
      { scriptpubkey: opReturnScript(opReturnRootHex), scriptpubkey_type: 'op_return' },
    ],
  };

  const node = {
    [`/tx/${txId}`]: tx,
    [`/block-height/${height}`]: blockHash,
    [`/block/${blockHash}/header`]: headerHex,
    [`/tx/${txId}/merkle-proof`]: { block_height: height, merkle, pos },
  };
  return { node, blockHash };
}

// ──────────────────────────────────────────────────────────────────────────
// Compose the fixture set.
// ──────────────────────────────────────────────────────────────────────────

const ISO = (epoch) => new Date(epoch * 1000).toISOString();
const fixtures = [];

// 1. odd-leaf-pass — 3-leaf app tree, rightmost leaf (index 2) self-pairs
//    legitimately; full on-chain confirmation passes.
{
  const leaves = [h32('odd-a'), h32('odd-b'), h32('odd-c')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const idx = 2;
  const time = 1735689600;
  const { node } = buildNode({
    txId: h32('odd-tx'),
    opReturnRootHex: root,
    otherTxids: [h32('odd-sib1')],
    targetIndex: 0,
    height: 812345,
    time,
  });
  fixtures.push({
    name: 'odd-leaf-pass',
    description:
      'Odd (3) leaf app tree, rightmost leaf index 2 self-pairs legitimately; canonical ARKV‖root OP_RETURN; full independent on-chain confirmation passes.',
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: h32('odd-tx'),
      block_height: 812345,
      block_timestamp: ISO(time),
      batch_id: 'batch-odd-3',
      merkle_index: idx,
      leaf_count: 3,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: true },
  });
}

// 2. single-leaf-pass — single-leaf tree (empty branch), root == fingerprint.
{
  const fp = h32('single');
  const root = fp;
  const time = 1717200000;
  const { node } = buildNode({
    txId: h32('single-tx'),
    opReturnRootHex: root,
    otherTxids: [],
    targetIndex: 0,
    height: 799000,
    time,
  });
  fixtures.push({
    name: 'single-leaf-pass',
    description:
      'Single-leaf tree (empty branch): root equals the fingerprint; single-tx block; on-chain confirmation passes.',
    packet: {
      fingerprint: fp,
      merkle_root: root,
      merkle_proof: [],
      tx_id: h32('single-tx'),
      block_height: 799000,
      block_timestamp: ISO(time),
      batch_id: null,
      merkle_index: 0,
      leaf_count: 1,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: true },
  });
}

// 3. deep-leaf-pass — 5-leaf app tree, leaf index 4; full confirmation passes.
{
  const leaves = [0, 1, 2, 3, 4].map((i) => h32(`deep-${i}`));
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const idx = 4;
  const time = 1738368000;
  const { node } = buildNode({
    txId: h32('deep-tx'),
    opReturnRootHex: root,
    otherTxids: [h32('deep-sib1'), h32('deep-sib2')],
    targetIndex: 1,
    height: 820000,
    time,
  });
  fixtures.push({
    name: 'deep-leaf-pass',
    description: 'Deeper (5) leaf app tree, leaf index 4; full independent on-chain confirmation passes.',
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: h32('deep-tx'),
      block_height: 820000,
      block_timestamp: ISO(time),
      batch_id: 'batch-5',
      merkle_index: idx,
      leaf_count: 5,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: true },
  });
}

// 4. tampered-fingerprint-fail — fingerprint not in the published root; recompute fails.
{
  const leaves = [h32('odd-a'), h32('odd-b'), h32('odd-c')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const time = 1735689600;
  const { node } = buildNode({
    txId: h32('odd-tx'),
    opReturnRootHex: root,
    otherTxids: [h32('odd-sib1')],
    targetIndex: 0,
    height: 812345,
    time,
  });
  fixtures.push({
    name: 'tampered-fingerprint-fail',
    description:
      'Fingerprint does not belong to the published root; recompute must fail and the overall verdict is NOT VERIFIED.',
    packet: {
      fingerprint: h32('tampered-not-in-tree'),
      merkle_root: root,
      merkle_proof: appProof(levels, 2),
      tx_id: h32('odd-tx'),
      block_height: 812345,
      block_timestamp: ISO(time),
      batch_id: 'batch-odd-3',
      merkle_index: 2,
      leaf_count: 3,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: false, reasonIncludes: 'recomputed root' },
  });
}

// 5. forged-self-pair-fail — CVE-2012-2459: a self-pair at a NON-duplicated
//    position with merkle_index + leaf_count supplied; the structural guard rejects.
{
  const leaf = h32('forge-leaf');
  // running hash after step 1 self-pairs with itself again at index 0 of a
  // 4-leaf tree (a non-rightmost-odd position) — the guard must reject.
  const lvl1 = dsha256(Buffer.concat([Buffer.from(leaf, 'hex'), Buffer.from(leaf, 'hex')]));
  const root = dsha256(Buffer.concat([lvl1, lvl1])).toString('hex');
  fixtures.push({
    name: 'forged-self-pair-fail',
    description:
      'CVE-2012-2459 forged inclusion: a self-pair presented at a non-duplicated position with leaf index+count supplied; the structural guard must reject (no chain needed).',
    packet: {
      fingerprint: leaf,
      merkle_root: root,
      merkle_proof: [
        { hash: leaf, position: 'right' },
        { hash: lvl1.toString('hex'), position: 'right' },
      ],
      tx_id: null,
      block_height: null,
      block_timestamp: null,
      batch_id: 'batch-4',
      merkle_index: 0,
      leaf_count: 4,
      op_return_payload: null,
      verified: false,
    },
    expect: { ok: false, reasonIncludes: 'CVE-2012-2459' },
  });
}

// 6. wrong-root-onchain-fail — recompute passes, but the receipt's OP_RETURN
//    commits a DIFFERENT root; confirmInclusion → payload_mismatch.
{
  const leaves = [h32('w-a'), h32('w-b')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const wrongRoot = h32('a-completely-different-root');
  const idx = 0;
  const time = 1735689600;
  const { node } = buildNode({
    txId: h32('wrong-tx'),
    opReturnRootHex: wrongRoot, // ← receipt commits the WRONG root
    otherTxids: [h32('wrong-sib1')],
    targetIndex: 0,
    height: 812345,
    time,
  });
  fixtures.push({
    name: 'wrong-root-onchain-fail',
    description:
      'Recompute passes but the independent node receipt commits a DIFFERENT root; the on-chain payload step must fail.',
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: h32('wrong-tx'),
      block_height: 812345,
      block_timestamp: ISO(time),
      batch_id: 'batch-2',
      merkle_index: idx,
      leaf_count: 2,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: false, reasonIncludes: 'does NOT commit' },
  });
}

// 7. txid-mismatch-fail (Carson #1353 verify.ts:173) — the node serves, at the
//    requested /tx/<packet.tx_id> path, a tx + inclusion proof that actually
//    belong to a DIFFERENT transaction. Because confirmInclusion binds the
//    inclusion proof to packet.tx_id, the proof recomputes to the wrong value
//    and the receipt is NOT VERIFIED. A mismatched tx body cannot verify.
{
  const leaves = [h32('m-a'), h32('m-b')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const idx = 0;
  const time = 1735689600;
  const claimedTxId = h32('claimed-tx'); // what the packet asserts
  const realTxId = h32('some-other-tx'); // the tx actually in the block

  // Mine a block around realTxId carrying the right OP_RETURN, then re-key its
  // tx + merkle-proof responses under the CLAIMED txid path. The proof's leaf is
  // realTxId, so recompute bound to claimedTxId fails.
  const built = buildNode({
    txId: realTxId,
    opReturnRootHex: root,
    otherTxids: [h32('m-sib1'), h32('m-sib2')],
    targetIndex: 1,
    height: 812345,
    time,
  });
  const realTx = built.node[`/tx/${realTxId}`];
  const realProof = built.node[`/tx/${realTxId}/merkle-proof`];
  const blockHash = built.blockHash;
  const node = {
    // The node lies: it answers the claimed-txid path with the OTHER tx's body.
    [`/tx/${claimedTxId}`]: { ...realTx, txid: claimedTxId },
    [`/block-height/812345`]: blockHash,
    [`/block/${blockHash}/header`]: built.node[`/block/${blockHash}/header`],
    [`/tx/${claimedTxId}/merkle-proof`]: realProof,
  };
  fixtures.push({
    name: 'txid-mismatch-fail',
    description:
      'The independent node serves a tx + inclusion proof for a DIFFERENT transaction under the claimed txid path; confirmInclusion binds the proof to packet.tx_id, so the receipt is NOT VERIFIED (Carson #1353 verify.ts:173 txid-binding regression).',
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: claimedTxId,
      block_height: 812345,
      block_timestamp: ISO(time),
      batch_id: 'batch-mismatch',
      merkle_index: idx,
      leaf_count: 2,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: false, reasonIncludes: 'inclusion proof' },
  });
}

// 8. txid-body-mismatch-fail (Carson #1353 2nd-pass) — exercises the
//    TXID-BINDING GUARD itself (independent-node.ts:160). The #7 fixture above is
//    WEAK for the guard: it re-keys the body's `txid` field BACK to the requested
//    txid (`{ ...realTx, txid: claimedTxId }`), so the body's self-identity
//    MATCHES the request and the guard never fires — #7 only trips the later
//    inclusion-proof recompute. Here the node answers `/tx/<requested>` with a
//    body whose `txid` field is a DIFFERENT value (otherwise valid: confirmed,
//    in a block, carrying the canonical ARKV‖root OP_RETURN). The guard must
//    reject on identity BEFORE reading status/vout → txid_mismatch → NOT VERIFIED.
{
  const leaves = [h32('bm-a'), h32('bm-b')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const idx = 0;
  const time = 1735689600;
  const requestedTxId = h32('bm-requested'); // what the packet asserts (we ask for this)
  const otherTxId = h32('bm-other-identity'); // the identity the body falsely carries

  // Build a fully valid anchor block for `requestedTxId` (right OP_RETURN, real
  // header + inclusion proof). Then serve, at the requested path, a body whose
  // `txid` field is `otherTxId` — every other field is the genuine, verifiable
  // body. The guard binds the body to its cryptographic identity (txid) and must
  // reject the swap before extracting the planted OP_RETURN root.
  const built = buildNode({
    txId: requestedTxId,
    opReturnRootHex: root,
    otherTxids: [h32('bm-sib1')],
    targetIndex: 0,
    height: 812345,
    time,
  });
  const genuineTx = built.node[`/tx/${requestedTxId}`];
  const blockHash = built.blockHash;
  const node = {
    // The node lies about the body's OWN identity: same valid body, wrong txid.
    [`/tx/${requestedTxId}`]: { ...genuineTx, txid: otherTxId },
    [`/block-height/812345`]: blockHash,
    [`/block/${blockHash}/header`]: built.node[`/block/${blockHash}/header`],
    [`/tx/${requestedTxId}/merkle-proof`]: built.node[`/tx/${requestedTxId}/merkle-proof`],
  };
  fixtures.push({
    name: 'txid-body-mismatch-fail',
    description:
      "The independent node returns, at the requested receipt path, a body whose own txid field is a DIFFERENT value (otherwise valid + carrying ARKV‖root). The txid-binding guard (independent-node.ts:160) rejects on identity BEFORE reading status/vout, so the planted root is never trusted → NOT VERIFIED (Carson #1353 2nd-pass; the #7 fixture never exercised this body-mismatch path).",
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: requestedTxId,
      block_height: 812345,
      block_timestamp: ISO(time),
      batch_id: 'batch-body-mismatch',
      merkle_index: idx,
      leaf_count: 2,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: false, reasonIncludes: 'does NOT identify as the requested receipt' },
  });
}

// 9. forged-timestamp-fail (Carson #1353 2nd-pass, §1.5 timestamp honesty) — the
//    on-chain inclusion is genuine (recompute + OP_RETURN + block all pass), but
//    the packet's claimed `block_timestamp` is a DIFFERENT instant from the time
//    MEASURED off the 80-byte header the independent node served. The verifier
//    must report the header-MEASURED time as the Network Observed Time, flag the
//    divergence, and FAIL the verdict — a forged packet time must never be
//    silently presented as node-observed.
{
  const leaves = [h32('ts-a'), h32('ts-b'), h32('ts-c')];
  const levels = buildAppTree(leaves);
  const root = levels[levels.length - 1][0].toString('hex');
  const idx = 1;
  const headerTime = 1735689600; // the REAL time baked into the header bytes
  const forgedClaim = headerTime + 86400; // packet lies: claims +24h
  const { node } = buildNode({
    txId: h32('ts-tx'),
    opReturnRootHex: root,
    otherTxids: [h32('ts-sib1')],
    targetIndex: 0,
    height: 815000,
    time: headerTime,
  });
  fixtures.push({
    name: 'forged-timestamp-fail',
    description:
      "On-chain inclusion is genuine, but the packet's claimed block_timestamp differs from the time measured off the independent header. The verifier reports the header-measured Network Observed Time, flags the mismatch, and FAILS the verdict (Carson #1353 2nd-pass §1.5 timestamp honesty).",
    packet: {
      fingerprint: leaves[idx],
      merkle_root: root,
      merkle_proof: appProof(levels, idx),
      tx_id: h32('ts-tx'),
      block_height: 815000,
      block_timestamp: ISO(forgedClaim), // ← forged: not the header time
      batch_id: 'batch-ts-3',
      merkle_index: idx,
      leaf_count: 3,
      op_return_payload: opReturnPayload(root),
      verified: true,
    },
    node,
    expect: { ok: false, reasonIncludes: 'Time MISMATCH' },
  });
}

const out = {
  schema_version: 2,
  source:
    'PROOF-07 local synthetic vectors (PROOF-08 golden vectors pending). Generated by fixtures/generate-fixtures.mjs — canonical ARKV‖root OP_RETURN, real headers + inclusion proofs, Esplora REST shape.',
  fixtures,
};
writeFileSync(join(here, 'synthetic-vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${fixtures.length} fixtures to synthetic-vectors.json`);
