#!/usr/bin/env tsx
/**
 * check-doc-pointers.ts
 *
 * Every repo-relative path cited by the always-loaded governance docs must
 * resolve on disk.
 *
 * Why this exists: pointer rot is the single most-repeated defect found in the
 * 2026-08-02 harness audit. CLAUDE.md cited `memory/feedback_*.md` files that
 * did not exist; a hook's own deny message told the reader to consult a file
 * that had been deleted; and skills' `## Related` footers resolved at roughly a
 * 1-in-4 rate. None of it was detectable by review, because a dead pointer
 * looks exactly like a live one.
 *
 * Fixing the pointers once does not stop the class. A check does.
 *
 * Scope is deliberately narrow — the documents an agent is REQUIRED to read,
 * where a bad pointer sends it somewhere that does not exist at the moment it
 * is trying to follow a rule.
 *
 * 2026-08-31 widening. The original scan set stopped at the repo-root docs and
 * missed two surfaces that are just as load-bearing:
 *
 *   - **Nested `agents.md`.** CLAUDE.md §0.1 step 5 makes the `agents.md` of any
 *     folder you are about to edit required reading, so a dead pointer there
 *     fails in exactly the situation this check exists for. 218 of them were
 *     invisible.
 *   - **`.github/workflows/*.yml` comments.** A CI gate's comment block is where
 *     the reason for the gate lives; `ci.yml` cited a `memory/` file that never
 *     existed in the repo, and nothing could see it.
 *
 * Both were found by hand while working on something else — the failure mode
 * this script was written to end.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Sonar typescript:S4036 — resolve `git` to a FIXED absolute path rather than a
// bare name the OS looks up on `$PATH`, where a writable entry could shadow the
// real binary. `/usr/bin/git` is the GitHub-hosted Ubuntu runner path; the env
// override covers self-hosted runners and local dev (Homebrew's
// `/opt/homebrew/bin/git`). Mirrors the GIT_BIN convention in
// scripts/ci/lib/ciContext.ts, defined locally so this gate keeps its
// no-dependency posture and can run in a shallow-checkout job.
const GIT_BIN = process.env.GIT_BIN ?? '/usr/bin/git';

export interface ScannedDoc {
  doc: string;
  content: string;
}

export interface Miss {
  doc: string;
  line: number;
  path: string;
}

export interface Exemption {
  doc: string;
  path: string;
  reason: string;
}

export interface AuditOptions {
  repoRoot: string;
  /** Injected so the unit tests never touch the working tree. */
  exists: (absolutePath: string) => boolean;
  exemptions?: Exemption[];
}

export interface AuditResult {
  ok: boolean;
  misses: Miss[];
  checked: number;
}

export const EXEMPTIONS_PATH = 'scripts/ci/snapshots/doc-pointer-exemptions.json';

function gitLsFiles(repoRoot: string, ...patterns: string[]): string[] {
  return execFileSync(GIT_BIN, ['ls-files', ...patterns], { encoding: 'utf8', cwd: repoRoot })
    .trim()
    .split('\n')
    .filter(Boolean);
}

/**
 * Recursive walk in-process — deliberately not `find(1)`. These trees include
 * UNTRACKED files by design (a hook or skill added locally still gets scanned),
 * so `git ls-files` would be wrong here, and shelling out only re-opens the
 * `$PATH` question GIT_BIN exists to close.
 */
function findFiles(repoRoot: string, dir: string, matches: (name: string) => boolean): string[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && matches(entry.name)) out.push(relative(repoRoot, child));
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Docs whose pointers must all resolve: the normative set an agent is required
 * to read, plus the hooks, whose deny messages tell a blocked agent what to go
 * read next, plus the per-folder `agents.md` notes and the workflow files whose
 * comments explain why each gate exists.
 *
 * HANDOFF.md is deliberately NOT scanned. Its `## History` section is an
 * append-only log of what was true on a given date; a path cited there can be
 * legitimately dead today because the thing was later deleted. Rewriting
 * historical entries to satisfy a linter would corrupt the record — the exact
 * opposite of what this check is for.
 *
 * `docs/**` is excluded for the same reason: release runbooks, soak premortems
 * and RC manifests are dated narrative, not standing instructions. They carry
 * ~120 pointers that are dead by design because the run they describe is over.
 */
