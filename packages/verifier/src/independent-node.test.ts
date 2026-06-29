import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  confirmInclusion,
  type IndependentNodeFetch,
  type EsploraTx,
} from './independent-node.js';

// ──────────────────────────────────────────────────────────────────────────
// Test helpers — build a faithful, in-memory Esplora-shaped node. NO real
// network (CLAUDE.md §1.7). We construct real double-SHA256 Merkle trees and
// real 80-byte headers so the verifier's recompute path is exercised for real.
// ──────────────────────────────────────────────────────────────────────────

const ARKV = Buffer.from('ARKV'); // OP_RETURN prefix (services/worker/src/chain/signet.ts)

function sha256(b: Buffer): Buffer {
  return createHash('sha256').update(b).digest();
}
function dsha256(b: Buffer): Buffer {
  return sha256(sha256(b));
}

/** A 32-byte fingerprint as 64-char display hex. */
function fp(seed: number): string {
  return Buffer.alloc(32, seed).toString('hex');
}

/** Build the canonical OP_RETURN scriptPubKey hex: OP_RETURN <push len><ARKV||fingerprint[||meta]>. */
function opReturnScript(fingerprintHex: string, metaHex = ''): string {
  const payload = Buffer.concat([
    ARKV,
    Buffer.from(fingerprintHex, 'hex'),
    metaHex ? Buffer.from(metaHex, 'hex') : Buffer.alloc(0),
  ]);
  // 0x6a = OP_RETURN, then a single direct push of payload.length bytes.
  return Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString('hex');
}

/**
 * Bitcoin-style merkle tree over leaf txids (display hex). Returns the root
 * (display hex) and a merkle-proof (Esplora shape: `{ merkle: hex[], pos }`)
 * for the leaf at `targetIndex`. Internal hashing is on byte-reversed (LE)
 * txids per Bitcoin convention; siblings returned as display hex (Esplora).
 */
function buildTree(txidsHex: string[], targetIndex: number): { rootHex: string; merkle: string[]; pos: number } {
  let level: Buffer[] = txidsHex.map((h) => Buffer.from(Buffer.from(h, 'hex').reverse())); // → internal LE
  const merkle: string[] = [];
  let idx = targetIndex;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // odd → duplicate
      if (i === (idx - (idx % 2))) {
        // sibling of the target at this level
        const sibling = idx % 2 === 0 ? right : left;
        merkle.push(Buffer.from(sibling).reverse().toString('hex')); // → display hex
      }
      next.push(dsha256(Buffer.concat([left, right])));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  const rootHex = Buffer.from(level[0]!).reverse().toString('hex'); // → display hex
  return { rootHex, merkle, pos: targetIndex };
}

/** Build a real 80-byte header committing to `merkleRootHex` (display hex). */
function buildHeader(merkleRootHex: string, nonce = 0): string {
  const header = Buffer.alloc(80);
  header.writeInt32LE(0x20000000, 0); // version
  // [4,36) prev block hash — zeros are fine for the test
  Buffer.from(merkleRootHex, 'hex').reverse().copy(header, 36); // merkleroot LE at [36,68)
  header.writeUInt32LE(1_700_000_000, 68); // time
  header.writeUInt32LE(0x1d00ffff, 72); // bits
  header.writeUInt32LE(nonce, 76); // nonce
  return header.toString('hex');
}

