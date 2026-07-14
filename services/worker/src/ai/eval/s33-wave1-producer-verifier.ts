/**
 * Trusted-main verifier for the Sprint 3.3 Wave-1 producer commit.
 *
 * Producer TypeScript is parsed as data and is never imported or executed.
 * Every Git fact is derived from the object database before mirrored manifest
 * or Markdown declarations are compared.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import type { GroundTruthFields } from './types.js';
import {
  evaluateS33HeldoutGroundTruthContract,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';
import {
  WAVE1_CORPUS_SLICE_COUNTS,
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_CREDENTIAL_TYPE_COUNTS,
  WAVE1_DOMAIN_COUNTS,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_ENTRY_IDS,
  WAVE1_MANIFEST_PATH,
  WAVE1_SOURCE_BLOB_PATHS,
  WAVE1_TYPES_PATH,
  canonicalManifestHash,
  rawManifestHash,
  validateActiveS33Wave1PacketMirrors,
  type ParsedBatchManifest,
} from './s33-batch-acceptance.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ParsedProducerEntry {
  category: string;
  groundTruth: GroundTruthFields;
  id: string;
  sourcePath: string;
  strippedText: string;
}

export interface S33Wave1ProducerEntryResult {
  id: string;
  kind: 'covered' | 'ood-abstention';
  normalizedInputSha256: string;
  postValidationDepth: number | null;
  sourcePath: string;
  strippedFields: readonly string[];
}

export interface S33Wave1WorkflowReportEntry {
  groundTruth: Readonly<GroundTruthFields>;
  id: string;
  strippedText: string;
}

export interface S33Wave1ProducerValidationReport {
  algorithmVersion: 's33-wave1-producer-validation-v1';
  batchId: 'S33-W1';
  corpusSourceBlobs: Readonly<Record<string, string>>;
  counts: Readonly<{
    byCorpusSlice: Readonly<Record<string, number>>;
    byCredentialType: Readonly<Record<string, number>>;
    byDomain: Readonly<Record<string, number>>;
    covered: 72;
    ood: 9;
    total: 81;
  }>;
  entries: readonly S33Wave1ProducerEntryResult[];
  manifestCanonicalSha256: string;
  manifestRawSha256: string;
  producerHeadSha: string;
  producerChangedPaths: readonly string[];
  producerParentSha: string;
  producerTreeSha: string;
  reportDigestSha256: string;
  revision: number;
  schemaVersion: 1;
  support: Readonly<{
    commit: string;
    parentRetainedTypesBlob: string;
    typesBlob: string;
    typesPath: typeof WAVE1_TYPES_PATH;
  }>;
}

const GIT_EXECUTABLE = '/usr/bin/git';
const GIT_ENV = Object.freeze({
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
});
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_WAVE1_PRODUCER_ROWS = 81;
const WAVE1_PACKET_PATHS = Object.freeze([
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  ...WAVE1_SOURCE_BLOB_PATHS,
].sort());

const SOURCE_CONTRACTS = Object.freeze({
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts': {
    category: 's33-licensing-heldout',
    domain: 'professional-licensing',
    exportName: 'S33_LICENSING_HELDOUT',
  },
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts': {
    category: 's33-au-ke-heldout',
    domain: 'au-ke-priority-documents',
    exportName: 'S33_AU_KE_HELDOUT',
  },
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts': {
    category: 's33-ood-negative',
    domain: 'out-of-distribution',
    exportName: 'S33_OOD_NEGATIVES',
  },
} satisfies Record<(typeof WAVE1_SOURCE_BLOB_PATHS)[number], {
  category: string;
  domain: string;
  exportName: string;
}>);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertGitObject(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_OBJECT_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact hexadecimal Git object id`);
  }
}

function gitBuffer(repositoryRoot: string, args: readonly string[], label: string): Buffer {
  try {
    return execFileSync(GIT_EXECUTABLE, ['-C', repositoryRoot, ...args], { env: GIT_ENV });
  } catch (error) {
    throw new Error(`Unable to derive ${label} from Git`, { cause: error });
  }
}

function gitText(repositoryRoot: string, args: readonly string[], label: string): string {
  return gitBuffer(repositoryRoot, args, label).toString('utf8').trim();
}

function readGitPath(repositoryRoot: string, commit: string, path: string): Buffer {
  return gitBuffer(repositoryRoot, ['show', `${commit}:${path}`], `${path} at ${commit}`);
}

function gitBlob(repositoryRoot: string, commit: string, path: string, label: string): string {
  const blob = gitText(repositoryRoot, ['rev-parse', `${commit}:${path}`], label);
  assertGitObject(blob, label);
  return blob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} must contain exactly [${sortedExpected.join(', ')}]`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName, label: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`${label} uses a computed or unsupported property name`);
}

function parseLiteralExpression(expression: ts.Expression, label: string): JsonValue {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) {
    const number = Number(value.text);
    if (!Number.isFinite(number)) throw new Error(`${label} contains a non-finite number`);
    return number;
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value)
    && (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken)
    && ts.isNumericLiteral(value.operand)) {
    const number = Number(`${value.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${value.operand.text}`);
    if (!Number.isFinite(number)) throw new Error(`${label} contains a non-finite number`);
    return number;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((element, index) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        throw new Error(`${label}[${index}] may not be spread or omitted data`);
      }
      return parseLiteralExpression(element, `${label}[${index}]`);
    });
  }
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`${label} may contain only explicit property assignments`);
      }
      const key = propertyName(property.name, label);
      if (Object.hasOwn(result, key)) throw new Error(`${label} contains duplicate property ${key}`);
      result[key] = parseLiteralExpression(property.initializer, `${label}.${key}`);
    }
    return result;
  }
  throw new Error(`${label} must be literal producer data; executable/computed syntax is forbidden`);
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function assertS33SourceParseDiagnostics(source: ts.SourceFile, sourcePath: string): void {
  const parseDiagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (!Array.isArray(parseDiagnostics)) {
    throw new Error(`${sourcePath} TypeScript parser diagnostics API is unavailable`);
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(`${sourcePath} contains TypeScript parse diagnostics`);
  }
}

/** Parse only the named exported array graph; producer code is never evaluated. */
export function parseS33ProducerModule(
  sourceText: string,
  sourcePath: string,
  exportName: string,
): Record<string, unknown>[] {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  assertS33SourceParseDiagnostics(source, sourcePath);
  const declarations = new Map<string, Readonly<{ initializer: ts.Expression; isConst: boolean }>>();
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declarations.has(declaration.name.text)) {
        throw new Error(`${sourcePath} contains duplicate declaration ${declaration.name.text}`);
      }
      declarations.set(declaration.name.text, {
        initializer: declaration.initializer,
        isConst: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
      });
      if (hasExportModifier(statement)) exported.add(declaration.name.text);
    }
  }
  if (!exported.has(exportName)) throw new Error(`${sourcePath} must directly export const ${exportName}`);

  const evaluating = new Set<string>();
  const evaluated = new Map<string, Record<string, unknown>[]>();
  const appendRows = (
    target: Record<string, unknown>[],
    additions: readonly Record<string, unknown>[],
    label: string,
  ): void => {
    if (target.length + additions.length > MAX_WAVE1_PRODUCER_ROWS) {
      throw new Error(`${sourcePath} ${label} exceeds the maximum 81-row Wave-1 corpus`);
    }
    target.push(...additions);
  };
  const evaluateArray = (expression: ts.Expression, label: string): Record<string, unknown>[] => {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      const declaration = declarations.get(value.text);
      if (!declaration) throw new Error(`${sourcePath} references unknown array ${value.text}`);
      if (!declaration.isConst) throw new Error(`${sourcePath} array ${value.text} must be declared const`);
      const cached = evaluated.get(value.text);
      if (cached) return cached;
      if (evaluating.has(value.text)) throw new Error(`${sourcePath} contains cyclic array ${value.text}`);
      evaluating.add(value.text);
      const result = evaluateArray(declaration.initializer, value.text);
      evaluating.delete(value.text);
      evaluated.set(value.text, result);
      return result;
    }
    if (!ts.isArrayLiteralExpression(value)) {
      throw new Error(`${sourcePath} ${label} must resolve to a literal array graph`);
    }
    const result: Record<string, unknown>[] = [];
    value.elements.forEach((element, index) => {
      if (ts.isSpreadElement(element)) {
        appendRows(result, evaluateArray(element.expression, `${label}[${index}] spread`), label);
        return;
      }
      if (ts.isOmittedExpression(element)) throw new Error(`${sourcePath} ${label} contains an omitted row`);
      const parsed = parseLiteralExpression(element, `${sourcePath} ${label}[${index}]`);
      if (!isRecord(parsed)) throw new Error(`${sourcePath} ${label}[${index}] must be an object`);
      appendRows(result, [parsed], label);
    });
    return result;
  };

  const exportedDeclaration = declarations.get(exportName)!;
  if (!exportedDeclaration.isConst) throw new Error(`${sourcePath} must directly export const ${exportName}`);
  return evaluateArray(exportedDeclaration.initializer, exportName);
}

