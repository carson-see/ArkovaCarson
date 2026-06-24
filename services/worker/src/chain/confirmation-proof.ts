/**
 * Confirmation-proof fetch (PROOF-03 / SCRUM-2336).
 *
 * For a SECURED anchor's Bitcoin transaction, fetch the layer-2 "bitcoin-tree"
 * confirmation evidence: the block header (80 bytes) the tx was mined into, plus
 * the Merkle inclusion path that proves the tx is committed by that block's
 * `merkleroot`. Together with the layer-1 app-tree branch (already persisted by
 * FIX-1: `merkle_root` + `proof_path` + `merkle_index`), this lets a proof
 * bundle carry INDEPENDENTLY-CHECKABLE chain-confirmation evidence:
 *
 *     document fingerprint
 *        └─ (app-tree branch, FIX-1) ─▶ app_merkle_root  ── committed in ──▶ OP_RETURN of tx
 *     tx
 *        └─ (this module: bitcoin-tree branch) ─▶ block merkleroot ── committed in ──▶ block header
 *
 * SOURCE (DISC-03): GetBlock RPC is the default — `getblockheader <hash> false`
 * for the raw header and `gettxoutproof [<txid>] <blockhash>` for the Merkle
 * branch. Broadcast is already GetBlock-sovereign; this keeps the
 * inclusion-proof read on the same node. A documented mempool.space fallback
 * (`/api/block/:hash/header` + `/api/tx/:txid/merkle-proof`) is provided for
 * providers without the RPC methods, but GetBlock is preferred.
 *
 * OP_RETURN format is intentionally OUT OF SCOPE here (that is the verifier's
 * concern, S2). PROOF-03 fetches the tx's INCLUSION in its block and is
 * format-agnostic — it never parses or asserts the OP_RETURN payload.
 *
 * Constitution refs:
 *   - §1.1 Chain: header/inclusion source = GetBlock RPC; bitcoinjs-lib parsing.
 *   - §1.5 Evidence: the structure states exactly what is measured (the tx's
 *     position under the block merkleroot) and asserts nothing it cannot prove
 *     (a not-yet-confirmed tx returns `pending` with NO fabricated branch).
 *   - §1.7 Testing: NO real Bitcoin API — all provider calls are mockable.
 */

import * as bitcoin from 'bitcoinjs-lib';
import { logger } from '../utils/logger.js';
import type { MerkleProofEntry } from '../utils/merkle.js';
import type { ConfirmationProofProvider } from './utxo-provider.js';

// Re-export so callers/tests can import the provider slice alongside the
// confirmation-proof types from one module.
export type { ConfirmationProofProvider } from './utxo-provider.js';

/** A txid is exactly 64 hex characters (32 bytes). */
const TXID_HEX_RE = /^[0-9a-fA-F]{64}$/;
/** A block hash is exactly 64 hex characters (32 bytes). */
const BLOCK_HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;
/** A raw block header is exactly 160 hex characters (80 bytes). */
const BLOCK_HEADER_HEX_RE = /^[0-9a-fA-F]{160}$/;

/**
 * Status of a confirmation-proof fetch. Mutually exclusive.
 *  - `confirmed`: the tx is in a block, the header + Merkle branch were
 *    fetched, and the branch recomputes to the header's `merkleroot`.
 *  - `pending`: the tx exists but is not yet in a block (or has too few
 *    confirmations to bother). NO branch is returned — never fabricated.
 *  - `stale`: the previously-recorded block no longer contains this tx
 *    (reorg) or the tx/block could not be found. Marked, never crashes.
 */
export type ConfirmationProofStatus = 'confirmed' | 'pending' | 'stale';

/**
 * Deterministic, serializable confirmation proof for one transaction.
 *
 * `merkleBranch` is shaped exactly like the app-tree `MerkleProofEntry[]`
 * (sibling hash + position) so a verifier can walk it with the SAME positional
 * double-SHA256 rule — the values are byte-reversed (display) hex, matching how
 * Bitcoin block headers / merkleroots are presented and how
 * `bitcoinjs-lib` block parsing yields them.
 */
