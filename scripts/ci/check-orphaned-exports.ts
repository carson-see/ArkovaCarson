#!/usr/bin/env -S npx tsx
/**
 * Orphaned-export lint (SCRUM-3032 / SCRUM-3033 / SCRUM-3034, CTO ruling R14,
 * 2026-07-28 ratified sprint plan, Wave 0 item G3).
 *
 * Twice now a feature shipped its hook/data-layer with ZERO non-test UI
 * importers and passed every gate (folders #1657, CTDL #1603) — green CI and
 * a green soak are not the same thing as "a user can reach this code".
 *
 * Scans exported React hooks (`src/hooks/**`) and components
 * (`src/components/**`) and flags exports whose only importers are:
 *   - test files (`*.test.*`, `*.spec.*`)
 *   - Storybook files (`*.stories.*`)
 *   - the defining file itself
 *
 * Handles:
 *   - barrel files — a re-export (`export { X } from './x'` / `export * from
 *     './x'`) only counts as real usage if the BARREL ITSELF is, in turn,
 *     imported by real (non-test) code — traced transitively through nested
 *     barrels.
 *   - dynamic imports — `import('...')` anywhere in a file (including inside
 *     `React.lazy(() => import(...))` or a `.then(m => ...)` chain) counts as
 *     a real import of every export in the target module (conservative — we
 *     do not attempt to resolve which named export a `.then()` callback
 *     actually reads).
 *   - route-registered components — no special-casing needed: `src/lib/
 *     routes.ts` and router files (e.g. `src/App.tsx`) are just ordinary
 *     source files in the same scan, so a component reached only via a
 *     router's lazy `import(...)` is picked up by the dynamic-import handling
 *     above.
 *
 * Per CTO ruling R14: FAIL-CLOSED only for exports NEWLY introduced in the PR
 * diff (compared against the merge-base with `origin/main`); pre-existing
 * orphans are WARN-only, with the full inventory always printed so the
 * existing debt is visible.
 *
 * "New" is decided by export IDENTITY (name + kind) against the MERGE-BASE
 * version of the same file (or its pre-rename path, via `git diff
 * --find-renames`) — NOT by whether the declaration's line number falls in
 * the diff's added-line set. An earlier line-position-based implementation
 * mis-scored two cases, both fixed here (adversarial review, PR #1723,
 * 2026-07-28): (1) a purely cosmetic reformat of an existing orphan's
 * declaration line (e.g. whitespace-only edits) shifts which line the
 * declaration starts on with zero behavior/importer change, which flipped
 * pre-existing debt into a false hard failure; (2) a file rename/move showed
 * as 100% "added" content under a plain `git diff` with no rename detection,
 * which would have misclassified that file's exports as new. See
 * `exportIdentityKey` / `buildMergeBaseExportIndex` / `classifyOrphans`.
 *
 * Known limitations (documented rather than silently wrong):
 *   - Only exported `function`/`const`/`class` declarations are treated as
 *     candidate hooks/components — anonymous default exports
 *     (`export default () => ...`) are not classified.
 *   - `export * as ns from './x'` is treated the same as `export * from
 *     './x'` (a conservative widening: any real import of the barrel counts
 *     as usage of everything `x` exports).
 *   - A local `import { X } from './x'; export { X };` two-step re-export
 *     (as opposed to the single-statement `export { X } from './x'` barrel
 *     form used throughout this repo) is not traced.
 *   - `isComponentLikeInitializer`'s PascalCase-name + CallExpression-
 *     initializer heuristic can sweep in non-components that happen to match
 *     both shapes — e.g. `export const FooContext = createContext(...)` or a
 *     PascalCase Zod schema built via `z.object(...)`. Harmless when the
 *     binding is genuinely imported somewhere (it's simply never flagged as
 *     orphaned); latent false-positive surface if such a binding is ever
 *     legitimately unused, since it would print as an "orphaned component"
 *     rather than being excluded outright.
 *   - INVERSE GAP (known, not closed by this revision): if a PR deletes the
 *     last real importer of an EXISTING hook/component without touching that
 *     hook's own file, the export becomes newly unreachable but is only ever
 *     classified pre-existing (WARN), never fail-closed — this gate compares
 *     export IDENTITY against the merge base, not REACHABILITY against the
 *     merge base. Closing it requires reconstructing the full import graph
 *     at the merge base (every file under `src/hooks` + `src/components`,
 *     not just the ones touched by the diff) to detect a reachable-at-base /
 *     unreachable-at-head transition — materially more scope than the
 *     identity fix above, and out of scope for this time-critical PR per CTO
 *     ruling; tracked as a follow-up rather than attempted here.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { GIT_BIN, REPO, getBaseRef, isMainModule } from './lib/ciContext.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ExportKind = 'hook' | 'component';

export interface DiscoveredExport {
  file: string; // repo-relative posix path, e.g. src/hooks/useFoo.ts
  name: string; // exported binding name
  kind: ExportKind;
  line: number; // 1-based line of the export statement
}

/** 'ALL' = namespace import / dynamic import / `export * from`. Otherwise a
 * map from "name as exposed by the target" to "name exposed onward by this
 * statement" (only meaningful for `reexport` edges, used to recurse through
 * barrel chains with the correct alias). */