function parsedEntry(value: Record<string, unknown>, sourcePath: string): ParsedProducerEntry {
  const id = requiredString(value.id, `${sourcePath} entry.id`);
  const groundTruth = value.groundTruth;
  if (!isRecord(groundTruth)) throw new Error(`${sourcePath} ${id}.groundTruth must be an object`);
  return {
    category: requiredString(value.category, `${sourcePath} ${id}.category`),
    groundTruth: groundTruth as GroundTruthFields,
    id,
    sourcePath,
    strippedText: requiredString(value.strippedText, `${sourcePath} ${id}.strippedText`),
  };
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function assertCountMap(
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>,
  label: string,
): void {
  if (canonicaliseJson(actual) !== canonicaliseJson(expected)) {
    throw new Error(`${label} does not match the exact Wave-1 count map`);
  }
}

function assertExactUniverse(entries: readonly ParsedProducerEntry[]): void {
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Producer corpus contains duplicate entry ids');
  const actual = [...ids].sort();
  const expected = [...WAVE1_ENTRY_IDS].sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error('Producer corpus does not match the exact Wave-1 81-id universe');
  }
}

function verifyProvenance(
  repositoryRoot: string,
  producerHeadSha: string,
  manifest: ParsedBatchManifest,
): {
  corpusSourceBlobs: Record<string, string>;
  producerChangedPaths: string[];
  producerParentSha: string;
  producerTreeSha: string;
  support: S33Wave1ProducerValidationReport['support'];
} {
  const lineage = gitText(
    repositoryRoot,
    ['rev-list', '--parents', '-n', '1', producerHeadSha],
    'producer single-parent lineage',
  ).split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== producerHeadSha) {
    throw new Error('Wave-1 producer head must be an exact single-parent commit');
  }
  const producerParentSha = lineage[1];
  assertGitObject(producerParentSha, 'Wave-1 producer parent');
  const producerTreeSha = gitText(
    repositoryRoot,
    ['rev-parse', `${producerHeadSha}^{tree}`],
    'producer tree',
  );
  assertGitObject(producerTreeSha, 'Wave-1 producer tree');

  const diffRows = gitText(
    repositoryRoot,
    [
      'diff-tree', '--no-commit-id', '--name-status', '-r',
      '--find-renames', '--find-copies-harder', producerParentSha, producerHeadSha,
    ],
    'producer changed-path set',
  ).split('\n').filter((row) => row.length > 0);
  const producerChangedPaths = diffRows.map((row) => {
    const fields = row.split('\t');
    if (fields.length !== 2 || !/^[AM]$/u.test(fields[0])) {
      throw new Error(`Wave-1 producer diff contains a rename, copy, deletion, or ambiguous status: ${row}`);
    }
    return fields[1];
  }).sort();
  if (producerChangedPaths.length !== WAVE1_PACKET_PATHS.length
    || producerChangedPaths.some((path, index) => path !== WAVE1_PACKET_PATHS[index])) {
    throw new Error('Wave-1 producer commit must change exactly the six protocol packet paths');
  }

  const parsed = manifest.parsedJson;
  const declaredParent = requiredString(parsed.corpusRevisionParentCommit, 'Manifest corpusRevisionParentCommit');
  assertGitObject(declaredParent, 'Manifest corpusRevisionParentCommit');
  if (declaredParent !== producerParentSha) {
    throw new Error('Actual producer parent does not match manifest corpusRevisionParentCommit');
  }

  const supportDeclaration = parsed.lane3SupportBase;
  if (!isRecord(supportDeclaration)) throw new Error('Manifest lane3SupportBase must be an object');
  exactKeys(supportDeclaration, ['commit', 'typesPath', 'typesBlob', 'reviewState'], 'Manifest lane3SupportBase');
  const supportCommit = requiredString(supportDeclaration.commit, 'Manifest lane3SupportBase.commit');
  assertGitObject(supportCommit, 'Manifest lane3SupportBase.commit');
  if (supportDeclaration.typesPath !== WAVE1_TYPES_PATH) {
    throw new Error(`Manifest support types path must be ${WAVE1_TYPES_PATH}`);
  }
  const declaredTypesBlob = requiredString(supportDeclaration.typesBlob, 'Manifest lane3SupportBase.typesBlob');
  assertGitObject(declaredTypesBlob, 'Manifest lane3SupportBase.typesBlob');
  try {
    execFileSync(GIT_EXECUTABLE, [
      '-C', repositoryRoot, 'merge-base', '--is-ancestor', supportCommit, producerParentSha,
    ], { env: GIT_ENV });
  } catch (error) {
    throw new Error('Declared Lane-3 support commit is not retained by the actual producer parent', { cause: error });
  }
  const actualTypesBlob = gitBlob(repositoryRoot, supportCommit, WAVE1_TYPES_PATH, 'support types blob');
  if (actualTypesBlob !== declaredTypesBlob) {
    throw new Error('Declared Lane-3 support types blob does not match Git');
  }
  const parentRetainedTypesBlob = gitBlob(
    repositoryRoot,
    producerParentSha,
    WAVE1_TYPES_PATH,
    'producer-parent retained support types blob',
  );
  if (parentRetainedTypesBlob !== actualTypesBlob) {
    throw new Error('Producer parent does not retain the declared Lane-3 support types blob');
  }

  const declaredSourceBlobs = parsed.corpusSourceBlobs;
  if (!isRecord(declaredSourceBlobs)) throw new Error('Manifest corpusSourceBlobs must be an object');
  exactKeys(declaredSourceBlobs, WAVE1_SOURCE_BLOB_PATHS, 'Manifest corpusSourceBlobs');
  const corpusSourceBlobs: Record<string, string> = {};
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const declared = requiredString(declaredSourceBlobs[path], `Manifest corpusSourceBlobs.${path}`);
    assertGitObject(declared, `Manifest corpusSourceBlobs.${path}`);
    const actual = gitBlob(repositoryRoot, producerHeadSha, path, `producer source blob ${path}`);
    if (actual !== declared) throw new Error(`Declared corpus source blob does not match Git: ${path}`);
    corpusSourceBlobs[path] = actual;
  }
  return {
    corpusSourceBlobs,
    producerChangedPaths,
    producerParentSha,
    producerTreeSha,
    support: {
      commit: supportCommit,
      parentRetainedTypesBlob,
      typesBlob: actualTypesBlob,
      typesPath: WAVE1_TYPES_PATH,
    },
  };
}

