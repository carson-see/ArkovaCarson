#!/usr/bin/env tsx
/**
 * CI gate: a prose merge-hold must be label-backed (SCRUM-3804, the #2240
 * pattern).
 *
 * ## The defect this closes
 *
 * Mergify's queues are blocked by the `do-not-merge` LABEL
 * (`.mergify.yml` queue_conditions) — and by nothing else a human writes.
 * A PR body saying "do not merge" is a hold that exists only in prose:
 * Mergify never reads it, so once CI is green the queue embarks and merges
 * the PR over its own author's written objection (PR #2240). The author
 * believed the hold was real; the machinery had no way to know it existed.
 *
 * The rule: any NON-DRAFT PR whose body contains the phrase "do not merge"
 * (case-insensitive, whitespace-tolerant) without the `do-not-merge` label
 * fails this check. The fix is one of:
 *   - apply the `do-not-merge` label — the hold becomes real (and labels are
 *     read LIVE here, so applying it then re-running this job passes);
 *   - convert the PR to draft — drafts cannot enter the queue;
 *   - remove the phrase — assert there is no hold.
 *
 * The HYPHENATED form `do-not-merge` deliberately does NOT match: bodies
 * legitimately reference the label by name (including this gate's own
 * remediation text quoted in PR bodies).
 *
 * ## Freshness
 *
 * `PR_BODY` / `PR_DRAFT` come from the FROZEN pull_request payload, and
 * ci.yml does not re-run on body edits or draft flips (`edited` /
 * `ready_for_review` are not in its trigger types — shared with every other
 * body-gated check in this job, not introduced here). To make re-runs honest
 * in both directions, the check refreshes draft + body LIVE from the GitHub
 * API when a PR context and token exist (same pattern and degradation story
 * as ciContext.fetchLiveLabels), and reads labels through resolvePrLabels'
 * env ∪ live union. On any fetch failure it falls back to the env payload.
 *
 * No PR context (push builds, local runs) ⇒ empty body ⇒ pass.
 *
 * Exit 0 = pass. Exit 1 = an unlabeled prose hold on a non-draft PR.
 * No override label — the pass condition IS a label (`do-not-merge`).
 */

import { execFileSync } from 'node:child_process';
import { GH_BIN, REPO, isMainModule, parsePrNumber, resolvePrLabels } from './lib/ciContext';

/** The one label `.mergify.yml` honors as a merge hold. */
export const HOLD_LABEL = 'do-not-merge';

/**
 * The prose hold: "do not merge" with any whitespace (line wraps included)
 * between the words. Word boundaries keep `do-not-merge` (label mentions) and
 * fused strings out.
 */
const HOLD_PHRASE_RE = /\bdo\s+not\s+merge\b/iu;

export function bodyDeclaresHold(body: string): boolean {
  return HOLD_PHRASE_RE.test(body);
}

export interface ProseHoldState {
  body: string;
  draft: boolean;
  holdLabelApplied: boolean;
}

/** Null = pass; otherwise the violation message. Pure — all I/O stays in the resolvers. */
export function evaluateProseHold(state: ProseHoldState): string | null {
  if (state.draft) return null; // a draft cannot enter the queue
  if (!bodyDeclaresHold(state.body)) return null;
  if (state.holdLabelApplied) return null; // the hold is real — Mergify honors the label
  return (
    `Non-draft PR body declares a merge hold ("do not merge") but the '${HOLD_LABEL}' label is not applied. `
    + `Prose holds are INERT to Mergify (the #2240 pattern) — only the label blocks the queue. `
    + `Apply the '${HOLD_LABEL}' label (labels are read live, so a re-run of this job honors it), `
    + `convert the PR to draft, or remove the phrase from the body.`
  );
}

interface LivePrState {
  body: string;
  draft: boolean;
}

/**
 * Fetch the PR's CURRENT draft state and body via `gh`. Mirrors
 * ciContext.fetchLiveLabels: synchronous, short timeout, never throws — no PR
 * context, a missing token, or an API error all degrade to `null` so the
 * caller falls back to the frozen env payload.
 */
export function fetchLivePrState(env: NodeJS.ProcessEnv = process.env): LivePrState | null {
  const prNumber = parsePrNumber(env);
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (prNumber === null || !repo) return null;
  try {
    const out = execFileSync(
      GH_BIN,
      ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '{draft: .draft, body: (.body // "")}'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    );
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { draft, body } = parsed as { draft?: unknown; body?: unknown };
    if (typeof draft !== 'boolean' || typeof body !== 'string') return null;
    return { draft, body };
  } catch {
    return null;
  }
}

export function resolveProseHoldState(env: NodeJS.ProcessEnv = process.env): ProseHoldState {
  const live = fetchLivePrState(env);
  return {
    body: live?.body ?? env.PR_BODY ?? '',
    // Unknown draft state on a PR run is treated as NON-draft (the check
    // applies) — failing a stray draft costs nothing (drafts don't queue),
    // while passing a live one would silence the gate.
    draft: live?.draft ?? (env.PR_DRAFT ?? '').trim().toLowerCase() === 'true',
    holdLabelApplied: resolvePrLabels(env).includes(HOLD_LABEL),
  };
}

export function main(): number {
  const state = resolveProseHoldState();
  const violation = evaluateProseHold(state);
  if (violation === null) {
    if (!state.draft && bodyDeclaresHold(state.body)) {
      console.log(`::notice::PR body declares a merge hold and the '${HOLD_LABEL}' label backs it — the hold is real.`);
    }
    console.log('do-not-merge body/label parity OK.');
    return 0;
  }
  console.error(`::error::${violation}`);
  return 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main());
}