export interface ConfirmationProof {
  status: ConfirmationProofStatus;
  /** The transaction this proof is for (display-hex, 64-char). */
  chainTxId: string;
  /** Block hash the tx was mined into (display-hex, 64-char). Absent when pending/stale-missing. */
  blockHash?: string;
  /** Raw 80-byte block header (160-hex). PROOF-01 on_chain.block_header. */
  blockHeader?: string;
  /** The block's merkleroot extracted from the header (display-hex, 64-char). */
  blockMerkleRoot?: string;
  /** Inclusion branch tx → block merkleroot (display-hex siblings + position). */
  merkleBranch?: MerkleProofEntry[];
  /** Integer index of the tx within the block (Electrum/gettxoutproof position). */
  txIndex?: number;
  /** Number of confirmations observed at fetch time (informational). */
  confirmations?: number;
  /** Machine-stable short reason for pending/stale (never leaks tx internals beyond the txid). */
  reason?: string;
}

/** Inputs identifying which tx (and where) to fetch a confirmation proof for. */
export interface ConfirmationProofRequest {
  /** The SECURED anchor's chain_tx_id. */
  chainTxId: string;
  /** Expected block height (informational; reorg detection compares hashes, not heights). */
  blockHeight?: number | null;
  /**
   * Previously-recorded block hash, if any. When supplied AND the freshly
   * fetched tx reports a DIFFERENT block hash, the proof is `stale` (reorg):
   * we never silently overwrite with a path under a different block.
   */
  expectedBlockHash?: string | null;
  /** Minimum confirmations before we bother fetching a full proof (default 1). */
  minConfirmations?: number;
}

/**
 * SHA-256 of a buffer.
 */
function sha256(data: Uint8Array): Buffer {
  return bitcoin.crypto.sha256(Buffer.from(data));
}

/** Double-SHA-256 (Bitcoin standard). */
function doubleSha256(data: Uint8Array): Buffer {
  return sha256(sha256(data));
}

/**
 * Parse a `gettxoutproof` hex blob into its block header + the embedded
 * partial-merkle-tree, then derive the inclusion branch for the single target
 * txid.
 *
 * `gettxoutproof` returns a serialized `CMerkleBlock`:
 *   [ 80-byte block header ][ 4-byte total tx count ][ varint hash count ]
 *   [ hashes... ][ varint flag-bytes len ][ flag bytes ]
 *
 * We delegate the structural parse to `bitcoin.Block.fromHex` after splitting
 * out the 80-byte header, but `bitcoinjs-lib` does not expose a partial-merkle
 * walker, so we walk the flag-bit / hash stream ourselves to recover the
 * branch + index for the target tx. The walk is the standard Bitcoin
 * `CPartialMerkleTree::TraverseAndExtract` algorithm.
 *
 * Returns `null` when the proof does not contain the target txid (caller maps
 * that to `stale`), or when the structure is malformed.
 */
