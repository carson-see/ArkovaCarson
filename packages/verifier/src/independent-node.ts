/**
 * Independent-node inclusion confirmation (PROOF-07).
 *
 * Given a `txId` + the expected OP_RETURN payload (the app Merkle root) + a
 * stated block height, confirm the anchor's on-chain inclusion by querying an
 * INDEPENDENT block-explorer node (Esplora / Blockstream REST), NEVER Arkova's
 * own infrastructure and NEVER Arkova's GetBlock RPC token. This is the
 * verifier's trust-minimized cross-check: a third party must be able to run it
 * against a node WE do not control and reach the same verdict.
 *
 * It performs these independent checks, each of which must pass:
 *   0. Txid binding       — the fetched tx body's `txid` EQUALS the requested
 *      txid before any of its vout / OP_RETURN / status is read. The txid is the
 *      double-SHA256 identity of the body, so this rejects a node that pairs a
 *      valid proof for `txId` with a different body carrying a planted ARKV‖root.
 *   1. OP_RETURN payload  — the tx carries a canonical Arkova OP_RETURN output
 *      (`OP_RETURN <push> ARKV||<32-byte root>[||metadata]`) whose committed
 *      32-byte fingerprint EQUALS the expected Merkle root. Structural decode at
 *      a fixed byte offset, NOT a substring match (closes the forged-substring
 *      acceptance — mirrors services/worker/src/chain/signet.ts).
 *   2. Inclusion          — the node's Merkle proof for THIS txid recomputes to
 *      the block header's committed `merkleroot`. The proof's leaf is bound to
 *      the target txid (`pos` + the txid itself), so a valid proof for a
 *      DIFFERENT tx in the same block is rejected.
 *   3. Height binding     — the tx's block is at the stated height, AND the
 *      node's height→hash index (`/block-height/:h`) maps that height to the
 *      SAME block hash the tx claims (independent reorg check).
 *   4. Header integrity   — the 80-byte header is fetched independently and
 *      double-SHA256s to the claimed block hash; its merkleroot is the one the
 *      inclusion proof is checked against.
 *
 * Zero Arkova runtime dependency and zero third-party runtime deps: all Bitcoin
 * parsing is pure-buffer here so a standalone verifier CLI can consume it with
 * nothing but Node's `crypto`. The HTTP layer is injected (`fetch`) so the CLI
 * passes `--rpc <base>` and tests mock it (no real network — §1.7).
 *
 * Honesty (§1.5): the result reports exactly what was measured — the verdict,
 * the status reason, and what was actually found on chain (e.g. the real
 * extracted root on a payload mismatch). It asserts nothing it cannot prove and
 * never throws on a failed/uncooperative node — failures map to a status.
 */

import { createHash } from 'node:crypto';

/** 4-byte Arkova OP_RETURN prefix ('ARKV'), matching the anchor writer. */
const ARKV_PREFIX = Buffer.from('ARKV');
/** SHA-256 document fingerprint / app Merkle root is 32 bytes. */
const ROOT_BYTES = 32;
const OP_RETURN = 0x6a;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const HEADER_HEX_RE = /^[0-9a-fA-F]{160}$/;

// ──────────────────────────────────────────────────────────────────────────
// Injectable transport
// ──────────────────────────────────────────────────────────────────────────

/** A single Esplora response, normalized. Exactly one of json/text is set on success. */
export interface IndependentNodeResponse {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

/**
 * The injected transport. Receives an Esplora API PATH (e.g. `/tx/<txid>`) and
 * returns a normalized response. Implementations bind a base URL; tests mock it.
 */
export type IndependentNodeFetch = (path: string) => Promise<IndependentNodeResponse>;

/** Esplora `GET /tx/:txid` (subset we rely on). */
export interface EsploraTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_hash?: string };
  vout: Array<{ scriptpubkey: string; scriptpubkey_asm?: string; value?: number }>;
}

/** Esplora `GET /tx/:txid/merkle-proof`. */
interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export interface ConfirmInclusionRequest {
  /** Transaction id (display hex, 64-char). */
  txId: string;
  /** Expected OP_RETURN payload — the app Merkle root (display hex, 64-char). */
  expectedMerkleRoot: string;
  /** Block height the anchor claims to be confirmed at. */
  blockHeight: number;
}

export interface ConfirmInclusionOptions {
  /** Injected independent-node transport (Esplora REST). */
  fetch: IndependentNodeFetch;
}

