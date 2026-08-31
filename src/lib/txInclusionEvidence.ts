/**
 * Layer-2 BITCOIN-tree inclusion evidence — the ONE frontend reader.
 *
 * Migration 0427 persists `anchor_proofs.tx_inclusion_branch` +
 * `tx_block_index` so a holder can close the transaction→block half of the
 * proof LOCALLY instead of asking a Bitcoin node. Two modules in this package
 * hand that evidence to a holder — `sourceProofInput.ts` (the DB read) and
 * `generateAuditReport.ts` (the downloadable packet) — and they had two
 * different ideas of what a usable branch is: the packet builder mapped the two
 * fields independently and asked only `typeof hash === 'string'`, so
 * `[{"hash":"","position":"left"}]` shipped inside the holder's PDF as genuine
 * inclusion evidence. That is the same defect the API reader closes, on the one
 * surface with no server between it and the auditor.
 *
 * So there is one implementation, here, and both import it. It is deliberately
 * the SAME rule the worker applies on read (`api/v1/verify-proof.ts`) and on
 * write (`utils/anchorProofs.ts`), and that the SDK and verifier CLI apply:
 *
 *   1. BOTH-OR-NEITHER. Half a pair is not evidence.
 *   2. Every sibling is EXACTLY 64 hex characters. A value that is not 32 bytes
 *      cannot take part in a double-SHA256 fold at all.
 *   3. RANGE. A branch of length L describes a tree of height L, so the index
 *      must satisfy `0 <= index < 2^L` (L = 0 ⇒ a single-transaction block ⇒
 *      index 0).
 *   4. AGREEMENT. The index's bit at each level fixes that level's sibling side
 *      (even ⇒ sibling on the right), which is what lets a verifier re-derive
 *      the fold order and reject a branch that disagrees.
 *
 * Any violation ⇒ BOTH null. Never a partial, never a fabricated pairing
 * (Constitution §1.5: measured, not asserted). An EMPTY array with index 0 is
 * COMPLETE evidence, not missing evidence.
 *
 * ORIENTATION: these hashes are BYTE-REVERSED (display) hex folded with
 * Bitcoin's double-SHA256 positional rule — a DIFFERENT convention from
 * `merkle_proof`, which is the layer-1 APP tree in its stored orientation.
 * Folding one with the other's rule typechecks and proves nothing, which is why
 * the two never share a name.
 */

import type { MerkleProofEntry } from './generateAuditReport';

/** A 32-byte hash in display hex — the only shape a bitcoin-tree sibling takes. */
const SIBLING_HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** Type guard: a value is a well-formed `{ hash, position }` entry. */
function isEntry(v: unknown): v is MerkleProofEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.hash === 'string' && (e.position === 'left' || e.position === 'right');
}

/**
 * Read a stored branch + index as ONE fact. Returns `null` unless the pair is
 * present, well-formed, in range, and self-consistent — see the module header.
 */
export function readTxInclusionEvidence(
  branchValue: unknown,
  indexValue: unknown,
): { branch: MerkleProofEntry[]; index: number } | null {
  if (!Array.isArray(branchValue)) return null;
  if (!branchValue.every(isEntry)) return null;
  if (typeof indexValue !== 'number' || !Number.isInteger(indexValue) || indexValue < 0) return null;
  // Guard the shift: a branch long enough to overflow it is malformed on its face.
  if (branchValue.length > 31) return null;
  if (indexValue >= 1 << branchValue.length) return null;

  for (let level = 0; level < branchValue.length; level++) {
    if (!SIBLING_HASH_HEX_RE.test(branchValue[level].hash)) return null;
    const expected = ((indexValue >> level) & 1) === 0 ? 'right' : 'left';
    if (branchValue[level].position !== expected) return null;
  }
  return { branch: branchValue, index: indexValue };
}