export type Bindings = 'ALL' | ReadonlyMap<string, string>;

export interface ImportEdge {
  from: string; // importer file (repo-relative)
  to: string; // resolved target file (repo-relative)
  bindings: Bindings;
  kind: 'import' | 'reexport';
}

export interface RepoGraph {
  exports: DiscoveredExport[];
  edges: ImportEdge[];
}

export interface OrphanFinding extends DiscoveredExport {
  isNew: boolean;
}

// ─── Path predicates ────────────────────────────────────────────────────────

const TEST_OR_STORY_RE = /\.(test|spec|stories)\.[cm]?[jt]sx?$/;

export function isTestOrStorybookFile(path: string): boolean {
  return TEST_OR_STORY_RE.test(path);
}

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

export function isHookFile(path: string): boolean {
  return path.startsWith('src/hooks/') && SOURCE_EXT_RE.test(path) && !isTestOrStorybookFile(path);
}

export function isComponentFile(path: string): boolean {
  return (
    path.startsWith('src/components/') && SOURCE_EXT_RE.test(path) && !isTestOrStorybookFile(path)
  );
}

// ─── AST parsing helpers ────────────────────────────────────────────────────

function scriptKindFor(path: string): ts.ScriptKind {
  return path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(repoRelPath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(repoRelPath, text, ts.ScriptTarget.ES2022, true, scriptKindFor(repoRelPath));
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods !== undefined && mods.some((m) => m.kind === kind);
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

const SCREAMING_SNAKE_CASE_RE = /^[A-Z][A-Z0-9_]*$/;

/** `export const Foo = (...) => ...` / `React.forwardRef(...)` / `memo(...)`
 * — anything that looks like a component factory. Excludes plain object/array
 * literals (`export const ICONS = {...}`) so those are never misclassified
 * as an orphaned "component". */
function isComponentLikeInitializer(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  return ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init);
}

/** Candidate hook/component exports DECLARED in this file (function/const/
 * class). Re-exports (`export { X } from ...`) are handled separately as
 * graph edges, not as candidates — the defining file is where `X` is a
 * candidate. */
export function collectDeclaredExports(
  source: ts.SourceFile,
  repoRelPath: string,
  kindForFile: ExportKind | null,
): DiscoveredExport[] {
  if (!kindForFile) return [];
  const out: DiscoveredExport[] = [];
  const namePattern = kindForFile === 'hook' ? /^use[A-Z0-9_]/ : /^[A-Z]/;

  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const name = stmt.name.text;
      if (namePattern.test(name)) {
        out.push({ file: repoRelPath, name, kind: kindForFile, line: lineOf(source, stmt.getStart(source)) });
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const name = stmt.name.text;
      if (namePattern.test(name)) {
        out.push({ file: repoRelPath, name, kind: kindForFile, line: lineOf(source, stmt.getStart(source)) });
      }
      continue;
    }
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (!namePattern.test(name)) continue;
        if (kindForFile === 'component') {
          // SCREAMING_SNAKE_CASE constants (e.g. `WEBHOOK_EVENT_CATALOG`) match
          // the PascalCase name pattern's first-letter test but are data, not
          // components — real component names are mixed-case.
          if (SCREAMING_SNAKE_CASE_RE.test(name)) continue;
          if (!isComponentLikeInitializer(decl.initializer)) continue;
        }
        out.push({ file: repoRelPath, name, kind: kindForFile, line: lineOf(source, stmt.getStart(source)) });
      }
    }
  }
  return out;
}

