#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1581 — keep the canonical API key scope vocabulary in sync.
 *
 * The worker owns runtime enforcement, but the same vocabulary is also copied
 * into frontend display metadata, SQL CHECK constraints, and API docs. This
 * guard fails CI when any of those surfaces drifts.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

const SCOPE_ARRAY_NAMES = [
  'API_V2_SCOPES',
  'LEGACY_API_SCOPES',
  'COMPLIANCE_API_SCOPES',
  'API_KEY_SCOPES',
  'DEFAULT_API_KEY_SCOPES',
] as const;

type ScopeArrayName = (typeof SCOPE_ARRAY_NAMES)[number];

export type ScopeVocabulary = Record<ScopeArrayName, string[]>;

export interface ScopeVocabularyViolation {
  surface: string;
  detail: string;
}

type ArrayItem = string | { spread: string };

export interface ScopeVocabularySurfaces {
  workerSource: string;
  frontendSource: string;
  dbConstraintSql: string;
  apiReadmeMarkdown: string;
  v2MigrationMarkdown: string;
  v1OpenApiYaml: string;
}

export function resolveRepoRoot(): string {
  const envRoot = process.env.API_SCOPE_VOCABULARY_REPO_ROOT;
  if (!envRoot) return DEFAULT_REPO_ROOT;

  const resolved = resolve(envRoot);
  const realResolved = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const realDefault = realpathSync(DEFAULT_REPO_ROOT);
  const realTmp = realpathSync(tmpdir());
  const isInRepo = realResolved === realDefault || realResolved.startsWith(realDefault + sep);
  const isInTmp = realResolved === realTmp || realResolved.startsWith(realTmp + sep);

  if (!isInRepo && !isInTmp) {
    throw new Error(
      `API_SCOPE_VOCABULARY_REPO_ROOT=${envRoot} resolves outside the repo and temp dir; refusing to scan it.`,
    );
  }

  if (!existsSync(join(resolved, 'package.json'))) {
    throw new Error(`API_SCOPE_VOCABULARY_REPO_ROOT=${envRoot} does not look like a repo root.`);
  }

  return resolved;
}

function parseExportedArrays(source: string): Map<string, ArrayItem[]> {
  const arrays = new Map<string, ArrayItem[]>();
  const arrayRe = /export\s+const\s+(\w+)(?:\s*:[^=]+)?\s*=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?\s*;/g;
  let match: RegExpExecArray | null;

  while ((match = arrayRe.exec(source)) !== null) {
    const [, name, body] = match;
    const items: ArrayItem[] = [];
    const itemRe = /\.\.\.(\w+)|['"]([^'"]+)['"]/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRe.exec(body)) !== null) {
      const [, spread, literal] = itemMatch;
      items.push(spread ? { spread } : literal);
    }
    arrays.set(name, items);
  }

  return arrays;
}

function resolveArray(name: string, arrays: Map<string, ArrayItem[]>, stack: string[] = []): string[] {
  const items = arrays.get(name);
  if (!items) throw new Error(`Missing exported array ${name}`);
  if (stack.includes(name)) throw new Error(`Circular exported array reference: ${[...stack, name].join(' -> ')}`);

  const resolved: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      resolved.push(item);
    } else {
      resolved.push(...resolveArray(item.spread, arrays, [...stack, name]));
    }
  }
  return resolved;
}

export function parseScopeVocabulary(source: string): ScopeVocabulary {
  const arrays = parseExportedArrays(source);
  return Object.fromEntries(
    SCOPE_ARRAY_NAMES.map((name) => [name, resolveArray(name, arrays)]),
  ) as ScopeVocabulary;
}

export function diffOrdered(surface: string, expected: readonly string[], actual: readonly string[]): ScopeVocabularyViolation[] {
  if (expected.length === actual.length && expected.every((scope, index) => scope === actual[index])) {
    return [];
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((scope) => !actualSet.has(scope));
  const extra = actual.filter((scope) => !expectedSet.has(scope));
  const orderOnly = missing.length === 0 && extra.length === 0 ? 'same values, different order' : '';
  const details = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `extra: ${extra.join(', ')}` : '',
    orderOnly,
    `expected: ${expected.join(', ')}`,
    `actual: ${actual.join(', ')}`,
  ].filter(Boolean);

  return [{ surface, detail: details.join(' | ') }];
}

export function extractSqlConstraintScopes(sql: string, constraintName = 'api_keys_scopes_known_values'): string[] {
  const uncommentedSql = sql.replace(/^\s*--.*$/gm, '');
  const escapedName = constraintName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constraintStart = uncommentedSql.search(new RegExp(`ADD\\s+CONSTRAINT\\s+${escapedName}`, 'i'));
  if (constraintStart === -1) return [];

  const afterConstraint = uncommentedSql.slice(constraintStart);
  const arrayStart = afterConstraint.search(/ARRAY\s*\[/i);
  if (arrayStart === -1) return [];

  const afterArray = afterConstraint.slice(arrayStart);
  const arrayEnd = afterArray.search(/\]\s*::\s*text\s*\[\]/i);
  if (arrayEnd === -1) return [];

  return extractQuotedValues(afterArray.slice(0, arrayEnd));
}

