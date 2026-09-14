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
 *
 * Post-soak T0 delta allowance (CTO decision 2026-09-12, Confluence 146440221
 * / SCRUM-5054): `check-staging-evidence.ts` accepts a `Post-soak T0 delta:`
 * body field that relaxes exact-head binding when every commit after the
 * soaked `PR head SHA:` touches only T0-classified files. This gate's check A
 * (`checkHeadShaIdentity`) was not taught the same rule and failed every PR
 * legitimately using it — this file closes that gap by evaluating the SAME
 * field with the SAME semantics, reusing `requiredTierFor` /
 * `changedFilesBetween` / `gitAncestryProvider` from `check-staging-evidence.ts`
 * so the two gates cannot drift apart on this rule the way they just did.
 *
 * Edge-deploy-only carve-out (CTO decision 2026-09-13, PR #2908): check B's
 * clean-mirror requirement is unconditional for T2/T3 in
 * `check-staging-evidence.ts` (a PR either has clean_mirror evidence or a
 * `### Residual-risk note`), but this gate never grew that residual-risk-note
 * hatch — deliberately: it is the one check that cannot be talked out of by
 * prose, and a general hatch here would weaken it for every soak run on a
 * contaminated rig. A Cloudflare-Worker-only PR has no Supabase project in
 * scope at all, so instead of a prose hatch, `evaluateCleanPreflightIdentity`
 * skips the clean-mirror requirement ONLY when `isEdgeDeployOnlyChange`
 * (imported from `check-staging-evidence.ts`) is true of the PR's own
 * changed-file set (declared `Base SHA:` → `PR head SHA:`) — a fact computed
 * from a real diff, not asserted by the PR author. See the rationale comment
 * on `evaluateCleanPreflightIdentity` for the full argument and its explicit
 * rejection of the general-hatch alternative.
 */

import {
  requiredTierFor,
  changedFilesBetween,
  gitAncestryProvider,
  isEdgeDeployOnlyChange,
  type AncestryProvider,
  type ChangedFilesProvider,
} from './check-staging-evidence.js';

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
  /**
   * Injection points for the Post-soak T0 delta allowance's git-facing
   * questions (ancestry + changed-file list between the soaked `PR head SHA:`
   * and `actualHeadSha`). Tests inject stubs so this module never shells out;
   * omitted in production, where `checkHeadShaIdentity` falls back to real git
   * via {@link gitAncestryProvider} / {@link changedFilesBetween}.
   */
  ancestryProvider?: AncestryProvider;
  changedFilesProvider?: ChangedFilesProvider;
}

