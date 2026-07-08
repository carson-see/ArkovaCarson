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
 *
 * Frontend-T2 evidence mode: a PR that is required-tier T2 purely because it
 * touches a sensitive *frontend* surface, and whose every changed file is
 * frontend-only (`isFrontendOnlyChange`), cannot produce worker artifacts. It
 * satisfies T2 with a Vercel deployment URL + view-E2E + a `### Residual-risk
 * note` attesting no worker artifacts exist, instead of the worker-artifact
 * fields. This does NOT change tier classification (`requiredTierFor` is
 * unchanged) — it only swaps the accepted evidence form for that narrow case.
 * Any worker/migration/SDK/contract-touching T2 PR keeps the full
 * worker-artifact requirements.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import {
  REPO,
  getBaseRef,
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
    soakHours: 2,
    requiredFields: [
      'Tier:',
      'PR head SHA:',
      'Staging tag URL or N/A explanation:',
      'Health/smoke result:',
      'Soak start:',
      'Soak end:',
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

/**
 * The SHARED PROD-RUNTIME surface: the subset of {@link PATH_RULES} at tier T2 or
 * higher. These are the files whose semantics a completed soak implicitly depends
 * on because they are the same deployed artifact / DB / queue substrate the soak
 * ran against — migrations (T3), chain/treasury (T3), security (T3), anchor
 * lifecycle + cron (T3), billing (T3), queue/concurrency (T2), public API (T2),
 * stripe/webhooks/auth/ai (T2), edge (T2), and the catch-all worker-behavior
 * rule (T2). Derived from the single source of truth ({@link PATH_RULES}) so the
 * shared surface can NEVER drift from the tier detector: adding a T2+ path rule
 * automatically widens the surface whose intervening main-drift invalidates a
 * completed soak, and lowering a rule below T2 automatically drops it.
 *
 * The <T2 rules (frontend `src/…` at T1) are intentionally excluded: a
 * frontend-only PR is classified T1 and never reaches the T2/T3
 * {@link stagingIntegrityErrors} base-drift path, so folding the T1 frontend
 * surface in here would only gate PRs that can't reach the check anyway.
 */
export const SHARED_PROD_RUNTIME_RULES: PathRule[] = PATH_RULES.filter(
  (rule) => TIER_RANK[rule.minTier] >= TIER_RANK.T2,
);

const SHA_RE = /\b[0-9a-f]{40}\b/i;
const DECLARED_TIER_VALUES = new Set<Tier>(['T0', 'T1', 'T2', 'T3']);
const ALLOWED_EVIDENCE_SCOPES = new Set([
  'merge-grade shared staging',
  'merge-grade isolated staging',
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const PUBLIC_CONTRACT_DOC_RE = /^docs\/(?:api\/|guides\/API_GUIDE\.md)/;
const DOCS_ONLY_RE = /^(?:docs\/|README\.md|ARKOVA_WORKSPACE_README\.md|WORKSPACE_STATUS\.md|memory\/.*\.md$)/;

/**
 * Supplies the unified diff body (the lines after each `@@` hunk header, i.e.
 * context + `+`/`-` lines) for a single changed file, or `null` when it cannot
 * be obtained (no git history, deleted file, binary, error). Threaded through
 * {@link isT0OnlyFile} / {@link requiredTierFor} so the classifier can, for the
 * narrow {@link DEPLOY_WORKER_WORKFLOW} carve-out, look at WHAT changed in the
 * file rather than only its name. Everything else stays name-only. A `null`
 * return always fails closed (keeps the path-rule tier).
 */
export type DiffProvider = (file: string) => string | null;

interface TierClassifyOpts {
  diffProvider?: DiffProvider;
}

const DEPLOY_WORKER_WORKFLOW = '.github/workflows/deploy-worker.yml';

// A changed line in deploy-worker.yml that is "harmless" for prod runtime: a
// GitHub-Actions `uses:` pin (the Dependabot bump target), a YAML comment, or a
// blank line. Anything else (env, secrets, min/max-instances, image, region,
// service account, --set-env-vars, scaling, …) is a real runtime change.
// Note the optional dash + its trailing whitespace are grouped together rather
// than written as two adjacent `[^\S\r\n]*` runs — the adjacent form lets the
// engine split a whitespace span ambiguously (super-linear backtracking Sonar
// flags). Behaviour is identical: optional indent, optional `- ` list marker,
// then `uses:`.
const DEPLOY_WORKER_USES_LINE_RE = /^[^\S\r\n]*(?:-[^\S\r\n]*)?uses:[^\S\r\n]*\S/;
const YAML_COMMENT_OR_BLANK_RE = /^[^\S\r\n]*(?:#.*)?$/;

/**
 * True iff a unified diff for {@link DEPLOY_WORKER_WORKFLOW} changes ONLY
 * `uses:` action-version/SHA lines (plus YAML comments / blank lines). Used to
 * exempt a Dependabot GitHub-Actions version bump from the T2 deploy-config rule
 * without weakening the gate for real runtime-config edits.
 *
 * Fail-closed: returns false for an empty/`null` diff, and for any diff that
 * contains at least one added/removed line which is not a `uses:`/comment/blank
 * line. A diff with no added/removed lines at all is also false (nothing
 * attestable as a uses-only bump → keep the path-rule tier).
 */
export function isDeployWorkerUsesOnlyBump(diff: string | null | undefined): boolean {
  if (!diff || diff.trim().length === 0) return false;

  let sawChange = false;
  for (const rawLine of diff.split(/\r?\n/)) {
    // Skip unified-diff file headers (`+++`/`---`) and hunk headers (`@@ … @@`);
    // they are not content lines.
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('@@')) {
      continue;
    }
    if (rawLine.startsWith('+') || rawLine.startsWith('-')) {
      const content = rawLine.slice(1);
      if (DEPLOY_WORKER_USES_LINE_RE.test(content) || YAML_COMMENT_OR_BLANK_RE.test(content)) {
        sawChange = true;
        continue;
      }
      // A real (non-uses) changed line → not a uses-only bump. Fail closed.
      return false;
    }
    // Context line (leading space) or stray line — ignored for the decision.
  }
  return sawChange;
}

/**
 * deploy-worker.yml is normally a T2 prod-runtime surface. The ONLY exemption is
 * a Dependabot GitHub-Actions `uses:`-version bump (verified against the file's
 * diff via {@link isDeployWorkerUsesOnlyBump}); such a change touches no prod
 * runtime config and is treated as CI-tooling (T0). Fail-closed: without a diff
 * provider, or when the diff can't be obtained, the file stays T2.
 *
 * Possible future carve-out (NOT implemented — a separate policy call for the
 * operator): a `@types/*`-only manifest/lockfile bump. Deliberately left out.
 */
function isDeployWorkerUsesOnlyExempt(file: string, opts?: TierClassifyOpts): boolean {
  if (file !== DEPLOY_WORKER_WORKFLOW) return false;
  if (!opts?.diffProvider) return false;
  return isDeployWorkerUsesOnlyBump(opts.diffProvider(file));
}

function isT0OnlyFile(file: string, opts?: TierClassifyOpts): boolean {
  if (PUBLIC_CONTRACT_DOC_RE.test(file)) return false;
  if (TEST_FILE_RE.test(file) || file.endsWith('agents.md')) return true;
  // Dependency bumps that don't touch a core runtime surface are T0:
  //   - ANY package-lock.json (root / packages/* / services/* / integrations/*) —
  //     a lockfile is a deterministic re-resolution of the manifest, not a source
  //     change; it carries no behavior a soak could exercise on its own.
  //   - package.json MANIFESTS only for peripheral, non-core workspaces
  //     (packages/* libraries + integrations/* connectors). These are SDK/embed/
  //     integration surfaces, not the deployed Cloud Run worker or app root.
  // Deliberately NOT exempt: root `package.json` and `services/*/package.json`
  // manifests — those govern the prod worker / app runtime dependency tree, so a
  // manifest bump there must still earn a tier (the lockfile counterparts stay T0).
  if (/^(?:package-lock\.json|(?:packages|services|integrations)\/[^/]+\/package-lock\.json|(?:packages|integrations)\/[^/]+\/package\.json)$/.test(file)) return true;
  // deploy-worker.yml is a T2 PATH_RULE, but a Dependabot `uses:`-only action
  // bump touches no prod runtime config — exempt it to CI-tooling (T0) when the
  // diff confirms it. Checked BEFORE the PATH_RULES.some() T2 short-circuit.
  if (isDeployWorkerUsesOnlyExempt(file, opts)) return true;
  // PROOF-08 (SCRUM-2341): the proof test-fixtures subtree lives under
  // services/worker/src/, which matches the T2 `services/worker/src/` PATH_RULE.
  // Its loader (index.ts) + JSON are imported ONLY by test suites (verified no
  // non-test importer), so there is no prod-runtime path. Exempt it to T0 BEFORE
  // the PATH_RULES.some() short-circuit — same shape as the deploy-worker carve-out
  // above (a T0 allowlist entry that has to win over a matching PATH_RULE).
  if (file.startsWith('services/worker/src/proof/fixtures/')) return true;
  if (PATH_RULES.some((rule) => rule.pattern.test(file))) return false;
  return STAGING_TOOLING_ALLOW.some((re) => re.test(file))
    || DOCS_ONLY_RE.test(file)
    || /^\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|pull_request_template\.md|CONTRIBUTING\.md|dependabot\.yml)/.test(file);
}

export function requiredTierFor(
  files: string[],
  opts?: TierClassifyOpts,
): { tier: Tier; reason: string } {
  if (files.length === 0) return { tier: 'T0', reason: 'no changed files' };
  if (files.every((f) => isT0OnlyFile(f, opts))) {
    return { tier: 'T0', reason: 'docs/tests/CI/tooling-only' };
  }

  let best: Tier = 'T1';
  let reason = 'default frontend / additive change';
  for (const f of files) {
    if (isT0OnlyFile(f, opts)) continue;
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(f) && TIER_RANK[rule.minTier] > TIER_RANK[best]) {
        best = rule.minTier;
        reason = `${f} — ${rule.reason}`;
      }
    }
  }
  return { tier: best, reason };
}

/**
 * Patterns for any non-frontend, prod-runtime (or CI) surface. A change that
 * touches ANY of these can produce real worker/migration/SDK/contract artifacts
 * (or is CI config/script, which is not a frontend asset), so it must NOT be
 * eligible for the frontend-T2 evidence path — it keeps the full worker-artifact
 * (standard) evidence requirements. This list is intentionally a denylist (not
 * just "outside src/|public/|e2e/") so the guard fails closed: a future file
 * that lands under one of the allowed prefixes but matches a server/SDK/contract
 * pattern would still be pushed onto the standard evidence path.
 */
const NON_FRONTEND_SURFACE_RE: RegExp[] = [
  /^services\//,
  /^supabase\/(?:migrations|functions)\//,
  /^packages\//,
  /^sdks\//,
  /^docs\/api\//,
  /^docs\/guides\/API_GUIDE\.md$/,
  /^\.github\/workflows\//,
  // CI scripts are not a frontend asset — a `scripts/` change (e.g. this gate,
  // or the CSP-deps guard) keeps the standard worker-evidence path even when it
  // rides alongside a src/ change.
  /^scripts\//,
];

/** Prefixes a frontend feature can legitimately ship without producing any
 * deploying (worker/migration/SDK) artifact:
 *   - `src/`          the React/TS app source itself,
 *   - `public/`       static + vendored runtime assets (e.g. self-hosted
 *                     Tesseract OCR wasm/worker/lang under `public/vendor`),
 *   - `e2e/`          the Playwright spec(s) that exercise the changed view.
 * None of these are built into the Cloud Run worker image or applied to the DB,
 * so a PR confined to them (modulo the NON_FRONTEND_SURFACE_RE denylist) cannot
 * produce worker artifacts and is eligible for the frontend-T2 evidence path. */
const FRONTEND_PREFIXES = ['src/', 'public/', 'e2e/'];

/**
 * True iff EVERY changed file is a purely-frontend file — under one of
 * {@link FRONTEND_PREFIXES} (`src/` / `public/` / `e2e/`) and not matching any
 * server/migration/SDK/contract/CI surface ({@link NON_FRONTEND_SURFACE_RE}).
 * This is the backward-compatibility guard for the frontend-T2 evidence mode:
 * it gates the alternate (Vercel + view-E2E) evidence path so it can only ever
 * apply to a PR that genuinely cannot produce worker artifacts. A frontend
 * feature shipping vendored assets (`public/vendor`) + its E2E (`e2e/`)
 * alongside its `src/` change is exactly this case (the #1262 §1.6 fail-closed
 * OCR enabler); workflow / CI-script / worker / migration changes stay on the
 * full worker-evidence path (fail-closed preserved).
 *
 * An empty fileset returns false: there is nothing to attest as frontend-only,
 * and a non-frontend caller should never reach the frontend path by default.
 */
export function isFrontendOnlyChange(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) => FRONTEND_PREFIXES.some((p) => f.startsWith(p))
      && !NON_FRONTEND_SURFACE_RE.some((re) => re.test(f)),
  );
}

