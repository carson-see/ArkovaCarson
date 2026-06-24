/**
 * Tests for the PROOF-03 (SCRUM-2336) confirmation-proof fetch.
 *
 * NO real Bitcoin API (§1.7): the `gettxoutproof` blobs are built in-process by
 * a faithful re-implementation of Bitcoin's `CMerkleBlock` serializer
 * (`buildMerkleBlockHex` below), so the parser is checked against
 * ground-truth-shaped data without any network call. The provider is a plain
 * `vi.fn()` mock.
 */

import { describe, it, expect, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  fetchConfirmationProof,
  parseTxOutProof,
  type ConfirmationProofProvider,
} from './confirmation-proof.js';

type ProviderSliceType = ConfirmationProofProvider;

// ─── Test helpers: build a real CMerkleBlock + the inputs that produce it ───

function sha256(b: Buffer): Buffer {
  return bitcoin.crypto.sha256(b);
}
function dsha(b: Buffer): Buffer {
  return sha256(sha256(b));
}

/** Make a deterministic 32-byte "txid" (internal byte order) from a seed. */
function makeTxidLE(seed: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(seed >>> 0, 0);
  // fill some bytes so it isn't mostly zeros
  for (let i = 4; i < 32; i++) b[i] = (seed * 7 + i) & 0xff;
  return b;
}

/** Display (RPC) txid = byte-reversed internal hash, lowercase hex. */
function displayHex(le: Buffer): string {
  return Buffer.from(le).reverse().toString('hex');
}