export function collectScannedDocs(repoRoot: string): string[] {
  return [
    'CLAUDE.md',
    'AGENTS.md',
    ...findFiles(repoRoot, '.claude/skills', (n) => n === 'SKILL.md'),
    ...findFiles(repoRoot, '.claude/hooks', (n) => n.endsWith('.sh')),
    ...findFiles(repoRoot, 'memory', (n) => n.endsWith('.md')),
    // Tracked-file listings, not `find`: `agents.md` exists under node_modules.
    ...gitLsFiles(repoRoot, '*agents.md', 'agents.md').filter((p) => p !== 'AGENTS.md'),
    ...gitLsFiles(repoRoot, '.github/workflows/*.yml', '.github/workflows/*.yaml'),
  ];
}

export function readScannedDocs(repoRoot: string): ScannedDoc[] {
  return collectScannedDocs(repoRoot)
    .filter((doc) => existsSync(join(repoRoot, doc)))
    .map((doc) => ({ doc, content: readFileSync(join(repoRoot, doc), 'utf8') }));
}

export function loadExemptions(repoRoot: string): Exemption[] {
  const abs = join(repoRoot, EXEMPTIONS_PATH);
  if (!existsSync(abs)) return [];
  return JSON.parse(readFileSync(abs, 'utf8')).exemptions as Exemption[];
}

/**
 * Where a cited path may legitimately resolve from, most-specific first.
 *
 * A folder-local `agents.md` writes paths the way its own readers do:
 * `packages/verifier-cli/agents.md` says `src/cli.ts` and means its own `src/`,
 * while `services/worker/src/api/v1/agents.md` says `src/api/_org-auth.ts` and
 * means the worker package root. Resolving repo-root-only reported 59 of those
 * as dead when every one of them is a live, correctly-written reference.
 */
export function resolutionBases(repoRoot: string, doc: string): string[] {
  const bases = [join(repoRoot, dirname(doc))];
  let dir = dirname(doc);
  while (dir && dir !== '.' && dir !== '/') {
    const isPackageRoot =
      existsSync(join(repoRoot, dir, 'package.json')) ||
      existsSync(join(repoRoot, dir, 'pyproject.toml'));
    if (isPackageRoot && !bases.includes(join(repoRoot, dir))) bases.push(join(repoRoot, dir));
    dir = dirname(dir);
  }
  if (!bases.includes(repoRoot)) bases.push(repoRoot);
  return bases;
}

/**
 * Path-shaped tokens we care about. Anchored on directories that actually
 * exist in this repo, so prose like "see the memory corpus" is not mistaken
 * for a path and a URL fragment is never treated as a file.
 */
const PATH_PREFIXES = [
  'memory/',
  'docs/',
  'scripts/',
  'machines/',
  'supabase/',
  '.github/',
  '.claude/',
  'services/',
  'src/',
  'e2e/',
  'packages/',
];

/**
 * The subset asserted inside workflow YAML comments. A workflow step runs under
 * a `working-directory:`, so a comment near it says `src/lib/safe-fetch.ts` and
 * means `services/worker/src/lib/safe-fetch.ts` — correct in context and
 * unresolvable from the file's own location. Governance prefixes carry no such
 * ambiguity: `memory/x.md` is repo-root-relative wherever it is written.
 */
const WORKFLOW_PREFIXES = ['memory/', 'docs/', '.claude/', '.github/'];

/** Extensions worth asserting. A bare directory reference is also allowed. */
function candidateRe(prefixes: string[]): RegExp {
  return new RegExp(
    String.raw`(?:^|[\s(\[\`"'|])(` +
      prefixes.map((p) => p.replace(/[.]/g, '\\.')).join('|') +
      String.raw`)([A-Za-z0-9._/*-]*)`,
    'g',
  );
}

const MARKDOWN_CANDIDATE = candidateRe(PATH_PREFIXES);
const WORKFLOW_CANDIDATE = candidateRe(WORKFLOW_PREFIXES);

const isWorkflow = (doc: string): boolean =>
  doc.startsWith('.github/workflows/') && /\.ya?ml$/.test(doc);

