#!/usr/bin/env -S npx tsx
/**
 * S0-4.3 — Migration `agents.md` collision lint (CLAUDE.md §6).
 *
 * Two PRs each appending a bare `## Recent migrations` block at EOF of
 * supabase/migrations/agents.md collide on merge — the loser gets dequeued
 * from Mergify (this hit #1031 behind #1022 on 2026-06-01). The §6 rule:
 * title each block `## Recent migrations (PR #NNNN)`. This lint enforces it:
 *   - every `## Recent migrations` header must carry a `(PR #NNNN)` discriminator;
 *   - no two blocks may share the same PR number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isMainModule } from './lib/ciContext.js';

const REPO = process.env.AGENTS_MD_LINT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const TARGET = join(REPO, 'supabase', 'migrations', 'agents.md');

export interface Violation {
  code: string;
  message: string;
}

const RECENT_HEADER_RE = /^##\s+Recent migrations(.*)$/;
/** Any parenthetical with non-whitespace content: (PR #1031), (SCRUM-2044), etc. */
const DISCRIMINATOR_RE = /\([^)]*\S[^)]*\)/;

/**
 * The §6 rule's intent: every `## Recent migrations` block is UNIQUELY titled
 * so two concurrent EOF appends cannot collide. We therefore require (a) some
 * parenthetical discriminator (a PR number or SCRUM id both qualify) and
 * (b) no two identical header lines — not a rigid `(PR #NNNN)` form, which
 * would false-positive on the legitimate historical blocks already in the file.
 */
export function auditAgentsMd(content: string): Violation[] {
  const violations: Violation[] = [];
  const headerCounts = new Map<string, number>();

  for (const line of content.split('\n')) {
    const m = line.match(RECENT_HEADER_RE);
    if (!m) continue;
    const header = line.trim();
    headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1);
    if (!DISCRIMINATOR_RE.test(m[1])) {
      violations.push({
        code: 'recent-migrations-missing-discriminator',
        message:
          `"${header}" has no (…) discriminator. Title each block uniquely, ` +
          'e.g. `## Recent migrations (PR #NNNN)` (CLAUDE.md §6), so concurrent appends do not collide.',
      });
    }
  }

  for (const [header, count] of headerCounts) {
    if (count > 1) {
      violations.push({
        code: 'recent-migrations-duplicate-header',
        message: `${count} identical "${header}" headers — a concurrent append collided; renumber or merge the blocks.`,
      });
    }
  }

  return violations;
}

function main(): void {
  if (!existsSync(TARGET)) {
    console.log('::notice::No supabase/migrations/agents.md — nothing to lint.');
    return;
  }
  const violations = auditAgentsMd(readFileSync(TARGET, 'utf8'));
  if (violations.length === 0) {
    console.log('::notice title=agents.md OK::Recent-migrations blocks are PR-discriminated (CLAUDE.md §6).');
    return;
  }
  for (const v of violations) console.error(`::error::${v.code}: ${v.message}`);
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) main();
