#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_no_credit_limits_beta.
 *
 * No quota / credit-limit enforcement during beta. Detects new SQL
 * migrations or RPCs introducing `RAISE EXCEPTION ... Quota exceeded`
 * or `ERRCODE ... P0002` in `supabase/migrations/*.sql`.
 *
 * Override: PR labeled `post-beta-quota-rollout`.
 *
 * Why: feedback_no_credit_limits_beta.md was enshrined 2026-03-23 ~10:25;
 * migration 0093_atomic_quota_enforcement.sql (lines 122-191) violated it
 * 6 hours later. Free-tier orgs hit P0002 for 5 weeks before discovery.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, hasLabel, changedFiles, LABELS } from '../lib/ciContext.js';

const QUOTA_MESSAGE_RE = /RAISE\s+EXCEPTION[^;]*Quota\s+exceeded/i;

const P0002_RES = [
  /ERRCODE\s*=?\s*['"]?P0002['"]?/i,
  /raise\s+exception\s+using\s+errcode\s*=\s*['"]P0002['"]/i,
];

// P0002 is Postgres `no_data_found`. 0093 abused it for a quota refusal, which
// is why it is matched at all; a RAISE whose message literal is a not-found
// error is the code's ordinary meaning, not quota enforcement (0470/0482
// `'user_not_found'`, flagged on PR #3019 and #3036). Deliberately narrow: only
// the message literal is consulted, and a quota-worded line never reaches here.
const NOT_FOUND_MESSAGE_RE = /RAISE\s+EXCEPTION\s+'[^']*not[_ ]found[^']*'/i;

const BASELINE_MIGRATION = 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql';

interface Violation {
  file: string;
  line: number;
  text: string;
}

function isViolation(line: string): boolean {
  if (QUOTA_MESSAGE_RE.test(line)) return true;
  if (!P0002_RES.some((re) => re.test(line))) return false;
  return !NOT_FOUND_MESSAGE_RE.test(line);
}

export function findViolationsInSql(content: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isViolation(lines[i])) violations.push({ file, line: i + 1, text: lines[i].trim() });
  }
  return violations;
}

function checkFile(file: string): Violation[] {
  try {
    return findViolationsInSql(readFileSync(resolve(REPO, file), 'utf8'), file);
  } catch {
    return [];
  }
}

export function run(): { ok: boolean; message: string } {
  const overridden = hasLabel(LABELS.postBetaQuotaRollout);
  const files = changedFiles('supabase/migrations/*.sql').filter((file) => file !== BASELINE_MIGRATION);
  const violations = files.flatMap(checkFile);

  if (violations.length === 0) {
    return { ok: true, message: '✅ feedback_no_credit_limits_beta: no quota enforcement violations found.' };
  }

  const lines = [`Detected ${violations.length} quota/credit-limit violation(s):`];
  for (const v of violations) lines.push(`  ${v.file}:${v.line}  ${v.text}`);

  if (overridden) {
    lines.push(`\n⚠️  PR labeled \`${LABELS.postBetaQuotaRollout}\` — allowing.`);
    return { ok: true, message: lines.join('\n') };
  }

  lines.push('');
  lines.push('::error::feedback_no_credit_limits_beta violation (R0-7 / SCRUM-1253).');
  lines.push('  Beta tenants must not hit quota / credit-limit errors.');
  lines.push('  See memory/feedback_no_credit_limits_beta.md for context.');
  lines.push(`  To allow this change, label the PR \`${LABELS.postBetaQuotaRollout}\`.`);
  return { ok: false, message: lines.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