function blockHashOf(headerHex: string): string {
  return Buffer.from(dsha256(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');
}

interface FixtureBlock {
  height: number;
  hash: string;
  headerHex: string;
  txids: string[];
}

/**
 * Compose a complete fixture: a target tx carrying `expectedRoot` in its
 * OP_RETURN, mined at index `targetIndex` of a block of `blockTxids` at
 * `height`. Returns an Esplora-shaped fetch closure plus the identifiers.
 */
function makeFixture(opts: {
  targetTxId: string;
  opReturnScriptHex: string;
  otherTxids: string[];
  targetIndex: number;
  height: number;
  confirmed?: boolean;
}): { fetch: IndependentNodeFetch; block: FixtureBlock; targetTxId: string } {
  const { targetTxId, opReturnScriptHex, otherTxids, targetIndex, height } = opts;
  const confirmed = opts.confirmed ?? true;

  const txids = [...otherTxids];
  txids.splice(targetIndex, 0, targetTxId);

  const { rootHex, merkle, pos } = buildTree(txids, targetIndex);
  const headerHex = buildHeader(rootHex);
  const hash = blockHashOf(headerHex);

  const tx: EsploraTx = {
    txid: targetTxId,
    status: confirmed
      ? { confirmed: true, block_height: height, block_hash: hash }
      : { confirmed: false },
    vout: [
      { scriptpubkey: opReturnScriptHex, scriptpubkey_asm: 'OP_RETURN ...', value: 0 },
      { scriptpubkey: '0014' + '11'.repeat(20), scriptpubkey_asm: 'OP_0 ...', value: 1000 },
    ],
  };

  const fetch: IndependentNodeFetch = async (path: string) => {
    if (path === `/tx/${targetTxId}`) {
      return { ok: true, json: tx };
    }
    if (path === `/block/${hash}/header`) {
      return { ok: true, text: headerHex };
    }
    if (path === `/tx/${targetTxId}/merkle-proof`) {
      return { ok: true, json: { block_height: height, merkle, pos } };
    }
    if (path === `/block-height/${height}`) {
      return { ok: true, text: hash };
    }
    return { ok: false, status: 404 };
  };

  return { fetch, block: { height, hash, headerHex, txids }, targetTxId };
}

const TXID_A = 'a'.repeat(64);
const OTHER = [
  'b'.repeat(64),
  'c'.repeat(64),
  'd'.repeat(64),
  'e'.repeat(64),
  'f'.repeat(64),
  '1'.repeat(64),
  '2'.repeat(64),
];

describe('confirmInclusion (independent Esplora node)', () => {
  it('confirms a valid inclusion: OP_RETURN matches root, tx in block at stated height', async () => {
    const merkleRoot = fp(0xaa);
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 4),
      targetIndex: 2,
      height: 800_000,
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(true);
    expect(result.status).toBe('confirmed');
    expect(result.blockHeight).toBe(800_000);
    expect(result.extractedMerkleRoot).toBe(merkleRoot.toLowerCase());
    expect(result.blockHash).toBeDefined();
    expect(result.txIndex).toBe(2);
  });

  it('confirms a valid inclusion with an 8-byte metadata suffix on the OP_RETURN', async () => {
    const merkleRoot = fp(0x5c);
    const meta = '0011223344556677';
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot, meta),
      otherTxids: OTHER.slice(0, 2),
      targetIndex: 1,
      height: 750_000,
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 750_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(true);
    expect(result.extractedMerkleRoot).toBe(merkleRoot.toLowerCase());
  });

  it('REJECTS when the OP_RETURN payload does not equal the expected Merkle root', async () => {
    const minedRoot = fp(0x11);
    const claimedRoot = fp(0x22); // different — verifier must reject
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(minedRoot),
      otherTxids: OTHER.slice(0, 4),
      targetIndex: 0,
      height: 800_000,
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: claimedRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('payload_mismatch');
    // The verifier still reports what it actually found on chain (honesty §1.5).
    expect(result.extractedMerkleRoot).toBe(minedRoot.toLowerCase());
  });

  it('REJECTS a forged OP_RETURN that merely CONTAINS the root as a non-canonical substring', async () => {
    const merkleRoot = fp(0x33);
    // Junk byte before ARKV, so a naive substring match would falsely accept.
    const payload = Buffer.concat([Buffer.from([0xff]), ARKV, Buffer.from(merkleRoot, 'hex')]);
    const forged = Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString('hex');
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: forged,
      otherTxids: OTHER.slice(0, 2),
      targetIndex: 0,
      height: 800_000,
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('no_anchor_output');
  });

  it('REJECTS when the tx is not yet in a block (pending)', async () => {
    const merkleRoot = fp(0x44);
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 2),
      targetIndex: 0,
      height: 800_000,
      confirmed: false,
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('not_in_block');
  });

  it('REJECTS when the merkle proof does not recompute to the block header root (tx not in block)', async () => {
    const merkleRoot = fp(0x55);
    const { fetch: goodFetch, block } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 4),
      targetIndex: 1,
      height: 800_000,
    });

    // Tamper: return a merkle proof with a corrupted sibling so the recomputed
    // root no longer equals the header's committed merkleroot.
    const fetch: IndependentNodeFetch = async (path) => {
      if (path === `/tx/${TXID_A}/merkle-proof`) {
        return { ok: true, json: { block_height: 800_000, merkle: ['9'.repeat(64)], pos: 1 } };
      }
      return goodFetch(path);
    };
    void block;

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('inclusion_failed');
  });

  it('REJECTS same-block-different-tx: a proof built for a different txid in the same block', async () => {
    const merkleRoot = fp(0x66);
    const OTHER_TX = 'b'.repeat(64);
    const txids = [TXID_A, OTHER_TX, 'c'.repeat(64), 'd'.repeat(64)];
    const { rootHex, merkle: merkleForOther, pos: posOther } = buildTree(txids, 1); // proof for OTHER_TX
    const headerHex = buildHeader(rootHex);
    const hash = blockHashOf(headerHex);

    const tx: EsploraTx = {
      txid: TXID_A,
      status: { confirmed: true, block_height: 800_000, block_hash: hash },
      vout: [{ scriptpubkey: opReturnScript(merkleRoot), scriptpubkey_asm: 'OP_RETURN ...', value: 0 }],
    };

    // The node returns a VALID merkle proof — but for OTHER_TX, not TXID_A.
    // It recomputes to the real root, so a naive verifier that doesn't bind the
    // proof's leaf to the target txid would accept. We must reject.
    const fetch: IndependentNodeFetch = async (path) => {
      if (path === `/tx/${TXID_A}`) return { ok: true, json: tx };
      if (path === `/block/${hash}/header`) return { ok: true, text: headerHex };
      if (path === `/tx/${TXID_A}/merkle-proof`) {
        return { ok: true, json: { block_height: 800_000, merkle: merkleForOther, pos: posOther } };
      }
      if (path === `/block-height/800000`) return { ok: true, text: hash };
      return { ok: false, status: 404 };
    };

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('inclusion_failed');
  });

  it('REJECTS a height mismatch: tx is in a block at a DIFFERENT height than stated', async () => {
    const merkleRoot = fp(0x77);
    const { fetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 2),
      targetIndex: 0,
      height: 800_001, // tx really at 800_001
    });

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 }, // caller claims 800_000
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('height_mismatch');
  });

  it('REJECTS when block-height index maps the stated height to a DIFFERENT block hash (reorg)', async () => {
    const merkleRoot = fp(0x88);
    const { fetch: goodFetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 2),
      targetIndex: 0,
      height: 800_000,
    });

    // The /block-height/:h index points at a DIFFERENT block hash than the one
    // the tx claims to be in — independent height→hash binding fails (reorg).
    const fetch: IndependentNodeFetch = async (path) => {
      if (path === `/block-height/800000`) return { ok: true, text: '0'.repeat(64) };
      return goodFetch(path);
    };

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('block_hash_mismatch');
  });

  it('REJECTS when the fetched tx body carries a DIFFERENT txid than requested (txid-binding guard)', async () => {
    // Carson P1 (independent-node.ts:160): a buggy/malicious node could pair a
    // VALID merkle proof for TXID_A with a DIFFERENT tx body that carries the
    // expected ARKV||root in its OP_RETURN. The verifier must bind the response
    // to the REQUESTED txid BEFORE reading any vout/OP_RETURN/status — otherwise
    // it would extract the planted root and confirm against a tx it never asked
    // for. Build a fixture whose tx body matches in every way EXCEPT its txid.
    const merkleRoot = fp(0xab);
    const { fetch: goodFetch } = makeFixture({
      targetTxId: TXID_A,
      opReturnScriptHex: opReturnScript(merkleRoot),
      otherTxids: OTHER.slice(0, 4),
      targetIndex: 2,
      height: 800_000,
    });

    // Same node, but the /tx/<TXID_A> body reports a different txid in its JSON.
    const fetch: IndependentNodeFetch = async (path) => {
      if (path === `/tx/${TXID_A}`) {
        const resp = await goodFetch(path);
        const tx = resp.json as EsploraTx;
        return { ...resp, json: { ...tx, txid: 'b'.repeat(64) } };
      }
      return goodFetch(path);
    };

    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: merkleRoot, blockHeight: 800_000 },
      { fetch },
    );

    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('txid_mismatch');
    // The guard fires BEFORE the OP_RETURN is read, so no planted root leaks out.
    expect(result.extractedMerkleRoot).toBeUndefined();
  });

  it('REJECTS when the tx cannot be found on the independent node', async () => {
    const fetch: IndependentNodeFetch = async () => ({ ok: false, status: 404 });
    const result = await confirmInclusion(
      { txId: TXID_A, expectedMerkleRoot: fp(0x99), blockHeight: 800_000 },
      { fetch },
    );
    expect(result.confirmed).toBe(false);
    expect(result.status).toBe('tx_not_found');
  });

  it('rejects malformed inputs without throwing (non-hex txid / root)', async () => {
    const fetch: IndependentNodeFetch = async () => ({ ok: false, status: 404 });
    const bad = await confirmInclusion(
      { txId: 'not-a-txid', expectedMerkleRoot: fp(0x01), blockHeight: 1 },
      { fetch },
    );
    expect(bad.confirmed).toBe(false);
    expect(bad.status).toBe('bad_request');
  });
});

