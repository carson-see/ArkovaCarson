import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.github/workflows/agents.md`: "Workflows use pinned action SHAs (not `@v4`
 * tags) for supply-chain safety."
 *
 * A tag is a mutable pointer. Whoever can move `v4` in the upstream repo — an
 * upstream maintainer, or anyone who compromises that account — silently
 * changes what our runner executes, with our `secrets` and `GITHUB_TOKEN` in
 * scope. That is the `tj-actions/changed-files` shape: a retagged action
 * dumped runner memory into the logs of ~23,000 repositories. A branch ref
 * (`@release/v1`) is strictly worse, since every upstream push moves it.
 *
 * A 40-hex commit SHA is immutable, so the pin names exactly one tree.
 *
 * The trailing `# vX.Y.Z` comment is not decoration: Dependabot reads it to
 * know which version a SHA represents, and without it the pin is unreadable to
 * a human reviewer and un-upgradeable by automation. Both halves are required.
 *
 * This is a census-proof ratchet rather than a one-time fix. The finding that
 * prompted it was reported against `gitleaks.yml`'s `actions/checkout@v4`
 * alone; this detector immediately surfaced eight more live sites across three
 * other workflows, including both SDK publish jobs — which hold `NPM_TOKEN`
 * and `id-token: write` for PyPI trusted publishing, making them the highest-
 * value targets in the repo.
 */

const repoRoot = process.cwd();
const githubDir = path.join(repoRoot, '.github');

/**
 * A `uses:` mapping key, with or without the leading `- ` of a step sequence,
 * capturing the ref and any trailing comment.
 *
 * Anchored at the key so sibling keys ENDING in `uses:` never match — the
 * `permissions:` block's `statuses: read` is the live example, and a substring
 * match would report four phantom violations.
 */
const USES_RE = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*?))?\s*$/;
/** A full-length git commit SHA — the only immutable ref form. */
const SHA_PIN_RE = /@[0-9a-f]{40}$/;
/** `# v1`, `# v7.0.0`, `# v3.97.0` — the comment Dependabot parses. */
const VERSION_COMMENT_RE = /^v\d+(?:\.\d+)*$/;
/** A container action is pinned by image digest rather than by commit. */
const DOCKER_DIGEST_RE = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/;

/** Every YAML file under `.github/`, so a composite action added later at
 *  `.github/actions/**` is covered the day it lands rather than reopening the
 *  hole this test exists to close. */
function githubYamlFiles(dir = githubDir): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return githubYamlFiles(full);
      return entry.name.endsWith('.yml') || entry.name.endsWith('.yaml') ? [full] : [];
    })
    .sort();
}

interface UsesRef {
  location: string;
  ref: string;
  comment: string | undefined;
}

function collectUsesRefs(): UsesRef[] {
  const refs: UsesRef[] = [];

  for (const file of githubYamlFiles()) {
    const rel = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('#')) return; // commented-out step
      const match = USES_RE.exec(line);
      if (!match) return;
      refs.push({ location: `${rel}:${index + 1}`, ref: match[1], comment: match[2]?.trim() });
    });
  }

  return refs;
}

function findViolations(): string[] {
  const violations: string[] = [];

  for (const { location, ref, comment } of collectUsesRefs()) {
    // A repo-local action or reusable workflow ships in this same commit —
    // there is no third party to pin against.
    if (ref.startsWith('./')) continue;
    if (DOCKER_DIGEST_RE.test(ref)) continue;

    if (!SHA_PIN_RE.test(ref)) {
      violations.push(`${location} — ${ref} is a mutable tag/branch ref, not a 40-hex commit SHA`);
      continue;
    }
    if (!comment || !VERSION_COMMENT_RE.test(comment)) {
      violations.push(`${location} — ${ref} lacks a trailing '# vX.Y.Z' version comment`);
    }
  }

  return violations;
}