export function parseTxOutProof(
  proofHex: string,
  targetTxId: string,
): {
  blockHeader: string;
  blockHash: string;
  blockMerkleRoot: string;
  merkleBranch: MerkleProofEntry[];
  txIndex: number;
} | null {
  if (typeof proofHex !== 'string' || proofHex.length < 160 || !/^[0-9a-fA-F]+$/.test(proofHex)) {
    return null;
  }
  if (!TXID_HEX_RE.test(targetTxId)) {
    return null;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(proofHex, 'hex');
  } catch {
    return null;
  }
  if (buf.length < 80 + 4 + 1) return null;

  // ── 1. Block header (first 80 bytes) ──
  const headerBuf = buf.subarray(0, 80);
  const blockHeader = headerBuf.toString('hex');
  // Block hash = double-SHA256 of the header, displayed byte-reversed.
  const blockHash = Buffer.from(doubleSha256(headerBuf)).reverse().toString('hex');
  // merkleroot is header bytes [36, 68), stored little-endian → display-reversed.
  const blockMerkleRoot = Buffer.from(headerBuf.subarray(36, 68)).reverse().toString('hex');

  // ── 2. Partial merkle tree fields ──
  let offset = 80;
  const totalTx = buf.readUInt32LE(offset);
  offset += 4;
  if (totalTx <= 0) return null;

  const readVarInt = (): number | null => {
    if (offset >= buf.length) return null;
    const first = buf.readUInt8(offset);
    offset += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      if (offset + 2 > buf.length) return null;
      const v = buf.readUInt16LE(offset);
      offset += 2;
      return v;
    }
    if (first === 0xfe) {
      if (offset + 4 > buf.length) return null;
      const v = buf.readUInt32LE(offset);
      offset += 4;
      return v;
    }
    // 0xff (8-byte) — far beyond any realistic block tx count; reject.
    return null;
  };

  const hashCount = readVarInt();
  if (hashCount == null || hashCount < 1) return null;
  const hashes: Buffer[] = [];
  for (let i = 0; i < hashCount; i++) {
    if (offset + 32 > buf.length) return null;
    hashes.push(buf.subarray(offset, offset + 32));
    offset += 32;
  }

  const flagBytesLen = readVarInt();
  if (flagBytesLen == null || flagBytesLen < 1) return null;
  if (offset + flagBytesLen > buf.length) return null;
  const flagBytes = buf.subarray(offset, offset + flagBytesLen);

  // ── 3. Walk the partial merkle tree (CPartialMerkleTree::TraverseAndExtract) ──
  // Compute tree height: ceil(log2) by doubling level width.
  let treeHeight = 0;
  while ((totalTx >> treeHeight) > 1 || (1 << treeHeight) < totalTx) {
    treeHeight++;
    if (treeHeight > 32) return null; // sanity bound
  }

  let bitPos = 0;
  let hashPos = 0;
  let matchedIndex = -1;
  let matchedLeafHashLE: Buffer | null = null;
  let parseError = false;

  const nextBit = (): number => {
    if (bitPos >= flagBytesLen * 8) {
      parseError = true;
      return 0;
    }
    const byte = flagBytes.readUInt8(Math.floor(bitPos / 8));
    const bit = (byte >> (bitPos % 8)) & 1;
    bitPos++;
    return bit;
  };

  const nextHash = (): Buffer | null => {
    if (hashPos >= hashes.length) {
      parseError = true;
      return null;
    }
    return hashes[hashPos++];
  };

  /**
   * Recursive descent. Returns the subtree hash. When the target match-bit
   * path is followed, records each sibling as a branch entry (relative to the
   * matched leaf) and captures the leaf index.
   *
   * `pos` is the node index at `height`; leaf positions live at height 0.
   */
  const calcWidthAtHeight = (height: number): number => {
    return Math.floor((totalTx + (1 << height) - 1) / (1 << height));
  };

  const traverse = (height: number, pos: number): Buffer | null => {
    if (parseError) return null;
    const isParentOfMatch = nextBit() === 1;
    if (height === 0 || !isParentOfMatch) {
      // Leaf, OR an internal node none of whose descendants match: hash is
      // taken verbatim from the hash stream.
      const h = nextHash();
      if (h == null) return null;
      if (height === 0 && isParentOfMatch) {
        // This leaf is the matched tx.
        matchedIndex = pos;
        matchedLeafHashLE = h;
      }
      return h;
    }
    // Internal node with at least one matched descendant: recurse.
    const left = traverse(height - 1, pos * 2);
    let right: Buffer | null;
    const rightChildPos = pos * 2 + 1;
    if (rightChildPos < calcWidthAtHeight(height - 1)) {
      right = traverse(height - 1, rightChildPos);
      // Bitcoin rejects left==right at internal nodes (CVE-2012-2459-adjacent);
      // here it can only happen via a duplicated last node, which the width
      // check above already excludes for a real right child.
    } else {
      // Odd row: right child is a duplicate of the left.
      right = left;
    }
    if (left == null || right == null) return null;
    return doubleSha256(Buffer.concat([left, right]));
  };

  const root = traverse(treeHeight, 0);
  if (parseError || root == null || matchedIndex < 0 || matchedLeafHashLE == null) return null;

  // ── Full-consumption parity (S1.2b / PROOF-03 review hardening) ──
  // A well-formed CPartialMerkleTree's traversal consumes EXACTLY the flag bits
  // it walks (one per visited node) and EXACTLY every carried hash. Anything
  // left over is malformed or malicious padding a verifier must reject — a
  // proof MUST NOT carry "spare" hashes or set flag bits the tree never reached.
  //
  //   (1) HASH parity: every provided hash was consumed.
  //   (2) FLAG-BYTE parity (Bitcoin Core's own rule): the bytes needed to hold
  //       the consumed bits equal the serialized flag-byte length — i.e. no
  //       extra trailing flag byte, even an all-zero one.
  //   (3) PADDING-BIT zero (stricter than stock Core): every bit AFTER the last
  //       consumed bit, within the final partial byte, is zero. A set padding
  //       bit cannot change the recovered tree (the walk stops at `bitPos`), so
  //       only this explicit check can reject a tampered/forged flag stream.
  const bitsConsumed = bitPos;
  // (1)
  if (hashPos !== hashes.length) return null;
  // (2)
  if (Math.ceil(bitsConsumed / 8) !== flagBytesLen) return null;
  // (3)
  for (let i = bitsConsumed; i < flagBytesLen * 8; i++) {
    const byte = flagBytes.readUInt8(i >> 3);
    if (((byte >> (i & 7)) & 1) !== 0) return null;
  }

  // Verify the recomputed root matches the header's merkleroot (raw LE form).
  const headerMerkleRootLE = headerBuf.subarray(36, 68);
  if (!Buffer.from(root).equals(headerMerkleRootLE)) return null;

  // CRITICAL: the matched leaf must actually be the TARGET tx. `gettxoutproof`
  // commits to the matched leaves via the flag bits, not by carrying the txid,
  // so a proof built for a DIFFERENT tx in the same block would otherwise be
  // accepted. Compare the matched leaf hash (internal LE) to the target txid
  // (display hex → reversed to LE). Mismatch ⇒ not a proof for this tx.
  const targetLE = Buffer.from(targetTxId.toLowerCase(), 'hex').reverse();
  if (!Buffer.from(matchedLeafHashLE).equals(targetLE)) return null;

  // ── 4. Re-derive the inclusion branch + positions for the matched leaf ──
  // The recursive walk above recovers `matchedIndex` and (implicitly) the
  // sibling hashes on the matched path. We re-extract them deterministically
  // by re-walking only the matched path now that the index is known, so the
  // returned branch is ordered leaf→root with explicit left/right positions.
  // To do this we reconstruct the per-level sibling from a second guided pass.
  const orderedBranch = extractBranchForIndex(hashes, flagBytes, flagBytesLen, totalTx, treeHeight, matchedIndex);
  if (orderedBranch == null) return null;

  return {
    blockHeader,
    blockHash,
    blockMerkleRoot,
    merkleBranch: orderedBranch,
    txIndex: matchedIndex,
  };
}

