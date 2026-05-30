#!/usr/bin/env -S npx tsx
/**
 * Staging soak evidence gate (CLAUDE.md §1.11 / §1.12).
 *
 * Every prod-affecting PR declares a risk tier (T1 / T2 / T3) in its
 * body. T0 docs/tests/CI/tooling-only PRs run CI only. The tier dictates
 * required evidence fields and, for T2/T3, required soak length. CI fails
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
 * was removed on 2026-05-07. The only CI-only path is T0, computed from
 * changed files rather than labels.
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

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

interface TierSpec {
  tier: Tier;
  /** Minimum soak duration in hours. */
  soakHours: number;
  /** Required evidence field labels. Match the literal string in the PR body. */
  requiredFields: string[];
}

export const TIER_SPECS: Record<Tier, TierSpec> = {
  T0: {
    tier: 'T0',
    soakHours: 0,
    requiredFields: ['Tier:'],
  },
  T1: {
    tier: 'T1',
    soakHours: 0,
    requiredFields: [
      'Tier:',
      'PR head SHA:',
      'Staging tag URL or N/A explanation:',
      'Health/smoke result:',
      'CI/E2E green:',
      'Rollback plan:',
      'Risk rationale:',
      'Human approver:',
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
    minTier: 'T3',
    reason: 'migration touches schema/data integrity',
  },
  {
    pattern: /^services\/worker\/src\/security\//,
    minTier: 'T3',
    reason: 'security-sensitive worker logic',
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
    pattern: /^src\/components\/admin\/treasury\//,
    minTier: 'T3',
    reason: 'treasury administration surface',
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
    pattern: /^\.github\/workflows\/deploy-worker\.yml$/,
    minTier: 'T2',
    reason: 'worker deploy config (prod runtime: min-instances, env, secrets, image)',
  },
  {
    pattern: /^services\/worker\/cloudbuild\.yaml$/,
    minTier: 'T2',
    reason: 'worker image build config',
  },
  {
    pattern: /^services\/worker\/src\/auth\//,
    minTier: 'T2',
    reason: 'auth-sensitive worker logic',
  },
  {
    pattern: /^services\/worker\/src\/(?:ai|agents|nessie|llm|model)\//,
    minTier: 'T2',
    reason: 'AI behavior',
  },
  {
    pattern: /^services\/worker\/src\/(?:jobs|queues?|concurrency)\//,
    minTier: 'T2',
    reason: 'worker queue/concurrency behavior',
  },
  {
    pattern: /^services\/worker\/src\//,
    minTier: 'T2',
    reason: 'worker behavior',
  },
  {
    pattern: /^(?:docs\/api\/|docs\/guides\/API_GUIDE\.md|sdks\/|packages\/(?:arkova-py|embed|mcp-server|typescript|langchain))/,
    minTier: 'T2',
    reason: 'public API contract / SDK surface',
  },
  {
    pattern: /^src\/components\/(?:anchor|api|auth|billing|public|verification|verify)\//,
    minTier: 'T2',
    reason: 'sensitive user-facing contract surface',
  },
  {
    pattern: /^src\/(components|pages|hooks|lib)\//,
    minTier: 'T1',
    reason: 'frontend code',
  },
];

const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const SHA_RE = /\b[0-9a-f]{40}\b/i;
const DECLARED_TIER_VALUES = new Set<Tier>(['T0', 'T1', 'T2', 'T3']);
const ALLOWED_EVIDENCE_SCOPES = new Set([
  'merge-grade shared staging',
  'merge-grade isolated staging',
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const PUBLIC_CONTRACT_DOC_RE = /^docs\/(?:api\/|guides\/API_GUIDE\.md)/;
const DOCS_ONLY_RE = /^(?:docs\/|README\.md|ARKOVA_WORKSPACE_README\.md|WORKSPACE_STATUS\.md|memory\/.*\.md$)/;

function isT0OnlyFile(file: string): boolean {
  if (PUBLIC_CONTRACT_DOC_RE.test(file)) return false;
  if (TEST_FILE_RE.test(file) || /agents\.md$/.test(file)) return true;
  if (/^(?:package-lock\.json|packages\/[^/]+\/package-lock\.json|services\/[^/]+\/package-lock\.json)$/.test(file)) return true;
  if (PATH_RULES.some((rule) => rule.pattern.test(file))) return false;
  return STAGING_TOOLING_ALLOW.some((re) => re.test(file))
    || DOCS_ONLY_RE.test(file)
    || /^\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|pull_request_template\.md|CONTRIBUTING\.md|dependabot\.yml)/.test(file);
}

export function requiredTierFor(files: string[]): { tier: Tier; reason: string } {
  if (files.length === 0) return { tier: 'T0', reason: 'no changed files' };
  if (files.every(isT0OnlyFile)) {
    return { tier: 'T0', reason: 'docs/tests/CI/tooling-only' };
  }

  let best: Tier = 'T1';
  let reason = 'default frontend / additive change';
  for (const f of files) {
    if (isT0OnlyFile(f)) continue;
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

function validateNonEmptyEvidenceField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length > 0) return null;
  return `${field} must include auditable evidence, not an empty value.`;
}

function validateStagingTagEvidence(body: string): string | null {
  const field = 'Staging tag URL or N/A explanation:';
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0) return null;

  const hasUrl = /\bhttps?:\/\/\S+/i.test(value);
  const hasExplanation = /\b(?:n\/a|not applicable|no staging tag|not needed)\b/i.test(value);
  return hasUrl || hasExplanation
    ? null
    : `${field} must contain a staging URL or an explicit N/A explanation.`;
}

function validatePassingEvidenceField(
  body: string,
  field: string,
  passPattern: RegExp,
  message: string,
): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0 || passPattern.test(value)) return null;
  return message;
}