export type ConfirmInclusionStatus =
  | 'confirmed'
  | 'bad_request'
  | 'tx_not_found'
  | 'txid_mismatch'
  | 'not_in_block'
  | 'no_anchor_output'
  | 'payload_mismatch'
  | 'height_mismatch'
  | 'block_hash_mismatch'
  | 'header_unavailable'
  | 'inclusion_failed';

export interface ConfirmInclusionResult {
  /** True only when every independent check passed. */
  confirmed: boolean;
  status: ConfirmInclusionStatus;
  /** The txid verified (echoed, lowercased). */
  txId: string;
  /** Block height as confirmed on the independent node (when known). */
  blockHeight?: number;
  /** Block hash the tx was found in (display hex, when known). */
  blockHash?: string;
  /** The 32-byte OP_RETURN payload actually found on chain (display hex, when an anchor output existed). */
  extractedMerkleRoot?: string;
  /** Block merkleroot from the independently-fetched header (display hex, when fetched). */
  blockMerkleRoot?: string;
  /** Tx position within the block per the Merkle proof (when fetched). */
  txIndex?: number;
  /** Human/machine-stable reason; present on every non-confirmed result. */
  reason?: string;
}

/**
 * Confirm on-chain inclusion of an Arkova anchor against an independent node.
 * Never throws; all failures map to a {@link ConfirmInclusionStatus}.
 */
