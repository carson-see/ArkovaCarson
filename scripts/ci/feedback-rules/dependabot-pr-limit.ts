#!/usr/bin/env -S npx tsx
/**
 * feedback_dependabot_pr_limit_sum: .github/dependabot.yml's
 * `open-pull-requests-limit` values must sum to <= 7 across every `updates`
 * entry, and every entry must set the field explicitly.
 *
 * WHY (CTO decision 2026-09-21): the Monday Dependabot wave opened 13 PRs at
 * once, took the repo to 20 open against the founder's 15-PR open-PR
 * ceiling, and helped exhaust the GitHub Actions budget the same day — each
 * new PR runs the full required-check matrix plus a Mergify speculative
 * run. `.github/dependabot.yml`'s own
 * header now states the sum<=7 invariant (so a full wave can never consume
 * more than half the PR ceiling); this rule is the CI enforcement of that
 * invariant, not a duplicate of it.
 *
 * Every entry must ALSO set the field explicitly: GitHub defaults an
 * OMITTED `open-pull-requests-limit` to 5, which would raise the true
 * effective sum without ever appearing as a number in this file — a config
 * that reads as compliant by eye while silently exceeding budget. So a
 * missing field fails this rule on its own, independent of the declared sum.
 *
 * Raising the sum (or removing a limit from an entry) is a founder decision,
 * not a PR-label override — matching the file's own header, which names the
 * rule as CTO-decided. No override label.
 *
 * This rule intentionally does not gate on the PR's changed-file list (it is
 * not a `changedFiles()`-scoped rule like most of this directory): it always
 * evaluates the CURRENT `.github/dependabot.yml` on disk, because a stale
 * violation that predates a PR is exactly as real as one that PR introduces
 * — this is a repo-invariant check, not a diff review.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { REPO } from '../lib/ciContext.js';

export const SUM_LIMIT = 7;
const DEPENDABOT_CONFIG_PATH = '.github/dependabot.yml';

interface DependabotUpdateEntry {
  'package-ecosystem'?: unknown;
  directory?: unknown;
  'open-pull-requests-limit'?: unknown;
}

interface DependabotConfig {
  updates?: DependabotUpdateEntry[];
}

export interface RuleResult {
  ok: boolean;
  message: string;
}

function entryLabel(entry: DependabotUpdateEntry, index: number): string {
  const eco = typeof entry['package-ecosystem'] === 'string' ? entry['package-ecosystem'] : undefined;
  const dir = typeof entry.directory === 'string' ? entry.directory : undefined;
  if (eco && dir) return `${eco}:${dir}`;
  if (eco) return eco;
  return `updates[${index}]`;
}

/**
 * Pure evaluator over an already-parsed dependabot.yml document — the
 * testable core. `run()` below is the only piece that touches the
 * filesystem.
 */
export function evaluateDependabotConfig(doc: unknown): RuleResult {
  const config = doc as DependabotConfig | null | undefined;
  const updates = Array.isArray(config?.updates) ? config!.updates : null;

  if (!updates || updates.length === 0) {
    return {
      ok: false,
      message: `${DEPENDABOT_CONFIG_PATH} has no \`updates\` entries (or failed to parse as expected) — config error, cannot evaluate the PR-limit sum.`,
    };
  }

  const missing: string[] = [];
  let sum = 0;
  updates.forEach((entry, index) => {
    const limit = entry?.['open-pull-requests-limit'];
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      sum += limit;
    } else {
      missing.push(entryLabel(entry ?? {}, index));
    }
  });

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `${missing.length} \`updates\` entr${missing.length === 1 ? 'y omits' : 'ies omit'} \`open-pull-requests-limit\` explicitly: ${missing.join(', ')}. `
      + 'GitHub defaults an omitted limit to 5, which would raise the TRUE effective sum without that number ever appearing in this file.',
    );
  }
  if (sum > SUM_LIMIT) {
    problems.push(`Declared \`open-pull-requests-limit\` values sum to ${sum}, which is above the ${SUM_LIMIT} budget.`);
  }

  if (problems.length === 0) {
    return {
      ok: true,
      message: `✅ feedback_dependabot_pr_limit_sum: ${updates.length} updates entries, every one sets open-pull-requests-limit explicitly, sum=${sum} (<= ${SUM_LIMIT}).`,
    };
  }

  const out = [`${DEPENDABOT_CONFIG_PATH} violates the Dependabot PR-limit budget:`, ...problems.map((p) => `  - ${p}`)];
  out.push('');
  out.push(
    'The 2026-09-21 Dependabot wave opened 13 PRs at once, took the repo to 20 open against '
    + `the founder's 15-PR ceiling, and helped exhaust the GitHub Actions budget the same day. `
    + `The sum<=${SUM_LIMIT} rule exists so a single full wave can never consume more than half `
    + 'that ceiling. Raising the sum, or leaving a limit unset, needs a founder decision — see '
    + `${DEPENDABOT_CONFIG_PATH}'s own header comment. No PR-label override exists for this rule.`,
  );
  return { ok: false, message: out.join('\n') };
}

export function run(): RuleResult {
  const filePath = resolve(REPO, DEPENDABOT_CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, message: `Could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let doc: unknown;
  try {
    doc = load(raw);
  } catch (e) {
    return { ok: false, message: `Could not parse ${filePath} as YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  return evaluateDependabotConfig(doc);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
