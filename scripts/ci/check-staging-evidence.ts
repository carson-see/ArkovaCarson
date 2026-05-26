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
 * No override label exists. The previous `staging-soak-skip` override
 * was removed on 2026-05-07 — every prod-bound PR must produce real
 * staging evidence per CLAUDE.md §1.11. The only remaining "skip" is
 * the `isStagingToolingOnly` allowlist below for PRs that exclusively
 * touch staging-tooling files (which by definition can't affect prod).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO,
  baseRef,
  prBody,
  changedFiles,
  resolveCommitOrFail,
} from './lib/ciContext.js';

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
    soakHours: 2,
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
    soakHours: 12,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'PR head SHA:',
      'Base SHA:',
      'Staging project ref:',
      'Cloud Run service/tag URL:',
      'Image digest:',
      'Evidence scope:',
      'Preflight timestamp:',
      'Preflight result:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
      // SCRUM-1803: every T2/T3 deploy MUST go through scripts/staging/deploy.sh,
      // which writes to public.staging_deploy_log. The PR body cites the row id.
      'Staging deploy log id:',
    ],
  },
  T3: {
    tier: 'T3',
    soakHours: 48,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'PR head SHA:',
      'Base SHA:',
      'Staging project ref:',
      'Cloud Run service/tag URL:',
      'Image digest:',
      'Evidence scope:',
      'Preflight timestamp:',
      'Preflight result:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
      'Staging deploy log id:',
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
    pattern: /^services\/worker\/src\/jobs\/(anchor|anchorExpirySweep|batch-anchor|check-confirmations|broadcast-recovery|chain-maintenance|attestationAnchor|grace-expiry-sweep|revocation)\.ts$/,
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
const SHA_RE = /\b[0-9a-f]{40}\b/i;
const DECLARED_TIER_VALUES = new Set<Tier>(['T1', 'T2', 'T3']);
const ALLOWED_EVIDENCE_SCOPES = new Set([
  'merge-grade shared staging',
  'merge-grade isolated staging',
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

export function requiredTierFor(files: string[]): { tier: Tier; reason: string } {
  let best: Tier = 'T1';
  let reason = 'default frontend / additive change';
  for (const f of files) {
    if (STAGING_TOOLING_ALLOW.some((re) => re.test(f))) continue;
    if (TEST_FILE_RE.test(f)) continue;
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
const UTC_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|Z)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export function extractDeclaredTier(body: string): Tier | null {
  for (const line of body.split(/\r?\n/)) {
    let candidate = line.trimStart();
    if (candidate.startsWith('-') || candidate.startsWith('*')) {
      candidate = candidate.slice(1).trimStart();
    }
    if (candidate.startsWith('[x]') || candidate.startsWith('[ ]')) {
      candidate = candidate.slice(3).trimStart();
    }
    if (!candidate.startsWith('Tier:')) continue;

    const rest = candidate.slice('Tier:'.length).trimStart();
    const value = rest.slice(0, 2);
    const next = rest[2];
    if (DECLARED_TIER_VALUES.has(value as Tier) && (next === undefined || !/[A-Za-z0-9_]/.test(next))) {
      return value as Tier;
    }
  }
  return null;
}

export function hasEvidenceSection(body: string): boolean {
  return EVIDENCE_HEADER_RE.test(body);
}

export function missingFields(body: string, tier: Tier): string[] {
  const spec = TIER_SPECS[tier];
  const missing: string[] = [];
  for (const field of spec.requiredFields) {
    // Field labels are line-anchored to avoid matching prose mentions.
    const re = new RegExp(String.raw`^[\s\-*]*(?:\[[ x]\]\s*)?${escapeRegExp(field)}`, 'im');
    if (!re.test(body)) missing.push(field);
  }
  return missing;
}

function extractEvidenceFieldValue(body: string, field: string): string | null {
  const re = new RegExp(String.raw`^[\s\-*]*(?:\[[ x]\]\s*)?${escapeRegExp(field)}[^\S\n]*(.*)$`, 'im');
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

function parseEvidenceTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return direct;

  const utc = UTC_TIMESTAMP_RE.exec(trimmed);
  if (!utc) return null;

  const [, date, time, seconds] = utc;
  const ms = Date.parse(`${date}T${time}:${seconds ?? '00'}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function formatHours(hours: number): string {
  if (Number.isInteger(hours)) return String(hours);
  const fixed = hours.toFixed(2);
  if (fixed.endsWith('00')) return fixed.slice(0, -3);
  if (fixed.endsWith('0')) return fixed.slice(0, -1);
  return fixed;
}

export function soakDurationErrors(body: string, tier: Tier): string[] {
  const startValue = extractEvidenceFieldValue(body, 'Soak start:');
  const endValue = extractEvidenceFieldValue(body, 'Soak end:');
  const errors: string[] = [];

  if (startValue === null || endValue === null) return errors;

  const startMs = parseEvidenceTimestamp(startValue);
  const endMs = parseEvidenceTimestamp(endValue);

  if (startMs === null || endMs === null) {
    if (startMs === null) {
      errors.push(`Soak start could not parse as a timestamp: \`${startValue}\`.`);
    }
    if (endMs === null) {
      errors.push(`Soak end could not parse as a timestamp: \`${endValue}\`.`);
    }
    return errors;
  }

  if (endMs <= startMs) {
    return ['Soak end must be after Soak start.'];
  }

  const spec = TIER_SPECS[tier];
  const elapsedHours = (endMs - startMs) / 3_600_000;
  if (elapsedHours < spec.soakHours) {
    return [
      `${tier} soak duration (${formatHours(elapsedHours)}h) is below the `
      + `${spec.soakHours}h minimum. Soak start: \`${startValue}\`; Soak end: \`${endValue}\`.`,
    ];
  }

  return errors;
}

function extractShaField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null) return null;
  const m = SHA_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

function normalizeSha(value: string | undefined): string | null {
  if (!value) return null;
  const m = SHA_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

function hasCleanMirrorPreflight(value: string): boolean {
  const lower = value.toLowerCase();
  if (/\b(?:soak_artifact|fixture_seeded)\b/.test(lower)) return false;
  if (/\bdiagnostic[- ]?only\b/.test(lower)) return false;
  return /["']?environment_type["']?\s*[:=]\s*["']?clean_mirror["']?/.test(lower);
}

function normalizeEvidenceScope(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function evidenceScopeErrors(body: string): string[] {
  const evidenceScope = extractEvidenceFieldValue(body, 'Evidence scope:');
  if (evidenceScope === null) {
    return ['Evidence scope must be one of: merge-grade shared staging, merge-grade isolated staging.'];
  }

  const normalized = normalizeEvidenceScope(evidenceScope);
  if (/\bdiagnostic[- ]?only\b/i.test(normalized)) {
    return ['Evidence scope is diagnostic-only; diagnostic evidence is not merge-grade staging evidence.'];
  }

  if (ALLOWED_EVIDENCE_SCOPES.has(normalized)) return [];

  return ['Evidence scope must be one of: merge-grade shared staging, merge-grade isolated staging.'];
}

function preflightResultErrors(body: string): string[] {
  const preflightResult = extractEvidenceFieldValue(body, 'Preflight result:');
  if (preflightResult === null || hasCleanMirrorPreflight(preflightResult)) return [];
  return ['Preflight result must capture `environment_type=clean_mirror`; dirty or diagnostic preflight output is not merge-grade evidence.'];
}

function preflightTimestampErrors(body: string): string[] {
  const preflightTimestampValue = extractEvidenceFieldValue(body, 'Preflight timestamp:');
  if (preflightTimestampValue === null) return [];

  const preflightMs = parseEvidenceTimestamp(preflightTimestampValue);
  if (preflightMs === null) {
    return [`Preflight timestamp could not parse as a timestamp: \`${preflightTimestampValue}\`.`];
  }

  const soakStartValue = extractEvidenceFieldValue(body, 'Soak start:');
  const soakStartMs = soakStartValue === null ? null : parseEvidenceTimestamp(soakStartValue);
  if (soakStartMs !== null && preflightMs > soakStartMs) {
    return ['Preflight timestamp must be at or before Soak start.'];
  }

  return [];
}

function shaEvidenceErrors(opts: {
  body: string;
  field: string;
  expectedSha?: string;
  currentLabel: string;
  staleMessage: string;
}): string[] {
  const evidenceSha = extractShaField(opts.body, opts.field);
  if (!evidenceSha) return [`${opts.field} must contain a 40-character commit SHA.`];

  const expectedSha = normalizeSha(opts.expectedSha);
  if (!expectedSha || evidenceSha === expectedSha) return [];

  return [
    `${opts.field} \`${evidenceSha}\` does not match current ${opts.currentLabel} \`${expectedSha}\`; ${opts.staleMessage}`,
  ];
}

function stagingIntegrityErrors(
  body: string,
  tier: Tier,
  opts: { headSha?: string; baseSha?: string } = {},
): string[] {
  if (tier === 'T1') return [];

  return [
    ...evidenceScopeErrors(body),
    ...preflightResultErrors(body),
    ...preflightTimestampErrors(body),
    ...shaEvidenceErrors({
      body,
      field: 'PR head SHA:',
      expectedSha: opts.headSha,
      currentLabel: 'PR head',
      staleMessage: 'evidence cannot be copied across commits.',
    }),
    ...shaEvidenceErrors({
      body,
      field: 'Base SHA:',
      expectedSha: opts.baseSha,
      currentLabel: 'base',
      staleMessage: 're-check merge-base drift before claiming merge-grade evidence.',
    }),
  ];
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
const STAGING_TOOLING_ALLOW = [
  /^scripts\/staging\//,
  /^scripts\/ci\/check-staging-evidence(\.test)?\.ts$/,
  /^scripts\/ci\/check-staging-gcloud-policy(\.test)?\.ts$/,
  /^scripts\/ci\/staging-honesty-preflight(\.test)?\.ts$/,
  /^scripts\/ci\/lib\//,
  /^scripts\/gcp-setup\//,
  /^docs\/staging\//,
  /^docs\/ops\/gemini-model-upgrade\.md$/,
  /^docs\/reference\/STAGING_RIG\.md$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/workflows\/staging-evidence\.yml$/,
  /^\.github\/workflows\/deploy-staging\.yml$/,
  /^\.github\/workflows\/deploy-worker\.yml$/,
  /^services\/worker\/cloudbuild\.yaml$/,
  /^\.mergify\.yml$/,
  /^CLAUDE\.md$/,
  /^HANDOFF\.md$/,
  /^\.gitignore$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/hooks\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package-lock\.json$/,
  /^services\/[^/]+\/package\.json$/,
  /^services\/[^/]+\/package-lock\.json$/,
  /agents\.md$/,
  /^eslint-rules\//,
  /(^|\/)eslint\.config\.(js|cjs|mjs)$/,
  /^e2e\//,
];

export function isStagingToolingOnly(files: string[]): StagingFilesOnlyResult {
  if (files.length === 0) return { pass: true, reason: 'no changed files' };
  for (const f of files) {
    if (!STAGING_TOOLING_ALLOW.some((re) => re.test(f))) {
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

export function check(opts: { body: string; files: string[]; headSha?: string; baseSha?: string }): CheckResult {
  const { body, files } = opts;
  const result: CheckResult = { ok: true, errors: [], notes: [] };

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

  const durationErrors = soakDurationErrors(body, declared);
  if (durationErrors.length > 0) {
    result.ok = false;
    result.errors.push(...durationErrors);
  }

  const integrityErrors = stagingIntegrityErrors(body, declared, opts);
  if (integrityErrors.length > 0) {
    result.ok = false;
    result.errors.push(...integrityErrors);
  }

  return result;
}

function main(): void {
  const files = changedFiles();
  const currentHeadSha = resolveCommitOrFail(
    process.env.HEAD_REF_SHA || process.env.GITHUB_SHA || 'HEAD',
    'CI head ref',
  );
  const result = check({ body: prBody, files, headSha: currentHeadSha, baseSha: baseRef });

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
