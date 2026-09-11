/**
 * SCRUM-3953 ratchet tests.
 *
 * The point of a detector is that it catches the thing that actually happened.
 * These pin BOTH directions against the REAL pre-fix and post-fix source lines,
 * so a future edit that reverts the coalesce order turns CI red rather than
 * quietly re-shipping a height that fails chain verification.
 */
import { describe, it, expect } from 'vitest';
import { findViolations } from './proof-block-height-source.js';

// The exact line that shipped the bug in src/lib/sourceProofInput.ts.
const PRE_FIX_SOURCE_PROOF_INPUT = `
  const proof: ProofInput = {
    tx_id: anchor.chain_tx_id ?? proofRow.receipt_id ?? null,
    block_height: proofRow.block_height ?? anchor.chain_block_height ?? null,
    block_hash: proofRow.block_hash,
  };
`;

// The exact ternary that shipped the bug in src/lib/generateAuditReport.ts.
const PRE_FIX_BUILD_PACKET = `
    block_height:
      typeof p.block_height === 'number'
        ? p.block_height
        : typeof data.blockHeight === 'number'
          ? data.blockHeight
          : null,
`;

const POST_FIX_SOURCE_PROOF_INPUT = `
    block_height: anchor.chain_block_height ?? proofRow.block_height ?? null,
`;

const POST_FIX_BUILD_PACKET = `
    block_height:
      typeof data.blockHeight === 'number'
        ? data.blockHeight
        : typeof p.block_height === 'number'
          ? p.block_height
          : null,
`;

describe('proof-block-height-source detector', () => {
  it('catches the pre-fix sourceProofInput coalesce order', () => {
    const found = findViolations('src/lib/sourceProofInput.ts', PRE_FIX_SOURCE_PROOF_INPUT);
    expect(found).toHaveLength(1);
    expect(found[0].why).toMatch(/coalesces AHEAD/);
  });

  it('catches the pre-fix buildProofPacket ternary order', () => {
    const found = findViolations('src/lib/generateAuditReport.ts', PRE_FIX_BUILD_PACKET);
    expect(found).toHaveLength(1);
  });

  it('passes the post-fix sourceProofInput order', () => {
    expect(findViolations('src/lib/sourceProofInput.ts', POST_FIX_SOURCE_PROOF_INPUT)).toEqual([]);
  });

  it('passes the post-fix buildProofPacket order', () => {
    expect(findViolations('src/lib/generateAuditReport.ts', POST_FIX_BUILD_PACKET)).toEqual([]);
  });

  it('does not fire on a comment that QUOTES the old shape', () => {
    const commentOnly = `
      // SCRUM-3953: was proofRow.block_height ?? anchor.chain_block_height
      block_height: anchor.chain_block_height ?? proofRow.block_height ?? null,
    `;
    expect(findViolations('src/lib/sourceProofInput.ts', commentOnly)).toEqual([]);
  });

  it('exempts test files and the rule itself', () => {
    expect(findViolations('src/lib/sourceProofInput.test.ts', PRE_FIX_SOURCE_PROOF_INPUT)).toEqual([]);
    expect(
      findViolations('scripts/ci/feedback-rules/proof-block-height-source.ts', PRE_FIX_SOURCE_PROOF_INPUT),
    ).toEqual([]);
  });
});
