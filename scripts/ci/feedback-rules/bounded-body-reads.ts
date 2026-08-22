#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_bounded_body_reads (F-D0-5).
 *
 * `AbortSignal.timeout(...)` passed to `fetch()` bounds the REQUEST. It does
 * NOT bound the `await response.json()` / `.text()` that follows — that is a
 * separate await with no timer, and undici's default `bodyTimeout` fires only
 * on total silence, so a provider that sends headers and then stalls parks the
 * caller indefinitely.
 *
 * Observed 2026-08-12 on the fullsoak rig (prod's image digest): one parked
 * body read in `jobs/check-confirmations.ts` suspended a run inside
 * `withRunLease`, whose heartbeat then renewed the lease forever — disabling
 * SUBMITTED→SECURED promotion for EVERY tenant for 35+ minutes with zero
 * warn/error logs. See memory/feedback_bounded_body_reads.md and
 * docs/staging/fullsoak-2026-08/day0-bl2-secured-e2e-evidence.md §2.6a.
 *
 * WHY A LINT AND NOT A CHECKLIST. The fix swept ~20 call sites across five
 * files. A careful human census finds most of them; the next PR to add a
 * `fetch` does not read that census. This is the ratchet.
 *
 * WHAT IT FLAGS: a raw `.json()` / `.text()` on a fetch response in worker
 * source. The bounded readers (`readJsonBounded` / `readTextBounded` from
 * `utils/body-read-timeout.ts`) are the sanctioned form.
 *
 * Deliberately narrow, to stay a zero-false-positive gate:
 *  - only `services/worker/src/**` (the long-lived job/cron surface where a
 *    park becomes an outage rather than one failed request),
 *  - only identifiers that a fetch response is conventionally bound to here
 *    (`response`, `res`, `resp`, `heightResp`, `*Response`, `*Resp`), so
 *    `JSON.parse`, `req.json()`, and non-HTTP `.text()` are never touched,
 *  - test files and the primitive's own implementation are exempt.
 *
 * A RATCHET ON ADDED LINES, NOT A WHOLE-FILE GATE — and that is load-bearing,
 * not a softening. A whole-tree scan of this rule reports **145 pre-existing
 * unbounded reads** in worker source (run it with FEEDBACK_RULES_SCAN_ALL=1 to
 * see the list). Flagging every match in a changed FILE — the `no-aws.ts`
 * shape, correct there because that rule has zero legacy sites — would fail any
 * PR that so much as touches `samGovFetcher.ts` for an unrelated reason, and a
 * gate that reddens unrelated work gets labelled around until it means nothing.
 * Scoping to lines this changeset ADDS guarantees the one property that
 * matters — no NEW unbounded read lands — while the 145 are migrated
 * deliberately. Do NOT "strengthen" this to whole-file without first clearing
 * that backlog.
 *
 * Override: PR labeled `unbounded-body-read-reviewed`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GIT_BIN, REPO, changedFiles, getBaseRef, resolvePrLabels, scanAll } from '../lib/ciContext.js';

const OVERRIDE_LABEL = 'unbounded-body-read-reviewed';

/** Only the worker's own source — the surface where a parked await hangs a job. */
const SCOPE_PREFIX = 'services/worker/src/';

/** The module that IMPLEMENTS the bounded read necessarily calls the raw form. */
const ALLOWED_PATHS = ['services/worker/src/utils/body-read-timeout.ts'];

/**
 * Identifiers a fetch `Response` is bound to in this codebase. Matching on the
 * receiver — rather than on a bare `.json()` — is what keeps `JSON.parse(...)`,
 * Express `req.body`, and unrelated `.text()` calls out of the results.
 */
const RESPONSE_RECEIVER = String.raw`(?:response|res|resp|\w*(?:Response|Resp))`;

/** `await response.json()` / `(await resp.text())` / `heightResp.text()`. */
const RAW_BODY_READ = new RegExp(String.raw`\b${RESPONSE_RECEIVER}\s*\.\s*(?:json|text)\s*\(\s*\)`);

