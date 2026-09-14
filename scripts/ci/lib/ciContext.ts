/**
 * Shared CI context (SCRUM-1253 / R0-7).
 *
 * Single source of truth for the env vars + git helpers that every
 * scripts/ci/* check reads. Replaces the 5-way duplication where each
 * rule re-declared `BASE_REF`, `PR_LABELS`, `PR_BODY`, etc.
 *
 * Override labels live here too so the names cannot drift between
 * documentation (memory/README.md) and the actual checks.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');

// Resolve the `gh` CLI to a FIXED absolute path instead of letting the OS
// search `$PATH` (Sonar typescript:S4036 — a writable/attacker-controlled PATH
// entry could shadow the real binary). `/usr/bin/gh` is where GitHub-hosted
// Ubuntu runners install it; an explicit `GH_BIN` override covers self-hosted
// runners and local dev (e.g. Homebrew's `/opt/homebrew/bin/gh`). Mirrors the
// `GIT_BIN` convention in check-duplicate-artifacts.ts / check-dep-pinning.ts.
export const GH_BIN = process.env.GH_BIN ?? '/usr/bin/gh';

// Same S4036 reasoning for `git`: resolve to a FIXED absolute path rather than
// a bare `git` name that the OS looks up on `$PATH` (a writable/attacker-
// controlled PATH entry could shadow the real binary). `/usr/bin/git` is the
// GitHub-hosted Ubuntu runner path; `GIT_BIN` overrides for self-hosted runners
// and local dev (e.g. Homebrew's `/opt/homebrew/bin/git`). Mirrors GH_BIN and
// the GIT_BIN convention in check-duplicate-artifacts.ts / check-dep-pinning.ts.
export const GIT_BIN = process.env.GIT_BIN ?? '/usr/bin/git';

/**
 * True when a module is being run directly (not imported). Uses fileURLToPath
 * so a checkout path containing a space or `%` is URL-decoded correctly —
 * `new URL(metaUrl).pathname` does NOT decode and would silently no-op the
 * CLI. Mirrors the helper in check-api-contract-drift.ts / staging-honesty-preflight.ts.
 */
export function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

// Code-review issue #N (PR #563): on push events ci.yml passes the literal
// string 'HEAD~1' as BASE_REF_SHA. On a single-commit branch or shallow
// checkout HEAD~1 doesn't exist; git diff/grep against the literal string
// silently fails and downstream try/catches return [] / 0, no-op'ing the
// gates. Fail closed instead — resolve to a real SHA via git rev-parse,
// or exit 1 with a clear actionable message.
/**
 * Resolve `ref` to a 40-hex commit SHA, or `null` if it cannot be resolved
 * (shallow checkout, bad revision, non-SHA output). Pure: never exits, never
 * warns — the caller decides the failure policy. Shared by `resolveCommitOrFail`
 * (exit) and `getBaseRef`'s optional path (null + warn) so the rev-parse +
 * validation logic lives in exactly one place.
 */