/**
 * The same action pinned to the same SHA must carry the same version comment
 * everywhere.
 *
 * A comment is unverifiable offline on its own — nothing local proves
 * `# v7.0.0` names that SHA. But INTERNAL agreement is checkable, and it
 * catches the drift that actually occurs: `deploy-staging.yml` and
 * `deploy-worker.yml` both labelled `actions/setup-node@8207627…` as `# v4`
 * while twenty other sites labelled that identical SHA `# v7.0.0`. A reviewer
 * reading the stale pair would have believed the deploy path ran three majors
 * behind what it actually ran.
 */
function findCommentDisagreements(): string[] {
  const bySha = new Map<string, Map<string, string[]>>();

  for (const { location, ref, comment } of collectUsesRefs()) {
    if (!SHA_PIN_RE.test(ref) || !comment) continue;
    const byComment = bySha.get(ref) ?? new Map<string, string[]>();
    byComment.set(comment, [...(byComment.get(comment) ?? []), location]);
    bySha.set(ref, byComment);
  }

  return [...bySha.entries()]
    .filter(([, byComment]) => byComment.size > 1)
    .map(([ref, byComment]) => {
      const detail = [...byComment.entries()]
        .map(([comment, locations]) => `'# ${comment}' at ${locations.join(', ')}`)
        .join(' vs ');
      return `${ref} — disagreeing version comments: ${detail}`;
    });
}

describe('workflow action SHA pinning (supply-chain)', () => {
  it('pins every third-party action to a full commit SHA with a version comment', () => {
    expect(findViolations()).toEqual([]);
  });

  it('labels each pinned SHA with one consistent version across all workflows', () => {
    expect(findCommentDisagreements()).toEqual([]);
  });

  it('actually parses the workflows it claims to check', () => {
    // Guards the guard: a walker that silently finds nothing passes forever.
    const refs = collectUsesRefs();
    expect(refs.length).toBeGreaterThan(50);
    expect(refs.some((r) => r.location.includes('gitleaks.yml'))).toBe(true);
  });

  it('detects mutable refs and accepts only the pinned shape', () => {
    const parse = (line: string) => USES_RE.exec(line);

    // Mutable refs of every shape seen in the wild.
    expect(SHA_PIN_RE.test('actions/checkout@v4')).toBe(false);
    expect(SHA_PIN_RE.test('actions/setup-node@v7.0.0')).toBe(false);
    expect(SHA_PIN_RE.test('pypa/gh-action-pypi-publish@release/v1')).toBe(false);
    expect(SHA_PIN_RE.test('actions/checkout@main')).toBe(false);
    // A short SHA is NOT a pin: it is ambiguous and GitHub rejects it.
    expect(SHA_PIN_RE.test('actions/checkout@9c091bb')).toBe(false);
    expect(SHA_PIN_RE.test('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')).toBe(true);

    // Sibling keys that merely END in `uses:` must not be read as `uses:`.
    expect(parse('      statuses: read')).toBeNull();
    expect(parse('      contents: read')).toBeNull();

    // Both step forms, with and without the sequence dash, and any comment gap.
    expect(parse('      - uses: actions/checkout@abc # v1')?.[1]).toBe('actions/checkout@abc');
    expect(parse('        uses: actions/checkout@abc  # v1')?.[2]).toBe('v1');
    expect(parse('      - uses: ./.github/actions/local')?.[1]).toBe('./.github/actions/local');
    expect(parse('      - uses: actions/checkout@abc')?.[2]).toBeUndefined();

    // Version-comment shapes: a bare version only, not prose.
    expect(VERSION_COMMENT_RE.test('v7.0.0')).toBe(true);
    expect(VERSION_COMMENT_RE.test('v1')).toBe(true);
    expect(VERSION_COMMENT_RE.test('pin me later')).toBe(false);
    expect(VERSION_COMMENT_RE.test('')).toBe(false);
  });
});
