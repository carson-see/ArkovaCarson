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
import { REPO, baseRef as BASE_REF, prLabels as PR_LABELS, prBody as PR_BODY, prCommitsMsgs as PR_COMMITS_MSGS, hasLabel, LABELS } from './lib/ciContext.js';

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
    regex: /\b(?:rev(?:ision)?|arkova-worker)[\s-]*(?:[a-z-]+)?(\d{5}-[a-z0-9]{3})/gi,
    artifactPatterns: [
      /gcloud run services describe/i,
      /github\.com\/.+\/actions\/runs\/\d+/i,
      /deploy-worker\.yml.*?run/i,
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
      /SCRUM-\d+.*(?:closed|done|merged|shipped)/i,
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
const FOOTER_RE = /_Last refreshed:\s*\d{4}-\d{2}-\d{2}\s+by\s+\S+.*?claims verified against gcloud\/MCP\/CI output[^_]*\._/i;

interface Violation {
  pattern: ClaimPattern;
  matchedText: string;
  diffLine: number;
}

function getDiff(): string {
  // Code-review issue #E: prefer execFileSync (no shell) over execSync with
  // shell-interpolated BASE_REF. BASE_REF is now a real SHA from
  // ciContext.resolveBaseRefOrFail, so injection is moot — but match the
  // pattern used by the rest of the PR's scripts.
  try {
    return execFileSync('git', ['diff', `${BASE_REF}...HEAD`, '--', 'HANDOFF.md'], {
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
  const footerOk = FOOTER_RE.test(trailing);

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