export function extractMarkdownCodeScopes(markdown: string): string[] {
  const scopes: string[] = [];
  const inlineOnlyMarkdown = markdown.replace(/```[\s\S]*?```/g, '');
  const codeSpanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeSpanRe.exec(inlineOnlyMarkdown)) !== null) {
    const value = match[1].trim();
    if (looksLikeScope(value)) scopes.push(value);
  }
  return scopes;
}

function extractQuotedValues(content: string): string[] {
  const values: string[] = [];
  const quotedRe = /'([^']+)'|"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRe.exec(content)) !== null) {
    values.push(match[1] ?? match[2]);
  }
  return values;
}

function looksLikeScope(value: string): boolean {
  return value === 'verify' || /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(value);
}

function missingFromSurface(surface: string, expected: readonly string[], actual: readonly string[]): ScopeVocabularyViolation[] {
  const actualSet = new Set(actual);
  const missing = expected.filter((scope) => !actualSet.has(scope));
  if (missing.length === 0) return [];
  return [{ surface, detail: `missing: ${missing.join(', ')}` }];
}

function missingTextMentions(surface: string, expected: readonly string[], content: string): ScopeVocabularyViolation[] {
  const missing = expected.filter((scope) => !content.includes(scope));
  if (missing.length === 0) return [];
  return [{ surface, detail: `missing: ${missing.join(', ')}` }];
}

export function collectScopeVocabularyViolations(surfaces: ScopeVocabularySurfaces): ScopeVocabularyViolation[] {
  const worker = parseScopeVocabulary(surfaces.workerSource);
  const frontend = parseScopeVocabulary(surfaces.frontendSource);
  const violations: ScopeVocabularyViolation[] = [];

  for (const name of SCOPE_ARRAY_NAMES) {
    violations.push(...diffOrdered(`frontend ${name}`, worker[name], frontend[name]));
  }

  violations.push(
    ...missingFromSurface(
      'database api_keys_scopes_known_values CHECK constraint',
      worker.API_KEY_SCOPES,
      extractSqlConstraintScopes(surfaces.dbConstraintSql, 'api_keys_scopes_known_values'),
    ),
  );

  violations.push(
    ...missingFromSurface(
      'database agents_allowed_scopes_known_values CHECK constraint',
      worker.API_KEY_SCOPES,
      extractSqlConstraintScopes(surfaces.dbConstraintSql, 'agents_allowed_scopes_known_values'),
    ),
  );

  violations.push(
    ...missingFromSurface(
      'docs/api/README.md canonical scope table',
      worker.API_KEY_SCOPES,
      extractMarkdownCodeScopes(surfaces.apiReadmeMarkdown),
    ),
  );

  violations.push(
    ...missingFromSurface(
      'docs/api/v2-migration.md v2 scope table',
      worker.API_V2_SCOPES,
      extractMarkdownCodeScopes(surfaces.v2MigrationMarkdown),
    ),
  );

  violations.push(
    ...missingTextMentions(
      'docs/api/openapi.yaml /keys scope enum',
      worker.API_KEY_SCOPES,
      surfaces.v1OpenApiYaml,
    ),
  );

  return violations;
}

function latestScopeConstraintMigration(repo: string): string {
  const migrationsDir = join(repo, 'supabase', 'migrations');
  const candidates = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => {
      const content = readFileSync(join(migrationsDir, file), 'utf8');
      return /ADD\s+CONSTRAINT\s+api_keys_scopes_known_values/i.test(content);
    });

  const latest = candidates[candidates.length - 1];
  if (!latest) {
    throw new Error('No migration defines api_keys_scopes_known_values.');
  }
  return join(migrationsDir, latest);
}

function readRepoSurfaces(repo: string): ScopeVocabularySurfaces {
  const dbConstraintPath = latestScopeConstraintMigration(repo);
  return {
    workerSource: readFileSync(join(repo, 'services', 'worker', 'src', 'api', 'apiScopes.ts'), 'utf8'),
    frontendSource: readFileSync(join(repo, 'src', 'lib', 'apiScopes.ts'), 'utf8'),
    dbConstraintSql: readFileSync(dbConstraintPath, 'utf8'),
    apiReadmeMarkdown: readFileSync(join(repo, 'docs', 'api', 'README.md'), 'utf8'),
    v2MigrationMarkdown: readFileSync(join(repo, 'docs', 'api', 'v2-migration.md'), 'utf8'),
    v1OpenApiYaml: readFileSync(join(repo, 'docs', 'api', 'openapi.yaml'), 'utf8'),
  };
}

function main(): void {
  const repo = resolveRepoRoot();
  const violations = collectScopeVocabularyViolations(readRepoSurfaces(repo));

  if (violations.length === 0) {
    console.log('✅ API scope vocabulary is aligned across worker, frontend, DB, and docs.');
    return;
  }

  console.error(`::error::SCRUM-1581 found ${violations.length} API scope vocabulary drift issue(s):`);
  for (const violation of violations) {
    console.error(`  ${violation.surface}: ${violation.detail}`);
  }
  process.exit(1);
}

function isMainModule(): boolean {
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
}

if (isMainModule()) {
  main();
}
