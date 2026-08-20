#!/usr/bin/env -S npx tsx
/**
 * Rule: no bare code-unit truncation (`.slice(0, N)` / `.substring(0, N)` /
 * `.substr(0, N)`) inside a PostgREST write payload in the worker.
 *
 * THE FAILURE MODE
 *   `String.prototype.slice` cuts at UTF-16 CODE-UNIT boundaries. A cut that
 *   lands inside a surrogate pair leaves a lone high surrogate; a lone
 *   surrogate cannot be encoded as UTF-8, and PostgREST rejects the WHOLE
 *   request body as invalid JSON (`PGRST102 "Empty or invalid json"`). One
 *   such string in `anchors.description` — an OpenAlex abstract with
 *   astral-plane math symbols, split exactly at unit 500 — poisoned the head
 *   of the public-record anchoring queue for 16 days (2026-08-17 incident,
 *   PR #2266). A follow-up census found the same shape on `job_queue
 *   .last_error`, `webhook_delivery_logs.response_body` (endpoint-controlled
 *   bytes!), `compliance_audits.error_message`, and the `anchors` insert
 *   payloads of two more routes — which is why this is a detector and not a
 *   review-checklist item (see memory/feedback_lint_rule_beats_human_census.md).
 *
 * THE FIX
 *   `services/worker/src/utils/utf16-truncate.ts` `truncateUtf16Safe(s, N)` —
 *   same bound, guaranteed well-formed output.
 *
 * WHAT THIS SCANS (honest limits)
 *   Truncation calls that appear LEXICALLY INSIDE the argument span of a
 *   `.insert(` / `.update(` / `.upsert(` call in `services/worker/src`
 *   non-test files. It is a single-file lexical check: a truncation whose
 *   result flows into a write through a variable or helper function (the
 *   `sanitizeLastError` shape) is NOT detected — those were migrated by the
 *   same PR that added this rule, and their regression guard is their tests.
 *   `createHash()/createHmac().update(...)` receivers are exempted.
 *
 * RATCHET, NOT A BIG BANG
 *   Pre-existing violations are pinned in `surrogate-truncate-baseline.json`
 *   as a burn-down list. Anything new fails. The baseline may only shrink —
 *   a stale entry is itself a failure, so the list cannot quietly
 *   re-authorise a regression.
 *
 * ENFORCEMENT
 *   Runs in `Policy Lints` via the feedback-rules orchestrator. Because
 *   `Policy Lints` is not a Mergify merge condition, the merge-time gate is
 *   `surrogate-safe-truncate.test.ts`, which runs in `Tests`.
 *
 * Override: PR label `surrogate-slice-reviewed`.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { hasLabel } from '../lib/ciContext.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCAN_ROOT = resolve(REPO_ROOT, 'services/worker/src');
const BASELINE_FILE = resolve(import.meta.dirname, 'surrogate-truncate-baseline.json');

const WRITE_CALL = /\.(insert|update|upsert)\s*\(/g;
const TRUNCATE_CALL = /\.(slice|substring|substr)\(\s*0\s*,/g;
/** Hash builders whose `.update(...)` is not a DB write. */
const HASH_RECEIVER = /create(Hash|Hmac)\s*\([^()]*\)\s*$|\bhash\s*$|\bhmac\s*$/;
/** Longest argument span we will bracket-match before giving up (defensive cap). */
const MAX_SPAN_CHARS = 6000;

export interface Violation {
  file: string;
  line: number;
  /** `<file>::<normalized source line>#<n>` — the stable identity used by the baseline. */
  key: string;
  snippet: string;
}

/**
 * Blank comments in place (offsets preserved) so a `.slice(0,` in prose or a
 * commented-out call can never match. String contents are left alone — the
 * span walker below tracks quote state itself.
 */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

/**
 * Given the index of the opening `(` of a call, return the index just past its
 * matching `)`. Tracks single/double/backtick quote state (backslash escapes)
 * so parens inside string literals do not unbalance the walk. Template
 * `${...}` interpolations are treated as string content — an approximation; a
 * span that a template unbalances is truncated at MAX_SPAN_CHARS and scanned
 * as-is (over-scanning fails safe: worst case is a baseline entry, not a
 * missed violation inside the true span).
 */
