#!/usr/bin/env -S npx tsx
/**
 * agents.md append-only gate — catches silent union-merge content drops.
 *
 * `.gitattributes` declares `agents.md merge=union` so parallel PRs can append
 * to the same notes file without pairwise conflicts. On 2026-07-28 we found a
 * `merge.union.driver = true` entry in the shared `.git/config`: naming a
 * BUILT-IN driver overrides git's real union algorithm, and `true` is a no-op
 * that exits 0 without writing %A. Git recorded clean merges while keeping
 * "ours" and discarding every line unique to "theirs" — silently, for months
 * (169 lines lost off main across 31 commits; 4 open PRs still carrying drops).
 *
 * The local config is fixed and `scripts/agent/check-git-merge-config.sh`
 * blocks its return. This gate is the backstop that does not care about the
 * CAUSE: agents.md is append-only by convention, so a line present in the
 * merge base but absent from the head is content this branch DELETED — and a
 * deletion recorded in branch history propagates to main on merge.
 *
 * Edits are legitimate and must not trip the gate: a reworded line is matched
 * back to its base line by token similarity, so only wholesale disappearances
 * are reported.
 *
 * Override: PR label `agents-md-deletion-approved` (deliberate consolidation).
 * Exit 0 = pass, 1 = violation, 2 = config error.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isMainModule } from './lib/ciContext.js';

const REPO = process.env.AGENTS_MD_LINT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const OVERRIDE_LABEL = 'agents-md-deletion-approved';

/** Footers are rewritten on every edit by design — never a "drop". */
const IGNORED_LINE_RE = /^_Last updated:/;
/** Below this length a line carries no distinguishing content (bullets, `---`, `|---|`). */
const MIN_SIGNIFICANT_LENGTH = 20;
/** Best-match token overlap at or above this reads as "edited", not "deleted". */
const EDIT_SIMILARITY_THRESHOLD = 0.5;

export interface Drop {
  file: string;
  line: string;
}

function git(args: string[], cwd = REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOrNull(args: string[], cwd = REPO): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function tokens(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

/** Jaccard overlap; 1 = identical token sets, 0 = disjoint. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Lines that vanished between `baseText` and `headText` without a plausible
 * edited counterpart surviving in the head.
 */
export function findDrops(baseText: string, headText: string): string[] {
  const headLines = headText.split('\n');
  const headSet = new Set(headLines);
  const candidates = baseText
    .split('\n')
    .filter(
      (l) =>
        l.trim().length >= MIN_SIGNIFICANT_LENGTH &&
        !IGNORED_LINE_RE.test(l.trim()) &&
        !headSet.has(l),
    );
  if (candidates.length === 0) return [];

  // Only compare against head lines absent from base: an edit REPLACES a line,
  // so its counterpart is necessarily new. Comparing against unchanged lines
  // would let any similar-looking neighbour mask a real deletion.
  const baseSet = new Set(baseText.split('\n'));
  const newHeadTokens = headLines
    .filter((l) => !baseSet.has(l) && l.trim().length >= MIN_SIGNIFICANT_LENGTH)
    .map(tokens);

  return candidates.filter((line) => {
    const t = tokens(line);
    return !newHeadTokens.some((h) => similarity(t, h) >= EDIT_SIMILARITY_THRESHOLD);
  });
}

function show(rev: string, path: string): string | null {
  return gitOrNull(['show', `${rev}:${path}`]);
}

export function auditRange(baseRev: string, headRev: string): Drop[] {
  const paths = git(['ls-tree', '-r', '--name-only', baseRev])
    .split('\n')
    .filter((p) => p.endsWith('agents.md'));

  const drops: Drop[] = [];
  for (const file of paths) {
    const baseText = show(baseRev, file);
    const headText = show(headRev, file);
    // Absent on either side = added or intentionally removed file, not a merge drop.
    if (baseText === null || headText === null) continue;
    for (const line of findDrops(baseText, headText)) drops.push({ file, line });
  }
  return drops;
}

function main(): void {
  const labels = (process.env.PR_LABELS ?? '').split(',').map((l) => l.trim());
  if (labels.includes(OVERRIDE_LABEL)) {
    console.log(`::notice title=agents.md append-only::Skipped via '${OVERRIDE_LABEL}' label.`);
    return;
  }

  const explicitBase = process.env.BASE_REF_SHA?.trim();
  const baseSha = explicitBase || 'origin/main';
  const headSha = process.env.HEAD_REF_SHA ?? 'HEAD';

  const mergeBase = gitOrNull(['merge-base', baseSha, headSha])?.trim();
  if (!mergeBase) {
    // No PR base (push-to-main, tag build) means there is no "theirs" side to
    // have lost — skip rather than fail the run. An explicitly supplied base
    // that cannot be resolved IS a config error worth surfacing.
    if (explicitBase) {
      console.error(`::error::Could not resolve merge-base of ${baseSha}...${headSha}.`);
      process.exit(2);
    }
    console.log('::notice title=agents.md append-only::No PR base to compare against — skipped.');
    return;
  }

  const drops = auditRange(mergeBase, headSha);
  if (drops.length === 0) {
    console.log('::notice title=agents.md append-only::No dropped agents.md content.');
    return;
  }

  const byFile = new Map<string, string[]>();
  for (const d of drops) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.line]);

  for (const [file, lines] of byFile) {
    console.error(
      `::error file=${file}::${lines.length} line(s) present in merge-base ` +
        `${mergeBase.slice(0, 8)} but MISSING at head — agents.md is append-only, so this ` +
        'branch deletes them from main on merge. Restore them, or apply the ' +
        `'${OVERRIDE_LABEL}' label if the removal is deliberate.`,
    );
    for (const line of lines.slice(0, 10)) console.error(`  - ${line.slice(0, 200)}`);
    if (lines.length > 10) console.error(`  ... +${lines.length - 10} more`);
  }

  console.error(
    `\nRecover the exact content with:\n  git show ${mergeBase.slice(0, 12)}:<file> > <file>\n` +
      'then re-apply this branch\'s own additions on top.',
  );
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) main();