/**
 * Prefixes of the OFFLINE, architecturally-unsoakable distributable surface: the
 * standalone client SDK / CLI / library packages that ship to consumers and run
 * offline (pytest / vitest / parity), NOT the deployed Cloud Run worker.
 *   - `packages/`  the `packages/*` library + CLI tree (arkova-py, verifier,
 *                  verifier-cli, embed, mcp-server, typescript, langchain, sdk, …).
 *   - `sdks/`      the client SDK tree (typescript / langchain / mcp-server).
 * Verified (grep): no `packages/**` or `sdks/**` file is imported by
 * `services/worker/src/**`, so none is bundled into the deployed worker image or
 * applied to the DB — there is no worker runtime to soak for a PR confined here.
 */
const OFFLINE_PACKAGE_PREFIXES = ['packages/', 'sdks/'];

/**
 * A served-contract-doc predicate. `docs/api/` and `docs/guides/API_GUIDE.md`
 * are part of the SDK PATH_RULE, but they DOCUMENT the served Cloud Run worker
 * HTTP contract — a soak validates that contract's behavior — so a PR touching
 * them is NOT architecturally unsoakable and must stay on the standard
 * worker-evidence path. Excluded from {@link isOfflinePackageOnlyChange}.
 */
const SERVED_CONTRACT_DOC_RE = /^(?:docs\/api\/|docs\/guides\/API_GUIDE\.md$)/;

/**
 * True iff EVERY changed file is a purely-offline package/SDK file — under one of
 * {@link OFFLINE_PACKAGE_PREFIXES} (`packages/` / `sdks/`) and NOT matching any
 * worker/migration/served-contract surface ({@link NON_FRONTEND_SURFACE_RE} minus
 * the offline-package prefixes it also lists, plus the {@link SERVED_CONTRACT_DOC_RE}
 * carve-out). This is the fail-closed guard for the architecturally-unsoakable
 * evidence mode: it gates the alternate (test/parity + N/A-tag + unsoakable-note)
 * evidence path so it can only ever apply to a PR that genuinely has no worker
 * runtime to soak. #1411 (offline verifier-cli + arkova-py SDK) is exactly this
 * case; any worker/migration/API-contract-doc-touching PR stays on the full
 * worker-evidence path (fail-closed preserved).
 *
 * `NON_FRONTEND_SURFACE_RE` lists `^packages/` and `^sdks/` as "non-frontend", so
 * it cannot be used directly as the denylist here (it would reject every offline
 * package). Instead the denylist is the SERVED/worker/migration subset: worker
 * (`services/`), migration/functions (`supabase/(migrations|functions)/`), served
 * contract docs, CI workflows, and CI scripts. An offline package file matches
 * none of those.
 *
 * An empty fileset returns false: there is nothing to attest as offline-only.
 */
export function isOfflinePackageOnlyChange(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) => OFFLINE_PACKAGE_PREFIXES.some((p) => f.startsWith(p))
      && !/^services\//.test(f)
      && !/^supabase\/(?:migrations|functions)\//.test(f)
      && !SERVED_CONTRACT_DOC_RE.test(f)
      && !/^\.github\/workflows\//.test(f)
      && !/^scripts\//.test(f),
  );
}