export interface EvidenceIdentityResult {
  skipped: boolean;
  skipReason: string | null;
  findings: Finding[];
  /** Informational lines — e.g. an accepted Post-soak T0 delta — that do not fail the gate. */
  notes: string[];
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

const POST_SOAK_T0_DELTA_FIELD = 'Post-soak T0 delta:';

/** Injectable git access for the Post-soak T0 delta allowance. See {@link EvidenceIdentityInput}. */
export interface HeadShaIdentityOpts {
  ancestryProvider?: AncestryProvider;
  changedFilesProvider?: ChangedFilesProvider;
}

interface HeadShaIdentityEvaluation {
  finding: Finding | null;
  /** Set only on an accepted Post-soak T0 delta — informational, never fails the gate. */
  note: string | null;
}

/**
 * Core `head-sha-identity` evaluation, including the Post-soak T0 delta
 * allowance (CTO decision 2026-09-12, Confluence 146440221 / SCRUM-5054).
 * `checkHeadShaIdentity` is a thin wrapper returning only `.finding`, unchanged
 * in shape for existing callers; `runEvidenceIdentity` also reads `.note` so an
 * accepted delta surfaces as an info line instead of vanishing silently.
 *
 * This mirrors `check-staging-evidence.ts`'s `headShaEvidenceResult()` for the
 * SAME field, reusing its `requiredTierFor` / `changedFilesBetween` /
 * `gitAncestryProvider` rather than re-implementing the git-facing questions:
 *
 *   (a) The field's value must name the CURRENT head SHA this gate is
 *       grading (`actualHeadSha`) — it cannot be claimed against another
 *       commit.
 *   (b) The soaked SHA (declared `PR head SHA:`) must be an ANCESTOR of the
 *       actual head: the delta is an append-only continuation of the soaked
 *       tree, not a rebase/force-push onto different history. Unresolvable
 *       ancestry (`null`) rejects.
 *   (c) The changed-file list between soaked and actual head must be
 *       computable and non-empty, and `requiredTierFor` of that list must
 *       return `'T0'` — no diff-provider carve-outs, since those decide
 *       T0-ness from a diff against the PR base rather than the post-soak
 *       delta. An uncomputable list rejects.
 *
 * Every condition fails CLOSED to the original stale-head finding: this is
 * opt-in per PR, not a general stale-head waiver.
 */
function evaluateHeadShaIdentity(
  body: string,
  actualHeadSha: string,
  opts: HeadShaIdentityOpts = {},
): HeadShaIdentityEvaluation {
  const name = 'head-sha-identity';
  const declared = extractShaFromField(body, 'PR head SHA:');

  if (declared === null) {
    return {
      finding: {
        name,
        message:
          'Evidence block declares no `PR head SHA:` value. Soak evidence must ' +
          'bind to the exact commit under test.',
      },
      note: null,
    };
  }

  if (!actualHeadSha) {
    return {
      finding: {
        name,
        message:
          'No actual PR head SHA available in CI context to compare against the ' +
          'declared `PR head SHA:`.',
      },
      note: null,
    };
  }

  if (shaMatches(declared, actualHeadSha)) {
    return { finding: null, note: null };
  }

  const staleFinding: Finding = {
    name,
    message:
      `Declared \`PR head SHA:\` ${declared} does not match the actual PR ` +
      `head ${actualHeadSha.toLowerCase()}. A commit pushed after the ` +
      `evidence was captured invalidates the exact-head soak; re-soak or ` +
      `bump the evidence head via \`gh pr edit\`.`,
  };

  // Post-soak T0-only delta allowance. Field absent → the pre-2026-09-12
  // behaviour, verbatim (the original stale-head finding stands).
  if (extractField(body, POST_SOAK_T0_DELTA_FIELD) === null) {
    return { finding: staleFinding, note: null };
  }

  const deltaSha = extractShaFromField(body, POST_SOAK_T0_DELTA_FIELD);
  if (deltaSha === null || !shaMatches(deltaSha, actualHeadSha)) {
    return {
      finding: {
        name,
        message:
          `${POST_SOAK_T0_DELTA_FIELD} must contain the CURRENT PR head SHA ` +
          `${actualHeadSha.toLowerCase()}${deltaSha ? ` (found ${deltaSha})` : ''}; the ` +
          'allowance cannot be claimed against a commit this gate is not grading, and ' +
          `the declared \`PR head SHA:\` ${declared} does not match the actual head either.`,
      },
      note: null,
    };
  }

  const ancestryProvider = opts.ancestryProvider ?? gitAncestryProvider();
  const ancestry = ancestryProvider(declared, actualHeadSha);
  if (ancestry !== true) {
    return {
      finding: {
        name,
        message:
          `${POST_SOAK_T0_DELTA_FIELD} rejected: soaked head \`${declared}\` is ` +
          `${ancestry === false ? 'not an ancestor of' : 'of unresolvable ancestry to'} ` +
          `current head \`${actualHeadSha.toLowerCase()}\`, so the post-soak commits are not ` +
          'an append-only continuation of the soaked tree. Re-soak on the current head.',
      },
      note: null,
    };
  }

  const changedFilesProvider = opts.changedFilesProvider ?? changedFilesBetween;
  const delta = changedFilesProvider(declared, actualHeadSha);
  if (delta === null || delta.length === 0) {
    return {
      finding: {
        name,
        message:
          `${POST_SOAK_T0_DELTA_FIELD} rejected: the changed-file list between soaked head ` +
          `\`${declared}\` and current head \`${actualHeadSha.toLowerCase()}\` ` +
          `${delta === null ? 'could not be computed' : 'is empty'}; the allowance fails closed.`,
      },
      note: null,
    };
  }

  const deltaTier = requiredTierFor(delta).tier;
  if (deltaTier !== 'T0') {
    return {
      finding: {
        name,
        message:
          `${POST_SOAK_T0_DELTA_FIELD} rejected: the post-soak delta between \`${declared}\` ` +
          `and \`${actualHeadSha.toLowerCase()}\` (${delta.length} file(s)) classifies ` +
          `${deltaTier}, not T0. Post-soak commits may only touch files the tier detector ` +
          'classifies T0 (e2e/, docs/, tests, CI/tooling); anything else can reach prod ' +
          'runtime, so the soaked evidence no longer describes this head.',
      },
      note: null,
    };
  }

  return {
    finding: null,
    note:
      `head moved ${declared.slice(0, 9)} → ${actualHeadSha.slice(0, 9).toLowerCase()}; ` +
      `${delta.length} post-soak file(s), all T0 (${POST_SOAK_T0_DELTA_FIELD} accepted).`,
  };
}

export function checkHeadShaIdentity(
  body: string,
  actualHeadSha: string,
  opts: HeadShaIdentityOpts = {},
): Finding | null {
  return evaluateHeadShaIdentity(body, actualHeadSha, opts).finding;
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

export interface CleanPreflightIdentityOpts {
  /**
   * Injection point for the edge-deploy-only carve-out's file-set question
   * (declared `Base SHA:` → declared `PR head SHA:`). Same shape and same
   * fallback convention as {@link HeadShaIdentityOpts.changedFilesProvider}:
   * tests inject a stub so this module never shells out; omitted in
   * production, where it falls back to real git via `changedFilesBetween`.
   */
  changedFilesProvider?: ChangedFilesProvider;
}

interface CleanPreflightIdentityEvaluation {
  findings: Finding[];
  /** Set only when the edge-deploy-only carve-out was applied — informational, never fails the gate. */
  note: string | null;
}

/**
 * Core `clean-preflight-identity` evaluation, including the edge-deploy-only
 * carve-out (CTO decision 2026-09-13, PR #2908). `checkCleanPreflightIdentity`
 * is a thin wrapper returning only `.findings`, unchanged in shape for
 * existing callers; `runEvidenceIdentity` also reads `.note` so an applied
 * carve-out surfaces as an info line instead of vanishing silently — mirrors
 * how `evaluateHeadShaIdentity` / `checkHeadShaIdentity` split for the
 * Post-soak T0 delta allowance above.
 *
 * WHY A FILE-SET CARVE-OUT AND NOT A PROSE ONE: the clean-mirror requirement
 * binds evidence to an uncontaminated Supabase database (CLAUDE.md §1.11A). A
 * PR that deploys only a Cloudflare Worker has no database in scope at
 * all — for that PR the requirement is INAPPLICABLE, not waived, because
 * there is nothing for a preflight to certify as clean. That is a narrower
 * claim than a general `### Residual-risk note` escape hatch (the kind
 * `check-staging-evidence.ts`'s `preflightResultErrors()` grants elsewhere),
 * and deliberately so: this gate has no such general hatch anywhere else,
 * because it is the one check that cannot be talked out of by an author's own
 * prose, and a general hatch here would weaken it for every soak run on a
 * contaminated rig — precisely what §1.11A exists to stop. So the carve-out
 * is keyed strictly on the PR's changed-file set via
 * {@link isEdgeDeployOnlyChange}, computed from data (`Base SHA:` /
 * `PR head SHA:` + a real diff), never from a claim in the PR body. A
 * null/empty/uncomputable file list is NOT edge-deploy-only — it fails CLOSED
 * to the original clean-mirror finding, exactly like every other file-set
 * carve-out in this repo.
 */
function evaluateCleanPreflightIdentity(
  body: string,
  declaredHead: string | null,
  tier: Tier | null,
  opts: CleanPreflightIdentityOpts = {},
): CleanPreflightIdentityEvaluation {
  const name = 'clean-preflight-identity';
  const findings: Finding[] = [];
  let note: string | null = null;
  const preflight = extractField(body, 'Preflight result:');

  // No preflight field present — nothing to identity-check here (the standard
  // staging-evidence gate enforces presence/format; this gate is identity only).
  if (preflight === null || preflight.length === 0) return { findings, note };

  // (b1) clean_mirror is required for T2/T3 environment identity — unless the
  // PR's own changed-file set proves there is no Supabase surface to bind a
  // clean-mirror claim to at all (see the carve-out rationale above).
  const requiresCleanMirror = tier === 'T2' || tier === 'T3';
  if (requiresCleanMirror && !isCleanMirror(preflight)) {
    const changedFilesProvider = opts.changedFilesProvider ?? changedFilesBetween;
    const declaredBase = extractShaFromField(body, 'Base SHA:');
    const files = declaredBase && declaredHead
      ? changedFilesProvider(declaredBase, declaredHead)
      : null;

    if (files !== null && isEdgeDeployOnlyChange(files)) {
      note =
        'clean-preflight-identity: edge-deploy-only carve-out applied — ' +
        `${files.length} changed file(s) between declared \`Base SHA:\` ` +
        `${declaredBase} and \`PR head SHA:\` ${declaredHead} classify as ` +
        'Cloudflare-Worker-only (isEdgeDeployOnlyChange), so this PR has no ' +
        'Supabase surface to preflight. The clean-mirror requirement is ' +
        'inapplicable, not waived (CTO decision 2026-09-13).';
    } else {
      findings.push({
        name,
        message:
          `Preflight result does not declare \`environment_type=clean_mirror\` ` +
          `(found: \`${preflight}\`). ${tier} merge-grade evidence requires a ` +
          `clean-mirror preflight identity (CLAUDE.md §1.11A).`,
      });
    }
  }

  // (b2) any head SHA embedded in the preflight must match the declared head —
  // otherwise the preflight was captured against a different head (copied
  // evidence across heads). Unaffected by the carve-out above: it is an
  // orthogonal identity check, not a clean-mirror requirement.
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

  return { findings, note };
}

export function checkCleanPreflightIdentity(
  body: string,
  declaredHead: string | null,
  tier: Tier | null,
  opts: CleanPreflightIdentityOpts = {},
): Finding[] {
  return evaluateCleanPreflightIdentity(body, declaredHead, tier, opts).findings;
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
      notes: [],
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
      notes: [],
      ok: true,
    };
  }

  if (!soakTier && !hasEvidenceSection(body)) {
    return {
      skipped: true,
      skipReason:
        'No soak-tier Staging Soak Evidence block (T0 / CI-only / no-evidence PR).',
      findings: [],
      notes: [],
      ok: true,
    };
  }

  const findings: Finding[] = [];
  const notes: string[] = [];
  const headEvaluation = evaluateHeadShaIdentity(body, actualHeadSha, {
    ancestryProvider: input.ancestryProvider,
    changedFilesProvider: input.changedFilesProvider,
  });
  if (headEvaluation.finding) findings.push(headEvaluation.finding);
  if (headEvaluation.note) notes.push(headEvaluation.note);

  const declaredHead = extractShaFromField(body, 'PR head SHA:');
  const preflightEvaluation = evaluateCleanPreflightIdentity(body, declaredHead, tier, {
    changedFilesProvider: input.changedFilesProvider,
  });
  findings.push(...preflightEvaluation.findings);
  if (preflightEvaluation.note) notes.push(preflightEvaluation.note);

  return {
    skipped: false,
    skipReason: null,
    findings,
    notes,
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

  for (const note of result.notes) {
    lines.push(`  ℹ️  ${note}`);
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