interface RawImportInfo {
  specifier: string;
  bindings: Bindings;
  kind: 'import' | 'reexport';
}

/** Every static import/export-from declaration at the top level, plus every
 * `import(...)` dynamic-import call anywhere in the file (arbitrarily
 * nested — this is what makes `React.lazy(() => import(...))` fall out of
 * the same code path with no special-casing). */
export function collectRawImports(source: ts.SourceFile): RawImportInfo[] {
  const out: RawImportInfo[] = [];

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) continue; // side-effect-only import: `import './x'`
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        out.push({ specifier, bindings: 'ALL', kind: 'import' });
        continue;
      }
      const bindings = new Map<string, string>();
      if (clause.name) bindings.set('default', clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          bindings.set((el.propertyName ?? el.name).text, el.name.text);
        }
      }
      if (bindings.size > 0) out.push({ specifier, bindings, kind: 'import' });
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      if (!stmt.exportClause || ts.isNamespaceExport(stmt.exportClause)) {
        // `export * from '...'` or `export * as ns from '...'` — forwards
        // every name unchanged (namespace-aliased re-export is treated the
        // same, conservatively; see module doc "Known limitations").
        out.push({ specifier, bindings: 'ALL', kind: 'reexport' });
        continue;
      }
      const bindings = new Map<string, string>();
      for (const el of stmt.exportClause.elements) {
        bindings.set((el.propertyName ?? el.name).text, el.name.text);
      }
      out.push({ specifier, bindings, kind: 'reexport' });
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        out.push({ specifier: arg.text, bindings: 'ALL', kind: 'import' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return out;
}

// ─── Specifier resolution ───────────────────────────────────────────────────

const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Resolve an import specifier written by `repoRelImporter` to a repo-relative
 * file path present in `fileSet`, or `null` for a bare/node_modules specifier
 * or one that cannot be resolved to a file we scanned. */
export function specifierResolvedPath(
  repoRelImporter: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = toPosix(join(dirname(repoRelImporter), specifier));
  } else if (specifier.startsWith('@/')) {
    base = toPosix(join('src', specifier.slice(2)));
  } else {
    return null; // bare / node_modules specifier — out of scope
  }
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function buildEdgesForFile(
  repoRelPath: string,
  raw: readonly RawImportInfo[],
  fileSet: ReadonlySet<string>,
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const r of raw) {
    const resolved = specifierResolvedPath(repoRelPath, r.specifier, fileSet);
    if (!resolved) continue;
    edges.push({ from: repoRelPath, to: resolved, bindings: r.bindings, kind: r.kind });
  }
  return edges;
}

// ─── Graph construction ─────────────────────────────────────────────────────

/** Pure: given a map of repo-relative-path -> source text (the whole `src/`
 * tree in production, an in-memory fixture in tests), builds the candidate
 * export list and the full import/re-export/dynamic-import edge graph. */
