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

  for (let cursor = 0; cursor < source.length;) {
    const exportStart = source.indexOf('export const', cursor);
    if (exportStart === -1) break;

    const nameStart = skipWhitespace(source, exportStart + 'export const'.length);
    const nameEnd = readIdentifierEnd(source, nameStart);
    if (nameEnd === nameStart) {
      cursor = exportStart + 'export const'.length;
      continue;
    }

    const name = source.slice(nameStart, nameEnd);
    const statementEnd = findStatementEnd(source, nameEnd);
    const equalsIndex = source.indexOf('=', nameEnd);
    const arrayStart = equalsIndex === -1 || equalsIndex > statementEnd ? -1 : source.indexOf('[', equalsIndex);
    if (arrayStart === -1 || arrayStart > statementEnd) {
      cursor = statementEnd + 1;
      continue;
    }

    const arrayEnd = findClosingBracket(source, arrayStart);
    if (arrayEnd === -1 || arrayEnd > statementEnd) {
      cursor = statementEnd + 1;
      continue;
    }

    const items = parseArrayItems(source.slice(arrayStart + 1, arrayEnd));
    arrays.set(name, items);
    cursor = statementEnd + 1;
  }

  return arrays;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function readIdentifierEnd(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor])) cursor += 1;
  return cursor;
}

function findStatementEnd(source: string, start: number): number {
  const end = source.indexOf(';', start);
  return end === -1 ? source.length : end;
}

function findClosingBracket(source: string, start: number): number {
  let depth = 0;
  let cursor = start;

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (isQuote(char)) {
      cursor = skipQuotedLiteral(source, cursor, char);
      continue;
    }

    if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor);
      continue;
    }

    if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor);
      continue;
    }

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }

  return -1;
}

function isQuote(char: string): char is '"' | "'" {
  return char === '"' || char === "'";
}

function skipQuotedLiteral(source: string, start: number, quote: '"' | "'"): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const commentEnd = source.indexOf('*/', start + 2);
  return commentEnd === -1 ? source.length : commentEnd + 2;
}

function parseArrayItems(body: string): ArrayItem[] {
  const items: ArrayItem[] = [];

  for (let cursor = 0; cursor < body.length;) {
    cursor = skipWhitespace(body, cursor);
    if (body[cursor] === ',') {
      cursor += 1;
      continue;
    }

    if (body.startsWith('...', cursor)) {
      const spreadStart = cursor + 3;
      const spreadEnd = readIdentifierEnd(body, spreadStart);
      if (spreadEnd > spreadStart) items.push({ spread: body.slice(spreadStart, spreadEnd) });
      cursor = spreadEnd;
      continue;
    }

    if (body[cursor] === '"' || body[cursor] === "'") {
      const { value, end } = readStringLiteral(body, cursor);
      items.push(value);
      cursor = end;
      continue;
    }

    cursor += 1;
  }

  return items;
}

function readStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = '';

  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '\\') {
      const next = source[cursor + 1];
      if (next) value += next;
      cursor += 1;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
  }

  return { value, end: source.length };
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

export function diffSet(surface: string, expected: readonly string[], actual: readonly string[]): ScopeVocabularyViolation[] {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((scope) => !actualSet.has(scope));
  const extra = actual.filter((scope) => !expectedSet.has(scope));
  if (missing.length === 0 && extra.length === 0) return [];

  const details = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `extra: ${extra.join(', ')}` : '',
    `expected: ${expected.join(', ')}`,
    `actual: ${actual.join(', ')}`,
  ].filter(Boolean);

  return [{ surface, detail: details.join(' | ') }];
}

export function extractSqlConstraintScopes(sql: string, constraintName = 'api_keys_scopes_known_values'): string[] {
  const uncommentedSql = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const escapedName = constraintName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const constraintStart = uncommentedSql.search(
    new RegExp(String.raw`(?:ADD\s+)?CONSTRAINT\s+"?${escapedName}"?`, 'i'),
  );
  if (constraintStart === -1) return [];

  const afterConstraint = uncommentedSql.slice(constraintStart);
  const arrayStart = afterConstraint.search(/ARRAY\s*\[/i);
  if (arrayStart === -1) return [];

  const afterArray = afterConstraint.slice(arrayStart);
  const arrayEnd = afterArray.indexOf(']');
  if (arrayEnd === -1) return [];

  return extractQuotedValues(afterArray.slice(0, arrayEnd + 1)).filter((value) => value !== 'text');
}

export function extractMarkdownCodeScopes(markdown: string): string[] {
  const scopes: string[] = [];
  const inlineOnlyMarkdown = markdown.replaceAll(/```[\s\S]*?```/g, '');
  const codeSpanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeSpanRe.exec(inlineOnlyMarkdown)) !== null) {
    const value = match[1].trim();
    if (looksLikeScope(value)) scopes.push(value);
  }
  return scopes;
}

