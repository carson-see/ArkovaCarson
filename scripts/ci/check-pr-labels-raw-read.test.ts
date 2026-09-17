/**
 * Regression lint: no `scripts/ci` check may read `process.env.PR_LABELS`
 * directly — every label-gated check must resolve labels through
 * `hasLabel()` / `resolvePrLabels()` in `./lib/ciContext.ts`.
 *
 * ── The defect this pins (2026-09-14) ───────────────────────────────────────
 * Eleven checks bypassed `ciContext` entirely with their own
 * `(process.env.PR_LABELS ?? '').split(',')...` (or, for
 * `check-csp-runtime-deps.ts`, its own now-removed `hasOverrideLabel()`).
 * That was doubly broken:
 *   1. No LIVE label fetch — an override label applied after the run started
 *      only took effect on a fresh push, never a re-run (the class
 *      `check-pr-labels-token-parity.test.ts` already guards for the
 *      ciContext-routed checks).
 *   2. No Mergify MERGE-QUEUE resolution — inside a Mergify speculative
 *      check PR, `process.env.PR_LABELS` describes the ephemeral queue PR
 *      (which carries none of the real PR's labels), not the real PR being
 *      checked. Confirmed live on queue PR #2936 checking real PR #2841 and
 *      #2939 checking the same — `agents-md-deletion-approved` present and
 *      passing on #2841's own runs, absent inside both queue runs.
 *
 * `hasLabel()` fixes both. Routing every check through it is what stops this
 * regressing — but nothing enforced that the NEXT check written the same way
 * the old eleven were wouldn't reintroduce the exact same gap. This is that
 * enforcement.
 *
 * ── Why a lint and not just fixing the eleven ───────────────────────────────
 * The failure mode here is invisible at the call site (the code reads a plain
 * env var, looks completely ordinary) and the copy-paste path is easy: the
 * natural way to add a new override label is to copy a neighbouring check's
 * `const prLabels = (process.env.PR_LABELS ?? '')...` block. Pinning "route
 * through ciContext" structurally is what stops a twelfth.
 *
 * `eslint.config.*` ignores `scripts/` entirely, so a custom eslint rule
 * would never fire here — this lives in vitest (`npm test`) instead, the same
 * reason `check-pr-labels-token-parity.test.ts` is a `.test.ts` with no
 * companion `.ts` implementation.
 *
 * Scope: every `scripts/ci/**\/*.ts` file (feedback-rules/ included) except
 * `lib/ciContext.ts` itself (the one file allowed to touch the raw env var)
 * and `*.test.ts` files (test fixtures legitimately set `process.env.PR_LABELS`
 * to simulate CI env — e.g. `ciContext.test.ts` — that is exercising the
 * resolver, not bypassing it).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCAN_ROOT = resolve(REPO, 'scripts/ci');
const EXCLUDED_ABS_PATHS = new Set([resolve(SCAN_ROOT, 'lib/ciContext.ts')]);

/** `process.env.PR_LABELS` (dot access) or `process.env['PR_LABELS']` / `process.env["PR_LABELS"]` (bracket access). */
const RAW_READ_PATTERN = /process\.env\.PR_LABELS\b|process\.env\[\s*['"]PR_LABELS['"]\s*\]/;

export interface ScannedFile {
  path: string;
  content: string;
}

export interface RawReadViolation {
  file: string;
  line: number;
  text: string;
}

/**
 * Pure: scan already-loaded file contents for the raw-read pattern. Separated
 * from disk I/O so the detector itself can be proven red/green with synthetic
 * fixtures, independent of the real repo tree.
 */
export function findRawPrLabelsReads(files: ScannedFile[]): RawReadViolation[] {
  const violations: RawReadViolation[] = [];
  for (const { path, content } of files) {
    content.split('\n').forEach((line, idx) => {
      if (RAW_READ_PATTERN.test(line)) {
        violations.push({ file: path, line: idx + 1, text: line.trim() });
      }
    });
  }
  return violations;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The real `scripts/ci` tree, filtered per the scope rules documented above. */
export function realScriptFiles(): ScannedFile[] {
  return collectTsFiles(SCAN_ROOT)
    .filter((f) => !EXCLUDED_ABS_PATHS.has(f))
    .map((f) => ({ path: relative(REPO, f), content: readFileSync(f, 'utf8') }));
}

describe('no scripts/ci check bypasses ciContext with a raw process.env.PR_LABELS read', () => {
  it('finds zero raw reads across the real scripts/ci tree (feedback-rules/ included)', () => {
    const violations = findRawPrLabelsReads(realScriptFiles());
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line} → ${v.text}`).join('\n');
      throw new Error(
        `Found ${violations.length} raw \`process.env.PR_LABELS\` read(s) bypassing ciContext:\n${detail}\n\n`
        + 'Route label resolution through `hasLabel(OVERRIDE_LABEL)` (import from `./lib/ciContext.js`) '
        + 'instead. `hasLabel()` resolves labels LIVE from the GitHub API and, inside a Mergify merge-queue '
        + "speculative check, resolves the ORIGINAL PR's labels rather than the ephemeral queue PR's own "
        + '(empty) labels — a raw `process.env.PR_LABELS` read is silently broken in both respects.',
      );
    }
    expect(violations).toEqual([]);
  });

  it('the scan is not vacuously empty — it actually walks scripts/ci, feedback-rules/ included', () => {
    const files = realScriptFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.path.includes('feedback-rules/'))).toBe(true);
  });

  it('excludes only lib/ciContext.ts, not the whole lib/ directory', () => {
    const files = realScriptFiles();
    expect(files.some((f) => f.path === 'scripts/ci/lib/ciContext.ts')).toBe(false);
    expect(
      files.some((f) => f.path.startsWith('scripts/ci/lib/') && f.path !== 'scripts/ci/lib/ciContext.ts'),
    ).toBe(true);
  });

  it('excludes .test.ts files from the scan (test fixtures legitimately touch the env var)', () => {
    const files = realScriptFiles();
    expect(files.some((f) => f.path.endsWith('.test.ts'))).toBe(false);
  });
});