export function buildRepoGraph(files: ReadonlyMap<string, string>): RepoGraph {
  const fileSet = new Set(files.keys());
  const exports: DiscoveredExport[] = [];
  const edges: ImportEdge[] = [];

  for (const [path, text] of files) {
    let source: ts.SourceFile;
    try {
      source = parseSource(path, text);
    } catch (error) {
      // Unparseable file — skip rather than crash the whole gate, but make
      // the skip VISIBLE in CI logs rather than silent (a silently-skipped
      // file could hide a real orphan or a real importer edge).
      console.warn(`::warning::orphaned-exports: failed to parse ${path}, skipping (${String(error)}).`);
      continue;
    }

    const kindForFile: ExportKind | null = isHookFile(path)
      ? 'hook'
      : isComponentFile(path)
        ? 'component'
        : null;
    if (kindForFile) {
      exports.push(...collectDeclaredExports(source, path, kindForFile));
    }

    edges.push(...buildEdgesForFile(path, collectRawImports(source), fileSet));
  }

  return { exports, edges };
}

// ─── Reachability ───────────────────────────────────────────────────────────

/** Is `exportName` from `targetFile` reachable from at least one real
 * (non-test, non-storybook, non-self) importer — directly, or transitively
 * through barrel re-exports? */
export function isReachable(
  edges: readonly ImportEdge[],
  targetFile: string,
  exportName: string,
  visited: Set<string> = new Set(),
): boolean {
  const key = `${targetFile} ${exportName}`;
  if (visited.has(key)) return false;
  visited.add(key);

  for (const edge of edges) {
    if (edge.to !== targetFile || edge.from === targetFile) continue;

    if (edge.bindings === 'ALL') {
      if (edge.kind === 'import') {
        if (!isTestOrStorybookFile(edge.from)) return true;
        continue;
      }
      if (isReachable(edges, edge.from, exportName, visited)) return true;
      continue;
    }

    const exposedAs = edge.bindings.get(exportName);
    if (exposedAs === undefined) continue;

    if (edge.kind === 'import') {
      if (!isTestOrStorybookFile(edge.from)) return true;
      continue;
    }
    if (isReachable(edges, edge.from, exposedAs, visited)) return true;
  }
  return false;
}

// ─── Diff scoping (fail-closed only for NEW exports, R14) ──────────────────
//
// See the module doc comment above for why this is IDENTITY-based (export
// name + kind, resolved against the merge-base version of the file / its
// pre-rename path) rather than POSITION-based (declaration line number).

/** "hook:useFoo" / "component:Foo" — the identity used to ask "did an export
 * with this name and kind already exist, for this file's identity, at the
 * merge base?" Hooks and components live in disjoint directories in
 * practice, but the kind is included in the key regardless so a same-named
 * hook and component are never conflated. */
export function exportIdentityKey(name: string, kind: ExportKind): string {
  return `${kind}:${name}`;
}

/** Unreachable candidate exports (per `isReachable`) — the pool
 * `classifyOrphans` splits into new vs. pre-existing. Pulled out as its own
 * step so callers only need to fetch merge-base content for the (typically
 * small) set of files that actually have a candidate, not the whole
 * `src/hooks` + `src/components` tree. */
export function findOrphanCandidates(
  exports: readonly DiscoveredExport[],
  edges: readonly ImportEdge[],
): DiscoveredExport[] {
  return exports.filter((exp) => !isReachable(edges, exp.file, exp.name));
}

/** Parses `git diff --find-renames --name-status <base>..HEAD` output into a
 * map of current-path -> merge-base (pre-rename) path, for the `R<score>`
 * rename lines only. Pure — takes the text directly so it is testable
 * without shelling out to git. */
export function parseRenameMap(nameStatusText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of nameStatusText.split('\n')) {
    if (!line.startsWith('R')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [, oldPath, newPath] = parts;
    if (!oldPath || !newPath) continue;
    map.set(newPath, oldPath);
  }
  return map;
}