/** Compute the Bitcoin merkleroot (internal LE) over an array of LE leaf hashes. */
function computeMerkleRootLE(leavesLE: Buffer[]): Buffer {
  if (leavesLE.length === 0) throw new Error('no leaves');
  let level = leavesLE.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(dsha(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}

/** Build an 80-byte block header whose merkleroot field is `merkleRootLE`. */
function buildHeader(merkleRootLE: Buffer): Buffer {
  const header = Buffer.alloc(80);
  header.writeInt32LE(0x20000000, 0); // version
  // prev block hash [4,36) — arbitrary nonzero
  for (let i = 4; i < 36; i++) header[i] = (i * 3) & 0xff;
  merkleRootLE.copy(header, 36); // merkleroot [36,68)
  header.writeUInt32LE(1_700_000_000, 68); // time
  header.writeUInt32LE(0x1d00ffff, 72); // bits
  header.writeUInt32LE(42, 76); // nonce
  return header;
}

const writeVarInt = (n: number): Buffer => {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
};

/**
 * The decomposed pieces of a serialized `CMerkleBlock`, plus the ground-truth
 * consumption counters a faithful traversal must report. Returned by
 * `buildMerkleBlock` so tamper-tests can reassemble the blob with one field
 * mutated, and so consumption-counter expectations are derived from the SAME
 * builder that produced the proof (no magic numbers).
 */
interface BuiltMerkleBlock {
  /** Hex of the full serialized CMerkleBlock (== gettxoutproof output). */
  hex: string;
  header: Buffer;
  totalTx: number;
  /** Ordered LE sibling/subtree hashes carried by the proof. */
  hashesLE: Buffer[];
  /** Packed flag bytes (LSB-first). */
  flagBytes: Buffer;
  /** Number of flag BITS a correct traversal consumes (one per visited node). */
  bitCount: number;
  /** Number of HASHES a correct traversal consumes (== hashesLE.length). */
  hashCount: number;
}

/** Reassemble a CMerkleBlock hex from (possibly-tampered) pieces. */
function assembleMerkleBlockHex(parts: {
  header: Buffer;
  totalTx: number;
  hashesLE: Buffer[];
  flagBytes: Buffer;
}): string {
  const totalTxBuf = Buffer.alloc(4);
  totalTxBuf.writeUInt32LE(parts.totalTx, 0);
  return Buffer.concat([
    parts.header,
    totalTxBuf,
    writeVarInt(parts.hashesLE.length),
    ...parts.hashesLE,
    writeVarInt(parts.flagBytes.length),
    parts.flagBytes,
  ]).toString('hex');
}

/**
 * Build the serialized `CMerkleBlock` (== `gettxoutproof` output) for a single
 * matched tx, given the full ordered list of LE leaf hashes in the block, and
 * return its decomposed pieces + the ground-truth bit/hash consumption counts.
 *
 * Mirrors Bitcoin's CPartialMerkleTree::TraverseAndBuild.
 */
function buildMerkleBlock(allLeavesLE: Buffer[], matchIndex: number): BuiltMerkleBlock {
  const totalTx = allLeavesLE.length;
  const merkleRootLE = computeMerkleRootLE(allLeavesLE);
  const header = buildHeader(merkleRootLE);

  // tree height
  let height = 0;
  while ((1 << height) < totalTx) height++;

  const matches = allLeavesLE.map((_, i) => i === matchIndex);

  const bits: number[] = [];
  const hashesLE: Buffer[] = [];

  const widthAt = (h: number) => Math.floor((totalTx + (1 << h) - 1) / (1 << h));
  const hashAt = (h: number, pos: number): Buffer => {
    if (h === 0) return allLeavesLE[pos];
    const left = hashAt(h - 1, pos * 2);
    const right = pos * 2 + 1 < widthAt(h - 1) ? hashAt(h - 1, pos * 2 + 1) : left;
    return dsha(Buffer.concat([left, right]));
  };

  const matchAt = (h: number, pos: number): boolean => {
    if (h === 0) return matches[pos];
    let m = matchAt(h - 1, pos * 2);
    if (pos * 2 + 1 < widthAt(h - 1)) m = m || matchAt(h - 1, pos * 2 + 1);
    return m;
  };

  const build = (h: number, pos: number) => {
    const parentOfMatch = matchAt(h, pos);
    bits.push(parentOfMatch ? 1 : 0);
    if (h === 0 || !parentOfMatch) {
      hashesLE.push(hashAt(h, pos));
    } else {
      build(h - 1, pos * 2);
      if (pos * 2 + 1 < widthAt(h - 1)) build(h - 1, pos * 2 + 1);
    }
  };
  build(height, 0);

  // Pack bits into flag bytes (LSB-first).
  const flagBytes = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) flagBytes[Math.floor(i / 8)] |= 1 << (i % 8);
  }

  return {
    hex: assembleMerkleBlockHex({ header, totalTx, hashesLE, flagBytes }),
    header,
    totalTx,
    hashesLE,
    flagBytes,
    bitCount: bits.length,
    hashCount: hashesLE.length,
  };
}

/** Hex-only convenience wrapper around {@link buildMerkleBlock}. */
function buildMerkleBlockHex(allLeavesLE: Buffer[], matchIndex: number): string {
  return buildMerkleBlock(allLeavesLE, matchIndex).hex;
}

/** Recompute a Merkle root from a display-hex branch (the parser's output). */
function recomputeFromBranch(
  leafDisplayHex: string,
  branch: Array<{ hash: string; position: 'left' | 'right' }>,
): string {
  let cur: Buffer = Buffer.from(Buffer.from(leafDisplayHex, 'hex').reverse()); // back to LE
  for (const entry of branch) {
    const sib = Buffer.from(Buffer.from(entry.hash, 'hex').reverse());
    cur = entry.position === 'right' ? dsha(Buffer.concat([cur, sib])) : dsha(Buffer.concat([sib, cur]));
  }
  return displayHex(cur);
}

function makeProvider(overrides: Partial<ProviderSliceType> = {}): ConfirmationProofProvider {
  return {
    getRawTransaction: vi.fn(),
    getBlockHeaderHex: vi.fn(),
    getTxOutProof: vi.fn(),
    ...overrides,
  } as ConfirmationProofProvider;
}

