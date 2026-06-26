/**
 * Hardened Merkle inclusion verifier (PROOF-VERIFY / SCRUM-2490).
 *
 * `api/v1/verify-proof.ts` sets the `verified` field from this function —
 * a CRYPTOGRAPHIC recompute-and-compare, **never** from `anchors.status`.
 * The pre-mortem K1 kill-shot was exactly "`verified` is derived from
 * status and nothing recomputes the root"; this closes it.
 *
 * ## What it recomputes
 *
 * It walks the inclusion branch from the document fingerprint up to the
 * root using the SAME hashing rule as `utils/merkle.ts::buildMerkleTree`:
 * plain double-SHA256 over the positional concatenation of the running
 * hash and the sibling. This MUST match `buildMerkleTree`, because that is
 * the rule under which the on-chain Merkle root was committed — the ~2.97M
 * already-SECURED anchors (PROOF-01 §4 back-catalog) can only be verified
 * against the bytes that were actually anchored. (Hence we do NOT use the
 * RFC-6962 tagged hashing below for the v1 verdict.)
 *
 * ## Hardening on top of recomputation (PROOF-01 §3)
 *
 *  1. **Leaf/internal length domain separation.** The leaf and every
 *     sibling must be exactly 32 bytes (64 hex). A malformed short/long
 *     value can never be walked as a hash.
 *  2. **CVE-2012-2459 duplicated-leaf guard.** `buildMerkleTree` duplicates
 *     the last element on odd levels (Bitcoin convention), so a node can
 *     legitimately self-pair (sibling == running hash) — but ONLY when it
 *     is the rightmost node of an odd-sized level. An attacker can abuse
 *     the duplication to present a forged branch whose sibling equals the
 *     running hash at some OTHER position, fabricating an inclusion path.
 *     When the leaf's position (`merkle_index`) and the tree `leafCount`
 *     are supplied, we reconstruct the level sizes and REJECT any self-pair
 *     that is not at a legitimate rightmost-odd position. When they are not
 *     supplied (legacy rows pre-FIX-1, callers without index/count) we fall
 *     back to recompute-and-compare only: a self-pair is tolerated because
 *     the verdict still pins the exact document fingerprint against the
 *     committed root, but the structural forgery guard is inactive — see
 *     residual-risk note in the PR.
 *  3. **Empty branch ⇒ single-leaf tree.** An empty branch is only valid
 *     when the root equals the leaf (matches `buildMerkleTree`'s n===1
 *     case: `root = fingerprint`, `proof = []`).
 *
 * ## RFC-6962 tagged hashing (future proof_schema_version=2)
 *
 * `hashLeafTagged` / `hashNodeTagged` implement certificate-transparency
 * style tagged hashing (leaf = H(0x00‖data), node = H(0x01‖l‖r)), giving
 * cryptographic leaf/internal domain separation at the HASH level. They are
 * intentionally NOT wired into the v1 verdict: adopting them changes the
 * root computation and therefore the on-chain bytes, which is irreversible
 * and gated behind the PROOF-01 §4 OP_RETURN version-byte decision (DISC
 * scope). They are exported + tested now so the v2 format is ready the
 * moment that byte is decided.
 */

import { createHash } from 'node:crypto';
import type { MerkleProofEntry } from './merkle.js';

/** SHA-256 of a buffer. */
function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Double-SHA-256 (Bitcoin standard). */
function doubleSha256(data: Uint8Array): Buffer {
  return sha256(sha256(data));
}

/** Exactly 64 hex chars (case-insensitive) == 32 bytes. */
const HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;

export interface MerkleInclusionOptions {
  /** Integer leaf index (PROOF-01 `merkle_index`). Enables the structural CVE guard. */
  leafIndex?: number;
  /** Total number of leaves in the batch tree. Enables the structural CVE guard. */
  leafCount?: number;
}

export interface MerkleInclusionResult {
  valid: boolean;
  /** Machine-stable short reason on failure (never leaks document bytes). */
  reason?: string;
}

/**
 * Recompute the Merkle root from a document fingerprint walking the
 * inclusion branch, and compare it to the committed root.
 *
 * Returns `{ valid: true }` ONLY when the recomputed root equals `root`
 * and all hardening checks pass. The verdict is purely cryptographic.
 *
 * @param leafHex   document fingerprint (64-hex, lowercase or upper)
 * @param branch    inclusion branch (sibling hash + position per level)
 * @param rootHex   the Merkle root committed on-chain (64-hex)
 * @param opts      optional leaf index + leaf count for the structural
 *                  CVE-2012-2459 guard (see module docstring)
 */