/** Given merge-base file contents (identity-path -> source text, for exactly
 * the file identities the current orphan candidates resolve to), builds the
 * set of export identities (`exportIdentityKey`) that already existed, per
 * file, at the merge base. Reuses `collectDeclaredExports` so "what counts
 * as a candidate export" can never drift between the current-tree scan and
 * this merge-base comparison. */
export function buildMergeBaseExportIndex(
  files: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [path, text] of files) {
    let source: ts.SourceFile;
    try {
      source = parseSource(path, text);
    } catch {
      continue; // unparseable at the merge base — treat as "no prior exports" (fails closed, not open)
    }
    const kindForFile: ExportKind | null = isHookFile(path)
      ? 'hook'
      : isComponentFile(path)
        ? 'component'
        : null;
    if (!kindForFile) continue;
    const set = new Set<string>();
    for (const d of collectDeclaredExports(source, path, kindForFile)) {
      set.add(exportIdentityKey(d.name, d.kind));
    }
    index.set(path, set);
  }
  return index;
}

/** Classify orphan CANDIDATES (already filtered to "no real importer" via
 * `findOrphanCandidates`) as new (no export of the same name+kind existed,
 * at the merge base, under the file's identity — fail-closed, R14) or
 * pre-existing (warn-only). `renameMap` maps a current path to its merge-base
 * identity path for files git detected as renamed/moved (`parseRenameMap`);
 * a file absent from it uses its own current path as the identity. Robust to
 * both pure reformatting (identity is unchanged even though the line moves)
 * and file moves (identity resolves through the rename map). */
export function classifyOrphans(
  candidates: readonly DiscoveredExport[],
  mergeBaseExports: ReadonlyMap<string, ReadonlySet<string>>,
  renameMap: ReadonlyMap<string, string> = new Map(),
): OrphanFinding[] {
  return candidates.map((exp) => {
    const identityFile = renameMap.get(exp.file) ?? exp.file;
    const existedAtMergeBase =
      mergeBaseExports.get(identityFile)?.has(exportIdentityKey(exp.name, exp.kind)) ?? false;
    return { ...exp, isNew: !existedAtMergeBase };
  });
}

// ─── Filesystem walking (impure — production wiring only) ──────────────────

const SCAN_EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const SCAN_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