// ─── parseTxOutProof ────────────────────────────────────────────────────────

describe('parseTxOutProof', () => {
  it('parses a single-tx block (coinbase only) — empty branch, root == leaf', () => {
    const leaf = makeTxidLE(1);
    const proofHex = buildMerkleBlockHex([leaf], 0);
    const parsed = parseTxOutProof(proofHex, displayHex(leaf));
    expect(parsed).not.toBeNull();
    expect(parsed!.txIndex).toBe(0);
    expect(parsed!.merkleBranch).toEqual([]);
    // single-leaf: merkleroot == the leaf
    expect(parsed!.blockMerkleRoot).toBe(displayHex(leaf));
  });

  it.each([0, 1, 2, 3, 4])('recovers a branch that recomputes to the block merkleroot (5 txs, match idx %i)', (idx) => {
    const leaves = [0, 1, 2, 3, 4].map((s) => makeTxidLE(s + 10));
    const proofHex = buildMerkleBlockHex(leaves, idx);
    const targetDisplay = displayHex(leaves[idx]);

    const parsed = parseTxOutProof(proofHex, targetDisplay);
    expect(parsed).not.toBeNull();
    expect(parsed!.txIndex).toBe(idx);
    expect(parsed!.merkleBranch.length).toBeGreaterThan(0);

    // The recovered branch must recompute to the parsed merkleroot.
    const recomputed = recomputeFromBranch(targetDisplay, parsed!.merkleBranch);
    expect(recomputed).toBe(parsed!.blockMerkleRoot);
  });

  it('recovers the branch for a power-of-two block (8 txs)', () => {
    const leaves = Array.from({ length: 8 }, (_, i) => makeTxidLE(i + 100));
    const idx = 5;
    const proofHex = buildMerkleBlockHex(leaves, idx);
    const targetDisplay = displayHex(leaves[idx]);
    const parsed = parseTxOutProof(proofHex, targetDisplay);
    expect(parsed).not.toBeNull();
    expect(parsed!.txIndex).toBe(idx);
    expect(parsed!.merkleBranch).toHaveLength(3); // log2(8)
    expect(recomputeFromBranch(targetDisplay, parsed!.merkleBranch)).toBe(parsed!.blockMerkleRoot);
  });

  it('extracts the block hash as double-SHA256 of the header (reversed)', () => {
    const leaves = [makeTxidLE(7), makeTxidLE(8)];
    const proofHex = buildMerkleBlockHex(leaves, 0);
    const parsed = parseTxOutProof(proofHex, displayHex(leaves[0]));
    expect(parsed).not.toBeNull();
    // recompute expected block hash from the parsed header
    const headerBuf = Buffer.from(parsed!.blockHeader, 'hex');
    const expectedHash = Buffer.from(dsha(headerBuf)).reverse().toString('hex');
    expect(parsed!.blockHash).toBe(expectedHash);
    expect(parsed!.blockHeader).toHaveLength(160); // 80 bytes
  });

  it('returns null when the target tx is not in the proof', () => {
    const leaves = [makeTxidLE(1), makeTxidLE(2), makeTxidLE(3)];
    const proofHex = buildMerkleBlockHex(leaves, 0); // proof is for leaf 0
    const otherTx = displayHex(makeTxidLE(999));
    expect(parseTxOutProof(proofHex, otherTx)).toBeNull();
  });

  it('returns null for malformed / too-short input', () => {
    expect(parseTxOutProof('', 'a'.repeat(64))).toBeNull();
    expect(parseTxOutProof('zz', 'a'.repeat(64))).toBeNull();
    expect(parseTxOutProof('ab'.repeat(40), 'a'.repeat(64))).toBeNull(); // 40 bytes < header
  });

  it('returns null when the target txid is not 64-hex', () => {
    const leaves = [makeTxidLE(1)];
    const proofHex = buildMerkleBlockHex(leaves, 0);
    expect(parseTxOutProof(proofHex, 'notahash')).toBeNull();
  });

  // ── S1.2b: flag-bit / hash FULL-consumption parity (PROOF-03 review) ──
  // A well-formed gettxoutproof partial merkle tree consumes EXACTLY the bits
  // the traversal walks and EXACTLY every carried hash. Leftover hashes, or a
  // set flag bit beyond the consumed bits (padding must be zero), make the blob
  // malformed/malicious and MUST be rejected.

  it('rejects a proof carrying an extra (unconsumed) trailing hash', () => {
    const built = buildMerkleBlock([makeTxidLE(3), makeTxidLE(4)], 0);
    const target = displayHex(makeTxidLE(3));
    // sanity: the untampered proof parses
    expect(parseTxOutProof(built.hex, target)).not.toBeNull();

    // Append one extra hash the traversal will never consume. The hash-count
    // varint is rewritten by assemble, so the structure is otherwise valid.
    const tampered = assembleMerkleBlockHex({
      header: built.header,
      totalTx: built.totalTx,
      hashesLE: [...built.hashesLE, makeTxidLE(0xdead)],
      flagBytes: built.flagBytes,
    });
    expect(parseTxOutProof(tampered, target)).toBeNull();
  });

  it('rejects a proof whose flag-bit padding has a set bit beyond consumed bits', () => {
    const built = buildMerkleBlock([makeTxidLE(11), makeTxidLE(12), makeTxidLE(13)], 1);
    const target = displayHex(makeTxidLE(12));
    expect(parseTxOutProof(built.hex, target)).not.toBeNull();

    // The traversal consumes `bitCount` bits; bits at indices [bitCount, 8*len)
    // are zero padding within the final byte. Set the first padding bit — the
    // tree shape is unchanged (the parser stops reading at bitCount), so ONLY
    // the full-consumption check can catch this.
    const lastByteBitCapacity = built.flagBytes.length * 8;
    expect(built.bitCount).toBeLessThan(lastByteBitCapacity); // a padding bit exists
    const paddingBit = built.bitCount; // first unused bit
    const tamperedFlags = Buffer.from(built.flagBytes);
    tamperedFlags[Math.floor(paddingBit / 8)] |= 1 << (paddingBit % 8);
    expect(tamperedFlags.equals(built.flagBytes)).toBe(false); // we actually flipped a bit

    const tampered = assembleMerkleBlockHex({
      header: built.header,
      totalTx: built.totalTx,
      hashesLE: built.hashesLE,
      flagBytes: tamperedFlags,
    });
    expect(parseTxOutProof(tampered, target)).toBeNull();
  });

  it('rejects a proof with a fully-zero extra trailing flag byte (byte-count parity)', () => {
    // Bitcoin Core's own check: ceil(bitsUsed/8) must equal the flag-byte
    // length. A trailing all-zero flag byte passes the padding-bit check but
    // fails byte-count parity — still malformed.
    const built = buildMerkleBlock([makeTxidLE(21), makeTxidLE(22)], 0);
    const target = displayHex(makeTxidLE(21));
    expect(parseTxOutProof(built.hex, target)).not.toBeNull();

    const tampered = assembleMerkleBlockHex({
      header: built.header,
      totalTx: built.totalTx,
      hashesLE: built.hashesLE,
      flagBytes: Buffer.concat([built.flagBytes, Buffer.from([0x00])]),
    });
    expect(parseTxOutProof(tampered, target)).toBeNull();
  });

  it.each([0, 1, 2, 3, 4])(
    'consumes EXACTLY the expected bit/hash counts for the 5-tx vector (match idx %i)',
    (idx) => {
      const leaves = [0, 1, 2, 3, 4].map((s) => makeTxidLE(s + 10));
      const built = buildMerkleBlock(leaves, idx);
      const target = displayHex(leaves[idx]);

      // The proof parses only because consumption is exact: every carried hash
      // is used and no flag-bit padding is set. These ground-truth counts come
      // from the builder's own traversal.
      expect(built.hashCount).toBe(built.hashesLE.length);
      expect(Math.ceil(built.bitCount / 8)).toBe(built.flagBytes.length);

      const parsed = parseTxOutProof(built.hex, target);
      expect(parsed).not.toBeNull();
      expect(parsed!.txIndex).toBe(idx);

      // Flip ANY consumed flag bit's padding companion → rejected, proving the
      // parser enforces exact consumption against these very counts.
      if (built.bitCount < built.flagBytes.length * 8) {
        const flags = Buffer.from(built.flagBytes);
        flags[Math.floor(built.bitCount / 8)] |= 1 << (built.bitCount % 8);
        const tampered = assembleMerkleBlockHex({
          header: built.header,
          totalTx: built.totalTx,
          hashesLE: built.hashesLE,
          flagBytes: flags,
        });
        expect(parseTxOutProof(tampered, target)).toBeNull();
      }
    },
  );
});