/**
 * Second guided pass over the partial merkle tree that, knowing the matched
 * leaf index, emits the ordered sibling branch (leaf→root) with display-hex
 * sibling hashes and explicit `position`. Position is derived from the leaf
 * index bit at each level (even index ⇒ sibling on the right, odd ⇒ left),
 * matching the app-tree `MerkleProofEntry` convention so a verifier walks both
 * layers identically.
 */
function extractBranchForIndex(
  hashes: Buffer[],
  flagBytes: Buffer,
  flagBytesLen: number,
  totalTx: number,
  treeHeight: number,
  matchedIndex: number,
): MerkleProofEntry[] | null {
  let bitPos = 0;
  let hashPos = 0;
  let parseError = false;

  const nextBit = (): number => {
    if (bitPos >= flagBytesLen * 8) {
      parseError = true;
      return 0;
    }
    const byte = flagBytes.readUInt8(Math.floor(bitPos / 8));
    const bit = (byte >> (bitPos % 8)) & 1;
    bitPos++;
    return bit;
  };
  const nextHash = (): Buffer | null => {
    if (hashPos >= hashes.length) {
      parseError = true;
      return null;
    }
    return hashes[hashPos++];
  };
  const calcWidthAtHeight = (height: number): number =>
    Math.floor((totalTx + (1 << height) - 1) / (1 << height));

  // Branch entries collected as { height, hash, position }. We collect during
  // descent then sort leaf→root (height ascending).
  const collected: Array<{ height: number; hash: string; position: 'left' | 'right' }> = [];

  const traverse = (height: number, pos: number): Buffer | null => {
    if (parseError) return null;
    const isParentOfMatch = nextBit() === 1;
    if (height === 0 || !isParentOfMatch) {
      const h = nextHash();
      return h;
    }
    const leftPos = pos * 2;
    const rightPos = pos * 2 + 1;
    // The matched leaf lives under exactly one child at this level. Determine
    // which by the corresponding bit of matchedIndex.
    const matchedChildIsLeft = ((matchedIndex >> (height - 1)) & 1) === 0;
    const left = traverse(height - 1, leftPos);
    let right: Buffer | null;
    if (rightPos < calcWidthAtHeight(height - 1)) {
      right = traverse(height - 1, rightPos);
    } else {
      right = left; // duplicated last node
    }
    if (left == null || right == null) return null;
    // The sibling of the matched path at this level:
    if (matchedChildIsLeft) {
      // matched descends left; sibling is the right child → position 'right'.
      collected.push({ height: height - 1, hash: Buffer.from(right).reverse().toString('hex'), position: 'right' });
    } else {
      collected.push({ height: height - 1, hash: Buffer.from(left).reverse().toString('hex'), position: 'left' });
    }
    return doubleSha256(Buffer.concat([left, right]));
  };

  traverse(treeHeight, 0);
  if (parseError) return null;
  collected.sort((a, b) => a.height - b.height);
  return collected.map((c) => ({ hash: c.hash, position: c.position }));
}