function tryReaddir(absDir: string) {
  try {
    return readdirSync(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function listSourceFiles(absDir: string, repoRoot: string, out: string[]): void {
  const entries = tryReaddir(absDir);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      listSourceFiles(join(absDir, entry.name), repoRoot, out);
      continue;
    }
    if (!SCAN_FILE_RE.test(entry.name)) continue;
    out.push(toPosix(relative(repoRoot, join(absDir, entry.name))));
  }
}

export function loadFileMap(repoRoot: string): Map<string, string> {
  const files: string[] = [];
  listSourceFiles(join(repoRoot, 'src'), repoRoot, files);
  const map = new Map<string, string>();
  for (const f of files) {
    map.set(f, readFileSync(join(repoRoot, f), 'utf8'));
  }
  return map;
}

function resolveMergeBaseSha(): string {
  const base = getBaseRef({ required: true })!;
  try {
    return execFileSync(GIT_BIN, ['merge-base', base, 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return base; // shallow history / unmerged base — fall back to the base ref itself
  }
}

/** `git diff --find-renames --name-status` between the merge base and HEAD,
 * parsed into a current-path -> pre-rename-path map. Without `--find-renames`
 * a moved file shows as 100% added content and its exports would otherwise
 * be misclassified as new (see module doc comment). On any git failure, warn
 * and return an empty map — a moved orphan may then misclassify as new,
 * which is the fail-CLOSED direction (extra warn-only noise avoided, never
 * silently suppressing a real new orphan). */
function gitRenameMap(mergeBaseSha: string): Map<string, string> {
  if (!existsSync(join(REPO, 'src', 'hooks')) && !existsSync(join(REPO, 'src', 'components'))) {
    return new Map();
  }
  try {
    const text = execFileSync(
      GIT_BIN,
      [
        'diff',
        '--find-renames',
        '--name-status',
        '--no-color',
        `${mergeBaseSha}..HEAD`,
        '--',
        'src/hooks',
        'src/components',
      ],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return parseRenameMap(text);
  } catch (error) {
    console.warn(
      `::warning::orphaned-exports: could not compute rename detection (${String(error)}); ` +
        'proceeding without it (a moved orphan file could misclassify as new — safe/fail-closed direction).',
    );
    return new Map();
  }
}

/** Fetches merge-base content for exactly the file identities the current
 * orphan candidates need (via `git show <sha>:<path>`) — bounded by the
 * (typically small) orphan count, not the full hooks/components tree. A
 * path absent from the merge base (new file, or pre-rename path git could
 * not resolve) is simply absent from the returned map; `classifyOrphans`
 * correctly treats that as "no prior exports" (fails closed). */
function loadMergeBaseFileMap(mergeBaseSha: string, identityPaths: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of identityPaths) {
    try {
      const content = execFileSync(GIT_BIN, ['show', `${mergeBaseSha}:${path}`], {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        // "Did not exist at the merge base" is the ORDINARY case for a
        // brand-new file, not a rare failure — silence git's stderr
        // ("fatal: path ... exists on disk, but not in <sha>") so a routine
        // new file doesn't print a scary-looking fatal line in CI logs for
        // an outcome this function already handles correctly via `catch`.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      map.set(path, content);
    } catch {
      // Did not exist at the merge base under this identity path — leave absent.
    }
  }
  return map;
}

function main(): void {
  const files = loadFileMap(REPO);
  const { exports, edges } = buildRepoGraph(files);
  const candidates = findOrphanCandidates(exports, edges);

  const mergeBaseSha = resolveMergeBaseSha();
  const renameMap = gitRenameMap(mergeBaseSha);
  const identityPaths = new Set(candidates.map((c) => renameMap.get(c.file) ?? c.file));
  const mergeBaseFiles = loadMergeBaseFileMap(mergeBaseSha, identityPaths);
  const mergeBaseExports = buildMergeBaseExportIndex(mergeBaseFiles);

  const orphans = classifyOrphans(candidates, mergeBaseExports, renameMap);

  const newOrphans = orphans.filter((o) => o.isNew);
  const preexisting = orphans.filter((o) => !o.isNew);

  console.log(
    `::notice::orphaned-exports: ${exports.length} candidate hook/component export(s) scanned; ` +
      `${orphans.length} orphaned (${newOrphans.length} new, ${preexisting.length} pre-existing).`,
  );

  if (preexisting.length > 0) {
    console.log(
      '--- Pre-existing orphan inventory (WARN-only per CTO ruling R14 — not a merge blocker) ---',
    );
    for (const o of [...preexisting].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`  [pre-existing] ${o.file}:${o.line} ${o.kind} \`${o.name}\` — no real importer found.`);
    }
  }

  if (newOrphans.length > 0) {
    console.error(
      `::error::orphaned-exports: ${newOrphans.length} NEWLY introduced orphaned export(s) ` +
        '(CTO ruling R14 / SCRUM-3032-3034). A new hook or component with zero non-test/non-storybook ' +
        'importers shipped its data layer without UI wiring — the folders #1657 / CTDL #1603 pattern.',
    );
    for (const o of [...newOrphans].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(
        `  [NEW ORPHAN] ${o.file}:${o.line} ${o.kind} \`${o.name}\` — wire it into a real importer, ` +
          'or remove it before merge.',
      );
    }
    process.exit(1);
  }

  console.log('::notice::orphaned-exports: no NEW orphaned exports introduced by this PR.');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error('::error::orphaned-exports check failed to run.');
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}