export async function confirmInclusion(
  req: ConfirmInclusionRequest,
  opts: ConfirmInclusionOptions,
): Promise<ConfirmInclusionResult> {
  const txId = (req.txId ?? '').toLowerCase();
  const expectedRoot = (req.expectedMerkleRoot ?? '').toLowerCase();

  if (!HEX64_RE.test(txId)) {
    return reject('bad_request', txId, 'txId is not a 64-hex transaction id');
  }
  if (!HEX64_RE.test(expectedRoot)) {
    return reject('bad_request', txId, 'expectedMerkleRoot is not a 64-hex value');
  }
  if (!Number.isInteger(req.blockHeight) || req.blockHeight < 0) {
    return reject('bad_request', txId, 'blockHeight must be a non-negative integer');
  }

  const { fetch } = opts;

  // ── 1. Fetch the tx ──
  const txResp = await safeFetch(fetch, `/tx/${txId}`);
  if (!txResp || !txResp.ok || !isEsploraTx(txResp.json)) {
    return reject('tx_not_found', txId, 'transaction not found on the independent node');
  }
  const tx = txResp.json;

  // ── 1a. TXID-BINDING GUARD (Carson P1) ──
  // Bind the returned body to the txid we actually requested BEFORE reading any
  // of its vout / OP_RETURN / status. A buggy or malicious node could pair a
  // valid Merkle proof for `txId` with a DIFFERENT tx body that carries the
  // expected ARKV‖root in its OP_RETURN; without this check the verifier would
  // extract the planted root and confirm against a tx it never asked for. The
  // txid is the cryptographic identity of the body (double-SHA256 of its bytes),
  // so this is the one field that ties the response to the request.
  if (typeof tx.txid !== 'string' || tx.txid.toLowerCase() !== txId) {
    return reject('txid_mismatch', txId, 'independent node returned a tx body whose txid does not match the requested txid');
  }

  if (!tx.status.confirmed || !tx.status.block_hash || tx.status.block_height == null) {
    return reject('not_in_block', txId, 'transaction is not yet confirmed in a block');
  }
  const blockHash = tx.status.block_hash.toLowerCase();
  const blockHeight = tx.status.block_height;
  if (!HEX64_RE.test(blockHash)) {
    return reject('not_in_block', txId, 'transaction reported a malformed block hash');
  }

  // ── 2. Extract + verify the OP_RETURN payload ──
  const extracted = extractAnchorPayload(tx.vout);
  if (extracted == null) {
    return {
      ...reject('no_anchor_output', txId, 'no canonical Arkova OP_RETURN anchor output found'),
      blockHeight,
      blockHash,
    };
  }
  if (extracted !== expectedRoot) {
    return {
      ...reject('payload_mismatch', txId, 'OP_RETURN payload does not equal the expected Merkle root'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }

  // ── 3. Height binding ──
  if (blockHeight !== req.blockHeight) {
    return {
      ...reject('height_mismatch', txId, `tx is in a block at height ${blockHeight}, not the stated ${req.blockHeight}`),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }

  // Independent height→hash index must point at the same block (reorg guard).
  const heightResp = await safeFetch(fetch, `/block-height/${req.blockHeight}`);
  const heightHash = heightResp?.ok ? (heightResp.text ?? '').trim().toLowerCase() : '';
  if (!HEX64_RE.test(heightHash)) {
    return {
      ...reject('block_hash_mismatch', txId, 'could not resolve the stated height to a block hash'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }
  if (heightHash !== blockHash) {
    return {
      ...reject('block_hash_mismatch', txId, 'stated height maps to a different block hash (reorg)'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }

  // ── 4. Header integrity ──
  const headerResp = await safeFetch(fetch, `/block/${blockHash}/header`);
  const headerHex = headerResp?.ok ? (headerResp.text ?? '').trim().toLowerCase() : '';
  if (!HEADER_HEX_RE.test(headerHex)) {
    return {
      ...reject('header_unavailable', txId, 'block header is not 80 bytes (160-hex) or unavailable'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }
  const headerBuf = Buffer.from(headerHex, 'hex');
  if (blockHashOfHeader(headerBuf) !== blockHash) {
    return {
      ...reject('header_unavailable', txId, 'fetched header does not hash to the block hash'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
    };
  }
  const headerMerkleRoot = Buffer.from(headerBuf.subarray(36, 68)).reverse().toString('hex');

  // ── 5. Inclusion proof: recompute → header merkleroot, bound to THIS txid ──
  const proofResp = await safeFetch(fetch, `/tx/${txId}/merkle-proof`);
  if (!proofResp || !proofResp.ok || !isMerkleProof(proofResp.json)) {
    return {
      ...reject('inclusion_failed', txId, 'merkle proof unavailable'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
      blockMerkleRoot: headerMerkleRoot,
    };
  }
  const proof = proofResp.json;
  if (proof.block_height !== req.blockHeight) {
    return {
      ...reject('inclusion_failed', txId, 'merkle proof block_height does not match the stated height'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
      blockMerkleRoot: headerMerkleRoot,
    };
  }

  const recomputed = recomputeMerkleRoot(txId, proof.merkle, proof.pos);
  if (recomputed == null || recomputed !== headerMerkleRoot) {
    return {
      ...reject('inclusion_failed', txId, 'merkle proof does not recompute to the block header merkleroot'),
      blockHeight,
      blockHash,
      extractedMerkleRoot: extracted,
      blockMerkleRoot: headerMerkleRoot,
      txIndex: proof.pos,
    };
  }

  return {
    confirmed: true,
    status: 'confirmed',
    txId,
    blockHeight,
    blockHash,
    extractedMerkleRoot: extracted,
    blockMerkleRoot: headerMerkleRoot,
    txIndex: proof.pos,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Esplora transport builder
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build an {@link IndependentNodeFetch} bound to an Esplora base URL (e.g.
 * `https://blockstream.info/api`). The HTTP implementation is injectable so the
 * CLI can pass `--rpc <base>` and tests can stub `globalThis.fetch`. Both JSON
 * and raw-text bodies are captured (the header + height endpoints return text).
 */
export function createEsploraFetch(
  baseUrl: string,
  httpFetch: typeof globalThis.fetch = globalThis.fetch,
): IndependentNodeFetch {
  const base = baseUrl.replace(/\/+$/, '');
  return async (path: string): Promise<IndependentNodeResponse> => {
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    let resp: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      resp = await httpFetch(url);
    } catch {
      return { ok: false };
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status };
    }
    const raw = await resp.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    return { ok: true, status: resp.status, text: raw, json };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure Bitcoin parsing helpers (zero-dependency)
// ──────────────────────────────────────────────────────────────────────────

function sha256(b: Buffer): Buffer {
  return createHash('sha256').update(b).digest();
}
function doubleSha256(b: Buffer): Buffer {
  return sha256(sha256(b));
}

/** Block hash (display hex) = reverse(double-SHA256(80-byte header)). */
function blockHashOfHeader(header: Buffer): string {
  return Buffer.from(doubleSha256(header)).reverse().toString('hex');
}

/**
 * Extract the committed 32-byte anchor payload (the app Merkle root) from a
 * tx's outputs, or `null` if no canonical Arkova OP_RETURN output exists.
 *
 * Canonical structure (mirrors services/worker/src/chain/signet.ts):
 *   OP_RETURN (0x6a) <single direct push of N bytes> where the pushed payload
 *   is `ARKV(4) || root(32) [|| metadata]`. The 32-byte root is read at the
 *   FIXED offset [4, 36) of the push payload — NOT a substring search — so a
 *   crafted script that merely contains `ARKV||root` behind a junk byte or
 *   split across pushes is rejected.
 */
function extractAnchorPayload(vout: EsploraTx['vout']): string | null {
  for (const out of vout) {
    const hex = (out.scriptpubkey ?? '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(hex) || hex.length < 2) continue;
    const script = Buffer.from(hex, 'hex');
    const payload = decodeSingleOpReturnPush(script);
    if (payload == null) continue;
    if (payload.length < ARKV_PREFIX.length + ROOT_BYTES) continue;
    if (!payload.subarray(0, ARKV_PREFIX.length).equals(ARKV_PREFIX)) continue;
    return payload
      .subarray(ARKV_PREFIX.length, ARKV_PREFIX.length + ROOT_BYTES)
      .toString('hex');
  }
  return null;
}

/**
 * Decode a scriptPubKey of the exact form `OP_RETURN <pushdata>` and return the
 * pushed bytes, or `null` if the script is not that canonical shape. Supports
 * direct pushes (0x01–0x4b), OP_PUSHDATA1 (0x4c), and OP_PUSHDATA2 (0x4d). The
 * push must consume the script EXACTLY (no trailing opcodes), so a multi-push
 * or padded script is rejected.
 */
function decodeSingleOpReturnPush(script: Buffer): Buffer | null {
  if (script.length < 2 || script[0] !== OP_RETURN) return null;
  let offset = 1;
  const opcode = script[offset]!;
  let len: number;
  if (opcode >= 0x01 && opcode <= 0x4b) {
    len = opcode;
    offset += 1;
  } else if (opcode === 0x4c) {
    if (offset + 1 >= script.length) return null;
    len = script[offset + 1]!;
    offset += 2;
  } else if (opcode === 0x4d) {
    if (offset + 2 >= script.length) return null;
    len = script.readUInt16LE(offset + 1);
    offset += 3;
  } else {
    return null;
  }
  if (offset + len !== script.length) return null; // must consume exactly
  return script.subarray(offset, offset + len);
}

/**
 * Recompute a Bitcoin Merkle root from an Esplora inclusion proof and return it
 * as display hex, or `null` on malformed input. The proof is bound to the
 * target leaf: we start from `txId` (the matched leaf), fold each sibling in
 * order using `pos` to decide left/right at each level, and the result is
 * compared by the caller to the header's committed merkleroot. Because the fold
 * begins at the TARGET txid, a proof carrying siblings for a DIFFERENT tx in the
 * same block recomputes to a different value and is rejected.
 */
function recomputeMerkleRoot(txId: string, merkle: string[], pos: number): string | null {
  if (!HEX64_RE.test(txId)) return null;
  if (!Array.isArray(merkle) || !Number.isInteger(pos) || pos < 0) return null;
  let acc: Buffer = Buffer.from(Buffer.from(txId, 'hex').reverse()); // → internal LE
  let index = pos;
  for (const sibHex of merkle) {
    if (typeof sibHex !== 'string' || !HEX64_RE.test(sibHex)) return null;
    const sib: Buffer = Buffer.from(Buffer.from(sibHex, 'hex').reverse()); // → internal LE
    acc =
      index % 2 === 0
        ? doubleSha256(Buffer.concat([acc, sib])) // target on the left
        : doubleSha256(Buffer.concat([sib, acc])); // target on the right
    index = Math.floor(index / 2);
  }
  return Buffer.from(acc).reverse().toString('hex'); // → display hex
}

// ──────────────────────────────────────────────────────────────────────────
// Narrowing + small utilities
// ──────────────────────────────────────────────────────────────────────────

function isEsploraTx(v: unknown): v is EsploraTx {
  if (typeof v !== 'object' || v == null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.txid === 'string' &&
    typeof o.status === 'object' &&
    o.status != null &&
    Array.isArray(o.vout)
  );
}

function isMerkleProof(v: unknown): v is EsploraMerkleProof {
  if (typeof v !== 'object' || v == null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.block_height === 'number' &&
    Array.isArray(o.merkle) &&
    typeof o.pos === 'number'
  );
}

async function safeFetch(
  fetch: IndependentNodeFetch,
  path: string,
): Promise<IndependentNodeResponse | null> {
  try {
    return await fetch(path);
  } catch {
    return null;
  }
}

function reject(
  status: ConfirmInclusionStatus,
  txId: string,
  reason: string,
): ConfirmInclusionResult {
  return { confirmed: false, status, txId, reason };
}