const EVIDENCE_HEADER_RE = /^##\s+Staging\s+Soak\s+Evidence\s*$/im;
const UTC_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|Z)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Tier declaration, tolerant of common markdown decoration on the line.
// Accepts, anchored to the start of a (whitespace-trimmed) line:
//   - an optional list marker (`-` / `*`) + optional `[x]`/`[ ]` checkbox,
//   - optional markdown emphasis (`*`/`**`/`_`/`__`) wrapping the word `Tier`
//     and/or its colon — covers `**Tier:**`, `*Tier*:`, `_Tier_:`, `**Tier**:`,
//   - then `T0`–`T3`, optionally emphasis-wrapped, as a whole token.
// The plain `Tier: T2` form keeps matching (every decoration group is optional).
// This is label-parsing tolerance only: the captured value is still validated
// against DECLARED_TIER_VALUES, so the set of accepted tiers is unchanged.
//
// Composed from named sub-parts rather than one dense literal: it keeps each
// fragment readable and below the per-regex cognitive-complexity bound, and it
// removes the backtracking ambiguity of adjacent `\s*` groups flanking optional
// emphasis (the old `\s*:\s*(?:[*_]{1,2})?\s*` shape) by using single horizontal-
// whitespace runs (`HSPACE`). Lines are pre-split on `\r?\n` by
// {@link extractDeclaredTier}, so horizontal-only whitespace is exact, not a
// behavior change — verified identical to the prior literal over a combinatorial
// corpus.
// `String.raw` only where the literal itself carries backslashes; the
// backslash-free fragments use plain template literals (interpolated sub-parts
// keep their own escaping). Same assembled source either way.
const TIER_HSPACE = String.raw`[^\S\r\n]`;
const TIER_EMPHASIS = `[*_]{1,2}`;
// Optional leading list bullet (`-`/`*`) then optional spaces.
const TIER_LIST_PREFIX = `(?:[-*]${TIER_HSPACE}*)?`;
// Optional GitHub task checkbox (`[ ]`/`[x]`) then optional spaces.
const TIER_CHECKBOX = String.raw`(?:\[[ x]\]${TIER_HSPACE}*)?`;
// The literal label `Tier`, optionally emphasis-wrapped on either side.
const TIER_LABEL = `(?:${TIER_EMPHASIS})?Tier(?:${TIER_EMPHASIS})?`;
// Separator: optional spaces, colon, optional spaces, then an optional emphasis
// run with its own trailing spaces — no two `\s*` flank the same optional group.
const TIER_SEPARATOR = `${TIER_HSPACE}*:${TIER_HSPACE}*(?:${TIER_EMPHASIS}${TIER_HSPACE}*)?`;
// The tier token `T0`–`T3`, optional trailing emphasis, not followed by a word char.
const TIER_VALUE_TOKEN = String.raw`(T[0-3])(?:${TIER_EMPHASIS})?(?!\w)`;
const DECLARED_TIER_LINE_RE = new RegExp(
  `^${TIER_HSPACE}*${TIER_LIST_PREFIX}${TIER_CHECKBOX}${TIER_LABEL}${TIER_SEPARATOR}${TIER_VALUE_TOKEN}`,
  'i',
);

export function extractDeclaredTier(body: string): Tier | null {
  for (const line of body.split(/\r?\n/)) {
    const m = DECLARED_TIER_LINE_RE.exec(line);
    if (!m) continue;
    const value = m[1].toUpperCase();
    if (DECLARED_TIER_VALUES.has(value as Tier)) {
      return value as Tier;
    }
  }
  return null;
}

export function hasEvidenceSection(body: string): boolean {
  return EVIDENCE_HEADER_RE.test(body);
}

/**
 * Evidence-block field set key: a standard tier, the frontend-T2 path, or the
 * architecturally-unsoakable (offline-package) T2 path.
 */
export type FieldSet = Tier | 'T2_FRONTEND' | 'T2_UNSOAKABLE';

function requiredFieldsFor(set: FieldSet): readonly string[] {
  if (set === 'T2_FRONTEND') return T2_FRONTEND_FIELDS;
  if (set === 'T2_UNSOAKABLE') return T2_UNSOAKABLE_FIELDS;
  return TIER_SPECS[set].requiredFields;
}

