#!/usr/bin/env -S npx tsx
/**
 * CE-registry provenance key parity guard.
 *
 * Two INDEPENDENT worker code paths write "CE Registry provenance" metadata
 * onto an `anchors` row:
 *
 *   - `services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts` — the
 *     `ce_registry_ctid`-keyed POC endpoint that anchors a CE Registry record
 *     directly by CTID (migration 0389's partial index exists to serve it).
 *   - `services/worker/src/lib/credential-source-import.ts`
 *     (`extractCeRegistryProvenance`) — the CSI issuer-partnership import
 *     path, stamps provenance when a fetched credential source resolves to a
 *     real CE Registry host.
 *
 * Both are read by exactly ONE consumer: the public `get_public_anchor`
 * projection (currently redefined wholesale by migration 0385 — see that
 * file's own docblock: "get_public_anchor is redefined WHOLESALE by every
 * migration that touches it. There is no partial edit."), whose metadata
 * allow-list does a literal `metadata ->> 'registry_url'` lookup — no
 * COALESCE, no fallback key, no reference to any `ce_`-prefixed variant.
 *
 * THE BUG THIS GUARD EXISTS FOR (already happened once, see PR history):
 * `credentials-ctdl-registry-anchor.ts` stamped `ce_registry_url` (prefixed)
 * for months. The projection only ever read `registry_url` (unprefixed).
 * Every CE-registry-anchored record silently failed to surface its registry
 * link on the public verify page — no error, no test failure, just an
 * `undefined` the UI quietly rendered nothing for. The fix stamped the
 * unprefixed key ADDITIVELY, tied to the projection only by a doc comment.
 * Nothing in the repo mechanically re-checks that tie. That is the same
 * defect class `check-envelope-key-index-parity.ts` exists for (a key and
 * its one true consumer can drift apart the moment either side is edited in
 * isolation) — this guard is that script's shape, applied to this key.
 *
 * WHAT THIS GUARD CHECKS (three checks, any one failing fails the guard):
 *
 *   1. Every FILE in {@link CE_REGISTRY_WRITER_FILES} (the registered writers)
 *      that stamps the CE-provenance marker key `ce_envelope_sha256` as an
 *      object key / interface property ALSO stamps `registry_url` the same
 *      way, somewhere in the same file. `ce_envelope_sha256` is used as the
 *      "this file writes CE-registry provenance" marker rather than an
 *      arbitrary choice: it is the one field both current writers already
 *      agree on, and it travels immediately next to `registry_url` in the
 *      projection's allow-list (0385, and originally 0362) — the two are the
 *      established co-traveling pair for this feature.
 *   2. No OTHER file under `services/worker/src` (excluding `*.test.ts`)
 *      stamps that same `ce_envelope_sha256` marker without being registered
 *      in {@link CE_REGISTRY_WRITER_FILES} — i.e. a third writer cannot be
 *      added and silently fall outside this guard's coverage. Fails closed,
 *      same policy as check #3.
 *   3. The live `get_public_anchor` projection (the highest-numbered
 *      migration that redefines `public.get_public_anchor`, located the same
 *      way 0385's own docblock instructs a human author to) still projects
 *      `metadata ->> 'registry_url'` in its metadata allow-list. If that
 *      migration cannot be located at all, that is a FAILURE, not a skip —
 *      a guard that silently no-ops when its target moves is the same class
 *      of bug it exists to catch.
 *
 * WHAT THIS GUARD DOES NOT CATCH (stated explicitly — an overclaiming guard
 * is worse than none):
 *
 *   - Block-level drift WITHIN one file: if a registered writer file stamped
 *     `registry_url` in one unrelated object literal and `ce_envelope_sha256`
 *     in a completely different, unrelated one, this guard checks file-level
 *     co-occurrence, not block-level — it would false-pass. Verified against
 *     the current two writer files that this is not the case (each stamps
 *     both keys in the SAME interface/object). A block-scoped (brace-matching)
 *     version would close this gap; not built here to match the coarse,
 *     text-scan style already established by `check-envelope-key-index-
 *     parity.ts`, which has the identical limitation for its own key array.
 *   - Dynamically computed key names (`metadata[someVar] = ...`). Only
 *     literal `identifier:` / `'identifier':` key sites are matched, the same
 *     limitation `check-envelope-key-index-parity.ts` has for its array.
 *   - Runtime correctness — this is a static source-text guard, not an
 *     integration test. `credentials-ctdl-registry-anchor.test.ts` and
 *     `credential-source-import.test.ts` cover that the values are actually
 *     correct at insert time for each writer individually.
 *   - TypeScript block comments (the multi-line, slash-star style) — only
 *     `//` line comments are stripped before matching (mirrors
 *     `stripSqlLineComment`'s scope for SQL `--` comments). Verified against
 *     current repo content that no relevant occurrence lives inside a block
 *     comment.
 *   - Any migration OTHER than the current highest-numbered redefinition of
 *     `get_public_anchor` — by design; matches how a human is instructed to
 *     find "the" definition per 0385's own header.
 *   - Destructuring-with-rename (`const { registry_url: x } = foo`) is a
 *     READ, not a write, but matches the same `key:` shape this guard scans
 *     for. This can only cause an over-eager FALSE POSITIVE (flagging a file
 *     as an unregistered writer when it merely reads-and-renames), never a
 *     silent miss — fails loud, not closed-but-wrong. Not present in any
 *     currently-scanned file.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectMigrationFiles, stripSqlLineComment } from './check-anchor-index-justification.js';

/**
 * Registered writers of CE-registry provenance metadata. Anything else under
 * `services/worker/src` that stamps the `ce_envelope_sha256` marker key
 * (outside `*.test.ts`) is treated as an unregistered writer — see check #2
 * in the header.
 */
