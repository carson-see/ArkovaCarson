#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1252 (R0-6) — HANDOFF.md verification-artifact lint.
 *
 * Runs on any PR touching HANDOFF.md. Parses the diff for sentence patterns
 * that assert prod state and requires a verification artifact link in the
 * SAME PR description or commit body. Fails the PR otherwise.
 *
 * Why: commit 9cbce957 (2026-04-24 16:16) overrode PR #506's truthful
 * "manual application required" with fabricated "applied on prod via
 * Supabase MCP — verified via pg_indexes query" 4 hours later. The
 * "verified via" query result has no source. Same pattern: HANDOFF
 * asserted revision arkova-worker-00397-9jm "deployed, healthy" — that
 * revision number does not exist on Cloud Run.
 *
 * Override: PR labeled `handoff-narrative-only` (acceptable for prose-style
 * retrospectives that don't claim live state).
 *
 * Also: every HANDOFF.md edit must include a footer
 *   `_Last refreshed: YYYY-MM-DD by <author> — claims verified against gcloud/MCP/CI output._`
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, GIT_BIN, getBaseRef, prBody as PR_BODY, prCommitsMsgs as PR_COMMITS_MSGS, hasLabel, LABELS } from './lib/ciContext.js';

const HANDOFF_PATH = resolve(REPO, 'HANDOFF.md');

interface ClaimPattern {
  id: string;
  description: string;
  regex: RegExp;
  artifactPatterns: RegExp[];
}

const PATTERNS: ClaimPattern[] = [
  {
    id: 'cloudrun-revision',
    description: 'Cloud Run revision number assertion',
    regex: /\b(?:rev(?:ision)?|arkova-worker)[\s-]{0,4}(?:[a-z]{1,32}-)?(\d{5}-[a-z0-9]{3})/gi,
    artifactPatterns: [
      /gcloud run services describe/i,
      /github\.com\/.+\/actions\/runs\/\d+/i,
      /deploy-worker\.yml[^\n]{0,160}\brun\b/i,
    ],
  },
  {
    id: 'applied-prod',
    description: 'Migration / DDL applied on prod',
    regex: /\bappl(?:ied|ying)\s+(?:on|to|in)\s+prod\b|\bmigrated\s+(?:on|to|in)\s+prod\b/gi,
    artifactPatterns: [
      /supabase\s+migration\s+list/i,
      /information_schema|pg_indexes|pg_proc|pg_class/i,
      /list_migrations\s+(?:MCP|tool)/i,
    ],
  },
  {
    id: 'verified-via',
    description: 'Verification claim',
    regex: /\bverified\s+via\b|\bconfirmed\s+via\b/gi,
    // Code-review issue #C: artifact patterns must be domain-specific.
    // /https?:\/\/[^\s)]+/ matched ANY URL (every PR body has one), trivially
    // satisfying the rule. Restrict to evidence-bearing domains/paths.
    artifactPatterns: [
      /\bSELECT\b|\bquery\b.*(?:result|output)/i,
      /github\.com\/.+\/actions\/runs\/\d+/i,
      /\barkova\.atlassian\.net\/wiki\/spaces\/A\/pages\/\d+/i,
      /supabase\s+(?:migration\s+list|MCP\s+execute_sql)/i,
    ],
  },
  {
    id: 'deployed-healthy',
    description: 'Deployed-healthy / live-in-prod claim',
    regex: /\bdeployed,?\s+healthy\b|\blive\s+in\s+prod\b|\bserving\s+\d+%\s+traffic\b/gi,
    artifactPatterns: [
      /gcloud run services describe/i,
      /\/health.*?(?:curl|jq|status\s*[:=])/i,
      /git_sha/i,
    ],
  },
  {
    id: 'audit-shipped',
    description: 'N out of M findings shipped',
    regex: /\b\d+\s+(?:of|out of)\s+\d+\s+(?:findings?|stories?|items?|issues?)\s+(?:shipped|closed|done|completed)/gi,
    // Code-review issue #D: SCRUM-\d+ alone matches every PR body. Require
    // the linked ticket count to match the claim shape (N closed/Done) so
    // the artifact actually corroborates the claim, not just any ticket
    // reference.
    artifactPatterns: [
      /SCRUM-\d+[^\n]{0,160}\b(?:closed|done|merged|shipped)\b/i,
      /confluence\.atlassian\.com|arkova\.atlassian\.net\/wiki\/spaces\/A\/pages\/\d+/i,
      /github\.com\/.+\/pull\/\d+/i, // a closed PR list IS evidence of the count
    ],
  },
  {
    id: 'tests-pass',
    description: 'Tests pass / X/Y green claim',
    regex: /\b(?:tests?\s+pass|\d+(?:\/|\s+of\s+)\d+\s+(?:tests?\s+)?(?:green|passing))/gi,
    artifactPatterns: [
      /github\.com\/.+\/actions\/runs\/\d+/i,
      /\.github\/workflows\/.*\.yml/i,
    ],
  },
];

