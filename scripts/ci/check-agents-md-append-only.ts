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
 * (86 lines lost off main across 19 commits; 3 open PRs still carrying drops).
 *
 * The local config is fixed and `scripts/agent/check-git-merge-config.sh`
 * blocks its return. This gate is the backstop that does not care about the
 * CAUSE: agents.md is append-only by convention, so a line present in the
 * merge base but absent from the head is content this branch DELETED — and a
 * deletion recorded in branch history propagates to main on merge.
 *
 * Edits are legitimate and must not trip the gate, so a vanished line is first
 * matched back to a surviving counterpart two ways: a markdown table row by its
 * first cell (its identity), any other line by token similarity. Each surviving
 * line can account for at most one vanished line. Only genuinely unmatched
 * disappearances are reported.
 *
 * Override: PR label `agents-md-deletion-approved` (deliberate consolidation).
 * Exit 0 = pass, 1 = violation, 2 = config error.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isMainModule, hasLabel } from './lib/ciContext.js';

const REPO = process.env.AGENTS_MD_LINT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const OVERRIDE_LABEL = 'agents-md-deletion-approved';

/** Footers are rewritten on every edit by design — never a "drop". */
const IGNORED_LINE_RE = /^_Last updated:/;
/** Below this length a line carries no distinguishing content (bullets, `---`, `|---|`). */
const MIN_SIGNIFICANT_LENGTH = 20;
/** Best-match token overlap at or above this reads as "edited", not "deleted". */
const EDIT_SIMILARITY_THRESHOLD = 0.5;
/** A shared leading run this long (and this much of the base line) reads as an edit. */
const MIN_EDIT_PREFIX = 40;
const MIN_EDIT_PREFIX_RATIO = 0.5;

export interface Drop {
  file: string;
  line: string;
}

function git(args: string[], cwd = REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Like {@link git}, but returns null instead of throwing — and silences stderr.
 * The expected-miss cases (a file added or deleted by this PR, so absent from
 * one side) make `git show` print `fatal: path … does not exist`, which would
 * otherwise spam the CI log with alarming-looking noise on every such PR.
 */
function gitOrNull(args: string[], cwd = REPO): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function tokens(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

/**
 * First cell of a markdown table row, lowercased and stripped of backticks —
 * the row's identity. Migration-ledger rows are keyed this way (`| \`0361\` | …`)
 * and get rewritten wholesale when a reservation is claimed, struck, or
 * renumbered; the prose can change past any similarity threshold while the row
 * plainly still exists. Returns null for anything that is not a table row.
 */
function tableRowKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const first = trimmed.slice(1).split('|')[0]?.replace(/`/g, '').trim().toLowerCase();
  // Ignore separator rows (`|---|---|`) and empty leading cells, which carry no identity.
  if (!first || /^:?-+:?$/.test(first)) return null;
  return first;
}

/** Jaccard overlap; 1 = identical token sets, 0 = disjoint. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * How strongly `head` reads as an edited form of `base`; 0 = unrelated.
 *
 * Jaccard alone is not enough. The dominant real edit is "keep the line and
 * append to it" (`- \`FileUpload.tsx\` — …` gaining a new clause), and appending
 * text drives symmetric overlap DOWN — a substantial addition pushes a genuine
 * edit below any threshold loose enough to still catch real deletions. A long
 * shared prefix identifies that case directly, so score it first and fall back
 * to token overlap for edits that rewrite the front of the line.
 */
function editScore(base: string, head: string): number {
  const prefix = commonPrefixLength(base, head);
  const significant = base.trim().length;
  if (prefix >= MIN_EDIT_PREFIX && prefix >= significant * MIN_EDIT_PREFIX_RATIO) {
    return 1 + prefix; // prefix matches outrank token matches, longest prefix wins
  }
  const score = similarity(tokens(base), tokens(head));
  return score >= EDIT_SIMILARITY_THRESHOLD ? score : 0;
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
  const newHeadLines = headLines.filter(
    (l) => !baseSet.has(l) && l.trim().length >= MIN_SIGNIFICANT_LENGTH,
  );
  const newHeadKeys = newHeadLines.map(tableRowKey);
  // Each new head line is the rewrite of at most ONE base line. Without this,
  // a single unrelated addition could absorb every deletion in the file.
  const claimed = new Array(newHeadLines.length).fill(false);

  const drops: string[] = [];
  for (const line of candidates) {
    const key = tableRowKey(line);
    let match = -1;

    if (key !== null) {
      // A table row's identity IS its first cell. Match on that alone and never
      // fall back to prose scoring: ledger rows share so much boilerplate
      // ("RESERVED — pre-soak, file-only") that an unrelated NEW row would
      // otherwise look like a rewrite of the deleted one and hide a real drop.
      match = newHeadKeys.findIndex((k, i) => !claimed[i] && k === key);
    } else {
      let bestScore = 0;
      newHeadLines.forEach((h, i) => {
        if (claimed[i] || newHeadKeys[i] !== null) return;
        const score = editScore(line, h);
        if (score > bestScore) {
          bestScore = score;
          match = i;
        }
      });
    }

    if (match === -1) drops.push(line);
    else claimed[match] = true;
  }
  return drops;
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
  // hasLabel() unions the frozen PR_LABELS payload with a live label fetch.
  // Reading PR_LABELS alone would mean the override does not take effect on a
  // plain re-run (no new webhook delivery) — the frozen-payload bug PR #1336 fixed.
  if (hasLabel(OVERRIDE_LABEL)) {
    console.log(`::notice title=agents.md append-only::Skipped via '${OVERRIDE_LABEL}' label.`);
    return;
  }

  const explicitBase = process.env.BASE_REF_SHA?.trim();
  const eventName = process.env.GITHUB_EVENT_NAME;
  // This job also runs on push to main/staging/develop, where the PR payload —
  // and so BASE_REF_SHA — is empty. Falling back to origin/main there would
  // diff a diverged branch against main and fail on unrelated history rather
  // than on anything this push did. Only a PR has a meaningful "theirs" side.
  if (!explicitBase && eventName && eventName !== 'pull_request') {
    console.log(
      `::notice title=agents.md append-only::Not a pull_request event (${eventName}) — skipped.`,
    );
    return;
  }

  // No GITHUB_EVENT_NAME means a local run; origin/main is the useful default there.
  const baseSha = explicitBase || 'origin/main';
  const headSha = process.env.HEAD_REF_SHA ?? 'HEAD';

  const mergeBase = gitOrNull(['merge-base', baseSha, headSha])?.trim();
  if (!mergeBase) {
    // An explicitly supplied base that cannot be resolved IS a config error.
    if (explicitBase) {
      console.error(`::error::Could not resolve merge-base of ${baseSha}...${headSha}.`);
      process.exit(2);
    }
    console.log('::notice title=agents.md append-only::No base to compare against — skipped.');
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