// ─── fetchConfirmationProof: confirmed ──────────────────────────────────────

describe('fetchConfirmationProof — confirmed', () => {
  it('returns a confirmed proof with header + branch when the tx is mined', async () => {
    const leaves = [0, 1, 2].map((s) => makeTxidLE(s + 500));
    const idx = 1;
    const targetTxId = displayHex(leaves[idx]);
    const proofHex = buildMerkleBlockHex(leaves, idx);
    const headerHex = proofHex.slice(0, 160); // header is the first 80 bytes
    const blockHashFromHeader = Buffer.from(dsha(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');

    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: targetTxId,
        confirmations: 12,
        blockhash: blockHashFromHeader,
        blocktime: 1_700_000_000,
        vout: [],
      }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(proofHex),
    });

    const proof = await fetchConfirmationProof(provider, { chainTxId: targetTxId, minConfirmations: 6 });
    expect(proof.status).toBe('confirmed');
    expect(proof.blockHeader).toBe(headerHex);
    expect(proof.blockHash).toBe(blockHashFromHeader);
    expect(proof.txIndex).toBe(idx);
    expect(proof.merkleBranch && proof.merkleBranch.length).toBeGreaterThan(0);
    expect(proof.confirmations).toBe(12);
    // gettxoutproof was pinned to the block hash
    expect(provider.getTxOutProof).toHaveBeenCalledWith([targetTxId], blockHashFromHeader);
  });
});

