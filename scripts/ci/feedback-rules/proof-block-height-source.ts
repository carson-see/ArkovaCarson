#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: SCRUM-3953 — a published proof's
 * `block_height` must come from `anchors.chain_block_height`, never from
 * `anchor_proofs.block_height` in preference to it.
 *
 * WHY. `anchor_proofs.block_height` is stamped at BROADCAST from the chain TIP
 * (`broadcastSignedTx` -> `getBlockchainInfo().blocks`), not from the block the
 * transaction was mined into. On prod `vzwyaatejekddvltxyye` (2026-09-02,
 * read-only) it disagreed with `anchors.chain_block_height` on 711,027 of
 * 713,949 rows — 100% of them LOW, by the number of blocks mined between
 * broadcast and confirmation. `anchors.chain_block_height` was checked against
 * the chain itself (`getblockheader`) and matched in 44/44 sampled groups.
 *
 * This is not cosmetic. The certificate packet ships `block_height` beside a
 * `block_hash`/`block_header` read from the confirmed chain, and every Arkova
 * verifier binds the height to the chain and rejects a mismatch:
 * `arkova-py` `_height_binding_failure`, `packages/verifier`
 * `independent-node.ts`, and `packages/verifier-cli`. A wrong height is a
 * `HEIGHT_MISMATCH` FALSE NEGATIVE on a genuine, correctly anchored document —
 * the exact shape of the repo's own forgery fixture
 * (`packages/verifier-cli/fixtures/author-adversarial.py`).
 *
 * A census cannot hold this shut: the defect was a `??` operand ORDER, and the
 * correct value was already in scope at both sites and simply lost the
 * coalesce. This detector pins the order.
 *
 * Override: PR labeled `proof-block-height-reviewed`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, hasLabel, changedFiles, LABELS } from '../lib/ciContext.js';

/**
 * A proof-row height winning a coalesce over the anchor height. Matches the
 * two real historical shapes:
 *   `proofRow.block_height ?? anchor.chain_block_height`
 *   `typeof p.block_height === 'number' ? p.block_height : … data.blockHeight`
 * Whitespace/newline tolerant; the source is normalised before matching.
 */
const VIOLATION_RES: Array<{ re: RegExp; why: string }> = [
  {
    re: /\b\w*(?:proofRow|proof)\w*\.block_height\s*\?\?\s*\w+\.chain_block_height/i,
    why: 'proof-row height coalesces AHEAD of anchors.chain_block_height',
  },
  {
    re: /typeof\s+\w+\.block_height\s*===\s*'number'\s*\?\s*\w+\.block_height\s*:\s*typeof\s+\w+\.blockHeight/i,
    why: 'proof-row height is preferred over the anchor blockHeight ternary',
  },
];

/** Files whose job is to DESCRIBE the bug rather than commit it. */
function isExempt(file: string): boolean {
  return (
    file.includes('.test.') ||
    file.includes('.spec.') ||
    file.startsWith('scripts/ci/feedback-rules/') ||
    file.startsWith('docs/') ||
    file.startsWith('memory/')
  );
}

export interface Violation {
  file: string;
  line: number;
  text: string;
  why: string;
}

/**
 * Pure detector over already-read source — exported so the test can pin BOTH
 * directions (the pre-fix shape is caught, the post-fix shape is not) without
 * touching the filesystem or the CI env.
 */
export function findViolations(file: string, content: string): Violation[] {
  if (isExempt(file)) return [];
  // Strip line comments so a comment QUOTING the old shape (this fix leaves
  // several, deliberately) is never reported as the shape itself.
  const lines = content.split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const violations: Violation[] = [];
  // Join a small sliding window so a multi-line ternary is still matched.
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 5).join(' ').replace(/\s+/g, ' ');
    for (const { re, why } of VIOLATION_RES) {
      if (re.test(window)) {
        violations.push({ file, line: i + 1, text: lines[i].trim(), why });
        break;
      }
    }
  }
  // One report per file is enough; the window overlaps by design.
  return violations.slice(0, 1);
}

function checkFile(file: string): Violation[] {
  if (isExempt(file)) return [];
  try {
    return findViolations(file, readFileSync(resolve(REPO, file), 'utf8'));
  } catch {
    return [];
  }
}

export function run(): { ok: boolean; message: string } {
  const overridden = hasLabel(LABELS.proofBlockHeightReviewed);
  const violations = changedFiles()
    .filter((f) => /\.(tsx?)$/.test(f))
    .flatMap(checkFile);

  if (violations.length === 0) {
    return {
      ok: true,
      message: '✅ proof-block-height-source: no proof-row height outranks anchors.chain_block_height.',
    };
  }

  const out = [`Detected ${violations.length} proof block_height provenance violation(s):`];
  for (const v of violations) out.push(`  ${v.file}:${v.line}  ${v.why}\n    ${v.text}`);

  if (overridden) {
    out.push(`\n⚠️  PR labeled \`${LABELS.proofBlockHeightReviewed}\` — allowing.`);
    return { ok: true, message: out.join('\n') };
  }

  out.push('');
  out.push('::error::SCRUM-3953: a published proof block_height must come from');
  out.push('  anchors.chain_block_height. anchor_proofs.block_height is the BROADCAST-time');
  out.push('  chain tip and was wrong on 711,027 of 713,949 prod rows — shipping it makes a');
  out.push('  genuine anchor fail verification with HEIGHT_MISMATCH.');
  return { ok: false, message: out.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
