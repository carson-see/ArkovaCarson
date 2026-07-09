/**
 * S3-B frozen machine reason codes (reason_enum_version 1.0.0).
 *
 * Every NOT-VERIFIED verdict maps to exactly ONE of these codes, mirrored
 * byte-for-byte in `fixtures/manifest.json` (`reason_codes`) and re-derived
 * independently by the Python verifier (`packages/arkova-py/src/arkova/proofs.py`).
 * The enum is FROZEN: additions are appended (never renamed/reordered) and bump
 * `reason_enum_version`; test/manifest.test.ts pins the freeze.
 *
 * Two mapping layers feed it:
 *   - `recomputeReasonCode` maps the vendored worker recompute reasons
 *     (src/vendor/merkle-verify.ts — a byte-identity-guarded copy, so these
 *     strings can only change when the worker itself changes and the sync test
 *     forces this mapping to be revisited);
 *   - `chainReasonCode` maps `@arkova/verifier` ConfirmInclusionStatus values.
 *
 * Codes are machine-readable JSON output only — the human report keeps the
 * terminology-ban-compliant prose (§1.3).
 */

import type { ConfirmInclusionStatus } from '@arkova/verifier';

export const REASON_CODES = [
  'MALFORMED_BUNDLE',
  'UNSUPPORTED_SCHEMA_VERSION',
  'EMPTY_BRANCH_UNVERIFIABLE',
  'MERKLE_MISMATCH',
  'FORGED_SELF_PAIR',
  'LEAF_INDEX_OUT_OF_RANGE',
  'TX_NOT_FOUND',
  'NOT_IN_BLOCK',
  'TXID_MISMATCH',
  'NO_ANCHOR_OUTPUT',
  'PAYLOAD_MISMATCH',
  'HEIGHT_MISMATCH',
  'BLOCK_HASH_MISMATCH',
  'HEADER_INVALID',
  'ROOT_NOT_IN_HEADER',
  'TIMESTAMP_MISMATCH',
  'SIG_INVALID',
  'DID_UNRESOLVED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Map a vendored `verifyMerkleInclusion` failure reason to a frozen code.
 * Unknown/absent reasons fail closed to MERKLE_MISMATCH (a failed recompute is
 * still a failed recompute — never a pass, never a crash).
 */
export function recomputeReasonCode(reason: string | undefined): ReasonCode {
  if (!reason) return 'MERKLE_MISMATCH';
  if (
    reason.includes('invalid leaf format') ||
    reason.includes('invalid root format') ||
    reason.includes('invalid sibling format') ||
    reason.includes('invalid position') ||
    reason.includes('not an array')
  ) {
    return 'MALFORMED_BUNDLE';
  }
  if (reason.includes('out of range')) return 'LEAF_INDEX_OUT_OF_RANGE';
  if (reason.includes('empty branch')) return 'EMPTY_BRANCH_UNVERIFIABLE';
  if (reason.includes('CVE-2012-2459')) return 'FORGED_SELF_PAIR';
  return 'MERKLE_MISMATCH';
}

/** Map an independent-node confirmation status to a frozen code. */
export function chainReasonCode(status: Exclude<ConfirmInclusionStatus, 'confirmed'>): ReasonCode {
  switch (status) {
    case 'bad_request':
      return 'MALFORMED_BUNDLE';
    case 'tx_not_found':
      return 'TX_NOT_FOUND';
    case 'not_in_block':
      return 'NOT_IN_BLOCK';
    case 'txid_mismatch':
      return 'TXID_MISMATCH';
    case 'no_anchor_output':
      return 'NO_ANCHOR_OUTPUT';
    case 'payload_mismatch':
      return 'PAYLOAD_MISMATCH';
    case 'height_mismatch':
      return 'HEIGHT_MISMATCH';
    case 'block_hash_mismatch':
      return 'BLOCK_HASH_MISMATCH';
    case 'header_unavailable':
      return 'HEADER_INVALID';
    case 'inclusion_failed':
      return 'ROOT_NOT_IN_HEADER';
  }
}