export function missingFields(body: string, set: FieldSet): string[] {
  const missing: string[] = [];
  for (const field of requiredFieldsFor(set)) {
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
const INCOMPLETE_VALUE_PATTERNS = [
  /^pending\.?$/i,
  /^tbd\.?$/i,
  /^to[\s-]?be[\s-]?(?:determined|announced|filled(?:[\s-]?in)?)\.?$/i,
  /^tba\.?$/i,
  /^todo\.?$/i,
  /^to[\s-]?do\.?$/i,
  /^fixme\.?$/i,
  /^wip\.?$/i,
  /^work[\s-]?in[\s-]?progress\.?$/i,
  /^fill[\s-]?in\.?$/i,
  /^placeholder\.?$/i,
  /^coming[\s-]?soon\.?$/i,
  /^see[\s-]?above\.?$/i,
  /^xxx+\.?$/i,
  /^\?+\.?$/i,
  /^-+\.?$/i,
  /^_+\.?$/i,
  /^\.{2,}\.?$/i,
  /^…\.?$/i,
  /^<[^>]*>\.?$/i,
];

// "Not applicable" markers — legitimate for some fields (e.g. `Migration
// applied: none`) but never for a concrete deploy artifact.
const NOT_APPLICABLE_VALUE_RE = /^(?:n\/?a|n\.?a\.?|none|not[\s-]?applicable|null|nil)\.?$/i;

function isIncompletePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return INCOMPLETE_VALUE_PATTERNS.some((re) => re.test(trimmed));
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

// ───────────────────────────────────────────────────────────────────────────
// Frontend-T2 evidence mode (decision (a)).
//
// A PR can be required-tier T2 purely by touching a sensitive *frontend*
// contract surface (the `src/components/{anchor,api,auth,billing,public,
// verification,verify}/` PATH_RULES rule). Such a PR ships no worker code, no
// migration, and no SDK/contract change, so it can never produce the worker
// artifacts (Worker revision, Image digest, Cloud Run URL, Staging deploy-log
// id) the standard T2 block demands. Instead it satisfies T2 with
// frontend-appropriate evidence: a Vercel deployment/preview URL, an
// E2E-on-the-affected-view result, and a `### Residual-risk note` attesting
// that no worker artifacts exist.
//
// This path is reachable ONLY through `isFrontendOnlyChange(files)` — see
// check(). Any worker- or migration-touching T2 PR keeps the unchanged
// worker-artifact requirements.
// ───────────────────────────────────────────────────────────────────────────
export const T2_FRONTEND_FIELDS = [
  'Tier:',
  'PR head SHA:',
  'Vercel deployment URL:',
  'E2E result:',
  'CI/E2E green:',
  'Rollback plan:',
];

// ───────────────────────────────────────────────────────────────────────────
// Architecturally-unsoakable evidence mode.
//
// A PR can be required-tier T2 purely by touching an OFFLINE package/SDK/CLI
// surface (the `packages/…` / `sdks/` half of the SDK PATH_RULE). Those
// packages ship no worker code, no migration, and are not the served Cloud Run
// HTTP contract — they are distributed as standalone libraries/CLIs run offline
// by consumers (pytest / vitest / parity). Such a PR can NEVER produce the
// worker artifacts (Worker revision, Image digest, Cloud Run URL, Staging
// deploy-log id) or the clean_mirror preflight the standard T2 block demands —
// there is no worker runtime to soak. Demanding those was an impossible
// catch-22 that blocked #1411 (verifier-cli + arkova-py).
//
// Instead it satisfies T2 with test/parity evidence (vitest/pytest/parity green
// at head), an N/A-with-justification staging tag, and an `### Unsoakable-surface
// note` attesting that no worker runtime exists to soak.
//
// This path is reachable ONLY through `isOfflinePackageOnlyChange(files)` — see
// check(). Any worker/migration/served-contract-touching T2 PR keeps the
// unchanged worker-artifact requirements (fail-closed).
// ───────────────────────────────────────────────────────────────────────────
export const T2_UNSOAKABLE_FIELDS = [
  'Tier:',
  'PR head SHA:',
  'Test evidence:',
  'CI green:',
  'Staging tag URL or N/A explanation:',
];

// Unsoakable-surface note: an offline-package PR substitutes this for the worker
// artifacts it cannot produce. The sub-fields attest that no worker runtime
// exists to soak + name the offline surfaces; the SAME real-approver guard as
// the other alternate-evidence notes applies.
const UNSOAKABLE_NOTE_REQUIRED_FIELDS = [
  'No worker runtime:',
  'Surfaces touched:',
  'Approved by:',
];

const UNSOAKABLE_NOTE_HEADER_RE = /^###\s+Unsoakable-surface\s+note\b/im;

function validateVercelUrlEvidence(body: string): string | null {
  const field = 'Vercel deployment URL:';
  // Must be present, filled, not a placeholder, AND an actual URL.
  const filled = validateFilledEvidenceField(body, field);
  if (filled !== null) return filled;
  const value = extractEvidenceFieldValue(body, field);
  if (value === null) return null; // label-absence owned by missingFields()
  return /\bhttps?:\/\/\S+/i.test(value)
    ? null
    : `${field} must contain a Vercel deployment or preview URL.`;
}

/**
 * Frontend-T2 evidence validation. Mirrors the spirit of the T1 auditable-value
 * checks (real Vercel URL, real E2E result, CI green, named approver) but swaps
 * the worker-artifact requirements for a residual-risk note attesting that no
 * worker artifacts exist. Returns the list of error strings (empty = ok).
 */
function frontendT2Errors(body: string): string[] {
  const errors: (string | null)[] = [];

  // Section + required field labels.
  if (!hasEvidenceSection(body)) {
    return [
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md (frontend-T2 block) as a starting point.',
    ];
  }
  const missing = missingFields(body, 'T2_FRONTEND');
  if (missing.length > 0) {
    errors.push(
      '`## Staging Soak Evidence` section is missing required fields for the '
      + 'frontend-T2 evidence path: '
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  // `CI/E2E green:` must be non-empty AND state a passing result. The
  // non-empty check runs first because validatePassingEvidenceField
  // short-circuits to PASS on an empty value — without it a bare
  // `- CI/E2E green:` line would attest nothing, weaker than the T1 path
  // (which runs validateNonEmptyEvidenceField over every required field).
  errors.push(
    validateVercelUrlEvidence(body),
    validateFilledEvidenceField(body, 'E2E result:'),
    validateNonEmptyEvidenceField(body, 'Rollback plan:'),
    validateNonEmptyEvidenceField(body, 'CI/E2E green:'),
    validatePassingEvidenceField(
      body,
      'CI/E2E green:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
      'CI/E2E green: must state that CI/E2E is green.',
    ),
  );

  // A frontend-T2 PR substitutes a residual-risk note for the worker
  // artifacts. The note's sub-fields are frontend-specific (attest no worker
  // artifacts + name the surfaces) and the validator enforces a real,
  // non-placeholder `Approved by:`.
  const note = hasFrontendResidualRiskNote(body);
  if (!note.valid) {
    if (note.missing.length > 0) {
      errors.push(
        'frontend-T2 `### Residual-risk note` is missing required sub-fields: '
        + note.missing.map((f) => `\`${f}\``).join(', ')
        + '. The note must attest that no worker artifacts exist (frontend-only) '
        + 'and carry a named `Approved by:`.',
      );
    } else {
      errors.push(
        'frontend-T2 evidence requires a `### Residual-risk note` section '
        + 'attesting that no worker artifacts exist (frontend-only: no Cloud Run '
        + 'deploy, no worker revision, no image digest, no staging deploy-log id).',
      );
    }
  }

  return errors.filter((e): e is string => e !== null);
}

/**
 * Architecturally-unsoakable evidence validation. Mirrors the spirit of the
 * frontend-T2 / T1 auditable-value checks (real test/parity result, real CI
 * green, real N/A-justified staging tag, named approver) but swaps the
 * worker-artifact requirements for a `### Unsoakable-surface note` attesting
 * that no worker runtime exists to soak. Returns the list of error strings
 * (empty = ok).
 */
function unsoakableT2Errors(body: string): string[] {
  const errors: (string | null)[] = [];

  if (!hasEvidenceSection(body)) {
    return [
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md (unsoakable-surface block) as a starting point.',
    ];
  }

  const missing = missingFields(body, 'T2_UNSOAKABLE');
  if (missing.length > 0) {
    errors.push(
      '`## Staging Soak Evidence` section is missing required fields for the '
      + 'architecturally-unsoakable (offline package/SDK) evidence path: '
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  // `Test evidence:` must be filled (no placeholder) AND state a passing result
  // (pytest/vitest/parity green). The non-empty check runs first because
  // validatePassingEvidenceField short-circuits to PASS on an empty value.
  errors.push(
    validateFilledEvidenceField(body, 'Test evidence:'),
    validatePassingEvidenceField(
      body,
      'Test evidence:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?|ok|\d+\s*\/\s*\d+)\b/i,
      'Test evidence: must state a passing test/parity result (e.g. pytest/vitest/parity green).',
    ),
    validateNonEmptyEvidenceField(body, 'CI green:'),
    validatePassingEvidenceField(
      body,
      'CI green:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
      'CI green: must state that CI is green.',
    ),
    // The staging tag MUST be an explicit N/A-with-justification (or a URL, for
    // symmetry with the T1 validator) — a bare "skipped" is not auditable.
    validateStagingTagEvidence(body),
    validateFilledEvidenceField(body, 'Staging tag URL or N/A explanation:'),
  );

  // The worker artifacts are substituted by an unsoakable-surface note.
  const note = hasUnsoakableSurfaceNote(body);
  if (!note.valid) {
    if (note.missing.length > 0) {
      errors.push(
        '`### Unsoakable-surface note` is missing required sub-fields: '
        + note.missing.map((f) => `\`${f}\``).join(', ')
        + '. The note must attest that no worker runtime exists to soak '
        + '(offline package/SDK) and carry a named `Approved by:`.',
      );
    } else {
      errors.push(
        'Architecturally-unsoakable evidence requires a `### Unsoakable-surface '
        + 'note` section attesting that no worker runtime exists to soak '
        + '(offline package/SDK: no Cloud Run deploy, no worker revision, no '
        + 'image digest, no staging deploy-log id, no migration).',
      );
    }
  }

  return errors.filter((e): e is string => e !== null);
}

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

// Frontend-T2 residual-risk note: a frontend-only PR substitutes this for the
// worker artifacts it cannot produce. The sub-fields are frontend-appropriate
// (attest no worker artifacts + name the affected surfaces) rather than the
// DB-contamination fields above, but the SAME real-approver guard applies — a
// blank/placeholder `Approved by:` is a self-waiver and never valid.
const FRONTEND_RESIDUAL_RISK_REQUIRED_FIELDS = [
  'No worker artifacts:',
  'Surfaces touched:',
  'Approved by:',
];

/**
 * Validate a `### Residual-risk note` section against a required-field list.
 * Shared by the DB-contamination exception ({@link hasResidualRiskException})
 * and the frontend-T2 note ({@link hasFrontendResidualRiskNote}). Enforces the
 * real-approver guard on `Approved by:` for both.
 */
function validateResidualRiskNote(
  body: string,
  requiredFields: readonly string[],
  headerRe: RegExp = RESIDUAL_RISK_HEADER_RE,
): { valid: boolean; missing: string[] } {
  const headerMatch = headerRe.exec(body);
  if (!headerMatch) return { valid: false, missing: [] };
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const nextHeading = body.slice(sectionStart).search(/^#{1,3}\s/m);
  const section = nextHeading === -1
    ? body.slice(sectionStart)
    : body.slice(sectionStart, sectionStart + nextHeading);
  const missing: string[] = [];
  for (const field of requiredFields) {
    const re = new RegExp(String.raw`^[\s\-*]*${escapeRegExp(field)}`, 'im');
    if (!re.test(section)) missing.push(field);
  }
  // `Approved by:` must name a real approver. A present-but-empty or
  // placeholder value (pending/tbd/n/a) is a self-waiver and does NOT grant
  // the exception/path, which would otherwise bypass the gate's protections
  // (CLAUDE.md §1.11A).
  if (requiredFields.includes('Approved by:') && !missing.includes('Approved by:')) {
    const approver = extractEvidenceFieldValue(section, 'Approved by:');
    const trimmed = approver?.trim() ?? '';
    if (trimmed.length === 0 || isIncompletePlaceholder(trimmed) || isNotApplicablePlaceholder(trimmed)) {
      missing.push('Approved by: (must name a real approver, not a blank or placeholder)');
    }
  }
  return { valid: missing.length === 0, missing };
}

export function hasResidualRiskException(body: string): { valid: boolean; missing: string[] } {
  return validateResidualRiskNote(body, RESIDUAL_RISK_REQUIRED_FIELDS);
}

export function hasFrontendResidualRiskNote(body: string): { valid: boolean; missing: string[] } {
  return validateResidualRiskNote(body, FRONTEND_RESIDUAL_RISK_REQUIRED_FIELDS);
}

export function hasUnsoakableSurfaceNote(body: string): { valid: boolean; missing: string[] } {
  return validateResidualRiskNote(
    body,
    UNSOAKABLE_NOTE_REQUIRED_FIELDS,
    UNSOAKABLE_NOTE_HEADER_RE,
  );
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

const BASE_DRIFT_IMPACT_FIELD = 'Base drift impact:';
const GIT_BIN = '/usr/bin/git';

function changedFilesBetween(fromSha: string, toSha: string): string[] | null {
  try {
    return execFileSync(
      GIT_BIN,
      ['diff', '--name-only', `${fromSha}..${toSha}`],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Default {@link DiffProvider} for the live CI path: the unified diff of a single
 * file between `baseRef` and `HEAD`. `null` on any failure (no history, deleted,
 * binary), which makes the deploy-worker carve-out fail closed (keeps T2).
 */
function gitFileDiffProvider(baseSha: string): DiffProvider {
  return (file: string): string | null => {
    try {
      const out = execFileSync(
        GIT_BIN,
        ['diff', '--unified=0', `${baseSha}...HEAD`, '--', file],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out.trim().length > 0 ? out : null;
    } catch {
      return null;
    }
  };
}

function hasNamedApprover(value: string): boolean {
  const match = /\bapproved by:\s*([^.;\n]+)/i.exec(value);
  return match !== null && isFilledValue(match[1] ?? null);
}

function impactNoteAttestsNoRuntimeEffect(value: string): boolean {
  const lower = value.toLowerCase();
  return /\b(?:t0|ci[- ]?only|tooling[- ]?only|docs\/tests\/ci)\b/.test(lower)
    && /\bno\b.*\b(?:runtime|schema|migration|staging|soak|deploy)\b.*\b(?:impact|change|effect)\b/.test(lower)
    && hasNamedApprover(value);
}

/**
 * The set of file-path predicates whose intervening main-drift could invalidate
 * THIS PR's completed soak. It is the UNION of:
 *   1. `ownFiles` — the exact files this PR changed (`opts.files`). If main
 *      independently edited one of the exact files the PR soaked, the soak ran
 *      against a now-stale version of that file → re-soak. Matched by exact path
 *      equality against the drift set.
 *   2. `sharedPatterns` — the SHARED PROD-RUNTIME surface ({@link
 *      SHARED_PROD_RUNTIME_RULES} patterns). Files not in this PR's diff but whose
 *      semantics the soak implicitly depends on because they are the same deployed
 *      artifact / DB / queue substrate (migrations, chain, queue/cron, billing,
 *      public API, …). Matched by regex against the drift set.
 */
function prSurfaceMatchers(files: string[]): { ownFiles: Set<string>; sharedPatterns: RegExp[] } {
  return {
    ownFiles: new Set(files),
    sharedPatterns: SHARED_PROD_RUNTIME_RULES.map((rule) => rule.pattern),
  };
}

/**
 * The subset of `driftFiles` (files changed on main between the evidence base and
 * the current base) that INTERSECTS this PR's soak surface — i.e. the drift files
 * that could have invalidated the soak. Empty ⇒ drift is disjoint from the PR
 * surface ⇒ evidence preserved.
 */
function driftFilesIntersectingSurface(
  driftFiles: string[],
  surface: { ownFiles: Set<string>; sharedPatterns: RegExp[] },
): string[] {
  return driftFiles.filter(
    (f) => surface.ownFiles.has(f) || surface.sharedPatterns.some((re) => re.test(f)),
  );
}

/**
 * Path-aware base-drift enforcement. When the evidence's `Base SHA` no longer
 * matches the current base, the intervening main movement is compared against
 * THIS PR's soak surface ({@link prSurfaceMatchers}):
 *
 *   • DISJOINT (no drift file touches the PR's own files or the shared
 *     prod-runtime surface) → evidence preserved, no attestation required.
 *   • INTERSECTS → the soak ran against a now-stale version of a surface the PR
 *     depends on → hard fail (re-soak), with a strictly-narrower fallback: the
 *     operator MAY preserve evidence for the T0-only case by supplying an
 *     approved `Base drift impact:` attestation AND the intervening drift being
 *     classified strictly T0. That fallback exists only so no
 *     currently-passing (T0-drift + attested) PR regresses; it is NOT a general
 *     override for T1+ same-surface drift.
 *   • drift-file list unavailable (`changedFilesBetween` → null and no override)
 *     → fail closed (re-soak).
 */
function baseDriftImpactErrors(
  body: string,
  evidenceBaseSha: string,
  currentBaseSha: string,
  prFiles: string[],
  driftFilesOverride?: string[],
): string[] {
  const driftFiles = driftFilesOverride ?? changedFilesBetween(evidenceBaseSha, currentBaseSha);
  if (driftFiles === null) {
    return [
      `Could not inspect changed files between evidence base \`${evidenceBaseSha}\` and current base \`${currentBaseSha}\`; `
      + 'refresh/re-scope the evidence or run with enough git history to classify base drift.',
    ];
  }

  const surface = prSurfaceMatchers(prFiles);
  const intersecting = driftFilesIntersectingSurface(driftFiles, surface);

  // Disjoint drift — the soak's surface is untouched by the intervening main
  // movement. Evidence preserved; no attestation needed.
  if (intersecting.length === 0) return [];

  // Same-surface drift. Preserve the strictly-narrower legacy escape hatch: an
  // approved `Base drift impact:` attestation for the case where the WHOLE
  // intervening drift is T0-only. Anything above T0 is an unconditional re-soak.
  const driftTier = requiredTierFor(driftFiles);
  if (driftTier.tier === 'T0') {
    const impact = extractEvidenceFieldValue(body, BASE_DRIFT_IMPACT_FIELD);
    if (impact === null || !isFilledValue(impact)) {
      return [
        `Base SHA \`${evidenceBaseSha}\` differs from current base \`${currentBaseSha}\` and the drift touches this PR's soak surface `
        + `(${intersecting.join(', ')}). If the intervening main movement is harmless (T0/CI-only), add \`${BASE_DRIFT_IMPACT_FIELD}\` `
        + 'with the changed files, the no-runtime/schema/staging-impact assessment, and a named approver; '
        + 'otherwise refresh/re-scope the evidence.',
      ];
    }
    if (!impactNoteAttestsNoRuntimeEffect(impact)) {
      return [
        `${BASE_DRIFT_IMPACT_FIELD} must state T0/CI-only drift, explicitly attest no runtime/schema/migration/staging/soak/deploy impact, and name an approver.`,
      ];
    }
    return [];
  }

  return [
    `Base SHA drift from \`${evidenceBaseSha}\` to \`${currentBaseSha}\` touches this PR's soak surface `
    + `(${intersecting.join(', ')}) at ${driftTier.tier} (${driftTier.reason}); `
    + 'existing soak evidence cannot be preserved without release-owner re-scope/retest.',
  ];
}

function baseShaEvidenceErrors(
  body: string,
  prFiles: string[],
  expectedSha?: string,
  driftFilesOverride?: string[],
): string[] {
  const evidenceSha = extractShaField(body, 'Base SHA:');
  if (!evidenceSha) return ['Base SHA: must contain a 40-character commit SHA.'];

  const expected = normalizeSha(expectedSha);
  if (!expected || evidenceSha === expected) return [];

  return baseDriftImpactErrors(body, evidenceSha, expected, prFiles, driftFilesOverride);
}

function stagingIntegrityErrors(
  body: string,
  tier: Tier,
  opts: { headSha?: string; baseSha?: string; baseDriftFiles?: string[]; files?: string[] } = {},
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
    ...baseShaEvidenceErrors(body, opts.files ?? [], opts.baseSha, opts.baseDriftFiles),
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
  // CI-only local-Supabase bootstrap for the types/tests/e2e jobs (sourced by
  // ci.yml). Runs exclusively on the runner, never ships to prod runtime → T0.
  /^scripts\/ci-supabase-start\.sh$/,
  /^scripts\/ci\/check-staging-evidence(\.test)?\.ts$/,
  /^scripts\/ci\/check-staging-gcloud-policy(\.test)?\.ts$/,
  /^scripts\/ci\/staging-honesty-preflight(\.test)?\.ts$/,
  // S0-4.2 / S0-4.3 (epic S0-E4): release-pipeline CI tooling. These run only
  // in CI and never ship to prod runtime, so they are T0 tooling.
  /^scripts\/ci\/check-ledger-numeric-integrity(\.test)?\.ts$/,
  /^scripts\/ci\/check-agents-md-migration-collision(\.test)?\.ts$/,
  /^scripts\/ci\/compute-merge-authority(\.test)?\.ts$/,
  // R0 verification/baseline CI gates (SCRUM-1252 / 1254 / R0-3). These run
  // ONLY in CI to lint PR metadata + repo invariants (HANDOFF.md claims,
  // `count: 'exact'` callsite baseline, coverage-threshold monotonicity). They
  // never ship to prod runtime → T0 tooling.
  /^scripts\/ci\/check-handoff-claims(\.test)?\.ts$/,
  /^scripts\/ci\/check-count-exact-baseline(\.test)?\.ts$/,
  /^scripts\/ci\/check-coverage-monotonic(\.test)?\.ts$/,
  /^scripts\/ci\/snapshots\//, // CI baselines/snapshots — tooling, never prod runtime
  // SCRUM-2666: the `npm run lint:copy` banned-terminology gate + its test
  // fixtures. Runs only in CI (ci.yml typecheck-lint job) and locally; never
  // ships to prod runtime → T0 tooling. scripts/fixtures/ holds .txt sources
  // read by scripts/*.test.ts only (never imported, typechecked, or bundled).
  /^scripts\/check-copy-terms(\.test)?\.ts$/,
  /^scripts\/fixtures\//,
  // S0-5.2 (epic S0-E5): config↔reality drift + cross-runtime parity gate (CI tooling).
  /^scripts\/ci\/check-config-drift(\.test)?\.ts$/,
  /^scripts\/ci\/config-drift\//,
  // WEBEXT-04 (SCRUM-2506): CSP↔runtime-deps drift gate — a sibling config↔reality
  // CI gate that parses vercel.json + scans on-device runtime sources. Runs only
  // in CI, never ships to prod runtime, so it is T0 tooling.
  /^scripts\/ci\/check-csp-runtime-deps(\.test)?\.ts$/,
  /^scripts\/ci\/lib\//,
  /^scripts\/gcp-setup\//,
  /^services\/worker\/scripts\/load-test\//,
  /^tests\/k6\//,
  /^tests\/load\//,
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
  // Lockfiles are deterministic re-resolutions of a manifest — T0 at every
  // workspace (root / packages/* / services/* / integrations/*).
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package-lock\.json$/,
  /^services\/[^/]+\/package-lock\.json$/,
  /^integrations\/[^/]+\/package-lock\.json$/,
  // Peripheral package.json MANIFESTS only: packages/* libraries (SDK/embed) and
  // integrations/* connectors are non-core surfaces. Root `package.json` and
  // `services/worker/package.json` are intentionally absent — they govern the prod
  // worker / app runtime dependency tree and must still earn a tier.
  /^packages\/[^/]+\/package\.json$/,
  /^integrations\/[^/]+\/package\.json$/,
  // services/edge is the peripheral Cloudflare edge worker (PR #884), not the
  // deployed Cloud Run worker — its manifest stays T0 by explicit carve-out.
  /^services\/edge\/package\.json$/,
  // PI-0 S2 (SCRUM-2341 / verifier track): @arkova/verifier + @arkova/verifier-cli
  // are new MIT-licensed STANDALONE library/CLI packages. They are NOT imported by
  // the deployed Cloud Run worker (services/worker) or the frontend (src/) — verified
  // no `@arkova/verifier` import exists under services/** or src/**. No migration, no
  // API/contract surface, no prod runtime: they run only in their own clean-room CI
  // job and as a developer/auditor CLI. Zero prod-runtime impact → T0 tooling. (The
  // packages/*/package.json + package-lock.json + eslint.config.js + agents.md within
  // them are already covered by the peripheral-package / lockfile / eslint / agents.md
  // rules; these two prefixes additionally cover their src/, tsconfig, vitest config,
  // fixtures, README, LICENSE, .gitignore, and generator script.)
  /^packages\/verifier\//,
  /^packages\/verifier-cli\//,
  // NOTE: services/worker/src/proof/fixtures/ (PROOF-08, #1357) is ALSO T0, but it
  // matches the T2 `services/worker/src/` PATH_RULE, so it is exempted earlier in
  // isT0OnlyFile() (BEFORE the PATH_RULES short-circuit) rather than here — an entry
  // in this list alone would never be reached for it. See that carve-out for the
  // test-only justification.
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

type RcManifestLoader = (path: string) => string | null | undefined;

interface CheckOptions {
  body: string;
  files: string[];
  headSha?: string;
  baseSha?: string;
  baseDriftFiles?: string[];
  prNumber?: number;
  nowMs?: number;
  rcManifestLoader?: RcManifestLoader;
  /**
   * Per-file unified-diff source for content-aware tier classification (the
   * deploy-worker.yml `uses:`-only carve-out). Defaults to a git-backed provider
   * in {@link main}; tests inject a stub. Absent → carve-out fails closed (T2).
   */
  diffProvider?: DiffProvider;
}

function addErrors(result: CheckResult, errors: string[]): void {
  if (errors.length === 0) return;
  result.ok = false;
  result.errors.push(...errors);
}

function tierDeclarationErrors(declared: Tier, required: { tier: Tier; reason: string }): string[] {
  if (TIER_RANK[declared] >= TIER_RANK[required.tier]) return [];
  return [
    `Declared tier ${declared} is below required tier ${required.tier} `
    + `for the touched files. Reason: ${required.reason}.`,
  ];
}

function isFrontendT2EvidencePath(declared: Tier, required: Tier, files: string[]): boolean {
  return declared === 'T2'
    && required === 'T2'
    && isFrontendOnlyChange(files);
}

function isUnsoakableEvidencePath(declared: Tier, required: Tier, files: string[]): boolean {
  return declared === 'T2'
    && required === 'T2'
    && isOfflinePackageOnlyChange(files);
}

function frontendT2Result(body: string, headSha?: string): CheckResult {
  const result: CheckResult = { ok: true, errors: [], notes: [] };
  const feErrors = frontendT2Errors(body);
  // Exact-head integrity still applies: frontend evidence cannot be copied
  // across commits any more than worker evidence can.
  const headShaErrors = shaEvidenceErrors({
    body,
    field: 'PR head SHA:',
    expectedSha: headSha,
    currentLabel: 'PR head',
    staleMessage: 'frontend evidence cannot be copied across commits.',
  });

  addErrors(result, [...feErrors, ...headShaErrors]);
  if (result.ok) {
    result.notes.push(
      'frontend-T2 evidence path accepted (frontend-only change; no worker '
      + 'artifacts producible — Vercel deployment + view-E2E + residual-risk '
      + 'note satisfy T2).',
    );
  }
  return result;
}

function unsoakableT2Result(body: string, headSha?: string): CheckResult {
  const result: CheckResult = { ok: true, errors: [], notes: [] };
  const usErrors = unsoakableT2Errors(body);
  // Exact-head integrity still applies: test evidence cannot be copied across
  // commits any more than worker or frontend evidence can.
  const headShaErrors = shaEvidenceErrors({
    body,
    field: 'PR head SHA:',
    expectedSha: headSha,
    currentLabel: 'PR head',
    staleMessage: 'test/parity evidence cannot be copied across commits.',
  });

  addErrors(result, [...usErrors, ...headShaErrors]);
  if (result.ok) {
    result.notes.push(
      'architecturally-unsoakable evidence path accepted (offline package/SDK '
      + 'change; no worker runtime to soak — test/parity evidence + N/A staging '
      + 'tag + unsoakable-surface note satisfy T2).',
    );
  }
  return result;
}

function durationValidation(body: string, declared: Tier): { errors: string[]; notes: string[] } {
  const errors = soakDurationErrors(body, declared);
  if (errors.length === 0) return { errors: [], notes: [] };

  const riskException = hasResidualRiskException(body);
  if (riskException.valid) {
    return {
      errors: [],
      notes: [`Soak duration below ${TIER_SPECS[declared].soakHours}h minimum; residual-risk exception accepted.`],
    };
  }
  return { errors, notes: [] };
}

function standardEvidenceErrors(
  body: string,
  declared: Tier,
  opts: { headSha?: string; baseSha?: string; baseDriftFiles?: string[]; files?: string[] },
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];

  const missing = missingFields(body, declared);
  if (missing.length > 0) {
    errors.push(
      `\`## Staging Soak Evidence\` section is missing required fields for ${declared}: `
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  const duration = durationValidation(body, declared);
  notes.push(...duration.notes);
  errors.push(
    ...duration.errors,
    ...requiredValueErrors(body, declared),
    ...stagingIntegrityErrors(body, declared, opts),
  );

  const preflightVal = extractEvidenceFieldValue(body, 'Preflight result:');
  const preflightIsClean = preflightVal !== null && hasCleanMirrorPreflight(preflightVal);
  if (errors.length === 0 && !preflightIsClean && hasResidualRiskException(body).valid) {
    notes.push('Preflight is not clean_mirror; residual-risk exception accepted.');
  }

  return { errors, notes };
}

const RC_MANIFEST_FIELD = 'RC manifest path:';
const RC_MANIFEST_PATH_RE = /^docs\/staging\/rc-manifests\/rc-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const RC_MANIFEST_DIR = resolve(REPO, 'docs/staging/rc-manifests');

function resolveRcManifestPath(path: string): string | null {
  if (!RC_MANIFEST_PATH_RE.test(path)) return null;
  const localPath = resolve(REPO, path);
  return localPath.startsWith(`${RC_MANIFEST_DIR}${sep}`) ? localPath : null;
}

function defaultRcManifestLoader(path: string): string | null {
  const localPath = resolveRcManifestPath(path);
  if (localPath === null || !existsSync(localPath)) return null;
  return readFileSync(localPath, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const child = value[key];
  return isRecord(child) ? child : null;
}

function arrayAt(value: Record<string, unknown>, key: string): unknown[] | null {
  const child = value[key];
  return Array.isArray(child) ? child : null;
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  const child = value[key];
  return typeof child === 'string' ? child : null;
}

function numberAt(value: Record<string, unknown>, key: string): number | null {
  const child = value[key];
  return typeof child === 'number' && Number.isFinite(child) ? child : null;
}

function stringArrayAt(value: Record<string, unknown>, key: string): string[] {
  const child = value[key];
  return Array.isArray(child) ? child.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isFilledValue(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !isIncompletePlaceholder(trimmed) && !isNotApplicablePlaceholder(trimmed);
}

function requireRcString(
  errors: string[],
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const field = stringAt(value, key);
  if (!isFilledValue(field)) {
    errors.push(`RC manifest ${label} must be a real value, not blank or a placeholder.`);
    return null;
  }
  return field;
}

function requireRcTimestamp(
  errors: string[],
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  const raw = requireRcString(errors, value, key, label);
  if (raw === null) return null;
  const parsed = parseEvidenceTimestamp(raw);
  if (parsed === null) {
    errors.push(`RC manifest ${label} could not parse as a timestamp: \`${raw}\`.`);
  }
  return parsed;
}

function rcTier(value: string | null): Tier | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return DECLARED_TIER_VALUES.has(normalized as Tier) ? normalized as Tier : null;
}

function rcUrlErrors(value: string | null, label: string): string[] {
  if (value === null || !isFilledValue(value)) return [`RC manifest ${label} must be a real URL.`];
  return /\bhttps?:\/\/\S+/i.test(value)
    ? []
    : [`RC manifest ${label} must contain an HTTP(S) URL.`];
}

function rcSoakWindowErrors(
  startMs: number | null,
  endMs: number | null,
  tier: Tier,
  soak: Record<string, unknown>,
): string[] {
  if (startMs === null || endMs === null) return [];
  if (endMs <= startMs) return ['RC manifest soak.end must be after soak.start.'];

  const errors: string[] = [];
  const minimumHours = TIER_SPECS[tier].soakHours;
  const elapsedHours = (endMs - startMs) / 3_600_000;
  if (elapsedHours < minimumHours) {
    errors.push(
      `RC manifest soak duration (${formatHours(elapsedHours)}h) is below the ${minimumHours}h minimum for ${tier}.`,
    );
  }

  const declaredHours = numberAt(soak, 'duration_hours');
  if (declaredHours !== null && declaredHours < minimumHours) {
    errors.push(`RC manifest soak.duration_hours is below the ${minimumHours}h minimum for ${tier}.`);
  }
  return errors;
}

function rcPassingResultErrors(result: string | null): string[] {
  if (result === null || /\b(?:green|pass(?:ed|es)?|success(?:ful)?|ok|healthy)\b/i.test(result)) {
    return [];
  }
  return ['RC manifest soak.result must state a passing result.'];
}

function rcEvidenceTtlErrors(expiresAt: number | null, nowMs: number): string[] {
  if (expiresAt === null || expiresAt > nowMs) return [];
  return ['RC manifest evidence is expired; refresh the release-candidate evidence before merging.'];
}

function rcSoakDurationErrors(
  soak: Record<string, unknown>,
  tier: Tier,
  nowMs: number,
): string[] {
  const errors: string[] = [];
  const startMs = requireRcTimestamp(errors, soak, 'start', 'soak.start');
  const endMs = requireRcTimestamp(errors, soak, 'end', 'soak.end');
  errors.push(...rcSoakWindowErrors(startMs, endMs, tier, soak));

  const result = requireRcString(errors, soak, 'result', 'soak.result');
  errors.push(...rcPassingResultErrors(result));

  requireRcString(errors, soak, 'harness_version', 'soak.harness_version');
  const evidenceLinks = stringArrayAt(soak, 'evidence_links');
  if (evidenceLinks.length === 0) {
    errors.push('RC manifest soak.evidence_links must include at least one evidence link.');
  }

  const expiresAt = requireRcTimestamp(errors, soak, 'expires_at', 'soak.expires_at');
  errors.push(...rcEvidenceTtlErrors(expiresAt, nowMs));

  return errors;
}

function rcCurrentBaseCovered(
  manifest: Record<string, unknown>,
  currentBaseSha?: string,
): boolean {
  const current = normalizeSha(currentBaseSha);
  if (current === null) return true;

  const allowed = [
    stringAt(manifest, 'train_launch_sha'),
    stringAt(manifest, 'target_main_sha'),
    ...stringArrayAt(manifest, 'allowed_base_shas'),
    ...stringArrayAt(manifest, 'covered_main_shas'),
  ].map((value) => normalizeSha(value ?? undefined)).filter((value): value is string => value !== null);

  return allowed.includes(current);
}

function rcPrBaseCovered(
  manifest: Record<string, unknown>,
  pr: Record<string, unknown>,
  currentBaseSha?: string,
): boolean {
  const prBase = normalizeSha(stringAt(pr, 'base_sha') ?? undefined);
  if (prBase === null) return false;

  const allowed = [
    currentBaseSha,
    stringAt(manifest, 'train_launch_sha'),
    stringAt(manifest, 'target_main_sha'),
    ...stringArrayAt(pr, 'allowed_base_shas'),
  ].map((value) => normalizeSha(value ?? undefined)).filter((value): value is string => value !== null);

  return allowed.includes(prBase);
}

function findCoveredRcPr(
  includedPrs: unknown[],
  opts: { headSha?: string; prNumber?: number },
): Record<string, unknown> | null {
  const normalizedHead = normalizeSha(opts.headSha);
  for (const entry of includedPrs) {
    if (!isRecord(entry)) continue;
    const number = numberAt(entry, 'number');
    const head = normalizeSha(stringAt(entry, 'head_sha') ?? undefined);
    if (opts.prNumber !== undefined && number === opts.prNumber) return entry;
    if (normalizedHead !== null && head === normalizedHead) return entry;
  }
  return null;
}

function parseRcManifest(path: string, raw: string, errors: string[]): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`RC manifest \`${path}\` is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`);
    return null;
  }

  if (!isRecord(parsed)) {
    errors.push(`RC manifest \`${path}\` must be a JSON object.`);
    return null;
  }
  return parsed;
}

function validateRcManifestMetadata(
  manifest: Record<string, unknown>,
  opts: CheckOptions,
  errors: string[],
): void {
  const schemaVersion = numberAt(manifest, 'schema_version');
  if (schemaVersion !== 1) {
    errors.push('RC manifest schema_version must be 1.');
  }

  requireRcString(errors, manifest, 'rc_id', 'rc_id');
  requireRcTimestamp(errors, manifest, 'created_at', 'created_at');
  requireRcString(errors, manifest, 'created_by', 'created_by');
  requireRcString(errors, manifest, 'release_owner', 'release_owner');
  const approvalStatus = requireRcString(errors, manifest, 'approval_status', 'approval_status');
  if (approvalStatus !== null && approvalStatus.trim().toLowerCase() !== 'approved') {
    errors.push('RC manifest approval_status must be approved.');
  }
  requireRcString(errors, manifest, 'approval_actor', 'approval_actor');
  requireRcTimestamp(errors, manifest, 'approval_time', 'approval_time');
  requireRcString(errors, manifest, 'train_launch_sha', 'train_launch_sha');

  if (!rcCurrentBaseCovered(manifest, opts.baseSha)) {
    errors.push('RC manifest does not cover the current base SHA; update the manifest or re-check main drift.');
  }
}

function validateCoveredRcPr(
  manifest: Record<string, unknown>,
  includedPrs: unknown[],
  declared: Tier,
  required: { tier: Tier; reason: string },
  files: string[],
  opts: CheckOptions,
  errors: string[],
): Record<string, unknown> | null {
  if (includedPrs.length === 0) {
    errors.push('RC manifest included_prs must list at least one PR.');
  }

  const coveredPr = findCoveredRcPr(includedPrs, opts);
  if (coveredPr === null) {
    errors.push('RC manifest does not include the current PR head SHA.');
    return null;
  }

  const entryHead = normalizeSha(stringAt(coveredPr, 'head_sha') ?? undefined);
  const currentHead = normalizeSha(opts.headSha);
  if (currentHead !== null && entryHead !== currentHead) {
    errors.push(`RC manifest current PR entry head SHA \`${entryHead ?? 'missing'}\` does not match current PR head \`${currentHead}\`.`);
  }
  if (!rcPrBaseCovered(manifest, coveredPr, opts.baseSha)) {
    errors.push('RC manifest current PR entry base SHA does not match the current base, train launch SHA, target main SHA, or an allowed base SHA.');
  }

  const manifestTier = rcTier(stringAt(coveredPr, 'risk_tier'));
  if (manifestTier === null) {
    errors.push('RC manifest current PR entry risk_tier must be T1, T2, or T3.');
  } else {
    if (TIER_RANK[manifestTier] < TIER_RANK[required.tier]) {
      errors.push(`RC manifest risk_tier ${manifestTier} is below required tier ${required.tier} for this PR. Reason: ${required.reason}.`);
    }
    if (TIER_RANK[manifestTier] < TIER_RANK[declared]) {
      errors.push(`RC manifest risk_tier ${manifestTier} is below declared tier ${declared}.`);
    }
  }
  requireRcString(errors, coveredPr, 'owner', 'included_prs[].owner');
  requireRcString(errors, coveredPr, 'ci_summary', 'included_prs[].ci_summary');
  requireRcString(errors, coveredPr, 'rollback_note', 'included_prs[].rollback_note');
  if (files.some(touchesMigrationFile) && stringArrayAt(coveredPr, 'migration_files').length === 0) {
    errors.push('RC manifest included_prs[].migration_files must list migration files for a migration-bearing PR.');
  }
  return coveredPr;
}

function validateRcEnvironment(manifest: Record<string, unknown>, errors: string[]): void {
  const environment = objectAt(manifest, 'environment');
  if (environment === null) {
    errors.push('RC manifest environment must be an object.');
    return;
  }

  const scope = normalizeEvidenceScope(stringAt(environment, 'evidence_scope') ?? '');
  if (!ALLOWED_EVIDENCE_SCOPES.has(scope)) {
    errors.push('RC manifest environment.evidence_scope must be merge-grade shared staging or merge-grade isolated staging.');
  }

  const stagingApiBase = stringAt(environment, 'staging_api_base');
  errors.push(...rcUrlErrors(stagingApiBase, 'environment.staging_api_base'));
  if (stagingApiBase !== null && /https?:\/\/arkova-worker-staging[-.]/i.test(stagingApiBase)) {
    errors.push('RC manifest environment.staging_api_base must not point at the main shared staging URL; use a PR tag URL or isolated service URL.');
  }
  errors.push(...rcUrlErrors(stringAt(environment, 'staging_url'), 'environment.staging_url'));
  requireRcString(errors, environment, 'revision', 'environment.revision');
  requireRcString(errors, environment, 'deploy_tag', 'environment.deploy_tag');
  requireRcString(errors, environment, 'image_digest', 'environment.image_digest');
  requireRcString(errors, environment, 'supabase_project_ref', 'environment.supabase_project_ref');
  requireRcString(errors, environment, 'deploy_log_id', 'environment.deploy_log_id');

  const preflight = requireRcString(errors, environment, 'preflight_result', 'environment.preflight_result');
  if (preflight !== null && !hasCleanMirrorPreflight(preflight)) {
    errors.push('RC manifest environment.preflight_result must capture `environment_type=clean_mirror`.');
  }
}

function rcEffectiveTier(coveredPr: Record<string, unknown> | null, declared: Tier): Tier {
  return coveredPr === null ? declared : rcTier(stringAt(coveredPr, 'risk_tier')) ?? declared;
}

function validateRcSoak(
  manifest: Record<string, unknown>,
  effectiveTier: Tier,
  opts: CheckOptions,
  errors: string[],
): void {
  const soak = objectAt(manifest, 'soak');
  if (soak === null) {
    errors.push('RC manifest soak must be an object.');
    return;
  }
  errors.push(...rcSoakDurationErrors(soak, effectiveTier, opts.nowMs ?? Date.now()));
}

function touchesMigrationFile(file: string): boolean {
  return file.startsWith('supabase/migrations/');
}

function validateRcMigrationPlan(
  manifest: Record<string, unknown>,
  effectiveTier: Tier,
  files: string[],
  errors: string[],
): void {
  if (!files.some(touchesMigrationFile) && effectiveTier !== 'T3') return;

  const migrationPlan = objectAt(manifest, 'migration_plan');
  if (migrationPlan === null) {
    errors.push('RC manifest migration_plan is required for T3 or migration-bearing PRs.');
    return;
  }
  if (stringArrayAt(migrationPlan, 'order').length === 0) {
    errors.push('RC manifest migration_plan.order must list migration train order.');
  }
  requireRcString(errors, migrationPlan, 'rollback_proof', 'migration_plan.rollback_proof');
  requireRcString(errors, migrationPlan, 'reapply_proof', 'migration_plan.reapply_proof');
}

function rcManifestCoverage(
  body: string,
  declared: Tier,
  required: { tier: Tier; reason: string },
  files: string[],
  opts: CheckOptions,
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const path = extractEvidenceFieldValue(body, RC_MANIFEST_FIELD);
  if (path === null) return { errors, notes };

  if (!hasEvidenceSection(body)) {
    errors.push('RC manifest coverage must be declared under a `## Staging Soak Evidence` section.');
  }

  if (resolveRcManifestPath(path) === null) {
    errors.push(
      'RC manifest path must be a local JSON file under `docs/staging/rc-manifests/rc-*.json`; arbitrary URLs or paths are not allowed.',
    );
    return { errors, notes };
  }

  const raw = (opts.rcManifestLoader ?? defaultRcManifestLoader)(path);
  if (!raw) {
    errors.push(`RC manifest \`${path}\` was not found in the checked-out PR tree.`);
    return { errors, notes };
  }

  const parsed = parseRcManifest(path, raw, errors);
  if (parsed === null) return { errors, notes };
  validateRcManifestMetadata(parsed, opts, errors);
  const includedPrs = arrayAt(parsed, 'included_prs') ?? [];
  const coveredPr = validateCoveredRcPr(parsed, includedPrs, declared, required, files, opts, errors);
  const effectiveTier = rcEffectiveTier(coveredPr, declared);
  validateRcEnvironment(parsed, errors);
  validateRcSoak(parsed, effectiveTier, opts, errors);
  validateRcMigrationPlan(parsed, effectiveTier, files, errors);

  if (errors.length === 0) {
    const rcId = stringAt(parsed, 'rc_id') ?? path;
    notes.push(`RC manifest coverage accepted for ${rcId}; long soak evidence is centralized at the release-candidate level.`);
  }
  return { errors, notes };
}

export function check(opts: CheckOptions): CheckResult {
  const { body, files } = opts;
  const result: CheckResult = { ok: true, errors: [], notes: [] };

  const required = requiredTierFor(files, { diffProvider: opts.diffProvider });
  if (required.tier === 'T0') {
    result.notes.push(`T0 CI-only PR (${required.reason}) — no staging soak evidence required.`);
    return result;
  }

  const declared = extractDeclaredTier(body);
  if (!declared) {
    return {
      ok: false,
      errors: [
        `PR body is missing a tier declaration. Add a line \`Tier: ${required.tier}\` under a `
        + `\`## Staging Soak Evidence\` section. Required tier: ${required.tier} (${required.reason}).`,
      ],
      notes: [],
    };
  }

  addErrors(result, tierDeclarationErrors(declared, required));

  const rcManifestPath = extractEvidenceFieldValue(body, RC_MANIFEST_FIELD);
  if (rcManifestPath !== null) {
    const rc = rcManifestCoverage(body, declared, required, files, opts);
    addErrors(result, rc.errors);
    result.notes.push(...rc.notes);
    return result;
  }

  // ── Frontend-T2 evidence path (decision (a)) ──
  // Activates ONLY when the PR is T2 by requirement AND declaration AND every
  // changed file is purely frontend. Tier classification is unchanged; this
  // only swaps which evidence T2 accepts for that narrow case.
  if (isFrontendT2EvidencePath(declared, required.tier, files)) {
    const frontendResult = frontendT2Result(body, opts.headSha);
    addErrors(result, frontendResult.errors);
    result.notes.push(...frontendResult.notes);
    return result;
  }

  // ── Architecturally-unsoakable evidence path ──
  // Activates ONLY when the PR is T2 by requirement AND declaration AND every
  // changed file is an offline package/SDK path (no worker runtime to soak).
  // Tier classification is unchanged; this only swaps which evidence T2 accepts
  // for a surface that CANNOT be soaked. Unblocks #1411 (verifier-cli + arkova-py).
  if (isUnsoakableEvidencePath(declared, required.tier, files)) {
    const unsoakableResult = unsoakableT2Result(body, opts.headSha);
    addErrors(result, unsoakableResult.errors);
    result.notes.push(...unsoakableResult.notes);
    return result;
  }

  if (!hasEvidenceSection(body)) {
    return {
      ok: false,
      errors: [
        'PR body is missing a `## Staging Soak Evidence` section. '
        + 'Use docs/staging/PR_TEMPLATE.md as a starting point.',
      ],
      notes: result.notes,
    };
  }

  const standard = standardEvidenceErrors(body, declared, opts);
  addErrors(result, standard.errors);
  result.notes.push(...standard.notes);
  return result;
}

function main(): void {
  // Required base: fail closed if it can't resolve (getBaseRef exits 1).
  const baseRef = getBaseRef({ required: true })!;
  const files = changedFiles();
  const currentHeadSha = resolveCommitOrFail(
    process.env.HEAD_REF_SHA || process.env.GITHUB_SHA || 'HEAD',
    'CI head ref',
  );
  const parsedPrNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10);
  const prNumber = Number.isFinite(parsedPrNumber) ? parsedPrNumber : undefined;
  const result = check({
    body: prBody,
    files,
    headSha: currentHeadSha,
    baseSha: baseRef,
    prNumber,
    diffProvider: gitFileDiffProvider(baseRef),
  });

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