export function verifyMerkleInclusion(
  leafHex: string,
  branch: MerkleProofEntry[],
  rootHex: string,
  opts: MerkleInclusionOptions = {},
): MerkleInclusionResult {
  if (typeof leafHex !== 'string' || !HASH_HEX_RE.test(leafHex)) {
    return { valid: false, reason: 'leaf is not 64-hex (32-byte) — invalid leaf format' };
  }
  if (typeof rootHex !== 'string' || !HASH_HEX_RE.test(rootHex)) {
    return { valid: false, reason: 'root is not 64-hex (32-byte) — invalid root format' };
  }
  if (!Array.isArray(branch)) {
    return { valid: false, reason: 'branch is not an array' };
  }

  const leaf = leafHex.toLowerCase();
  const root = rootHex.toLowerCase();

  // Structural CVE guard is active only when BOTH index + count are valid.
  const structural =
    Number.isInteger(opts.leafIndex) &&
    Number.isInteger(opts.leafCount) &&
    (opts.leafCount as number) >= 1;
  if (structural) {
    const idx = opts.leafIndex as number;
    const count = opts.leafCount as number;
    if (idx < 0 || idx >= count) {
      return { valid: false, reason: `leafIndex ${idx} out of range for leafCount ${count}` };
    }
  }

  // Empty branch ⇒ single-leaf tree: root must equal the leaf.
  if (branch.length === 0) {
    return leaf === root
      ? { valid: true }
      : { valid: false, reason: 'empty branch (single-leaf tree) but root != leaf' };
  }

  let current: Uint8Array = Buffer.from(leaf, 'hex');
  let levelIndex = structural ? (opts.leafIndex as number) : 0;
  let levelSize = structural ? (opts.leafCount as number) : 0;

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry == null || typeof entry.hash !== 'string' || !HASH_HEX_RE.test(entry.hash)) {
      return { valid: false, reason: `branch[${i}] sibling is not 64-hex (32-byte) — invalid sibling format` };
    }
    if (entry.position !== 'left' && entry.position !== 'right') {
      return { valid: false, reason: `branch[${i}] has invalid position` };
    }

    const sibling = Buffer.from(entry.hash.toLowerCase(), 'hex');
    const selfPair = sibling.equals(current);

    if (structural) {
      // A node is the rightmost element of its level when its index is the
      // last one (== levelSize - 1); buildMerkleTree duplicates it when the
      // level size is odd, producing a legitimate self-pair.
      const isRightmostOddNode = levelIndex === levelSize - 1 && levelSize % 2 === 1;
      if (selfPair && !isRightmostOddNode) {
        return {
          valid: false,
          reason: `branch[${i}] sibling equals running hash at a non-duplicated position — forged self-pair rejected (CVE-2012-2459)`,
        };
      }
      // Advance to the parent level.
      levelIndex = Math.floor(levelIndex / 2);
      levelSize = Math.ceil(levelSize / 2);
    }

    current =
      entry.position === 'right'
        ? doubleSha256(Buffer.concat([current, sibling]))
        : doubleSha256(Buffer.concat([sibling, current]));
  }

  return Buffer.from(current).toString('hex') === root
    ? { valid: true }
    : { valid: false, reason: 'recomputed root does not match committed merkle_root' };
}

// ---------------------------------------------------------------------------
// RFC-6962 tagged hashing — FUTURE proof_schema_version=2 ONLY.
// Not wired into the v1 verdict (would change on-chain root bytes; gated
// behind PROOF-01 §4 OP_RETURN version-byte decision).
// ---------------------------------------------------------------------------

const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);

/** Tagged leaf hash: double-SHA256(0x00 ‖ data). */
export function hashLeafTagged(data: Uint8Array): string {
  return doubleSha256(Buffer.concat([LEAF_TAG, Buffer.from(data)])).toString('hex');
}

/** Tagged internal-node hash: double-SHA256(0x01 ‖ left ‖ right). */
export function hashNodeTagged(left: Uint8Array, right: Uint8Array): string {
  return doubleSha256(
    Buffer.concat([NODE_TAG, Buffer.from(left), Buffer.from(right)]),
  ).toString('hex');
}