export function spanEnd(source: string, openParen: number): number {
  let depth = 0;
  let quote: string | null = null;
  const limit = Math.min(source.length, openParen + MAX_SPAN_CHARS);
  for (let i = openParen; i < limit; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return limit;
}

/**
 * Blank string-literal CONTENTS in place (offsets preserved, quotes kept) so a
 * `.slice(0,` mentioned inside a string can never match the truncation scan.
 * Template-literal `${...}` interpolations are REAL CODE and are kept — a
 * `` `${title.slice(0, 180)}.url` `` build is exactly the poisonable shape.
 */
export function blankStrings(source: string): string {
  const out = source.split('');
  let quote: string | null = null;
  let interpolationDepth = 0;
  for (let i = 0; i < out.length; i++) {
    const ch = source[i];
    if (quote && interpolationDepth === 0) {
      if (ch === '\\') {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i++;
      } else if (ch === quote) {
        quote = null;
      } else if (quote === '`' && ch === '$' && source[i + 1] === '{') {
        interpolationDepth = 1;
        i++; // keep `${` visible; code follows
      } else if (ch !== '\n') {
        out[i] = ' ';
      }
      continue;
    }
    if (interpolationDepth > 0) {
      // Inside `${...}` — code. Nested braces tracked; nested strings within
      // an interpolation are rare enough to leave to the baseline.
      if (ch === '{') interpolationDepth++;
      else if (ch === '}') interpolationDepth--;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
  }
  return out.join('');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

function sourceLineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).replace(/\s+/g, ' ').trim();
}

/** Every truncation call lexically inside a `.insert(`/`.update(`/`.upsert(` argument span. */
export function findViolationsInSource(file: string, rawSource: string): Violation[] {
  const source = blankComments(rawSource);
  const out: Violation[] = [];
  const perSnippet = new Map<string, number>();

  for (const write of source.matchAll(WRITE_CALL)) {
    // `createHash('sha256').update(bytes)` is not a DB write.
    const before = source.slice(Math.max(0, write.index - 80), write.index);
    if (write[1] === 'update' && HASH_RECEIVER.test(before)) continue;

    const openParen = write.index + write[0].length - 1;
    const end = spanEnd(source, openParen);
    const span = blankStrings(source.slice(openParen, end));

    for (const trunc of span.matchAll(TRUNCATE_CALL)) {
      const absIndex = openParen + trunc.index;
      const snippet = sourceLineAt(source, absIndex);
      const n = (perSnippet.get(`${file}::${snippet}`) ?? 0) + 1;
      perSnippet.set(`${file}::${snippet}`, n);
      out.push({
        file,
        line: lineOf(source, absIndex),
        key: `${file}::${snippet}#${n}`,
        snippet,
      });
    }
  }
  return out;
}

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__fixtures__' || entry === 'node_modules') continue;
      yield* walkTsFiles(full);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

export function scanWorkerSrc(): Violation[] {
  if (!existsSync(SCAN_ROOT)) return [];
  const out: Violation[] = [];
  for (const full of walkTsFiles(SCAN_ROOT)) {
    const rel = relative(REPO_ROOT, full);
    out.push(...findViolationsInSource(rel, readFileSync(full, 'utf8')));
  }
  return out;
}

export function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_FILE)) return new Set();
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as { grandfathered?: string[] };
  return new Set(parsed.grandfathered ?? []);
}

export function run(): { ok: boolean; message: string } {
  if (hasLabel('surrogate-slice-reviewed')) {
    return {
      ok: true,
      message: '🏷️  surrogate_safe_truncate: skipped (label `surrogate-slice-reviewed`).',
    };
  }

  const all = scanWorkerSrc();
  const baseline = loadBaseline();
  const fresh = all.filter((v) => !baseline.has(v.key));

  // The baseline may only SHRINK — a stale entry silently re-authorises a
  // regression on that exact key. Enforced here AND in the vitest file so a
  // direct run cannot false-all-clear on a rotted baseline.
  const live = new Set(all.map((v) => v.key));
  const stale = [...baseline].filter((k) => !live.has(k)).sort((a, b) => a.localeCompare(b));

  if (fresh.length === 0 && stale.length === 0) {
    return {
      ok: true,
      message:
        `✅ surrogate_safe_truncate: no bare code-unit truncation inside a DB write payload ` +
        `(${baseline.size} grandfathered, burn-down list in ` +
        `scripts/ci/feedback-rules/surrogate-truncate-baseline.json).`,
    };
  }

  if (fresh.length === 0) {
    return {
      ok: false,
      message:
        `surrogate_safe_truncate: ${stale.length} baseline entr(ies) no longer violate — ` +
        `delete them from scripts/ci/feedback-rules/surrogate-truncate-baseline.json so the ` +
        `burn-down list stays honest:\n${stale.map((k) => `  - ${k}`).join('\n')}`,
    };
  }

  const lines = fresh.map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`);
  return {
    ok: false,
    message:
      `surrogate_safe_truncate: ${fresh.length} bare code-unit truncation(s) inside a DB write ` +
      `payload:\n${lines.join('\n')}\n\n` +
      `.slice(0, N) cuts at UTF-16 code-unit boundaries; a cut inside a surrogate pair\n` +
      `leaves a lone high surrogate and PostgREST rejects the WHOLE request body as\n` +
      `invalid JSON (PGRST102) — the 2026-08-17 poison-record mechanism. Use\n` +
      `  truncateUtf16Safe(value, N)   from services/worker/src/utils/utf16-truncate.ts\n` +
      `or, if this site provably never persists text (array slice, hex digest, ISO\n` +
      `date), add its key to surrogate-truncate-baseline.json with a reason.\n` +
      `Override: PR label \`surrogate-slice-reviewed\`.`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
