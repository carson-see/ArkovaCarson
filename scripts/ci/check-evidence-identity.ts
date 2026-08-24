#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2897 — evidence-identity CI gate.
 *
 * Merge-grade staging soak evidence is only trustworthy if it is bound to the
 * exact commit and clean environment it claims. Two silent-drift failures this
 * gate closes:
 *
 *   A. head-sha-identity — a new commit pushed after the evidence block was
 *      written leaves a stale `PR head SHA:` in the body. The soak proved an
 *      older tree; the tip is unproven. (feedback_pr_head_sha_in_evidence_block:
 *      "a new commit invalidates the body's PR head SHA".)
 *   B. clean-preflight-identity — the declared preflight must be
 *      `environment_type=clean_mirror` for T2/T3, and any head SHA embedded in
 *      the preflight output must match the declared PR head. Evidence may not be
 *      copied across heads/projects (CLAUDE.md §1.11A).
 *
 * SCOPE: this gate applies only to **Ready, soak-tier** PRs (T1/T2/T3 with a
 * Staging Soak Evidence block). Drafts and T0 / no-evidence PRs are skipped —
 * exact-head identity is meaningful at mark-ready, not while a Draft's head is
 * still moving.
 *
 * CI wiring: FAIL-CLOSED as of SCRUM-2965. The `evidence-identity` job in
 * ci.yml runs this CLI with no flags (non-zero exit reds the job, no
 * `continue-on-error`), and `.mergify.yml` lists `Evidence-identity gate` in
 * every queue rule's merge_conditions — a check absent from those conditions
 * can be red while Mergify merges anyway.
 *
 * `--report-only` survives as an explicit opt-in for local dry-runs and for
 * re-parking the gate during a calibration window. It makes `main()` always
 * exit 0 and emit `::warning::` instead of `::error::`; it is NOT what CI runs,
 * and `soak-integrity-gates-failclosed.test.ts` fails if it reappears in the
 * workflow invocation.
 */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

export interface Finding {
  /** Stable identifier for the identity check that produced the finding. */
  name: string;
  message: string;
}

export interface EvidenceIdentityInput {
  /** The PR body (github.event.pull_request.body). */
  body: string;
  /** The actual PR head SHA (github.event.pull_request.head.sha). */
  actualHeadSha: string;
  /** Whether the PR is a Draft (github.event.pull_request.draft). */
  isDraft: boolean;
  /** Declared tier override; if omitted it is parsed from the body's `Tier:`. */
  declaredTier?: Tier | null;
}

export interface EvidenceIdentityResult {
  skipped: boolean;
  skipReason: string | null;
  findings: Finding[];
  ok: boolean;
}

