#!/usr/bin/env -S npx tsx
/**
 * Staging soak evidence gate (CLAUDE.md §1.11 / §1.12).
 *
 * Every PR declares a soak tier (T1 / T2 / T3) in its body. The tier
 * dictates required soak length and required evidence fields. CI fails
 * the PR if:
 *
 *   1. The declared tier is missing.
 *   2. The declared tier is below what the touched files require
 *      (e.g. PR touches `services/worker/src/chain/` but declares T1).
 *   3. The `## Staging Soak Evidence` section is missing required
 *      fields for the declared tier.
 *
 * The detector for tier requirements is path-based and intentionally
 * conservative — when in doubt it pushes you up a tier rather than down.
 *
 * Override label: `staging-soak-skip` — for true CI-only / docs-only
 * changes that do not run on the worker (README updates, .github/
 * workflows that touch nothing else, agents.md edits, memory/ edits).
 *
 * The override label is itself audited by the feedback-rules orchestrator
 * (see scripts/ci/feedback-rules/) so abuse is visible.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO,
  hasLabel,
  prBody,
  changedFiles,
} from './lib/ciContext.js';

export const OVERRIDE_LABEL = 'staging-soak-skip';

export type Tier = 'T1' | 'T2' | 'T3';

interface TierSpec {
  tier: Tier;
  /** Minimum soak duration in hours. */
  soakHours: number;
  /** Required evidence field labels. Match the literal string in the PR body. */
  requiredFields: string[];
}

export const TIER_SPECS: Record<Tier, TierSpec> = {
  T1: {
    tier: 'T1',
    soakHours: 0.5,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
    ],
  },
  T2: {
    tier: 'T2',
    soakHours: 4,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
    ],
  },
  T3: {
    tier: 'T3',
    soakHours: 48,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
      'Trigger A fires:',
      'Trigger B fires:',
      'Daily flush observation:',
      'Per-org isolation check:',
    ],
  },
};

interface PathRule {
  /** Regex matched against POSIX-style relative paths. */
  pattern: RegExp;
  /** Minimum tier required when any matched file is touched. */
  minTier: Tier;
  /** Human-readable reason printed on failure. */
  reason: string;
}

/**
 * Path → minimum tier. Order matters only for failure messages — the
 * highest tier across all matching rules wins.
 *
 * Add a rule when you discover a new prod-affecting surface that
 * shouldn't be merged without staging soak.
 */
export const PATH_RULES: PathRule[] = [
  {
    pattern: /^supabase\/migrations\//,
    minTier: 'T2',
    reason: 'migration touches the schema',
  },
  {
    pattern: /^services\/worker\/src\/chain\//,
    minTier: 'T3',
    reason: 'chain/treasury hot path',
  },
  {
    pattern: /^services\/worker\/src\/jobs\/(anchor|batch-anchor|check-confirmations|broadcast-recovery|chain-maintenance)\.ts$/,
    minTier: 'T3',
    reason: 'anchor lifecycle / batch processor',
  },
  {
    pattern: /^services\/worker\/src\/routes\/scheduled\.ts$/,
    minTier: 'T3',
    reason: 'cron schedule',
  },
  {
    pattern: /^services\/worker\/src\/billing\//,
    minTier: 'T3',
    reason: 'entitlement / billing logic',
  },
  {
    pattern: /^services\/worker\/src\/stripe\//,
    minTier: 'T2',
    reason: 'Stripe handler',
  },
  {
    pattern: /^services\/worker\/src\/api\//,
    minTier: 'T2',
    reason: 'public API surface',
  },
  {
    pattern: /^services\/worker\/src\/webhooks\//,
    minTier: 'T2',
    reason: 'webhook delivery',
  },
  {
    pattern: /^services\/edge\/src\//,
    minTier: 'T2',
    reason: 'edge worker',
  },
  {
    pattern: /^src\/(components|pages|hooks|lib)\//,
    minTier: 'T1',
    reason: 'frontend code',
  },
];

const TIER_RANK: Record<Tier, number> = { T1: 1, T2: 2, T3: 3 };

export function requiredTierFor(files: string[]): { tier: Tier; reason: string } {
  let best: Tier = 'T1';
  let reason = 'default frontend / additive change';
  for (const f of files) {
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(f) && TIER_RANK[rule.minTier] > TIER_RANK[best]) {
        best = rule.minTier;
        reason = `${f} — ${rule.reason}`;
      }
    }
  }
  return { tier: best, reason };
}

const EVIDENCE_HEADER_RE = /^##\s+Staging\s+Soak\s+Evidence\s*$/im;
const TIER_DECLARATION_RE = /^\s*[-*]?\s*Tier:\s*(T[123])\b/im;