/**
 * Fetch the confirmation proof for one transaction.
 *
 * Flow:
 *   1. Look up the tx (getRawTransaction). Not found / no block ⇒ `pending`.
 *   2. If `expectedBlockHash` is set and differs from the tx's current block ⇒
 *      `stale` (reorg) — never write a path under a different block.
 *   3. Below `minConfirmations` ⇒ `pending`.
 *   4. Fetch raw header (getBlockHeaderHex) + the inclusion proof
 *      (getTxOutProof), parse, verify the branch recomputes to the header
 *      merkleroot. Any gap ⇒ `stale` with a reason; NEVER throws.
 *
 * The provider is the `ConfirmationProofProvider` slice of `UtxoProvider`;
 * GetBlock's `GetBlockHybridProvider` is the production implementation.
 */
export async function fetchConfirmationProof(
  provider: ConfirmationProofProvider,
  req: ConfirmationProofRequest,
): Promise<ConfirmationProof> {
  const chainTxId = req.chainTxId;
  const minConfirmations = req.minConfirmations ?? 1;

  if (!TXID_HEX_RE.test(chainTxId)) {
    return { status: 'stale', chainTxId, reason: 'chain_tx_id is not a 64-hex transaction id' };
  }

  // ── 1. Locate the tx + its block ──
  let rawTx;
  try {
    rawTx = await provider.getRawTransaction(chainTxId);
  } catch (err) {
    // A lookup failure here is transient/unknown — treat as pending so the
    // next cron tick retries rather than poisoning the row as stale.
    logger.debug({ chainTxId, err: errMsg(err) }, 'confirmation-proof: getRawTransaction failed — pending');
    return { status: 'pending', chainTxId, reason: 'transaction lookup failed' };
  }

  const blockHash = rawTx.blockhash;
  const confirmations = rawTx.confirmations ?? 0;

  if (!blockHash || confirmations <= 0) {
    return { status: 'pending', chainTxId, reason: 'transaction not yet in a block' };
  }
  if (!BLOCK_HASH_HEX_RE.test(blockHash)) {
    return { status: 'stale', chainTxId, reason: 'transaction reported a malformed block hash' };
  }

  // ── 2. Reorg guard ──
  if (req.expectedBlockHash && req.expectedBlockHash.toLowerCase() !== blockHash.toLowerCase()) {
    return {
      status: 'stale',
      chainTxId,
      blockHash,
      confirmations,
      reason: 'transaction is now in a different block than previously recorded (reorg)',
    };
  }

  // ── 3. Confirmation depth ──
  if (confirmations < minConfirmations) {
    return {
      status: 'pending',
      chainTxId,
      blockHash,
      confirmations,
      reason: `only ${confirmations} confirmation(s); waiting for ${minConfirmations}`,
    };
  }

  // ── 4. Fetch + parse the inclusion proof ──
  if (typeof provider.getTxOutProof !== 'function' || typeof provider.getBlockHeaderHex !== 'function') {
    // Provider can't supply the bitcoin-tree branch (e.g. plain mempool
    // provider). Not an error — but we have no independently-checkable path,
    // so the proof stays pending until a capable provider runs.
    return {
      status: 'pending',
      chainTxId,
      blockHash,
      confirmations,
      reason: 'provider does not support inclusion-proof fetch (gettxoutproof)',
    };
  }

  let headerHex: string;
  let proofHex: string;
  try {
    [headerHex, proofHex] = await Promise.all([
      provider.getBlockHeaderHex(blockHash),
      provider.getTxOutProof([chainTxId], blockHash),
    ]);
  } catch (err) {
    logger.warn({ chainTxId, blockHash, err: errMsg(err) }, 'confirmation-proof: header/proof fetch failed');
    return { status: 'stale', chainTxId, blockHash, confirmations, reason: 'header or inclusion-proof fetch failed' };
  }

  if (!BLOCK_HEADER_HEX_RE.test(headerHex)) {
    return { status: 'stale', chainTxId, blockHash, confirmations, reason: 'block header is not 80 bytes (160-hex)' };
  }

  const parsed = parseTxOutProof(proofHex, chainTxId);
  if (parsed == null) {
    // The proof did not contain this tx under this block (reorg/missing) or
    // was malformed. Mark stale — NEVER fabricate a branch.
    return {
      status: 'stale',
      chainTxId,
      blockHash,
      confirmations,
      reason: 'inclusion proof did not contain this transaction (reorg/missing) or was malformed',
    };
  }

  // Cross-check: the header we fetched must hash to the same block, and the
  // proof's own embedded header must match the one we fetched. Either mismatch
  // means the provider gave inconsistent data for this block ⇒ stale.
  if (parsed.blockHeader.toLowerCase() !== headerHex.toLowerCase()) {
    return {
      status: 'stale',
      chainTxId,
      blockHash,
      confirmations,
      reason: 'inclusion-proof header does not match fetched block header',
    };
  }
  if (parsed.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
    return {
      status: 'stale',
      chainTxId,
      blockHash,
      confirmations,
      reason: 'inclusion-proof block hash does not match the transaction block',
    };
  }

  return {
    status: 'confirmed',
    chainTxId,
    blockHash: parsed.blockHash,
    blockHeader: parsed.blockHeader,
    blockMerkleRoot: parsed.blockMerkleRoot,
    merkleBranch: parsed.merkleBranch,
    txIndex: parsed.txIndex,
    confirmations,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