// Accepts either the strict form `..._Last refreshed: YYYY-MM-DD by <author> — claims verified against gcloud/MCP/CI output._`
// or the form with optional parenthetical narrative between `output` and `._`.
const FOOTER_PREFIX_RE = /^_Last refreshed:\s*\d{4}-\d{2}-\d{2}\s+by\s+\S+/i;
const FOOTER_CLAIM_TEXT = 'claims verified against gcloud/MCP/CI output';

function isValidFooter(line: string): boolean {
  const trimmed = line.trim();
  if (!FOOTER_PREFIX_RE.test(trimmed) || !trimmed.endsWith('._')) return false;

  const normalized = trimmed.toLowerCase();
  const claimStart = normalized.indexOf(FOOTER_CLAIM_TEXT.toLowerCase());
  if (claimStart === -1) return false;

  const afterClaim = trimmed.slice(claimStart + FOOTER_CLAIM_TEXT.length, -2);
  return !afterClaim.includes('_');
}

interface Violation {
  pattern: ClaimPattern;
  matchedText: string;
  diffLine: number;
}

function resolveDiffBase(base: string): string {
  // Merge-ref hardening (2026-07-06, f11a5290 class): on `pull_request`
  // events actions/checkout checks out the SYNTHETIC merge commit
  // refs/pull/N/merge — the PR head merged into the CURRENT base tip — while
  // `github.event.pull_request.base.sha` (our BASE_REF_SHA) stays pinned at
  // PR-creation time. Once the base branch edits HANDOFF.md after the PR was
  // cut (e.g. a direct-to-main docs commit under the CLAUDE.md §0.8
  // carve-out), `pinnedBase..HEAD` re-surfaces the BASE branch's own edit as
  // if THIS PR authored it — every pre-drift PR then fails this gate with
  // zero HANDOFF delta in `gh pr diff` (hit 2026-07-06: main f11a5290 edited
  // HANDOFF.md; PR #1408 Policy Lints went red on an untouched file).
  //
  // When HEAD is provably that synthetic merge, the honest changeset is
  // `HEAD^1..HEAD` ("the PR as merged into the current base tip"). Guarded
  // narrowly — pull_request event + exactly-2-parent HEAD + pinned base
  // reachable from the first parent + HEAD is the GitHub-synthesized merge
  // (GITHUB_SHA match, or the canonical `Merge <sha> into <sha>` subject
  // GitHub writes on refs/pull/N/merge). Anything else falls back to the
  // strict pinned-base two-dot, so at worst the gate stays exactly as strict
  // as before (fail-closed).
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return base;
  try {
    const parents = execFileSync(GIT_BIN, ['rev-list', '--parents', '-n', '1', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split(/\s+/);
    if (parents.length !== 3) return base; // [self, parent1, parent2] — not a 2-parent merge
    const [headSha, firstParent] = parents;
    // Throws (→ fallback) when the pinned base is NOT an ancestor of the
    // first parent, i.e. the first parent is not an advanced base tip.
    execFileSync(GIT_BIN, ['merge-base', '--is-ancestor', base, firstParent], {
      cwd: REPO,
      stdio: 'ignore',
    });
    const subject = execFileSync(GIT_BIN, ['log', '-1', '--format=%s', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const isSyntheticPrMerge =
      process.env.GITHUB_SHA === headSha || /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/.test(subject);
    return isSyntheticPrMerge ? firstParent : base;
  } catch {
    return base;
  }
}

function getDiff(): string {
  // Code-review issue #E: prefer execFileSync (no shell) over execSync with
  // shell-interpolated BASE_REF. The base is a real SHA from
  // ciContext.getBaseRef({ required: true }), so injection is moot — but match
  // the pattern used by the rest of the PR's scripts.
  //
  // TWO-dot (`base..HEAD`), NOT three-dot. Three-dot diffs against the
  // merge-base, so on a rebased lane branch (e.g. lane2/*-wt) that reaches a
  // now-merged HANDOFF.md commit, `base...HEAD` re-surfaces that edit as if
  // THIS PR authored it — then the footer check fails on on-disk HANDOFF.md
  // even though `gh pr diff --name-only` (two-dot) shows no HANDOFF change.
  // Two-dot asks the correct question: "did THIS PR's changeset edit
  // HANDOFF.md vs the current base tip?". A PR that genuinely edits HANDOFF.md
  // still trips the gate. On a synthetic merge-ref checkout the base of that
  // two-dot is re-anchored to HEAD^1 by resolveDiffBase() — see above.
  const base = getBaseRef({ required: true })!;
  try {
    const from = resolveDiffBase(base);
    return execFileSync(GIT_BIN, ['diff', `${from}..HEAD`, '--', 'HANDOFF.md'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function extractAddedLines(diff: string): { line: number; text: string }[] {
  const added: { line: number; text: string }[] = [];
  const lines = diff.split('\n');
  let cursorLine = 0;
  for (const l of lines) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(l);
    if (hunk) {
      cursorLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      added.push({ line: cursorLine, text: l.slice(1) });
      cursorLine++;
    } else if (l.startsWith(' ')) {
      cursorLine++;
    }
  }
  return added;
}

function checkArtifactExists(pattern: ClaimPattern): boolean {
  const haystack = `${PR_BODY}\n${PR_COMMITS_MSGS}`;
  return pattern.artifactPatterns.some((re) => re.test(haystack));
}

function isOverridden(): { allowed: boolean; reason?: string } {
  if (hasLabel(LABELS.handoffNarrativeOnly)) {
    return { allowed: true, reason: `PR labeled \`${LABELS.handoffNarrativeOnly}\`` };
  }
  return { allowed: false };
}

function main(): void {
  const diff = getDiff();
  if (!diff) {
    console.log('ℹ️  HANDOFF.md not modified by this PR — skipping check.');
    return;
  }

  // Code-review issue #M: don't early-return when added.length === 0.
  // A PR that ONLY deletes lines (including the footer) needs the footer
  // check to still run.
  const added = extractAddedLines(diff);

  const violations: Violation[] = [];
  for (const { line, text } of added) {
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      const m = pattern.regex.exec(text);
      if (m && !checkArtifactExists(pattern)) {
        violations.push({ pattern, matchedText: m[0], diffLine: line });
      }
    }
  }

  // Footer check (R0-6 / SCRUM-1252).
  // Code-review issue #L: footer regex was matched against the full file,
  // so an unverified PR could append claims above an unchanged old footer
  // and pass. Require the footer line itself to be in this PR's added or
  // unchanged-tail set: in practice, the footer must be in the *current*
  // file AND its date must be the most-recent date in any added line. A
  // simpler proxy that catches the common bypass: the footer must be on
  // the LAST non-empty line of the file.
  const handoffBody = readFileSync(HANDOFF_PATH, 'utf8');
  const trailing = handoffBody.split('\n').filter((l) => l.trim().length > 0).slice(-1)[0] ?? '';
  const footerOk = isValidFooter(trailing);

  const override = isOverridden();
  if (violations.length === 0 && footerOk) {
    console.log('✅ HANDOFF.md claims pass verification check.');
    return;
  }

  if (override.allowed) {
    console.log(`⚠️  ${override.reason} — allowing changes.`);
    return;
  }

  console.error('::error::HANDOFF.md edit asserts prod state without verification artifact (R0-6 / SCRUM-1252):');
  for (const v of violations) {
    console.error(`  L${v.diffLine}: ${v.pattern.id} (${v.pattern.description})`);
    console.error(`    matched: "${v.matchedText.trim()}"`);
    console.error('    expected one of these in PR body or commit messages:');
    for (const ap of v.pattern.artifactPatterns) {
      console.error(`      ${ap}`);
    }
  }
  if (!footerOk) {
    console.error('  HANDOFF.md missing required footer: _Last refreshed: YYYY-MM-DD by <author> — claims verified against gcloud/MCP/CI output._');
  }
  console.error('\nFix:');
  console.error('  1. Add the verification artifact link to the PR description or a commit body.');
  console.error('  2. Or label the PR `handoff-narrative-only` if it is prose-only with no live-state claims.');
  process.exit(1);
}

main();