export function extractMarkdownSectionCodeScopes(markdown: string, heading: string): string[] {
  const headingText = heading.trim();
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === headingText);
  if (headingIndex === -1) return [];

  // Stop at any heading at the same or higher level than the start heading.
  // Without this, an `### Other section` after `### Canonical scope ...`
  // would leak its inline code spans into this section's scope set.
  const startLevel = headingText.match(/^#+/)?.[0].length ?? 1;
  const headingPattern = new RegExp(`^#{1,${startLevel}}\\s`);

  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (headingPattern.test(line.trimStart())) break;
    sectionLines.push(line);
  }

  return extractMarkdownCodeScopes(sectionLines.join('\n'));
}

export function extractOpenApiCanonicalScopes(openApiYaml: string): string[] {
  const lines = openApiYaml.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === 'x-arkova-canonical-scopes:');
  if (markerIndex === -1) return [];

  const markerIndent = countLeadingSpaces(lines[markerIndex]);
  const scopes: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    if (!line.trim()) continue;
    const indent = countLeadingSpaces(line);
    if (indent <= markerIndent) break;

    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      scopes.push(stripYamlQuotes(trimmed.slice(2).trim()));
    }
  }
  return scopes;
}

function stripYamlQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function countLeadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
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

export function collectScopeVocabularyViolations(surfaces: ScopeVocabularySurfaces): ScopeVocabularyViolation[] {
  const worker = parseScopeVocabulary(surfaces.workerSource);
  const frontend = parseScopeVocabulary(surfaces.frontendSource);
  const frontendViolations = SCOPE_ARRAY_NAMES.flatMap((name) => diffOrdered(`frontend ${name}`, worker[name], frontend[name]));

  return [
    ...frontendViolations,
    ...diffSet(
      'database api_keys_scopes_known_values CHECK constraint',
      worker.API_KEY_SCOPES,
      extractSqlConstraintScopes(surfaces.dbConstraintSql, 'api_keys_scopes_known_values'),
    ),
    ...diffSet(
      'database agents_allowed_scopes_known_values CHECK constraint',
      worker.API_KEY_SCOPES,
      extractSqlConstraintScopes(surfaces.dbConstraintSql, 'agents_allowed_scopes_known_values'),
    ),
    ...diffSet(
      'docs/api/README.md canonical scope table',
      worker.API_KEY_SCOPES,
      extractMarkdownSectionCodeScopes(
        surfaces.apiReadmeMarkdown,
        '### Canonical API key scope vocabulary',
      ),
    ),
    ...diffSet(
      'docs/api/v2-migration.md v2 scope table',
      worker.API_V2_SCOPES,
      extractMarkdownSectionCodeScopes(surfaces.v2MigrationMarkdown, '## Authentication'),
    ),
    ...diffSet(
      'docs/api/openapi.yaml x-arkova-canonical-scopes',
      worker.API_KEY_SCOPES,
      extractOpenApiCanonicalScopes(surfaces.v1OpenApiYaml),
    ),
  ];
}

export function latestConstraintMigration(repo: string, constraintName: string): string {
  const migrationsDir = join(repo, 'supabase', 'migrations');
  const escapedName = constraintName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const matcher = new RegExp(String.raw`(?:ADD\s+)?CONSTRAINT\s+"?${escapedName}"?`, 'i');
  const candidates = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => {
      const content = readFileSync(join(migrationsDir, file), 'utf8');
      return matcher.test(content);
    });

  const latest = candidates[candidates.length - 1];
  if (!latest) {
    throw new Error(`No migration defines ${constraintName}.`);
  }
  return join(migrationsDir, latest);
}

function readRepoSurfaces(repo: string): ScopeVocabularySurfaces {
  const apiKeysConstraintPath = latestConstraintMigration(repo, 'api_keys_scopes_known_values');
  const agentsConstraintPath = latestConstraintMigration(repo, 'agents_allowed_scopes_known_values');
  return {
    workerSource: readFileSync(join(repo, 'services', 'worker', 'src', 'api', 'apiScopes.ts'), 'utf8'),
    frontendSource: readFileSync(join(repo, 'src', 'lib', 'apiScopes.ts'), 'utf8'),
    dbConstraintSql: [
      readFileSync(apiKeysConstraintPath, 'utf8'),
      apiKeysConstraintPath === agentsConstraintPath ? '' : readFileSync(agentsConstraintPath, 'utf8'),
    ].filter(Boolean).join('\n'),
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