describe('createEsploraFetch', () => {
  it('builds a fetch bound to a base URL and parses json/text responses', async () => {
    // Lazy import to keep the http builder out of the pure-logic test surface.
    const { createEsploraFetch } = await import('./independent-node.js');
    const calls: string[] = [];
    const fakeHttp = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/block/abc/header')) {
        return { ok: true, status: 200, text: async () => 'deadbeef', json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => '{"x":1}', json: async () => ({ x: 1 }) };
    }) as unknown as typeof globalThis.fetch;

    const fetch = createEsploraFetch('https://blockstream.info/api', fakeHttp);
    const r1 = await fetch('/block/abc/header');
    expect(r1.ok).toBe(true);
    expect(r1.text).toBe('deadbeef');
    expect(calls[0]).toBe('https://blockstream.info/api/block/abc/header');

    const r2 = await fetch('/tx/xyz');
    expect(r2.ok).toBe(true);
    expect(r2.json).toEqual({ x: 1 });
  });

  it('strips a trailing slash from the base URL', async () => {
    const { createEsploraFetch } = await import('./independent-node.js');
    const calls: string[] = [];
    const fakeHttp = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;
    const fetch = createEsploraFetch('https://blockstream.info/api/', fakeHttp);
    await fetch('/block-height/1');
    expect(calls[0]).toBe('https://blockstream.info/api/block-height/1');
  });
});
