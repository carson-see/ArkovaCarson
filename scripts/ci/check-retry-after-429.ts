#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1273 — Retry-After enforcement for manual 429 responses.
 *
 * Every hand-written HTTP 429 must set a Retry-After header before sending
 * the response. Framework/middleware helpers that already set the header are
 * fine; this lint catches the easy regression: `res.status(429).json(...)`
 * with no nearby `setHeader('Retry-After', ...)`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const GIT_BIN = '/usr/bin/git';

export interface RetryAfterViolation {
  file: string;
  line: number;
  text: string;
}

const STATUS_429_RE = /\.status\s*\(\s*429\s*\)|\bstatus\s*\(\s*429\s*\)/;
const RETRY_AFTER_HEADER_RE = /\.(?:set|setHeader|header)\s*\(\s*['"]Retry-After['"]|\.set\s*\(\s*\{\s*['"]Retry-After['"]/;

function isScannedSource(file: string): boolean {
  return (
    file.startsWith('services/worker/src/')
    && file.endsWith('.ts')
    && !file.endsWith('.test.ts')
    && !file.includes('/__tests__/')
    && !file.endsWith('.d.ts')
  );
}

function trackedSourceFiles(): string[] {
  const output = execFileSync(GIT_BIN, ['ls-files', 'services/worker/src/**/*.ts'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return output.split('\n').filter(Boolean).filter(isScannedSource);
}

export function scanContent(file: string, content: string): RetryAfterViolation[] {
  const violations: RetryAfterViolation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!STATUS_429_RE.test(line)) continue;

    const nearby = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    if (RETRY_AFTER_HEADER_RE.test(nearby)) continue;

    violations.push({ file, line: i + 1, text: line.trim() });
  }

  return violations;
}

export function scanFiles(files: string[]): RetryAfterViolation[] {
  const violations: RetryAfterViolation[] = [];
  for (const file of files) {
    const content = readFileSync(resolve(REPO, file), 'utf8');
    violations.push(...scanContent(file, content));
  }
  return violations;
}

function main(): void {
  const violations = scanFiles(trackedSourceFiles());
  if (violations.length === 0) {
    console.log('✅ All manual 429 responses set Retry-After.');
    return;
  }

  console.error(`::error::Found ${violations.length} HTTP 429 response(s) without nearby Retry-After header (SCRUM-1273):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error('');
  console.error("Fix: set `Retry-After` before `res.status(429)` in the same response block.");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
