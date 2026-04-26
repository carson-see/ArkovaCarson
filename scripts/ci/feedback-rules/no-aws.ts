#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_no_aws.
 *
 * No AWS in production code. We don't have AWS in prod (only GCP); AWS
 * imports / `default('aws')` are dead branches that confuse customer
 * questions ("what cloud are you on?") and obscure the real signing path.
 *
 * Allowed exceptions:
 *  - test files (src/**\/*.test.ts, src/**\/*.spec.ts)
 *  - services/worker/src/chain/signing-provider.ts (documented dead branch
 *    intentionally retained per CLAUDE.md §1.1 chain row)
 *
 * Override: PR labeled `aws-intentional`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, hasLabel, changedFiles, LABELS } from '../lib/ciContext.js';

const ALLOWED_PATHS = [
  'services/worker/src/chain/signing-provider.ts',
  'services/worker/src/chain/aws-kms-provider.ts',
];

const VIOLATION_RES = [
  /from\s+['"]@aws-sdk\//,
  /require\s*\(\s*['"]@aws-sdk\//,
  /\.default\s*\(\s*['"]aws['"]\s*\)/,
  /kmsProvider\s*:\s*['"]aws['"]/,
];

function isAllowed(file: string): boolean {
  if (file.includes('.test.') || file.includes('.spec.')) return true;
  return ALLOWED_PATHS.some((p) => file === p);
}

function getCandidateFiles(): string[] {
  return changedFiles().filter((f) => /\.(tsx?)$/.test(f));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function checkFile(file: string): Violation[] {
  if (isAllowed(file)) return [];
  let content: string;
  try {
    content = readFileSync(resolve(REPO, file), 'utf8');
  } catch {
    return [];
  }
  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (VIOLATION_RES.some((re) => re.test(lines[i]))) {
      violations.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
  return violations;
}

export function run(): { ok: boolean; message: string } {
  const overridden = hasLabel(LABELS.awsIntentional);
  const violations = getCandidateFiles().flatMap(checkFile);

  if (violations.length === 0) {
    return { ok: true, message: '✅ feedback_no_aws: no AWS imports detected.' };
  }

  const out = [`Detected ${violations.length} AWS reference(s):`];
  for (const v of violations) out.push(`  ${v.file}:${v.line}  ${v.text}`);

  if (overridden) {
    out.push(`\n⚠️  PR labeled \`${LABELS.awsIntentional}\` — allowing.`);
    return { ok: true, message: out.join('\n') };
  }

  out.push('');
  out.push('::error::feedback_no_aws violation (R0-7 / SCRUM-1253). Arkova is GCP-only in production.');
  out.push('  See memory/feedback_no_aws.md for context.');
  return { ok: false, message: out.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