function tryResolveCommit(ref: string): string | null {
  try {
    const sha = execFileSync(GIT_BIN, ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function resolveCommitOrFail(ref: string, label = 'CI base ref'): string {
  const sha = tryResolveCommit(ref);
  if (sha) return sha;
  console.error(`::error::Cannot resolve ${label} '${ref}' (R0 / SCRUM-1246).`);
  console.error('  This usually means a shallow checkout. Use `actions/checkout@v4 with: fetch-depth: 0`.');
  console.error('  (A non-SHA rev-parse result is treated the same as an unresolvable ref.)');
  process.exit(1);
}

const RAW_BASE_REF = process.env.BASE_REF_SHA || process.env.BASE_REF || 'origin/main';

/**
 * Memoized resolution of the base ref.
 *
 * Was previously an eager `export const baseRef = resolveCommitOrFail(...)`
 * evaluated at MODULE LOAD. That made *any* import of ciContext — including a
 * labels/body-only import (prLabels / prBody / hasLabel) by a check that never
 * diffs against the base — shell out to `git rev-parse` and, on an unresolvable
 * ref, `process.exit(1)` the whole job. Worse, the three-/two-dot diff helpers
 * downstream inherited a base that could be a *merge-base* rather than the
 * current base tip.
 *
 * Now resolution is LAZY (first call) and split by intent:
 *   - getBaseRef({ required: true })  -> resolve or fail closed (exit 1 with the
 *     SCRUM-1246 actionable message). NEVER returns null/empty for required
 *     callers — a check that diffs against the base must not silently degrade
 *     to "no changes" and pass.
 *   - getBaseRef()  (optional)        -> resolve or return null with a warning,
 *     for callers that can meaningfully proceed without a base.
 *
 * Importing ciContext for labels/body only does NOT trigger any git here.
 */
let _resolvedBaseRef: string | null | undefined; // undefined = not yet resolved
let _baseRefResolutionFailed = false;

/**
 * Resolve the CI base ref lazily and memoized.
 *
 * @param opts.required - When true (default), an unresolvable base fails CLOSED
 *   via `resolveCommitOrFail` (process.exit(1)). When false, an unresolvable
 *   base returns `null` after a single warning — for callers that can proceed
 *   without a base.
 */
export function getBaseRef(opts: { required?: boolean } = {}): string | null {
  const required = opts.required ?? true;

  // Memoized hit: a prior call already resolved a real SHA.
  if (typeof _resolvedBaseRef === 'string') return _resolvedBaseRef;

  // Required callers ALWAYS fail closed on an unresolvable base — even if a
  // prior optional call already found it unresolvable. resolveCommitOrFail
  // emits the SCRUM-1246 message and process.exit(1)s; it never returns null.
  if (required) {
    _resolvedBaseRef = resolveCommitOrFail(RAW_BASE_REF);
    _baseRefResolutionFailed = false;
    return _resolvedBaseRef;
  }

  // Optional caller. If a prior optional attempt already failed, stay null
  // without re-shelling out to git.
  if (_baseRefResolutionFailed) return null;

  const sha = tryResolveCommit(RAW_BASE_REF);
  if (sha) {
    _resolvedBaseRef = sha;
    return sha;
  }
  _baseRefResolutionFailed = true;
  console.warn(
    `::warning::Could not resolve CI base ref '${RAW_BASE_REF}' (optional caller). ` +
      'Proceeding without a base.',
  );
  return null;
}

/**
 * Test-only: reset the memoized base-ref resolution so each test starts clean.
 * No-op in production (the module is loaded once per process).
 */
export function __resetBaseRefForTests(): void {
  _resolvedBaseRef = undefined;
  _baseRefResolutionFailed = false;
}

/**
 * Derive the PR number from the CI environment.
 *
 * On `pull_request` events GitHub sets `GITHUB_REF` to `refs/pull/<N>/merge`
 * (or `.../head`). We parse that first, then fall back to an explicit
 * `PR_NUMBER` env (e.g. staging-evidence.yml already passes one). Returns
 * `null` on push/main and any non-PR context — callers must treat that as
 * "no live labels available" and fall back to env-only behavior.
 */
export function parsePrNumber(env: NodeJS.ProcessEnv = process.env): number | null {
  const ref = env.GITHUB_REF ?? '';
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref);
  if (m) return Number(m[1]);
  const explicit = (env.PR_NUMBER ?? '').trim();
  if (/^\d+$/.test(explicit)) return Number(explicit);
  return null;
}

const ENV_LABELS_SPLIT = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Emitted at most once per process. A single job runs ~11 label-gated steps and
 * `hasLabel()` re-resolves on every call, so an un-deduped warning would paper
 * the log with the same line dozens of times.
 */
let _liveLabelFetchWarned = false;

/** Test seam: reset the once-per-process warning latch. */
export function __resetLiveLabelWarningForTests(): void {
  _liveLabelFetchWarned = false;
}

/** First non-empty line of a child-process failure, bounded so a long API body cannot flood the log. */
function ghFailureDetail(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string } | null;
  const raw = String(e?.stderr ?? '').trim() || String(e?.message ?? '').trim();
  const line = raw.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * Report a live-label fetch failure as a non-fatal Actions annotation.
 *
 * This exists because the failure used to be structurally invisible: the `gh`
 * call was wrapped in a bare `catch { return [] }` with stderr routed to
 * `ignore`, so a job missing its token degraded to frozen-payload labels with
 * NOTHING in the log. Every label-gated override in that job was inert and the
 * only symptom was "I applied the label, re-ran, and it still failed"
 * (observed on PR #2322, 2026-08-22).
 */
function warnLiveLabelFetchFailed(env: NodeJS.ProcessEnv, prNumber: number, err: unknown): void {
  if (_liveLabelFetchWarned) return;
  _liveLabelFetchWarned = true;
  const hasToken = Boolean((env.GH_TOKEN ?? '').trim() || (env.GITHUB_TOKEN ?? '').trim());
  // `gh` authenticates ONLY from GH_TOKEN / GITHUB_TOKEN (or a hosts.yml that
  // CI runners do not have). actions/checkout persists credentials into git
  // config, which `gh` never reads — so a job with `pull-requests: read` but no
  // token env is exactly as unauthenticated as one with no permission at all.
  const cause = hasToken
    ? 'a token IS present, so this is a `gh` binary/API/timeout failure rather than an auth gap'
    : 'neither GH_TOKEN nor GITHUB_TOKEN is set for this step, so `gh` cannot authenticate '
      + '(actions/checkout persists git credentials, which `gh` does not read; the job\'s '
      + '`pull-requests: read` permission alone grants nothing without the token env)';
  const detail = ghFailureDetail(err);
  console.warn(
    `::warning title=Live PR label fetch failed::Could not read PR #${prNumber} labels from the `
    + `GitHub API — ${cause}. Falling back to the FROZEN pull_request payload in PR_LABELS: an `
    + 'override label applied AFTER this run\'s webhook fired will NOT take effect on a re-run. '
    + 'Fix: add `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to this job\'s `env:` in the workflow.'
    + (detail ? ` (gh: ${detail})` : ''),
  );
}

/**
 * Fetch the PR's labels LIVE from the GitHub API via `gh`.
 *
 * Why this exists: ci.yml seeds `PR_LABELS` from the FROZEN `pull_request`
 * event payload, and the `pull_request` trigger does not fire on `labeled`.
 * Adding an override label after a run + `gh run rerun` replays the frozen
 * payload WITHOUT the label, so every label-gated override is structurally
 * non-functional on re-runs. Reading labels live closes that hole.
 *
 * Synchronous (matches the module's existing execFileSync style), short
 * timeout, and never throws — a missing `gh`, an API error, or a non-PR context
 * all degrade to env-only behavior so this can never fail a gate on its own.
 *
 * Two outcomes are deliberately NOT conflated:
 *   - No PR context (push / main / local run): legitimately empty, silent. A
 *     warning here would fire on every push build and train people to ignore it.
 *   - The `gh` call failed while a PR context DID exist: annotated, because the
 *     caller is now silently reading stale labels.
 *
 * Requires BOTH `pull-requests: read` on the calling job AND a `GH_TOKEN` /
 * `GITHUB_TOKEN` in its env. The permission without the token is a no-op; the
 * `check-pr-labels-token-parity` lint enforces the pairing.
 */
function fetchLiveLabelsForNumber(env: NodeJS.ProcessEnv, prNumber: number): string[] {
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!repo) return [];
  try {
    const out = execFileSync(
      GH_BIN,
      ['api', `repos/${repo}/issues/${prNumber}/labels`, '--jq', '.[].name'],
      // stderr is PIPEd (was `ignore`) so the failure reason can be surfaced in
      // the annotation below. It is still never echoed on the success path.
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    warnLiveLabelFetchFailed(env, prNumber, err);
    return [];
  }
}

export function fetchLiveLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  const prNumber = parsePrNumber(env);
  if (prNumber === null) return [];
  return fetchLiveLabelsForNumber(env, prNumber);
}

// ---------------------------------------------------------------------------
// Mergify merge-queue PR resolution (SCRUM label-override-in-queue fix).
//
// Mergify's queue creates an EPHEMERAL "speculative check" PR (head ref
// `mergify/merge-queue/<hash>`) that stacks the real PR's commits on current
// main. GitHub's `pull_request` context for THAT run — GITHUB_REF, the frozen
// `PR_LABELS`/`PR_NUMBER` env, everything `parsePrNumber`/`fetchLiveLabels`
// read — describes the speculative PR, not the real one. The speculative PR
// carries none of the real PR's override labels (confirmed on queue PR #2936
// checking real PR #2841: PR_LABELS empty, live labels only
// `needs-carson-merge`), so every label-gated override silently reads as
// "label absent" inside the queue even when it is correctly applied on the
// real PR. A refresh does not help — the queue PR is regenerated the same way.
//
// The fix: detect the queue-PR context from the head ref (a default runner
// env var, no workflow wiring needed) and resolve the REAL PR number from
// Mergify's own machine-generated PR body before reading labels.
// ---------------------------------------------------------------------------

const QUEUE_HEAD_REF_RE = /^mergify\/merge-queue\//;

/**
 * True when this run is one of Mergify's own speculative merge-queue checks,
 * detected from `GITHUB_HEAD_REF` — a default Actions env var populated for
 * every `pull_request` run, so no workflow wiring is required. Mergify names
 * every speculative PR's head branch `mergify/merge-queue/<hash>` (verified
 * against queue PRs #2936 and #2933); a real contributor branch happening to
 * start with that exact prefix is not a case worth defending against here —
 * worst case it is treated as a queue PR and its labels are (correctly, if
 * oddly) resolved from a linked "original" PR parsed out of its own body.
 */
export function isMergifyQueuePr(env: NodeJS.ProcessEnv = process.env): boolean {
  return QUEUE_HEAD_REF_RE.test(env.GITHUB_HEAD_REF ?? '');
}

/**
 * Primary signal: the fenced YAML state block Mergify appends to every
 * speculative PR body, e.g.:
 *
 *   ```yaml
 *   ---
 *   checking_base_sha: b69b6a96...
 *   pull_requests:
 *     - number: 2841
 *       scopes: []
 *   scopes: []
 *   ...
 *   ```
 *
 * This is Mergify's own internal state, not free text a PR author or
 * reviewer edits — the closest thing to a "documented signal" available
 * without a Mergify API integration. Every `queue_rules` entry in
 * `.mergify.yml` sets `batch_size: 1`, so exactly one `number:` is expected;
 * only the first is read.
 */
const YAML_PR_NUMBER_RE = /\bpull_requests:\s*\n\s*-\s*number:\s*(\d+)\b/;

/**
 * Fallback signal: the queue PR's title, which Mergify formats as
 * `merge queue: checking #<N> on <branch> (<sha>)[, stacked on #<M>]`
 * (verified on #2936: "...checking #2841 on main (6cb0006), stacked on
 * #2909" — the stacked-behind PR is deliberately NOT matched; it is a
 * different, not-yet-merged batch member, not the PR this run checks).
 * Anchored to the start of the title so it cannot match a title an author
 * wrote that merely mentions a PR number in passing.
 */
const TITLE_PR_NUMBER_RE = /^merge queue: checking #(\d+) on\b/;

/**
 * Parse the real PR number out of a Mergify speculative PR's title/body.
 * Tries the YAML block first (authoritative), then the title. Returns `null`
 * — never a guess — when neither matches, so the caller fails CLOSED (no
 * labels) instead of accidentally reading an unrelated PR's labels.
 */
export function parseOriginalPrNumberFromQueuePr(title: string, body: string): number | null {
  const yamlMatch = YAML_PR_NUMBER_RE.exec(body ?? '');
  if (yamlMatch) return Number(yamlMatch[1]);
  const titleMatch = TITLE_PR_NUMBER_RE.exec(title ?? '');
  if (titleMatch) return Number(titleMatch[1]);
  return null;
}

let _queueOriginalWarned = false;

/** Test seam: reset the once-per-process queue-resolution warning latch. */
export function __resetQueueOriginalWarningForTests(): void {
  _queueOriginalWarned = false;
}

function warnQueueOriginalUnresolvable(queuePrNumber: number, reason: string): void {
  if (_queueOriginalWarned) return;
  _queueOriginalWarned = true;
  console.warn(
    `::warning title=Mergify queue PR original unresolved::Running inside Mergify speculative `
    + `check PR #${queuePrNumber} (head ref matches mergify/merge-queue/*) but could not determine `
    + `the real PR it is checking (${reason}). Failing CLOSED: label-gated overrides are treated as `
    + 'ABSENT for this run rather than risk reading an unrelated PR\'s labels. If this recurs, '
    + 'confirm Mergify still formats the queue PR title as `merge queue: checking #<N> on ...` and '
    + 'still appends the `pull_requests:\\n  - number: <N>` YAML block to the body.',
  );
}

/**
 * Fetch a queue PR's title + body live via `gh`. Mirrors
 * {@link fetchLiveLabelsForNumber}: synchronous, short timeout, never throws.
 */
function fetchQueuePrMeta(
  env: NodeJS.ProcessEnv,
  queuePrNumber: number,
): { title: string; body: string } | null {
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!repo) return null;
  try {
    const out = execFileSync(
      GH_BIN,
      ['api', `repos/${repo}/pulls/${queuePrNumber}`, '--jq', '{title: .title, body: (.body // "")}'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    );
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { title, body } = parsed as { title?: unknown; body?: unknown };
    if (typeof title !== 'string' || typeof body !== 'string') return null;
    return { title, body };
  } catch {
    return null;
  }
}

/**
 * The PR number whose labels should actually gate this run.
 *
 * Outside a Mergify queue context this is exactly {@link parsePrNumber} —
 * unchanged behavior for ordinary PR runs, push builds, and local runs.
 *
 * Inside a queue context ({@link isMergifyQueuePr}), `parsePrNumber` would
 * return the EPHEMERAL speculative PR's own number, which carries none of the
 * real PR's labels. This resolves the real PR instead, preferring
 * `PR_TITLE`/`PR_BODY` when a workflow already wired them (no extra `gh`
 * call), else fetching the queue PR's title/body live. Returns `null` — fail
 * CLOSED — when the queue PR cannot be identified or its title/body cannot be
 * parsed; callers must treat `null` as "no labels available", never as
 * "same as the raw PR number".
 */
export function resolveOriginalPrNumber(env: NodeJS.ProcessEnv = process.env): number | null {
  const rawNumber = parsePrNumber(env);
  if (rawNumber === null) return null;
  if (!isMergifyQueuePr(env)) return rawNumber;

  let title = env.PR_TITLE ?? '';
  let body = env.PR_BODY ?? '';
  if (!title && !body) {
    const meta = fetchQueuePrMeta(env, rawNumber);
    if (meta === null) {
      warnQueueOriginalUnresolvable(rawNumber, 'the `gh` API fetch for the queue PR itself failed');
      return null;
    }
    ({ title, body } = meta);
  }

  const original = parseOriginalPrNumberFromQueuePr(title, body);
  if (original === null) {
    warnQueueOriginalUnresolvable(rawNumber, 'neither the body\'s YAML block nor the title matched the expected Mergify format');
    return null;
  }
  return original;
}

/**
 * The effective PR label set.
 *
 * Outside a queue context: the env-seeded (frozen-payload) labels UNIONed
 * with the live labels fetched from the API, deduped — unchanged behavior.
 *
 * Inside a Mergify queue context: the speculative PR's own env/live labels
 * belong to the WRONG PR, so they are not read at all. Instead this resolves
 * the real PR via {@link resolveOriginalPrNumber} and returns only ITS live
 * labels. An unresolvable original fails CLOSED to `[]` (no labels) rather
 * than falling back to the speculative PR's labels.
 */
export function resolvePrLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  if (isMergifyQueuePr(env)) {
    const originalNumber = resolveOriginalPrNumber(env);
    if (originalNumber === null) return [];
    return fetchLiveLabelsForNumber(env, originalNumber);
  }
  return [...new Set([...ENV_LABELS_SPLIT(env.PR_LABELS), ...fetchLiveLabels(env)])];
}

export const prLabels = resolvePrLabels();
export const prTitle = process.env.PR_TITLE ?? '';
export const prBody = process.env.PR_BODY ?? '';
/**
 * The PR's aggregated commit messages — read from a FILE, not an env string.
 *
 * These used to arrive as the PR_COMMITS_MSGS environment variable, which
 * Linux caps at MAX_ARG_STRLEN = 131,072 bytes for any single argv/envp
 * string. Once the aggregate crossed that, `execve` of the consuming step's
 * `/usr/bin/bash` failed with E2BIG — "Argument list too long" — before any
 * script logic ran, so no override label could clear it and the failure
 * carried no lint diagnosis at all. Measured on PR #2346 (run 32666797304,
 * job 97261336883, 2026-08-23): 153 commits / 138,166 bytes killed the
 * `HANDOFF.md verification lint` step. Pushing a commit refreshed the frozen
 * base and incidentally cleared it, but any sufficiently old PR — or the next
 * long-lived branch to merge — re-triggers it.
 *
 * `scripts/ci/aggregate-commit-messages.ts` now writes the full payload to
 * $RUNNER_TEMP and ci.yml passes only the PATH, which has no such ceiling.
 * PR_COMMITS_MSGS survives as a `head -c` capped fallback for local runs and
 * any caller not yet re-plumbed; falling back to it is ANNOTATED, never
 * silent, because a truncated haystack would let both gates report green on
 * evidence they never saw.
 */
export function resolvePrCommitsMsgs(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.PR_COMMITS_MSGS_FILE?.trim();
  if (path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `::error::Could not read PR_COMMITS_MSGS_FILE '${path}' (${reason}). ` +
          'Falling back to the size-capped PR_COMMITS_MSGS env var — commit messages ' +
          'beyond the cap are NOT visible to this gate.',
      );
    }
  }
  return env.PR_COMMITS_MSGS ?? '';
}

