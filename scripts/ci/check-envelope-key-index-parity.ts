#!/usr/bin/env -S npx tsx
/**
 * Envelope-key <-> index parity guard.
 *
 * `findExistingEnvelopeAnchor` (services/worker/src/jobs/
 * docusign-anchor-reconciliation.ts) looks an anchor up by envelope id across
 * every key listed in `ENVELOPE_ID_METADATA_KEYS`. Each of those lookups is a
 * `metadata ->> '<key>'` equality predicate against `public.anchors`, which is
 * ~2.97M rows in prod and overwhelmingly owned by a single org.
 *
 * A key with no supporting expression index is therefore not "a bit slower" —
 * it is a near-full-table scan that deterministically exceeds
 * `statement_timeout`, and it takes the DocuSign envelope->anchor path down.
 * That has already happened in prod (0381's header records both incidents).
 *
 * The failure mode this guard exists for is DRIFT, not the original bug:
 * appending a fourth key to `ENVELOPE_ID_METADATA_KEYS` is a one-line,
 * innocuous-looking change that silently reintroduces the timeout, because
 * nothing else in the repo ties the array to the migration set. This check ties
 * them together: every key in the array must have a `CREATE INDEX` on
 * `public.anchors` whose INDEXED EXPRESSION (not merely its WHERE predicate)
 * is `metadata ->> '<key>'`.
 *
 * Fail-closed by design. If the array cannot be located or parsed, that is a
 * failure, not a skip — a guard that silently no-ops when its input moves is
 * the same class of bug it is meant to catch.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectMigrationFiles } from './check-anchor-index-justification.js';

const KEYS_SOURCE_FILE = join(
  'services',
  'worker',
  'src',
  'jobs',
  'docusign-anchor-reconciliation.ts',
);
const KEYS_CONST_NAME = 'ENVELOPE_ID_METADATA_KEYS';

/** `export const ENVELOPE_ID_METADATA_KEYS = [ ... ]` (trailing `as const` optional). */
const KEYS_ARRAY_RE = new RegExp(
  String.raw`\bconst\s+${KEYS_CONST_NAME}\s*(?::[^=]+)?=\s*\[([^\]]*)\]`,
);
const QUOTED_STRING_RE = /['"`]([^'"`]+)['"`]/g;

/** `metadata ->> 'key'` / `metadata->>'key'`, with an optional `::text` cast. */
const METADATA_KEY_RE = /\bmetadata\s*->>\s*'([^']+)'/g;

const CREATE_INDEX_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
const ON_ANCHORS_RE =
  /\bON\s+(?:(?:"public"|public)\s*\.\s*)?(?:"anchors"|anchors)\b/i;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Read the envelope-id metadata keys straight out of the worker source, so the
 * guard can never drift from the array it is guarding.
 */
export function parseEnvelopeKeys(source: string): string[] {
  const arrayMatch = KEYS_ARRAY_RE.exec(source);
  if (arrayMatch === null) {
    throw new Error(
      `could not locate \`${KEYS_CONST_NAME}\` in ${KEYS_SOURCE_FILE}. ` +
        'If the constant was renamed or moved, update ' +
        'scripts/ci/check-envelope-key-index-parity.ts in the same change.',
    );
  }

  const keys = [...arrayMatch[1].matchAll(QUOTED_STRING_RE)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error(`\`${KEYS_CONST_NAME}\` parsed to an empty key list.`);
  }

  return keys;
}

/**
 * Split a CREATE INDEX statement at its top-level WHERE so only the indexed
 * expression list is considered. A key that appears solely in the partial
 * predicate (`WHERE (metadata ->> 'k') IS NOT NULL`) is NOT usable as a point
 * lookup on that key, so counting it would make the guard pass on an index
 * that does not actually fix the scan.
 */
export function indexedExpressionOf(statement: string): string {
  const normalized = normalizeSql(statement);
  let depth = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(char) && /^WHERE\b/i.test(normalized.slice(i + 1))) {
      return normalized.slice(0, i);
    }
  }

  return normalized;
}

/** Every `metadata ->> 'key'` indexed as an expression on `public.anchors`. */
export function collectIndexedMetadataKeys(sqlByFile: Map<string, string>): Map<string, string> {
  const indexedKeys = new Map<string, string>();

  for (const [file, sql] of sqlByFile) {
    for (const statement of sql.split(';')) {
      if (!CREATE_INDEX_RE.test(statement) || !ON_ANCHORS_RE.test(statement)) continue;

      const expression = indexedExpressionOf(statement);
      for (const match of expression.matchAll(METADATA_KEY_RE)) {
        if (!indexedKeys.has(match[1])) indexedKeys.set(match[1], file);
      }
    }
  }

  return indexedKeys;
}

export function findUnindexedKeys(
  keys: string[],
  indexedKeys: Map<string, string>,
): string[] {
  return keys.filter((key) => !indexedKeys.has(key));
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');

  const keys = parseEnvelopeKeys(readFileSync(join(repo, KEYS_SOURCE_FILE), 'utf8'));

  const sqlByFile = new Map(
    collectMigrationFiles(repo).map((file) => [file, readFileSync(join(repo, file), 'utf8')]),
  );
  const indexedKeys = collectIndexedMetadataKeys(sqlByFile);
  const unindexed = findUnindexedKeys(keys, indexedKeys);

  if (unindexed.length === 0) {
    const covered = keys.map((key) => `${key} (${indexedKeys.get(key)})`).join(', ');
    console.log(
      `envelope key/index parity passed — ${keys.length} key(s) indexed: ${covered}`,
    );
    return;
  }

  console.error(
    `::error::${unindexed.length} envelope metadata key(s) in ${KEYS_CONST_NAME} have no ` +
      `supporting index on public.anchors: ${unindexed.join(', ')}`,
  );
  console.error(
    'Each key in that array becomes a `metadata->>key` equality lookup against a ~2.97M-row\n' +
      'table in `findExistingEnvelopeAnchor`. Without an expression index the lookup is a full\n' +
      'scan of the calling org\'s anchors and will exceed statement_timeout in prod (see the\n' +
      'header of supabase/migrations/0381_docusign_envelope_metadata_lookup_indexes.sql).\n' +
      '\n' +
      'Fix: add a migration alongside the key, following 0381:\n' +
      "  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_<key>\n" +
      "    ON public.anchors ((metadata ->> '<key>'))\n" +
      "    WHERE (metadata ->> '<key>') IS NOT NULL;\n" +
      'CONCURRENTLY must live in its own file with no BEGIN/COMMIT (0313 convention).',
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