describe('findRawPrLabelsReads — the detector actually fires (TDD red proof)', () => {
  it('flags a dot-access read: (process.env.PR_LABELS ?? "").split(",")', () => {
    const violations = findRawPrLabelsReads([
      { path: 'scripts/ci/check-fake.ts', content: "const labels = (process.env.PR_LABELS ?? '').split(',');" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'scripts/ci/check-fake.ts', line: 1 });
  });

  it('flags the double-quoted bracket form: process.env["PR_LABELS"]', () => {
    const violations = findRawPrLabelsReads([
      { path: 'scripts/ci/check-fake.ts', content: 'if (process.env["PR_LABELS"]) { /* ... */ }' },
    ]);
    expect(violations).toHaveLength(1);
  });

  it("flags the single-quoted bracket form: process.env['PR_LABELS']", () => {
    const violations = findRawPrLabelsReads([
      { path: 'scripts/ci/check-fake.ts', content: "if (process.env['PR_LABELS']) {}" },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('does not flag hasLabel()/resolvePrLabels() usage — the correct route', () => {
    const violations = findRawPrLabelsReads([
      {
        path: 'scripts/ci/check-fake.ts',
        content: "import { hasLabel } from './lib/ciContext.js';\nif (hasLabel('foo')) {}",
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('does not flag an unrelated PR_LABELS object key (e.g. a test env fixture)', () => {
    const violations = findRawPrLabelsReads([
      { path: 'scripts/ci/check-fake.test.ts', content: "mod.resolvePrLabels({ PR_LABELS: 'foo' });" },
    ]);
    expect(violations).toEqual([]);
  });

  it('reports the correct 1-indexed line number for a violation mid-file', () => {
    const content = ['// line 1', '// line 2', 'const x = process.env.PR_LABELS;'].join('\n');
    const violations = findRawPrLabelsReads([{ path: 'f.ts', content }]);
    expect(violations[0]!.line).toBe(3);
  });

  it('flags every violating file independently in a multi-file scan', () => {
    const violations = findRawPrLabelsReads([
      { path: 'a.ts', content: 'process.env.PR_LABELS' },
      { path: 'b.ts', content: 'ok, nothing here' },
      { path: 'c.ts', content: 'process.env["PR_LABELS"]' },
    ]);
    expect(violations.map((v) => v.file).sort()).toEqual(['a.ts', 'c.ts']);
  });
});