/** Punctuation markdown prose glues onto the end of an inline path. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', ')', ']', '`', "'", '"']);

/** In workflow YAML only comment lines are prose; everything else is config. */
const isYamlComment = (line: string): boolean => line.trimStart().startsWith('#');

export function auditDocPointers(docs: ScannedDoc[], opts: AuditOptions): AuditResult {
  const { repoRoot, exists } = opts;
  const exempt = new Set((opts.exemptions ?? []).map((e) => `${e.doc}|${e.path}`));
  const misses: Miss[] = [];
  let checked = 0;

  for (const { doc, content } of docs) {
    const workflow = isWorkflow(doc);
    const candidate = workflow ? WORKFLOW_CANDIDATE : MARKDOWN_CANDIDATE;
    const bases = resolutionBases(repoRoot, doc);
    const resolves = (p: string): boolean => bases.some((b) => exists(resolve(b, p)));

    content.split('\n').forEach((rawLine, idx) => {
      if (workflow && !isYamlComment(rawLine)) return;

      // Strip inline code fences' backticks but keep content; skip URLs entirely.
      const line = rawLine.replace(/https?:\/\/\S+/g, ' ');

      candidate.lastIndex = 0;
      for (const m of line.matchAll(candidate)) {
        let p = `${m[1]}${m[2] ?? ''}`;

        // Trim trailing punctuation that markdown prose glues onto a path.
        // Character-set loop, not `/[...]+$/`: the anchored-quantifier form
        // backtracks super-linearly on a long non-matching tail (Sonar S8786).
        while (p.length > 0 && TRAILING_PUNCTUATION.has(p[p.length - 1]!)) {
          p = p.slice(0, -1);
        }
        if (!p || p.endsWith('/')) continue;

        // Globs and placeholders are intentional, not assertions about one file.
        if (/[*]|NNNN|<|\$\{/.test(p)) continue;

        // Illustrative stand-ins, e.g. a comment contrasting `<repo>/docs/x.md`
        // with `docs/x.md`. A single-character basename is never a real file
        // here, and demanding one would push authors toward vaguer comments.
        if (/(^|\/)[A-Za-z]\.[A-Za-z0-9]+$/.test(p)) continue;

        // Only assert things that look like a file (have an extension) or an
        // existing directory. Bare words like `docs` alone are prose.
        const hasExt = /\.[A-Za-z0-9]+$/.test(p);
        if (!hasExt && !resolves(p)) continue;

        if (exempt.has(`${doc}|${p}`)) continue;

        checked += 1;
        if (!resolves(p)) misses.push({ doc, line: idx + 1, path: p });
      }
    });
  }

  // Deduplicate: the same dead path cited twice is one defect to fix.
  const seen = new Set<string>();
  const unique = misses.filter((x) => {
    const k = `${x.doc}:${x.line}:${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: unique.length === 0, misses: unique, checked };
}

function main(): void {
  const repoRoot = execFileSync(GIT_BIN, ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  const { ok, misses, checked } = auditDocPointers(readScannedDocs(repoRoot), {
    repoRoot,
    exists: existsSync,
    exemptions: loadExemptions(repoRoot),
  });

  if (ok) {
    console.log(`check-doc-pointers: OK — ${checked} path references resolve.`);
    return;
  }

  console.error(`check-doc-pointers: ${misses.length} dead pointer(s) out of ${checked} references.\n`);
  const byDoc = new Map<string, Miss[]>();
  for (const m of misses) {
    if (!byDoc.has(m.doc)) byDoc.set(m.doc, []);
    byDoc.get(m.doc)!.push(m);
  }
  for (const [doc, items] of byDoc) {
    console.error(`  ${doc}`);
    for (const i of items) console.error(`    line ${i.line}: ${i.path}`);
  }
  console.error(
    `\nEither create the file or remove the reference. A rule that points at a
missing file is worse than no rule: it fails at the exact moment someone is
trying to comply with it.

A path that is deliberately absent (a negative example, a generated artifact,
a file a command writes) belongs in ${EXEMPTIONS_PATH} with a reason.`,
  );
  process.exit(1);
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