// ─── fetchConfirmationProof: pending ────────────────────────────────────────

describe('fetchConfirmationProof — pending', () => {
  const txid = 'a'.repeat(64);

  it('is pending when the tx has no block yet (0 confirmations)', async () => {
    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({ txid, confirmations: 0, vout: [] }),
    });
    const proof = await fetchConfirmationProof(provider, { chainTxId: txid });
    expect(proof.status).toBe('pending');
    expect(proof.blockHeader).toBeUndefined();
    expect(proof.merkleBranch).toBeUndefined();
    // never fetched a proof for an unconfirmed tx
    expect(provider.getTxOutProof).not.toHaveBeenCalled();
  });

  it('is pending when below minConfirmations (NEVER fabricates a path)', async () => {
    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid,
        confirmations: 2,
        blockhash: 'b'.repeat(64),
        vout: [],
      }),
    });
    const proof = await fetchConfirmationProof(provider, { chainTxId: txid, minConfirmations: 6 });
    expect(proof.status).toBe('pending');
    expect(proof.confirmations).toBe(2);
    expect(proof.merkleBranch).toBeUndefined();
    expect(provider.getTxOutProof).not.toHaveBeenCalled();
  });

  it('is pending (not stale) when the tx lookup throws — so it retries', async () => {
    const provider = makeProvider({
      getRawTransaction: vi.fn().mockRejectedValue(new Error('RPC down')),
    });
    const proof = await fetchConfirmationProof(provider, { chainTxId: txid });
    expect(proof.status).toBe('pending');
  });

  it('is pending when the provider cannot supply inclusion proofs', async () => {
    // No getTxOutProof / getBlockHeaderHex (e.g. a plain mempool provider).
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({
        txid,
        confirmations: 10,
        blockhash: 'b'.repeat(64),
        vout: [],
      }),
    };
    const proof = await fetchConfirmationProof(provider, { chainTxId: txid });
    expect(proof.status).toBe('pending');
    expect(proof.reason).toMatch(/gettxoutproof|inclusion-proof/i);
  });
});

