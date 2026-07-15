/**
 * Held-out leakage control (AI-01/AI-02 — SCRUM-2381/2382).
 *
 * The S3 CPE/CLE golden set carries a held-out split whose fixtures must NEVER
 * appear in any prompt, few-shot block, or tuning corpus committed to the repo —
 * otherwise the held-out score measures memorization, not generalization
 * (train/test contamination, same failure class as SCRUM-2200).
 *
 * Mechanism:
 *   - Every held-out fixture is fingerprinted (SHA-256 over whitespace/case
 *     normalized text) and the fingerprints are version-pinned in
 *     `cpe-cle-s3-manifest.json`.
 *   - `checkHeldoutLeakage` scans a corpus (normalized the same way) for either
 *     the fixture's full text (content leak — survives reformatting) or its
 *     fixture id (reference leak, e.g. a few-shot selector keyed by id).
 *   - `loadLeakageCorpus` defines WHAT counts as a corpus: committed tuning /
 *     training JSONL under `training-data/`, and the prompt-building AI sources
 *     under `src/ai/` (providers own the extraction prompts + few-shot blocks).
 *     The golden dataset module itself, its manifest, this module, and tests
 *     are excluded — they legitimately contain the fixtures.
 *
 * Wired into: the vitest suite (heldout-leakage.test.ts) and the AI-02 eval
 * gate runner (run-pe-gates.ts `--dataset s3`), both fail-closed.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface HeldoutFixtureLike {
  id: string;
  strippedText: string;
  tags: string[];
}

export interface CorpusFile {
  /** Path (repo/worker-relative preferred) — used in violation reports only. */
  path: string;
  content: string;
}

export interface LeakageViolation {
  fixtureId: string;
  corpusFile: string;
  kind: 'content' | 'id';
}

/** Lowercase + collapse all whitespace runs to single spaces. */
export function normalizeForLeakageScan(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SHA-256 fingerprint of the normalized fixture text (hex). */
export function fingerprintFixtureText(text: string): string {
  return createHash('sha256').update(normalizeForLeakageScan(text), 'utf-8').digest('hex');
}

/**
 * Scan a corpus for held-out fixture leakage. A violation is either:
 *  - `content`: the fixture's full normalized text appears as a substring of a
 *    normalized corpus file (robust to JSON escaping-free reformats, casing,
 *    and whitespace churn), or
 *  - `id`: the fixture id string appears anywhere in a corpus file.
 */
export function checkHeldoutLeakage(
  heldOutEntries: readonly HeldoutFixtureLike[],
  corpus: readonly CorpusFile[],
): LeakageViolation[] {
  const violations: LeakageViolation[] = [];
  const normalizedFixtures = heldOutEntries.map((entry) => ({
    id: entry.id,
    normalizedText: normalizeForLeakageScan(entry.strippedText),
  }));

  for (const file of corpus) {
    const normalizedContent = normalizeForLeakageScan(file.content);
    for (const fixture of normalizedFixtures) {
      if (fixture.normalizedText.length > 0 && normalizedContent.includes(fixture.normalizedText)) {
        violations.push({ fixtureId: fixture.id, corpusFile: file.path, kind: 'content' });
      }
      if (file.content.includes(fixture.id)) {
        violations.push({ fixtureId: fixture.id, corpusFile: file.path, kind: 'id' });
      }
    }
  }
  return violations;
}

/** File extensions considered part of a scannable corpus. */
const CORPUS_EXTENSIONS = ['.jsonl', '.json', '.ts', '.txt', '.md'];

/**
 * EXACT worker-root-relative paths that legitimately contain the held-out
 * fixtures (or the leakage mechanism itself) and must not self-match.
 * Round-1 review hardening: exact paths, NOT substrings — a substring rule
 * would silently skip any OTHER file that merely mentions the dataset name
 * (e.g. a few-shot module named after it), which is exactly the leak this
 * check exists to catch. Build-output mirrors are excluded by the walk
 * (node_modules/dist are skipped).
 */
const SELF_EXCLUSION_EXACT_PATHS = new Set([
  'src/ai/eval/golden-dataset-cpe-cle-s3.ts',
  'src/ai/eval/cpe-cle-s3-manifest.json',
  'src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
  'src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
  'src/ai/eval/golden-dataset-s33-ood-negatives.ts',
  'src/ai/eval/heldout-leakage.ts',
]);

/**
 * Is this worker-root-relative path a legitimate self-exclusion? Exact-path
 * matches plus test files (tests assert ON the fixtures, so they contain
 * them by design).
 */
export function isLeakageSelfExclusion(
  relPath: string,
  additionalExactPaths: ReadonlySet<string> = new Set(),
): boolean {
  const posixPath = relPath.split('\\').join('/');
  return SELF_EXCLUSION_EXACT_PATHS.has(posixPath)
    || additionalExactPaths.has(posixPath)
    || posixPath.endsWith('.test.ts');
}

function walk(dir: string, out: string[], failOnUnreadable = false): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (failOnUnreadable) throw new Error(`Cannot enumerate leakage-corpus directory ${dir}`, { cause: error });
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch (error) {
      if (failOnUnreadable) throw new Error(`Cannot stat leakage-corpus path ${full}`, { cause: error });
      continue;
    }
    if (stats.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out, failOnUnreadable);
    } else if (CORPUS_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
}

/**
 * Load the leakage-scan corpus for the worker package:
 *   - `training-data/**` — committed tuning/fixture corpora (JSONL etc.)
 *   - `src/ai/**` — provider prompt builders, few-shot blocks, tuning exporters,
 *     and eval datasets OTHER than the S3 set itself.
 *   - `scripts/**` — CLI tooling (prompt exporters, training-data generators)
 *     that could equally embed a fixture (round-1 review hardening).
 *
 * @param workerRoot absolute path to `services/worker`
 */
export function loadLeakageCorpus(
  workerRoot: string,
  options: Readonly<{
    failOnUnreadable?: boolean;
    additionalExactSelfExclusions?: readonly string[];
  }> = {},
): CorpusFile[] {
  const roots = [
    join(workerRoot, 'training-data'),
    join(workerRoot, 'src', 'ai'),
    join(workerRoot, 'scripts'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    walk(root, files, options.failOnUnreadable === true);
  }
  const corpus: CorpusFile[] = [];
  const additionalExactPaths = new Set(
    (options.additionalExactSelfExclusions ?? []).map((path) => path.split('\\').join('/')),
  );
  for (const file of files) {
    const rel = relative(workerRoot, file);
    if (isLeakageSelfExclusion(rel, additionalExactPaths)) continue;
    try {
      corpus.push({ path: rel, content: readFileSync(file, 'utf-8') });
    } catch (error) {
      if (options.failOnUnreadable === true) {
        throw new Error(`Cannot read leakage-corpus file ${file}`, { cause: error });
      }
      // Unreadable file — skip; checkS3LeakagePrecondition and the test-suite
      // sanity assertions fail closed if the corpus ends up empty.
    }
  }
  return corpus;
}
