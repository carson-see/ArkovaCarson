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
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/**
 * Docs whose pointers must all resolve: the normative set an agent is required
 * to read, plus the hooks, whose deny messages tell a blocked agent what to go
 * read next.
 *
 * HANDOFF.md is deliberately NOT scanned. Its `## History` section is an
 * append-only log of what was true on a given date; a path cited there can be
 * legitimately dead today because the thing was later deleted. Rewriting
 * historical entries to satisfy a linter would corrupt the record — the exact
 * opposite of what this check is for.
 */
const SCANNED: string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  ...globSkills(),
  ...globHooks(),
  ...globMemory(),
];

function globMemory(): string[] {
  const dir = join(REPO_ROOT, 'memory');
  if (!existsSync(dir)) return [];
  return execFileSync('find', [dir, '-name', '*.md'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(REPO_ROOT.length + 1));
}

function globHooks(): string[] {
  const dir = join(REPO_ROOT, '.claude/hooks');
  if (!existsSync(dir)) return [];
  return execFileSync('find', [dir, '-name', '*.sh'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(REPO_ROOT.length + 1));
}

function globSkills(): string[] {
  const dir = join(REPO_ROOT, '.claude/skills');
  if (!existsSync(dir)) return [];
  return execFileSync('find', [dir, '-name', 'SKILL.md'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(REPO_ROOT.length + 1));
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

/** Extensions worth asserting. A bare directory reference is also allowed. */
const CANDIDATE = new RegExp(
  String.raw`(?:^|[\s(\[\`"'|])(` +
    PATH_PREFIXES.map((p) => p.replace(/[.]/g, '\\.')).join('|') +
    String.raw`)([A-Za-z0-9._/*-]*)`,
  'g',
);

interface Miss {
  doc: string;
  line: number;
  path: string;
}

const misses: Miss[] = [];
let checked = 0;

for (const doc of SCANNED) {
  const abs = join(REPO_ROOT, doc);
  if (!existsSync(abs)) {
    misses.push({ doc: '(scan list)', line: 0, path: doc });
    continue;
  }

  const lines = readFileSync(abs, 'utf8').split('\n');

  lines.forEach((rawLine, idx) => {
    // Strip inline code fences' backticks but keep content; skip URLs entirely.
    const line = rawLine.replace(/https?:\/\/\S+/g, ' ');

    for (const m of line.matchAll(CANDIDATE)) {
      let p = `${m[1]}${m[2] ?? ''}`;

      // Trim trailing punctuation that markdown prose glues onto a path.
      p = p.replace(/[.,;:)\]`'"]+$/, '');
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
      const abs2 = resolve(REPO_ROOT, p);
      if (!hasExt && !existsSync(abs2)) continue;

      checked += 1;
      if (!existsSync(abs2)) {
        misses.push({ doc, line: idx + 1, path: p });
      }
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

if (unique.length === 0) {
  console.log(`check-doc-pointers: OK — ${checked} path references resolve.`);
  process.exit(0);
}

console.error(
  `check-doc-pointers: ${unique.length} dead pointer(s) out of ${checked} references.\n`,
);
const byDoc = new Map<string, Miss[]>();
for (const m of unique) {
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
trying to comply with it.`,
);
process.exit(1);