export const CE_REGISTRY_WRITER_FILES = [
  join('services', 'worker', 'src', 'api', 'v1', 'credentials-ctdl-registry-anchor.ts'),
  join('services', 'worker', 'src', 'lib', 'credential-source-import.ts'),
] as const;

const WORKER_SRC_DIR = join('services', 'worker', 'src');

/** `ce_envelope_sha256` (or `registry_url`) as an object key / interface property — `identifier:` / `'identifier':`. */
function keyWriteRe(key: string): RegExp {
  return new RegExp(String.raw`(?:\b${key}|['"\`]${key}['"\`])\s*:`);
}

const CE_PROVENANCE_MARKER_RE = keyWriteRe('ce_envelope_sha256');
const REGISTRY_URL_KEY_RE = keyWriteRe('registry_url');

/**
 * Strip `//` line comments before matching, the same rationale as
 * `stripSqlLineComment` for SQL `--` comments (see that function's docblock
 * in `check-anchor-index-justification.ts`): without it, a comment that
 * merely MENTIONS a key with a trailing colon (e.g. prose like
 * `registry_url: the CE link`) would count as the file actually stamping it
 * — a false pass for check #1, or a false positive for check #2. Does not
 * handle slash-star block comments (documented limitation above) or every
 * edge case of string-literal `//` (e.g. inside a template literal expression) —
 * quote-tracking below covers plain string/template literals, which is
 * exactly what this repo's key sites use.
 */
export function stripJsLineComment(line: string): string {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < line.length && line[i] !== ch) {
        i += line[i] === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i).trimEnd();
    }
    i += 1;
  }
  return line;
}

function stripJsComments(source: string): string {
  return source.split(/\r?\n/).map(stripJsLineComment).join('\n');
}

/** True if `source` stamps `ce_envelope_sha256` as a real (non-commented) key anywhere. */
export function hasCeProvenanceMarker(source: string): boolean {
  return CE_PROVENANCE_MARKER_RE.test(stripJsComments(source));
}

/** True if `source` stamps `registry_url` as a real (non-commented) key anywhere. */
export function hasRegistryUrlKey(source: string): boolean {
  return REGISTRY_URL_KEY_RE.test(stripJsComments(source));
}

/** Check #1: registered writer files that mark themselves as CE-provenance writers but never stamp `registry_url`. */
export function findRegisteredWritersMissingRegistryUrl(
  sourceByFile: Map<string, string>,
): string[] {
  const missing: string[] = [];
  for (const file of CE_REGISTRY_WRITER_FILES) {
    const source = sourceByFile.get(file);
    if (source === undefined) {
      // A registered file that no longer exists is exactly the "target moved"
      // case — fail closed rather than silently skipping it.
      missing.push(`${file} (file not found — registered writer moved or renamed?)`);
      continue;
    }
    if (hasCeProvenanceMarker(source) && !hasRegistryUrlKey(source)) {
      missing.push(file);
    }
  }
  return missing;
}

/** Check #2: files that stamp the CE-provenance marker but are not in {@link CE_REGISTRY_WRITER_FILES}. */
export function findUnregisteredWriters(sourceByFile: Map<string, string>): string[] {
  const registered = new Set<string>(CE_REGISTRY_WRITER_FILES);
  const unregistered: string[] = [];
  for (const [file, source] of sourceByFile) {
    if (registered.has(file)) continue;
    if (hasCeProvenanceMarker(source)) unregistered.push(file);
  }
  return unregistered.sort();
}

/** Recursively collect non-test `.ts` files under `services/worker/src` (relative to `repo`), same shape as `check-v1-uuid-leaks.ts`'s local `walkTs`. */
export function collectWorkerTsFiles(repo: string): string[] {
  const absDir = join(repo, WORKER_SRC_DIR);
  if (!existsSync(absDir)) return [];

  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(relative(repo, full).split(sep).join('/'));
      }
    }
  }
  walk(absDir);
  return out;
}

