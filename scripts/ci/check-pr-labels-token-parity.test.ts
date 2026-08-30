/**
 * Regression lint: a workflow job that seeds `PR_LABELS` must also hand `gh` a
 * token.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `scripts/ci/lib/ciContext.ts` resolves override labels LIVE: `resolvePrLabels()`
 * unions the env-seeded `PR_LABELS` (captured from the FROZEN `pull_request`
 * webhook payload) with a `gh api repos/<repo>/issues/<n>/labels` call, so a
 * label applied AFTER the run started is still honored on `gh run rerun`.
 *
 * That live half only works if `gh` can authenticate, and `gh` authenticates
 * from `GH_TOKEN` / `GITHUB_TOKEN` and nothing else. Two things that look like
 * they should supply one do not:
 *   - `permissions: { pull-requests: read }` SCOPES a token; it never supplies
 *     one to the step env.
 *   - `actions/checkout` persists credentials into `.git/config`, which `gh`
 *     does not read.
 *
 * With no token the `gh` call throws, `fetchLiveLabels()` catches it, and
 * `resolvePrLabels()` degrades to the frozen payload — silently, before the
 * annotation added alongside this lint. Every label-gated override in the job
 * becomes inert: the documented "apply the override label, then re-run the
 * failed job" remediation cannot work, because the label only counts if it was
 * already on the PR when the webhook fired.
 *
 * Confirmed on PR #2322 (2026-08-22): `agents-md-deletion-approved` applied,
 * `gh run rerun --failed`, same failure. `Dependency Scanning` is a required
 * `check-success` in all three `.mergify.yml` queue rules, so the job it broke
 * can block a merge with no escape hatch short of an empty commit.
 *
 * ── Why a lint and not just the one-line fix ────────────────────────────────
 * The class recurs: the gap is invisible at the step that suffers it, and the
 * natural way to add a label gate is to copy a neighbouring step's `env:` block
 * (which carries `PR_LABELS` but not the token) into whichever job is
 * convenient. Pinning the pairing structurally is what stops the next one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..');
const WORKFLOW_DIR = resolve(REPO, '.github/workflows');

/** The only env vars `gh` will authenticate from. */
const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

const PR_LABELS_RE = /^\s*PR_LABELS:\s*\S/u;
const TOKEN_RE = new RegExp(`^\\s*(?:${TOKEN_KEYS.join('|')}):\\s*\\S`, 'u');

function indentOf(line: string): number {
  return /^(\s*)/u.exec(line)?.[1].length ?? 0;
}

/**
 * Blank out whole-line comments, preserving line indices.
 *
 * Load-bearing: the jobs fixed alongside this lint carry comments that MENTION
 * `GH_TOKEN` in prose. Without this, a job could satisfy the lint with a
 * comment about the token instead of the token.
 */
function blankComments(lines: string[]): string[] {
  return lines.map((line) => (/^\s*#/u.test(line) ? '' : line));
}

/** Lines nested under the mapping key at `keyIdx` (deeper indent; blanks pass through). */
function blockAfter(lines: string[], keyIdx: number): string[] {
  const keyIndent = indentOf(lines[keyIdx]);
  const out: string[] = [];
  for (let i = keyIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      out.push(lines[i]);
      continue;
    }
    if (indentOf(lines[i]) <= keyIndent) break;
    out.push(lines[i]);
  }
  return out;
}

interface Job {
  readonly name: string;
  /** Body lines of the job, original indentation preserved, job key line excluded. */
  readonly lines: readonly string[];
}

/**
 * Split a workflow's `jobs:` mapping into one block per job.
 *
 * Anchored to the `jobs:` block specifically — `on:` also has two-space keys
 * (`push:`, `pull_request:`) and must not be mistaken for a job.
 */
function parseJobs(raw: string): Job[] {
  const lines = blankComments(raw.split('\n'));
  const jobsIdx = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIdx === -1) return [];

  let end = lines.length;
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  }

  const jobs: Job[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (let i = jobsIdx + 1; i < end; i += 1) {
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/u.exec(lines[i]);
    if (key) {
      current = { name: key[1], lines: [] };
      jobs.push(current);
      continue;
    }
    current?.lines.push(lines[i]);
  }
  return jobs;
}

/** Smallest indentation used by the job's direct children (`name:`, `env:`, `steps:`, …). */
function childIndent(lines: readonly string[]): number {
  const indents = lines.filter((l) => l.trim() !== '').map(indentOf);
  return indents.length > 0 ? Math.min(...indents) : 0;
}