export function extractDeclaredTier(body: string): Tier | null {
  const m = TIER_DECLARATION_RE.exec(body);
  return m ? (m[1] as Tier) : null;
}

export function hasEvidenceSection(body: string): boolean {
  return EVIDENCE_HEADER_RE.test(body);
}

export function missingFields(body: string, tier: Tier): string[] {
  const spec = TIER_SPECS[tier];
  const missing: string[] = [];
  for (const field of spec.requiredFields) {
    // Field labels are line-anchored to avoid matching prose mentions.
    const re = new RegExp(`^[\\s\\-*]*${field.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'im');
    if (!re.test(body)) missing.push(field);
  }
  return missing;
}

interface StagingFilesOnlyResult {
  pass: boolean;
  reason: string;
}

/**
 * The rig PR itself (this PR) only adds staging tooling and CI gates —
 * it should not require its own soak gate to pass. We skip when EVERY
 * touched file is in the staging-tooling allowlist.
 */
export function isStagingToolingOnly(files: string[]): StagingFilesOnlyResult {
  if (files.length === 0) return { pass: true, reason: 'no changed files' };
  const ALLOW = [
    /^scripts\/staging\//,
    /^scripts\/ci\/check-staging-evidence(\.test)?\.ts$/,
    /^scripts\/ci\/lib\//,
    // Operator-setup tooling lives next to the rig conceptually — same
    // category of meta-infra (script the operator runs once to wire up
    // cloud resources). Edits here can't break the running worker; they
    // only change what `bash scripts/gcp-setup/*` does on the next run.
    /^scripts\/gcp-setup\//,
    /^docs\/staging\//,
    /^\.github\/workflows\/staging-evidence\.yml$/,
    /^CLAUDE\.md$/,
    /^package\.json$/,
    /^package-lock\.json$/,
    /agents\.md$/,
  ];
  for (const f of files) {
    if (!ALLOW.some((re) => re.test(f))) {
      return { pass: false, reason: `${f} is outside the staging-tooling allowlist` };
    }
  }
  return { pass: true, reason: 'all touched files are staging-tooling-only' };
}

interface CheckResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

export function check(opts: { body: string; files: string[]; overridden: boolean }): CheckResult {
  const { body, files, overridden } = opts;
  const result: CheckResult = { ok: true, errors: [], notes: [] };

  if (overridden) {
    result.notes.push(`Override label \`${OVERRIDE_LABEL}\` present — skipping.`);
    return result;
  }

  const tooling = isStagingToolingOnly(files);
  if (tooling.pass) {
    result.notes.push(`Staging-tooling PR (${tooling.reason}) — gate self-skips.`);
    return result;
  }

  const required = requiredTierFor(files);
  const declared = extractDeclaredTier(body);

  if (!declared) {
    result.ok = false;
    result.errors.push(
      `PR body is missing a tier declaration. Add a line \`Tier: ${required.tier}\` under a `
      + `\`## Staging Soak Evidence\` section. Required tier: ${required.tier} (${required.reason}).`,
    );
    return result;
  }

  if (TIER_RANK[declared] < TIER_RANK[required.tier]) {
    result.ok = false;
    result.errors.push(
      `Declared tier ${declared} is below required tier ${required.tier} `
      + `for the touched files. Reason: ${required.reason}.`,
    );
  }

  if (!hasEvidenceSection(body)) {
    result.ok = false;
    result.errors.push(
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md as a starting point.',
    );
    return result;
  }

  const missing = missingFields(body, declared);
  if (missing.length > 0) {
    result.ok = false;
    result.errors.push(
      `\`## Staging Soak Evidence\` section is missing required fields for ${declared}: `
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  return result;
}

function main(): void {
  const files = changedFiles();
  const overridden = hasLabel(OVERRIDE_LABEL);
  const result = check({ body: prBody, files, overridden });

  for (const note of result.notes) console.log(`ℹ️  ${note}`);
  if (result.ok) {
    console.log('✅ Staging soak evidence gate passed.');
    return;
  }
  for (const err of result.errors) console.error(`::error::${err}`);
  console.error('');
  console.error('See CLAUDE.md §1.11 (universal staging) and §1.12 (soak tier matrix) for context.');
  console.error(`See ${resolve(REPO, 'docs/staging/README.md')} for the rig + workflow.`);
  process.exit(1);
}

const isDirectInvocation = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const invokedPath = resolve(process.argv[1]);
  const modulePath = resolve(new URL(import.meta.url).pathname);
  return invokedPath === modulePath;
})();

if (isDirectInvocation) {
  if (!existsSync(REPO)) {
    console.error(`::error::REPO root ${REPO} does not exist.`);
    process.exit(1);
  }
  main();
}