const GET_PUBLIC_ANCHOR_DEF_RE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_public_anchor\s*\(/i;

/**
 * The highest-numbered migration that redefines `public.get_public_anchor`,
 * following the exact same "ascending sort, take the last match" shape as
 * `check-api-scope-vocabulary.ts`'s `latestConstraintMigration` — this
 * repo's established pattern for "find the live definition of a
 * wholesale-redefined SQL object."
 */
export function latestGetPublicAnchorMigration(
  sqlByFile: Map<string, string>,
): { file: string; sql: string } | null {
  const candidates = [...sqlByFile.entries()]
    .filter(([, sql]) => GET_PUBLIC_ANCHOR_DEF_RE.test(sql))
    .sort(([a], [b]) => a.localeCompare(b));

  const latest = candidates.at(-1);
  return latest ? { file: latest[0], sql: latest[1] } : null;
}

/**
 * Isolate the `get_public_anchor` function body (`CREATE OR REPLACE
 * FUNCTION ... AS $$ ... $$;`) out of a migration file that may define many
 * other functions/helpers before or after it (0385 defines six). Comments
 * are stripped first via `stripSqlLineComment`, the same helper
 * `check-envelope-key-index-parity.ts` uses for the identical reason: a
 * migration's header block or a rollback note can otherwise make the guard
 * count an index/key the live statement never actually creates/projects.
 */
export function extractGetPublicAnchorBody(sql: string): string | null {
  const executable = sql.split(/\r?\n/).map(stripSqlLineComment).join('\n');
  const start = GET_PUBLIC_ANCHOR_DEF_RE.exec(executable);
  if (!start) return null;
  const closeIdx = executable.indexOf('$$;', start.index);
  if (closeIdx === -1) return null;
  return executable.slice(start.index, closeIdx + 3);
}

/** Check #3: does the live projection body still allow-list `metadata ->> 'registry_url'`? */
export function projectionHasRegistryUrlKey(functionBody: string): boolean {
  return /metadata\s*->>\s*'registry_url'/.test(functionBody);
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');

  const sourceByFile = new Map(
    collectWorkerTsFiles(repo).map((file) => [file, readFileSync(join(repo, file), 'utf8')]),
  );

  const missingRegistryUrl = findRegisteredWritersMissingRegistryUrl(sourceByFile);
  const unregistered = findUnregisteredWriters(sourceByFile);

  const sqlByFile = new Map(
    collectMigrationFiles(repo).map((file) => [file, readFileSync(join(repo, file), 'utf8')]),
  );
  const projection = latestGetPublicAnchorMigration(sqlByFile);

  const failures: string[] = [];

  if (missingRegistryUrl.length > 0) {
    failures.push(
      `${missingRegistryUrl.length} registered CE-registry writer(s) stamp ` +
        `\`ce_envelope_sha256\` but never stamp \`registry_url\`: ${missingRegistryUrl.join(', ')}. ` +
        "The public get_public_anchor projection reads the literal key `registry_url` — " +
        'any other spelling (e.g. a `ce_`-prefixed variant) never reaches the verify page. ' +
        "Fix: add a `registry_url: <same value>` key alongside the existing provenance fields.",
    );
  }

  if (unregistered.length > 0) {
    failures.push(
      `${unregistered.length} file(s) under ${WORKER_SRC_DIR} stamp the CE-registry provenance ` +
        `marker (\`ce_envelope_sha256\`) but are not registered in CE_REGISTRY_WRITER_FILES: ` +
        `${unregistered.join(', ')}. ` +
        'Add the file to CE_REGISTRY_WRITER_FILES in scripts/ci/check-ce-registry-key-parity.ts ' +
        'so this guard actually checks it for registry_url parity.',
    );
  }

  if (!projection) {
    failures.push(
      'could not locate a migration redefining `public.get_public_anchor` at all. ' +
        'If the function was renamed, moved to a different definition style, or the ' +
        'redefinition marker changed, update GET_PUBLIC_ANCHOR_DEF_RE in ' +
        'scripts/ci/check-ce-registry-key-parity.ts in the same change.',
    );
  } else {
    const body = extractGetPublicAnchorBody(projection.sql);
    if (!body) {
      failures.push(
        `found ${projection.file} as the redefining migration but could not isolate its ` +
          "function body (expected an \`AS $$ ... $$;\` block). Update extractGetPublicAnchorBody " +
          'in scripts/ci/check-ce-registry-key-parity.ts if the body delimiter style changed.',
      );
    } else if (!projectionHasRegistryUrlKey(body)) {
      failures.push(
        `${projection.file} no longer projects \`metadata ->> 'registry_url'\` in its metadata ` +
          'allow-list. Every registered CE-registry writer stamps that key, but the public verify ' +
          'page can no longer read it — the "Registry reference" row in SourceProvenanceDisplay.tsx ' +
          'will silently stop populating for every anchor, old and new alike.',
      );
    }
  }

  if (failures.length === 0) {
    console.log(
      `CE-registry key parity passed — ${CE_REGISTRY_WRITER_FILES.length} registered writer(s) ` +
        `agree with the live projection (${projection?.file}) on \`registry_url\`.`,
    );
    return;
  }

  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