let _prCommitsMsgs: string | undefined;

/**
 * Memoized accessor for {@link resolvePrCommitsMsgs}.
 *
 * Deliberately a FUNCTION, not an eagerly-evaluated `const` like `prBody` /
 * `prTitle`: `scripts/ci/aggregate-commit-messages.ts` imports this module to
 * borrow {@link resolveDiffBase}, and it runs BEFORE the file exists. An eager
 * read there fired the not-readable ::error:: annotation on every run — an
 * error annotation from the very step whose job is to create the file.
 */
export function prCommitsMsgs(): string {
  _prCommitsMsgs ??= resolvePrCommitsMsgs();
  return _prCommitsMsgs;
}

export const headRef = process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? '';
export const repository = process.env.GITHUB_REPOSITORY ?? '';
export const scanAll = process.env.FEEDBACK_RULES_SCAN_ALL === '1';

export const LABELS = {
  postBetaQuotaRollout: 'post-beta-quota-rollout',
  awsIntentional: 'aws-intentional',
  handoffNarrativeOnly: 'handoff-narrative-only',
  countExactAllowed: 'count-exact-allowed',
  coverageDropAllowed: 'coverage-drop-allowed',
  ciConfigChange: 'ci-config-change',
  confluenceDriftSkip: 'confluence-drift-skip',
  worktreeBranchException: 'worktree-branch-exception',
  proofBlockHeightReviewed: 'proof-block-height-reviewed',
} as const;