/**
 * `res => res.ok ? res.json() : null` — the promise-chain form. Same hazard,
 * and it is the shape `jobs/treasury-cache.ts` carried inside a
 * `Promise.allSettled`, where ONE stalled leg hangs the entire refresh.
 */
const CHAINED_BODY_READ = new RegExp(
  String.raw`\.\s*then\s*\(.*\b${RESPONSE_RECEIVER}\s*\.\s*(?:json|text)\s*\(\s*\)`,
);

function isExempt(file: string): boolean {
  if (!file.startsWith(SCOPE_PREFIX)) return true;
  if (!/\.tsx?$/.test(file)) return true;
  if (file.includes('.test.') || file.includes('.spec.')) return true;
  return ALLOWED_PATHS.includes(file);
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * 1-based line numbers this changeset ADDS to `file`, parsed from the unified
 * diff's hunk headers (`@@ -a,b +c,d @@`). Returns null when the diff cannot be
 * taken, which the caller treats as "fall back to whole-file" — failing OPEN on
 * attribution would let a new violation ride in on an unreadable diff.
 */
function addedLines(file: string, base: string): Set<number> | null {
  let diff: string;
  try {
    diff = execFileSync(
      GIT_BIN,
      ['diff', '--unified=0', '--no-color', `${base}..HEAD`, '--', file],
      { cwd: REPO, encoding: 'utf8' },
    );
  } catch {
    return null;
  }

  const added = new Set<number>();
  let cursor = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      cursor = Number.parseInt(hunk[1], 10);
      continue;
    }
    // `+++ b/path` is a header, not an added line.
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.add(cursor);
      cursor++;
    }
  }
  return added;
}

function checkFile(file: string, base: string | null): Violation[] {
  if (isExempt(file)) return [];
  let content: string;
  try {
    content = readFileSync(resolve(REPO, file), 'utf8');
  } catch {
    // Deleted or renamed-away in this changeset — nothing to lint.
    return [];
  }

  // scanAll is the inventory mode (FEEDBACK_RULES_SCAN_ALL=1): report every
  // site so the backlog can be sized. The PR path attributes to added lines.
  const added = scanAll || base === null ? null : addedLines(file, base);

  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (added !== null && !added.has(lineNo)) continue;
    const line = lines[i];
    // Skip comments, so the prose explaining this very rule is not a violation.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (RAW_BODY_READ.test(line) || CHAINED_BODY_READ.test(line)) {
      violations.push({ file, line: lineNo, text: trimmed });
    }
  }
  return violations;
}

export function run(): { ok: boolean; message: string } {
  // Optional: a rule that cannot resolve a base still lints (whole-file), it
  // just cannot attribute. It must never silently pass for lack of a base.
  const base = scanAll ? null : getBaseRef({ required: false });
  const violations = changedFiles().flatMap((f) => checkFile(f, base));

  if (violations.length === 0) {
    return {
      ok: true,
      message: '✅ feedback_bounded_body_reads: no unbounded response body reads in worker source.',
    };
  }

  const out = [`Detected ${violations.length} unbounded response body read(s):`];
  for (const v of violations) out.push(`  ${v.file}:${v.line}  ${v.text}`);

  if (resolvePrLabels().includes(OVERRIDE_LABEL)) {
    out.push(`\n⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing.`);
    return { ok: true, message: out.join('\n') };
  }

  out.push('');
  out.push(
    '::error::feedback_bounded_body_reads violation (R0-7 / SCRUM-1253, F-D0-5). ' +
      'AbortSignal.timeout() bounds the REQUEST, not the body read — a provider that stalls ' +
      'after sending headers parks this await forever.',
  );
  out.push(
    "  Use readJsonBounded / readTextBounded from 'utils/body-read-timeout.js', " +
      'or label the PR `' + OVERRIDE_LABEL + '` if the call is genuinely bounded elsewhere.',
  );
  out.push('  See memory/feedback_bounded_body_reads.md for the incident this came from.');
  return { ok: false, message: out.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