// "Not filled in yet" markers — never acceptable as evidence on any tier.
// Anchored to the whole (trimmed) value so a legitimate sentence that merely
// mentions one of these words is not falsely rejected.
const INCOMPLETE_VALUE_RE =
  /^(?:pending|tbd|to[\s-]?be[\s-]?(?:determined|announced|filled(?:[\s-]?in)?)|tba|todo|to[\s-]?do|fixme|wip|work[\s-]?in[\s-]?progress|fill[\s-]?in|placeholder|coming[\s-]?soon|see[\s-]?above|xxx+|\?+|-+|_+|\.{2,}|…|<[^>]*>)\.?$/i;

// "Not applicable" markers — legitimate for some fields (e.g. `Migration
// applied: none`) but never for a concrete deploy artifact.
const NOT_APPLICABLE_VALUE_RE = /^(?:n\/?a|n\.?a\.?|none|not[\s-]?applicable|null|nil)\.?$/i;

function isIncompletePlaceholder(value: string): boolean {
  return INCOMPLETE_VALUE_RE.test(value.trim());
}

function isNotApplicablePlaceholder(value: string): boolean {
  return NOT_APPLICABLE_VALUE_RE.test(value.trim());
}

/**
 * Non-empty AND not a "not filled in yet" placeholder (PENDING/TBD/…).
 * N/A-style answers are allowed — use {@link validateArtifactEvidenceField}
 * for fields where N/A is also unacceptable.
 */
function validateFilledEvidenceField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null) return null; // label absent → missingFields() owns this
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${field} must include auditable evidence, not an empty value.`;
  if (isIncompletePlaceholder(trimmed)) {
    return `${field} is a placeholder (\`${trimmed}\`), not auditable evidence — fill in the real value from the staging deploy.`;
  }
  return null;
}

/**
 * A concrete artifact that a real T2/T3 soak necessarily produces (worker
 * revision, image digest, deploy-log id, Cloud Run URL). Neither a "not filled
 * in" placeholder nor an "N/A" is acceptable here.
 */
function validateArtifactEvidenceField(body: string, field: string): string | null {
  const filled = validateFilledEvidenceField(body, field);
  if (filled !== null) return filled;
  const value = extractEvidenceFieldValue(body, field);
  if (value !== null && isNotApplicablePlaceholder(value)) {
    return `${field} must reference a real staging deploy artifact; \`${value.trim()}\` is not auditable evidence for a T2/T3 soak.`;
  }
  return null;
}