// ─── fetchConfirmationProof: reorg / stale / missing ────────────────────────

describe('fetchConfirmationProof — reorg / stale', () => {
  it('is stale when the tx is now in a different block than recorded (reorg)', async () => {
    const txid = 'c'.repeat(64);
    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid,
        confirmations: 8,
        blockhash: 'd'.repeat(64), // current block
        vout: [],
      }),
    });
    const proof = await fetchConfirmationProof(provider, {
      chainTxId: txid,
      expectedBlockHash: 'e'.repeat(64), // previously recorded — differs
      minConfirmations: 1,
    });
    expect(proof.status).toBe('stale');
    expect(proof.reason).toMatch(/reorg|different block/i);
    // we do NOT fetch / persist a path under the new block automatically
    expect(provider.getTxOutProof).not.toHaveBeenCalled();
  });

  it('is stale when the inclusion proof does not contain the tx (reorged out)', async () => {
    const leaves = [makeTxidLE(1), makeTxidLE(2)];
    const proofForOther = buildMerkleBlockHex(leaves, 0); // proof is for leaf 0
    const headerHex = proofForOther.slice(0, 160);
    const blockHash = Buffer.from(dsha(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');
    const targetTxId = displayHex(makeTxidLE(777)); // not in the block

    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: targetTxId,
        confirmations: 9,
        blockhash: blockHash,
        vout: [],
      }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(proofForOther),
    });

    const proof = await fetchConfirmationProof(provider, { chainTxId: targetTxId });
    expect(proof.status).toBe('stale');
    expect(proof.merkleBranch).toBeUndefined();
  });

  it('is stale when header/proof fetch throws (does not crash)', async () => {
    const txid = 'f'.repeat(64);
    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid,
        confirmations: 10,
        blockhash: 'a'.repeat(64),
        vout: [],
      }),
      getBlockHeaderHex: vi.fn().mockRejectedValue(new Error('getblockheader failed')),
      getTxOutProof: vi.fn().mockResolvedValue('00'),
    });
    const proof = await fetchConfirmationProof(provider, { chainTxId: txid });
    expect(proof.status).toBe('stale');
  });

  it('is stale when the fetched header does not match the proof header', async () => {
    const leaves = [makeTxidLE(3), makeTxidLE(4)];
    const proofHex = buildMerkleBlockHex(leaves, 0);
    const targetTxId = displayHex(leaves[0]);
    const blockHash = Buffer.from(dsha(Buffer.from(proofHex.slice(0, 160), 'hex'))).reverse().toString('hex');
    const wrongHeader = 'a'.repeat(160); // 80 bytes but not the proof's header

    const provider = makeProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: targetTxId,
        confirmations: 10,
        blockhash: blockHash,
        vout: [],
      }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(wrongHeader),
      getTxOutProof: vi.fn().mockResolvedValue(proofHex),
    });
    const proof = await fetchConfirmationProof(provider, { chainTxId: targetTxId });
    expect(proof.status).toBe('stale');
    expect(proof.reason).toMatch(/header/i);
  });

  it('is stale for a malformed chain_tx_id', async () => {
    const provider = makeProvider();
    const proof = await fetchConfirmationProof(provider, { chainTxId: 'not-a-txid' });
    expect(proof.status).toBe('stale');
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
  });
});