/**
 * Atlassian Basic-auth header builder. Reused by check-confluence-coverage
 * (CI gate) and the healthcheck Atlassian probes — same env var contract
 * on both sides.
 */
export function atlassianBasicAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

export function hasLabel(label: string): boolean {
  // Resolve live at call time so a label added after the frozen pull_request
  // payload (then `gh run rerun`) is honored — the whole point of the fix.
  return resolvePrLabels().includes(label);
}

/** The parent SHAs of HEAD (empty on any failure — treated as "not a merge"). */
function headParentShas(): string[] {
  try {
    const out = execFileSync(GIT_BIN, ['rev-list', '--parents', '-n', '1', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out.split(/\s+/).filter(Boolean).slice(1);
  } catch {
    return [];
  }
}

/** `git merge-base --is-ancestor` — false on non-ancestry AND on any error. */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  try {
    execFileSync(GIT_BIN, ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: REPO,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** `git merge-base a b`, or `null` when it cannot be resolved. */
function tryMergeBase(a: string, b: string): string | null {
  try {
    const sha = execFileSync(GIT_BIN, ['merge-base', a, b], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

const PULL_MERGE_REF_RE = /^refs\/pull\/\d+\/merge$/;

/**
 * The diff anchor for {@link changedFiles} — FD-GATE-2.
 *
 * `base` can be GitHub's FROZEN `pull_request.base.sha` (ci.yml and
 * merge-authority.yml still pass it), pinned at the base tip as of the PR's
 * LAST HEAD PUSH, while HEAD is the live refs/pull/N/merge preview GitHub
 * recomputes against current main. A raw two-dot `base..HEAD` from that pair
 * charges every main commit landed since the last push to the PR itself
 * (measured 2026-08-22: a 6-file PR presented as 162 files; 15 of 28 open PRs
 * desynced). The anchor is chosen so base movement is NEVER attributed to the
 * PR, per changeset-identity property the old two-dot comment protected:
 *
 *   1. HEAD is the merge preview (pull merge ref + exactly two parents, and
 *      the env base is an ancestor of the FIRST parent — the first parent of
 *      the preview IS the live base tip it was built on) → `HEAD^1`. The diff
 *      is then exactly what this PR adds on top of the CURRENT base,
 *      conflict resolutions included, and content the base already took
 *      cancels out — the property the two-dot form existed for.
 *      The ancestry probe is what keeps the raw-head fallback honest: a
 *      branch tip that merely merges main INTO the branch also has two
 *      parents, but its first parent is the previous BRANCH head, which the
 *      env base never descends into (a push resyncs the frozen base), so it
 *      routes to strategy 2 instead of mis-anchoring at the pre-merge head.
 *   2. Raw head (local run, staging-evidence raw-head fallback, push builds)
 *      → `merge-base(base, HEAD)`: three-dot semantics from the fork point,
 *      so base commits landed after the fork never enter the changeset.
 *   3. merge-base unresolvable (disjoint/shallow history) → the env base
 *      itself: the legacy anchor. Never `[]` — a diff failure still throws.
 */
export function resolveDiffBase(base: string): string {
  if (PULL_MERGE_REF_RE.test(process.env.GITHUB_REF ?? '')) {
    const parents = headParentShas();
    if (parents.length === 2 && isAncestorOf(base, parents[0])) return 'HEAD^1';
  }
  return tryMergeBase(base, 'HEAD') ?? base;
}

/**
 * Files changed by THIS PR (or all matching `pathspec` when scanAll=true).
 * Uses execFileSync to avoid shell-quoting issues with glob patterns.
 *
 * Fails CLOSED: the base is resolved via `getBaseRef({ required: true })`, so an
 * unresolvable base exits the job (it does NOT silently return `[]`). A previous
 * version swallowed the `git diff` error to `[]`, which made every path-gated
 * check see "no changed files" and PASS — exactly the wrong direction for a
 * gate. We now only swallow to `[]` in the genuinely-empty `scanAll` ls-files
 * case; a diff failure throws.
 *
 * The diff is anchored by {@link resolveDiffBase}, NOT two-dotted straight
 * from the env base — the env base can be the frozen event-payload sha, and
 * anchoring there attributes the base branch's later commits to the PR
 * (FD-GATE-2). Pinned by ci-workflow-contract.test.ts.
 */
export function changedFiles(pathspec?: string): string[] {
  if (scanAll) {
    const args = pathspec ? ['ls-files', pathspec] : ['ls-files'];
    return execFileSync(GIT_BIN, args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  // Required base: getBaseRef exits(1) if it cannot resolve, so the gate never
  // degrades to "no changes" on a shallow/broken checkout.
  const base = getBaseRef({ required: true })!;
  const diffBase = resolveDiffBase(base);
  const args = ['diff', '--name-only', '--diff-filter=AMR', `${diffBase}..HEAD`];
  if (pathspec) args.push('--', pathspec);
  return execFileSync(GIT_BIN, args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
}