export function verifyS33Wave1ProducerHead(input: Readonly<{
  producerHeadSha: string;
  repositoryRoot: string;
}>): Readonly<S33Wave1ProducerValidationReport> {
  assertGitObject(input.producerHeadSha, 'Wave-1 producer head');
  const manifestContent = readGitPath(input.repositoryRoot, input.producerHeadSha, WAVE1_MANIFEST_PATH);
  const manifest = validateActiveS33Wave1PacketMirrors(
    input.repositoryRoot,
    input.producerHeadSha,
    manifestContent,
  );
  const provenance = verifyProvenance(input.repositoryRoot, input.producerHeadSha, manifest);

  const entries: ParsedProducerEntry[] = [];
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const contract = SOURCE_CONTRACTS[path];
    const source = readGitPath(input.repositoryRoot, input.producerHeadSha, path).toString('utf8');
    const moduleEntries = parseS33ProducerModule(source, path, contract.exportName)
      .map((entry) => parsedEntry(entry, path));
    for (const entry of moduleEntries) {
      if (entry.category !== contract.category) {
        throw new Error(`${path} ${entry.id}.category must be ${contract.category}`);
      }
    }
    entries.push(...moduleEntries);
  }
  assertExactUniverse(entries);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const manifestById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results: S33Wave1ProducerEntryResult[] = [];
  const domains: string[] = [];
  const credentialTypes: string[] = [];
  const corpusSlices: string[] = [];
  let covered = 0;
  let ood = 0;

  for (const manifestEntry of manifest.entries) {
    const entry = byId.get(manifestEntry.id);
    if (!entry) throw new Error(`Manifest entry is absent from producer corpus: ${manifestEntry.id}`);
    const sourceContract = SOURCE_CONTRACTS[entry.sourcePath as keyof typeof SOURCE_CONTRACTS];
    if (!sourceContract || manifestEntry.domain !== sourceContract.domain) {
      throw new Error(`${entry.id} source module does not match its manifest domain`);
    }
    if (entry.groundTruth.credentialType !== manifestEntry.credentialType) {
      throw new Error(`${entry.id} producer ground-truth credential type does not match manifest`);
    }
    const normalizedInputSha256 = sha256(normalizeForFingerprint(entry.strippedText));
    if (normalizedInputSha256 !== manifestEntry.normalizedInputSha256) {
      throw new Error(`${entry.id} normalized input fingerprint does not match producer text`);
    }
    const contract = evaluateS33HeldoutGroundTruthContract(entry);
    if (!contract.accepted) {
      throw new Error(`${entry.id} fails the post-validation corpus contract: ${contract.errors.join('; ')}`);
    }
    if (contract.kind === 'covered') covered += 1;
    else ood += 1;
    domains.push(manifestEntry.domain);
    credentialTypes.push(requiredString(entry.groundTruth.credentialType, `${entry.id}.credentialType`));
    corpusSlices.push(sourceContract.category);
    results.push({
      id: entry.id,
      kind: contract.kind,
      normalizedInputSha256,
      postValidationDepth: contract.postValidationDepth,
      sourcePath: entry.sourcePath,
      strippedFields: [...contract.strippedFields],
    });
  }
  if (manifestById.size !== 81 || covered !== 72 || ood !== 9) {
    throw new Error(`Wave-1 corpus must be exactly 81=72 covered+9 OOD; got ${manifestById.size}=${covered}+${ood}`);
  }
  const byDomain = countValues(domains);
  const byCredentialType = countValues(credentialTypes);
  const byCorpusSlice = countValues(corpusSlices);
  assertCountMap(byDomain, WAVE1_DOMAIN_COUNTS, 'Actual producer domain counts');
  assertCountMap(byCredentialType, WAVE1_CREDENTIAL_TYPE_COUNTS, 'Actual producer credential-type counts');
  assertCountMap(byCorpusSlice, WAVE1_CORPUS_SLICE_COUNTS, 'Actual producer corpus-slice counts');

  const withoutDigest = {
    algorithmVersion: 's33-wave1-producer-validation-v1' as const,
    batchId: 'S33-W1' as const,
    corpusSourceBlobs: provenance.corpusSourceBlobs,
    counts: {
      byCorpusSlice,
      byCredentialType,
      byDomain,
      covered: 72 as const,
      ood: 9 as const,
      total: 81 as const,
    },
    entries: results,
    manifestCanonicalSha256: canonicalManifestHash(manifestContent),
    manifestRawSha256: rawManifestHash(manifestContent),
    producerChangedPaths: provenance.producerChangedPaths,
    producerHeadSha: input.producerHeadSha,
    producerParentSha: provenance.producerParentSha,
    producerTreeSha: provenance.producerTreeSha,
    revision: manifest.revision,
    schemaVersion: 1 as const,
    support: provenance.support,
  };
  return deepFreeze({
    ...withoutDigest,
    reportDigestSha256: sha256(canonicaliseJson(withoutDigest)),
  });
}

/**
 * Trusted-main report input. The corpus is read from the verified Git object,
 * parsed without execution, and returned only in memory to report tooling.
 */
export function loadS33Wave1WorkflowReportEntries(input: Readonly<{
  producerHeadSha: string;
  repositoryRoot: string;
}>): readonly Readonly<S33Wave1WorkflowReportEntry>[] {
  verifyS33Wave1ProducerHead(input);
  const byId = new Map<string, ParsedProducerEntry>();
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const contract = SOURCE_CONTRACTS[path];
    const source = readGitPath(input.repositoryRoot, input.producerHeadSha, path).toString('utf8');
    for (const candidate of parseS33ProducerModule(source, path, contract.exportName)) {
      const entry = parsedEntry(candidate, path);
      if (byId.has(entry.id)) throw new Error(`Workflow report input contains duplicate id ${entry.id}`);
      byId.set(entry.id, entry);
    }
  }
  return deepFreeze(WAVE1_ENTRY_IDS.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Workflow report input is missing ${id}`);
    return {
      groundTruth: entry.groundTruth,
      id: entry.id,
      strippedText: entry.strippedText,
    };
  }));
}