/** Lines under a direct child key of the job, e.g. `env:` or `permissions:`. */
function jobSection(job: Job, key: string): string[] {
  const lines = [...job.lines];
  const depth = childIndent(lines);
  const re = new RegExp(`^\\s{${depth}}${key}:\\s*$`, 'u');
  const idx = lines.findIndex((line) => re.test(line));
  return idx === -1 ? [] : blockAfter(lines, idx);
}

/** Split the job's `steps:` list into one block per `- ` bullet. */
function jobSteps(job: Job): string[][] {
  const block = jobSection(job, 'steps');
  const out: string[][] = [];
  let bulletIndent = -1;
  let current: string[] | null = null;
  for (const line of block) {
    const bullet = /^(\s*)- \S/u.exec(line);
    // A deeper `- ` (a `with:` list item, a shell heredoc bullet) is part of the
    // current step, not a sibling — only the first bullet depth starts a step.
    if (bullet && (bulletIndent === -1 || bullet[1].length === bulletIndent)) {
      bulletIndent = bullet[1].length;
      current = [line];
      out.push(current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

function hasToken(lines: readonly string[]): boolean {
  return lines.some((line) => TOKEN_RE.test(line));
}

function seedsPrLabels(lines: readonly string[]): boolean {
  return lines.some((line) => PR_LABELS_RE.test(line));
}

export interface Gap {
  readonly file: string;
  readonly job: string;
  readonly detail: string;
}

/**
 * Every job in `raw` that seeds `PR_LABELS` without a usable token, plus the
 * jobs that seed it without the `pull-requests` read scope the API call needs.
 * A token supplied at job level covers every step; a step may also carry its own.
 */
export function findPrLabelTokenGaps(file: string, raw: string): Gap[] {
  const gaps: Gap[] = [];
  for (const job of parseJobs(raw)) {
    const jobEnv = jobSection(job, 'env');
    const jobHasToken = hasToken(jobEnv);
    const steps = jobSteps(job);

    const seedingSteps = steps.filter(seedsPrLabels);
    const jobLevelSeed = seedsPrLabels(jobEnv);
    if (!jobLevelSeed && seedingSteps.length === 0) continue;

    if (jobLevelSeed && !jobHasToken) {
      gaps.push({
        file,
        job: job.name,
        detail:
          'seeds PR_LABELS in the JOB-level env but exports neither GH_TOKEN nor '
          + 'GITHUB_TOKEN there, so ciContext.fetchLiveLabels() cannot authenticate '
          + 'for any step in the job',
      });
    }

    if (!jobHasToken) {
      for (const step of seedingSteps) {
        if (hasToken(step)) continue;
        gaps.push({
          file,
          job: job.name,
          detail:
            `step ${describeStep(step)} sets PR_LABELS but neither it nor the job `
            + 'exports GH_TOKEN/GITHUB_TOKEN — its label-gated override is inert on a re-run',
        });
      }
    }

    // The token is necessary but not sufficient: reading a PR's labels needs the
    // `pull-requests` scope, and declaring ANY `permissions:` block drops every
    // scope not listed.
    const permissions = jobSection(job, 'permissions');
    if (permissions.length > 0 && !permissions.some((l) => /^\s*pull-requests:\s*(read|write)\s*$/u.test(l))) {
      gaps.push({
        file,
        job: job.name,
        detail:
          'seeds PR_LABELS and declares a permissions block without `pull-requests: read`, '
          + 'so the token is scoped out of the labels API',
      });
    }
  }
  return gaps;
}

function describeStep(step: readonly string[]): string {
  const named = step.find((line) => /^\s*- name:/u.test(line));
  return named ? `"${named.replace(/^\s*- name:\s*/u, '').trim()}"` : `"${step[0]?.trim() ?? '<unnamed>'}"`;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

describe('PR_LABELS ⇄ gh token parity across .github/workflows', () => {
  it('every job that seeds PR_LABELS also exports GH_TOKEN or GITHUB_TOKEN', () => {
    const gaps = workflowFiles().flatMap((f) =>
      findPrLabelTokenGaps(f, readFileSync(resolve(WORKFLOW_DIR, f), 'utf8')));

    expect(
      gaps.map((g) => `${g.file} › job "${g.job}": ${g.detail}`),
      'A label-gated override in these jobs cannot be applied by re-running the job. '
      + 'Add `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the JOB-level `env:` (not per-step, '
      + 'so steps added later inherit it).',
    ).toEqual([]);
  });

  it('actually finds the jobs that seed PR_LABELS (the scan is not vacuously empty)', () => {
    // Guards the lint against its own parser silently matching nothing — an
    // empty scan would report "no gaps" forever.
    const seeding = workflowFiles().flatMap((f) => {
      const raw = readFileSync(resolve(WORKFLOW_DIR, f), 'utf8');
      return parseJobs(raw)
        .filter((job) => seedsPrLabels(jobSection(job, 'env')) || jobSteps(job).some(seedsPrLabels))
        .map((job) => `${f}:${job.name}`);
    });

    // The three jobs that seed PR_LABELS today. Extend deliberately — a new
    // entry here means a new job needs the token pairing above.
    expect(seeding.sort()).toEqual([
      'ci.yml:dependency-scan',
      'ci.yml:policy-lints',
      'staging-evidence.yml:staging-evidence',
    ]);
  });

  it('counts every PR_LABELS-bearing step in ci.yml, not just the first per job', () => {
    const raw = readFileSync(resolve(WORKFLOW_DIR, 'ci.yml'), 'utf8');
    const perJob = Object.fromEntries(
      parseJobs(raw).map((job) => [job.name, jobSteps(job).filter(seedsPrLabels).length]),
    );
    // 11 in dependency-scan + 6 in policy-lints = the 17 PR_LABELS lines in the file.
    expect(perJob['dependency-scan']).toBe(11);
    expect(perJob['policy-lints']).toBe(6);
  });
});

describe('the lint itself fails on the regression it exists to catch', () => {
  const WITH_TOKEN = `name: t
on:
  pull_request:
jobs:
  scan:
    name: Scan
    permissions:
      contents: read
      pull-requests: read
    env:
      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: gated
        env:
          PR_LABELS: \${{ join(github.event.pull_request.labels.*.name, ',') }}
        run: tsx check.ts
`;

  it('passes a job whose job-level env supplies the token', () => {
    expect(findPrLabelTokenGaps('t.yml', WITH_TOKEN)).toEqual([]);
  });

  it('flags the exact PR #2322 shape: pull-requests: read, PR_LABELS, no token', () => {
    const gaps = findPrLabelTokenGaps('t.yml', WITH_TOKEN.replace(
      /    env:\n      GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/u,
      '',
    ));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].job).toBe('scan');
    expect(gaps[0].detail).toContain('inert on a re-run');
  });

  it('accepts a step that carries its own token even without a job-level one', () => {
    const stepScoped = WITH_TOKEN
      .replace(/    env:\n      GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/u, '')
      .replace('          PR_LABELS:', '          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n          PR_LABELS:');
    expect(findPrLabelTokenGaps('t.yml', stepScoped)).toEqual([]);
  });

  it('flags a SECOND label-gated step added to a job whose only token is step-scoped', () => {
    // The precise reason the fix is job-level: a step-scoped token does not
    // protect the next step someone appends.
    const stepScoped = WITH_TOKEN
      .replace(/    env:\n      GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/u, '')
      .replace('          PR_LABELS:', '          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n          PR_LABELS:')
      + `      - name: newly added gate
        env:
          PR_LABELS: \${{ join(github.event.pull_request.labels.*.name, ',') }}
        run: tsx other.ts
`;
    const gaps = findPrLabelTokenGaps('t.yml', stepScoped);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toContain('newly added gate');
  });

  it('is not satisfied by a COMMENT that merely mentions GH_TOKEN', () => {
    const commentOnly = WITH_TOKEN.replace(
      '      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      '      # GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}  <- removed, see ticket\n      FOO: bar',
    );
    expect(findPrLabelTokenGaps('t.yml', commentOnly)).toHaveLength(1);
  });

  it('flags a token present but scoped out by a permissions block missing pull-requests', () => {
    const noScope = WITH_TOKEN.replace('      pull-requests: read\n', '');
    const gaps = findPrLabelTokenGaps('t.yml', noScope);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toContain('scoped out of the labels API');
  });

  it('does not mistake an `on:` trigger key for a job', () => {
    expect(parseJobs(WITH_TOKEN).map((j) => j.name)).toEqual(['scan']);
  });

  it('ignores jobs that never seed PR_LABELS', () => {
    const unrelated = `name: t
on:
  pull_request:
jobs:
  build:
    permissions:
      contents: read
    steps:
      - run: npm ci
`;
    expect(findPrLabelTokenGaps('t.yml', unrelated)).toEqual([]);
  });
});