function validateCloudRunUrlEvidence(body: string): string | null {
  const field = 'Cloud Run service/tag URL:';
  const artifact = validateArtifactEvidenceField(body, field);
  if (artifact !== null) return artifact;
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0) return null;
  return /\bhttps?:\/\/\S+/i.test(value)
    ? null
    : `${field} must contain the Cloud Run service or tag URL.`;
}

// Concrete deploy artifacts: a placeholder or N/A here means the deploy did
// not actually happen for this evidence.
const T2_T3_ARTIFACT_FIELDS = [
  'Worker revision:',
  'Image digest:',
  'Staging deploy log id:',
];

// Remaining evidence fields that must at least be filled in (PENDING/TBD/empty
// rejected). N/A-style answers stay allowed where legitimate (e.g. `Migration
// applied: none`). T3-only fields are simply absent from a T2 body —
// validateFilledEvidenceField no-ops on a missing label.
const T2_T3_FILLED_FIELDS = [
  'Staging branch:',
  'Staging project ref:',
  'E2E result:',
  'Migration applied:',
  'Rollback rehearsed:',
  'Trigger A fires:',
  'Trigger B fires:',
  'Daily flush observation:',
  'Per-org isolation check:',
];

function requiredValueErrors(body: string, tier: Tier): string[] {
  if (tier === 'T0') return [];

  if (tier === 'T1') {
    const emptyFieldErrors = TIER_SPECS.T1.requiredFields
      .filter((field) => field !== 'Tier:' && field !== 'PR head SHA:')
      .map((field) => validateNonEmptyEvidenceField(body, field));

    return [
      ...emptyFieldErrors,
      validateStagingTagEvidence(body),
      validatePassingEvidenceField(
        body,
        'Health/smoke result:',
        /\b(?:green|pass(?:ed|es)?|ok|healthy)\b/i,
        'Health/smoke result: must state a passing health/smoke result.',
      ),
      validatePassingEvidenceField(
        body,
        'CI/E2E green:',
        /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
        'CI/E2E green: must state that CI/E2E is green.',
      ),
    ].filter((error): error is string => error !== null);
  }

  // T2 / T3 — the stricter, symmetric analog of the T1 checks above. Deploy
  // evidence must carry real, auditable values; the SHA / scope / preflight /
  // soak fields have their own dedicated validators and are skipped here to
  // avoid duplicate errors (CLAUDE.md §1.11A: PENDING deploy evidence on dirty
  // staging must not pass CI).
  return [
    ...T2_T3_ARTIFACT_FIELDS.map((field) => validateArtifactEvidenceField(body, field)),
    validateCloudRunUrlEvidence(body),
    ...T2_T3_FILLED_FIELDS.map((field) => validateFilledEvidenceField(body, field)),
  ].filter((error): error is string => error !== null);
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

const RESIDUAL_RISK_HEADER_RE = /^###\s+Residual-risk\s+note\b/im;

const RESIDUAL_RISK_REQUIRED_FIELDS = [
  'Contamination type:',
  'Affected rows:',
  'Impact on this PR:',
  'Reason not cleaned:',
  'Approved by:',
];

export function hasResidualRiskException(body: string): { valid: boolean; missing: string[] } {
  const headerMatch = RESIDUAL_RISK_HEADER_RE.exec(body);
  if (!headerMatch) return { valid: false, missing: [] };
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const nextHeading = body.slice(sectionStart).search(/^#{1,3}\s/m);
  const section = nextHeading === -1
    ? body.slice(sectionStart)
    : body.slice(sectionStart, sectionStart + nextHeading);
  const missing: string[] = [];
  for (const field of RESIDUAL_RISK_REQUIRED_FIELDS) {
    const re = new RegExp(String.raw`^[\s\-*]*${escapeRegExp(field)}`, 'im');
    if (!re.test(section)) missing.push(field);
  }
  // `Approved by:` must name a real approver. A present-but-empty or
  // placeholder value (pending/tbd/n/a) is a self-waiver and does NOT grant
  // the exception, which would otherwise bypass both the clean_mirror preflight
  // and the soak-duration minimum (CLAUDE.md §1.11A).
  if (!missing.includes('Approved by:')) {
    const approver = extractEvidenceFieldValue(section, 'Approved by:');
    const trimmed = approver?.trim() ?? '';
    if (trimmed.length === 0 || isIncompletePlaceholder(trimmed) || isNotApplicablePlaceholder(trimmed)) {
      missing.push('Approved by: (must name a real approver, not a blank or placeholder)');
    }
  }
  return { valid: missing.length === 0, missing };
}

function preflightResultErrors(body: string): string[] {
  const preflightResult = extractEvidenceFieldValue(body, 'Preflight result:');
  if (preflightResult === null || hasCleanMirrorPreflight(preflightResult)) return [];

  const riskException = hasResidualRiskException(body);
  if (riskException.valid) return [];
  if (riskException.missing.length > 0) {
    return [
      `Preflight is not clean_mirror but the residual-risk note is missing required sub-fields: `
      + riskException.missing.map((f) => `\`${f}\``).join(', ')
      + `. Add a \`### Residual-risk note\` section with all required fields.`,
    ];
  }

  return ['Preflight result must capture `environment_type=clean_mirror`; dirty or diagnostic preflight output is not merge-grade evidence. Alternatively, add a `### Residual-risk note` section documenting the exception (see CLAUDE.md §1.11A).'];
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
  if (tier === 'T0') return [];

  if (tier === 'T1') {
    return [
      ...shaEvidenceErrors({
        body,
        field: 'PR head SHA:',
        expectedSha: opts.headSha,
        currentLabel: 'PR head',
        staleMessage: 'expedited evidence cannot be copied across commits.',
      }),
    ];
  }

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
 * T0 changes cannot affect production runtime behavior. They run the normal
 * CI suite but do not need staging evidence.
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
  /^\.mergify\.yml$/,
  /^CLAUDE\.md$/,
  /^HANDOFF\.md$/,
  /^\.gitignore$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/hooks\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package-lock\.json$/,
  /^services\/edge\/package\.json$/,
  /^services\/[^/]+\/package-lock\.json$/,
  /agents\.md$/,
  /^eslint-rules\//,
  /(^|\/)eslint\.config\.(js|cjs|mjs)$/,
  /^e2e\//,
];

export function isStagingToolingOnly(files: string[]): StagingFilesOnlyResult {
  if (files.length === 0) return { pass: true, reason: 'no changed files' };
  for (const f of files) {
    if (!isT0OnlyFile(f)) {
      return { pass: false, reason: `${f} is outside the T0 docs/tests/CI/tooling allowlist` };
    }
  }
  return { pass: true, reason: 'all touched files are T0 docs/tests/CI/tooling-only' };
}

interface CheckResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

export function check(opts: { body: string; files: string[]; headSha?: string; baseSha?: string }): CheckResult {
  const { body, files } = opts;
  const result: CheckResult = { ok: true, errors: [], notes: [] };

  const required = requiredTierFor(files);
  if (required.tier === 'T0') {
    result.notes.push(`T0 CI-only PR (${required.reason}) — no staging soak evidence required.`);
    return result;
  }

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
    const riskException = hasResidualRiskException(body);
    if (riskException.valid) {
      result.notes.push(`Soak duration below ${TIER_SPECS[declared].soakHours}h minimum; residual-risk exception accepted.`);
    } else {
      result.ok = false;
      result.errors.push(...durationErrors);
    }
  }

  const valueErrors = requiredValueErrors(body, declared);
  if (valueErrors.length > 0) {
    result.ok = false;
    result.errors.push(...valueErrors);
  }

  const integrityErrors = stagingIntegrityErrors(body, declared, opts);
  if (integrityErrors.length > 0) {
    result.ok = false;
    result.errors.push(...integrityErrors);
  }

  const preflightVal = extractEvidenceFieldValue(body, 'Preflight result:');
  const preflightIsClean = preflightVal !== null && hasCleanMirrorPreflight(preflightVal);
  if (result.ok && !preflightIsClean && hasResidualRiskException(body).valid) {
    result.notes.push('Preflight is not clean_mirror; residual-risk exception accepted.');
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