// Evidence blocks may carry a short (7+) or full (40) hex SHA.
const SHORT_OR_FULL_SHA_RE = /\b[0-9a-f]{7,40}\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the trailing value of a `Field:` line from the body (checkbox-tolerant). */
export function extractField(body: string, field: string): string | null {
  const re = new RegExp(
    String.raw`^[\s\-*]*(?:\[[ x]\]\s*)?${escapeRegExp(field)}[^\S\n]*(.*)$`,
    'im',
  );
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

/** Extract a normalized (lowercased) SHA from a `Field:` value, or null. */
export function extractShaFromField(body: string, field: string): string | null {
  const value = extractField(body, field);
  if (value === null) return null;
  const m = SHORT_OR_FULL_SHA_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

export function extractDeclaredTier(body: string): Tier | null {
  const value = extractField(body, 'Tier:');
  if (value === null) return null;
  const m = /\bT([0-3])\b/.exec(value);
  return m ? (`T${m[1]}` as Tier) : null;
}

export function hasEvidenceSection(body: string): boolean {
  return /##+\s*Staging Soak Evidence/i.test(body) || /^Tier:\s*T[0-3]/im.test(body);
}

/** True if two SHAs are identity-equal (one may be a short-SHA prefix of the other). */
function shaMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  if (n < 7) return false; // too short to be a meaningful commit identity
  return x.slice(0, n) === y.slice(0, n);
}

// ---------------------------------------------------------------------------
// Check A — head-sha-identity
// ---------------------------------------------------------------------------

export function checkHeadShaIdentity(
  body: string,
  actualHeadSha: string,
): Finding | null {
  const name = 'head-sha-identity';
  const declared = extractShaFromField(body, 'PR head SHA:');

  if (declared === null) {
    return {
      name,
      message:
        'Evidence block declares no `PR head SHA:` value. Soak evidence must ' +
        'bind to the exact commit under test.',
    };
  }

  if (!actualHeadSha) {
    return {
      name,
      message:
        'No actual PR head SHA available in CI context to compare against the ' +
        'declared `PR head SHA:`.',
    };
  }

  if (!shaMatches(declared, actualHeadSha)) {
    return {
      name,
      message:
        `Declared \`PR head SHA:\` ${declared} does not match the actual PR ` +
        `head ${actualHeadSha.toLowerCase()}. A commit pushed after the ` +
        `evidence was captured invalidates the exact-head soak; re-soak or ` +
        `bump the evidence head via \`gh pr edit\`.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check B — clean-preflight-identity
// ---------------------------------------------------------------------------

function isCleanMirror(value: string): boolean {
  return /["']?environment_type["']?\s*[:=]\s*["']?clean_mirror["']?/i.test(value);
}

/** `head=<sha>` / `head_sha: <sha>` / `commit=<sha>` — an explicitly labelled commit. */
const KEYED_SHA_RE = /\b(?:head[_-]?sha|head|commit|sha)\s*[:=]\s*([0-9a-f]{7,40})\b/i;
/** A bare 40-hex run. Nothing else in a preflight line is 40 hex characters. */
const FULL_SHA_RE = /\b[0-9a-f]{40}\b/i;

/**
 * The commit a free-text `Preflight result:` value claims it was captured
 * against, or null.
 *
 * Deliberately NOT `SHORT_OR_FULL_SHA_RE` over the whole value. That matches
 * the first 7+ hex run anywhere, which also catches a 7+ digit decimal (a row
 * count, a unix timestamp) and any short hex-ish identifier that is not a
 * commit (`ref=abc1234`) — turning an innocuous note into
 * "Preflight result embeds head 3556355". Harmless while this gate was
 * report-only; merge-blocking (SCRUM-2965) it reds a T2/T3 PR on a message its
 * author cannot act on.
 *
 * So: an explicitly KEYED sha wins, and a bare run counts only at the
 * unambiguous full 40 characters. What that gives up is a bare, unkeyed, SHORT
 * sha — a real cross-head mismatch has to be either labelled or spelled out in
 * full to be caught. The declared `PR head SHA:` field is unaffected: it is a
 * keyed field already, read by extractShaFromField().
 */
function extractPreflightSha(value: string): string | null {
  const keyed = KEYED_SHA_RE.exec(value);
  if (keyed) return keyed[1].toLowerCase();
  const full = FULL_SHA_RE.exec(value);
  return full ? full[0].toLowerCase() : null;
}

export function checkCleanPreflightIdentity(
  body: string,
  declaredHead: string | null,
  tier: Tier | null,
): Finding[] {
  const name = 'clean-preflight-identity';
  const findings: Finding[] = [];
  const preflight = extractField(body, 'Preflight result:');

  // No preflight field present — nothing to identity-check here (the standard
  // staging-evidence gate enforces presence/format; this gate is identity only).
  if (preflight === null || preflight.length === 0) return findings;

  // (b1) clean_mirror is required for T2/T3 environment identity.
  const requiresCleanMirror = tier === 'T2' || tier === 'T3';
  if (requiresCleanMirror && !isCleanMirror(preflight)) {
    findings.push({
      name,
      message:
        `Preflight result does not declare \`environment_type=clean_mirror\` ` +
        `(found: \`${preflight}\`). ${tier} merge-grade evidence requires a ` +
        `clean-mirror preflight identity (CLAUDE.md §1.11A).`,
    });
  }

  // (b2) any head SHA embedded in the preflight must match the declared head —
  // otherwise the preflight was captured against a different head (copied
  // evidence across heads).
  const preflightSha = extractPreflightSha(preflight);
  if (preflightSha && declaredHead && !shaMatches(preflightSha, declaredHead)) {
    findings.push({
      name,
      message:
        `Preflight result embeds head ${preflightSha.toLowerCase()} which ` +
        `differs from the declared \`PR head SHA:\` ${declaredHead}. Evidence ` +
        `may not be copied across heads (CLAUDE.md §1.11A).`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runEvidenceIdentity(
  input: EvidenceIdentityInput,
): EvidenceIdentityResult {
  const { body, actualHeadSha, isDraft } = input;

  if (isDraft) {
    return {
      skipped: true,
      skipReason: 'PR is a Draft — evidence-identity applies at mark-ready.',
      findings: [],
      ok: true,
    };
  }

  const tier = input.declaredTier ?? extractDeclaredTier(body);
  const soakTier = tier === 'T1' || tier === 'T2' || tier === 'T3';

  // An explicitly declared T0 requires no evidence block at all (CLAUDE.md
  // §1.12), and `hasEvidenceSection()` deliberately matches a bare `Tier: T0`
  // line — so the tier check MUST come before it. Otherwise a T0 PR that
  // simply states its tier (the required thing to do) falls through to
  // checkHeadShaIdentity and fails on the absent `PR head SHA:`. That was
  // invisible while the gate was report-only; fail-closed it would red every
  // T0 PR in the repo.
  if (tier === 'T0') {
    return {
      skipped: true,
      skipReason:
        'PR declares Tier: T0 — no staging soak evidence required (CLAUDE.md §1.12).',
      findings: [],
      ok: true,
    };
  }

  if (!soakTier && !hasEvidenceSection(body)) {
    return {
      skipped: true,
      skipReason:
        'No soak-tier Staging Soak Evidence block (T0 / CI-only / no-evidence PR).',
      findings: [],
      ok: true,
    };
  }

  const findings: Finding[] = [];
  const headFinding = checkHeadShaIdentity(body, actualHeadSha);
  if (headFinding) findings.push(headFinding);

  const declaredHead = extractShaFromField(body, 'PR head SHA:');
  findings.push(...checkCleanPreflightIdentity(body, declaredHead, tier));

  return {
    skipped: false,
    skipReason: null,
    findings,
    ok: findings.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Report + CLI
// ---------------------------------------------------------------------------

export function formatReport(
  result: EvidenceIdentityResult,
  reportOnly = false,
): string {
  const lines: string[] = [
    `Evidence-identity gate (SCRUM-2897)${reportOnly ? ' [REPORT-ONLY / non-gating]' : ''}:`,
    '',
  ];

  if (result.skipped) {
    lines.push(`  ⏭️  Skipped: ${result.skipReason}`);
    return lines.join('\n');
  }

  if (result.ok) {
    lines.push('  ✅ Evidence identity holds: declared PR head SHA matches the actual head; preflight identity is consistent.');
    return lines.join('\n');
  }

  for (const f of result.findings) {
    lines.push(`  ❌ [${f.name}] ${f.message}`);
  }
  lines.push('');
  lines.push(
    reportOnly
      ? '::warning::Evidence-identity finding(s) detected. Report-only during calibration (SCRUM-2897) — non-gating; the evidence does not bind to the PR tip / clean environment it claims.'
      : '::error::Evidence-identity gate FAILED — the soak evidence does not bind to the exact PR head / clean environment it claims.',
  );
  return lines.join('\n');
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((value ?? '').trim());
}

export function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const reportOnly = argv.includes('--report-only');
  const body = env.PR_BODY ?? '';
  const actualHeadSha = env.PR_HEAD_SHA ?? '';
  const isDraft = isTruthyEnv(env.PR_IS_DRAFT);

  if (!actualHeadSha) {
    console.log(
      '::notice::evidence-identity: no PR head SHA in context (not a pull_request event) — nothing to check.',
    );
    return 0;
  }

  const result = runEvidenceIdentity({ body, actualHeadSha, isDraft });
  console.log(formatReport(result, reportOnly));

  if (result.skipped) return 0;
  return reportOnly ? 0 : result.ok ? 0 : 1;
}

function isMainModule(): boolean {
  // Only run the CLI when executed directly (not when imported by tests).
  const invoked = process.argv[1] ?? '';
  return invoked.endsWith('check-evidence-identity.ts') || invoked.endsWith('check-evidence-identity.js');
}

if (isMainModule()) {
  process.exit(main());
}
