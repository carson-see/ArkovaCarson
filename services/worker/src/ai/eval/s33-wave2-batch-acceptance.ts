/** Trusted-main, whole-batch acceptance for S3.3 Wave-2 held-out corpus tranches. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  assertS33HeldoutGroundTruthContract,
  countS33SubstantiveGroundTruthFields,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';
import type { GroundTruthFields } from './types.js';
import {
  checkHeldoutLeakage,
  loadLeakageCorpus,
  type CorpusFile,
} from './heldout-leakage.js';
import {
  parseStrictJsonDocument,
  scanS33ExactLexicalLeakage,
} from './s33-batch-acceptance.js';
import { parseS33ProducerModuleWithLimit } from './s33-wave1-producer-parser.js';
import {
  computeS33Wave2AcceptedEntryOrderSha256,
  verifyS33Wave2AuthenticatedBatchAcceptance,
  type S33Wave2AcceptedEntryInput,
  type S33Wave2AcceptanceTrustRoot,
  type S33Wave2AuthenticatedBatchAcceptance,
} from './s33-wave2-acceptance-envelope.js';
import {
  extendS33Wave2CorpusRegistry,
  type S33Wave2CorpusRegistry,
  type S33Wave2RegistryBatch,
  type S33Wave2RegistryEntry,
} from './s33-wave2-corpus-registry.js';

const GIT = '/usr/bin/git';
const GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
});
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const MANIFEST_PATH = new RegExp(`^docs/lane4/s33-wave2-batches/(${SLUG})/manifest\\.json$`, 'u');
const COVERAGE_REGISTRY_PATH = 'docs/lane4/s33-wave2-top15-registry.json' as const;

type JsonRecord = Record<string, unknown>;

export interface S33Wave2ManifestEntry {
  readonly id: string;
  readonly domain: string;
  readonly registryTypeId: string;
  readonly credentialType: string;
  readonly normalizedInputSha256: string;
}

export interface ParsedS33Wave2BatchManifest {
  readonly batchId: string;
  readonly revision: number;
  readonly baseRegistryDigestSha256: string;
  readonly source: Readonly<{ path: string; exportName: string; blobSha: string }>;
  readonly datasheet: Readonly<{ path: string; blobSha: string }>;
  readonly testPath: string;
  readonly entryCount: number;
  readonly entries: readonly S33Wave2ManifestEntry[];
  readonly rawSha256: string;
  readonly canonicalSha256: string;
}

export interface S33Wave2CandidateSnapshot {
  readonly candidateBaseSha: string;
  readonly candidateHeadSha: string;
  readonly candidateTreeSha: string;
  readonly changedPaths: readonly Readonly<{
    status: string;
    path: string;
    mode: string;
    objectType: string;
    blobSha: string;
  }>[];
  readonly manifestPath: string;
  readonly manifestContent: string;
  readonly sourceContent: string;
  readonly datasheetContent: string;
  readonly testContent: string;
  readonly coverageRegistryContent: string;
  readonly parsedEntries: readonly JsonRecord[];
  readonly leakageCorpus: readonly CorpusFile[];
  readonly leakageCorpusRootCounts: Readonly<Record<'training-data' | 'src/ai' | 'scripts', number>>;
}

export interface S33Wave2BatchPreflight {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-wave2-batch-preflight';
  readonly candidateBaseSha: string;
  readonly candidateHeadSha: string;
  readonly candidateTreeSha: string;
  readonly manifestPath: string;
  readonly manifest: ParsedS33Wave2BatchManifest;
  readonly coverageRegistry: Readonly<{
    path: typeof COVERAGE_REGISTRY_PATH;
    rawSha256: string;
    canonicalSha256: string;
  }>;
  readonly registryEntries: readonly S33Wave2RegistryEntry[];
  readonly acceptanceEntries: readonly S33Wave2AcceptedEntryInput[];
  readonly batch: S33Wave2RegistryBatch;
  readonly leakage: Readonly<{ corpusFileCount: number; comparisons: number; exactMatchCount: 0 }>;
  readonly artifactDigestSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicaliseJson(actual) !== canonicaliseJson(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function objectId(value: unknown, label: string): string {
  const result = text(value, label);
  if (!GIT_OBJECT.test(result)) throw new Error(`${label} must be a full lowercase SHA-1 Git object id`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function parseManifest(content: string, manifestPath: string): ParsedS33Wave2BatchManifest {
  const pathMatch = MANIFEST_PATH.exec(manifestPath);
  if (!pathMatch) throw new Error('Wave-2 manifest path is unauthorized');
  const slug = pathMatch[1];
  const document = parseStrictJsonDocument(content, 'Wave-2 batch manifest');
  const parsed = document.parsed as JsonRecord;
  exactKeys(parsed, [
    'schemaVersion', 'artifactType', 'batchId', 'revision', 'producerLane',
    'acceptanceAuthority', 'status', 'intendedSplit', 'acceptanceScope',
    'baseRegistryDigestSha256', 'source', 'datasheet', 'testPath', 'entryCount', 'entries',
  ], 'Wave-2 batch manifest');
  if (parsed.schemaVersion !== 1 || parsed.artifactType !== 'arkova-s33-wave2-batch-manifest'
    || parsed.batchId !== `S33-W2-${slug.toUpperCase()}` || parsed.producerLane !== 'Lane 4'
    || parsed.acceptanceAuthority !== 'Lane 3'
    || parsed.status !== 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE'
    || parsed.intendedSplit !== 'held-out-candidate' || parsed.acceptanceScope !== 'whole-batch-only') {
    throw new Error('Wave-2 manifest identity/authority/status/scope tuple is invalid');
  }
  const revision = positiveInteger(parsed.revision, 'Wave-2 manifest revision');
  const source = record(parsed.source, 'Wave-2 manifest source');
  exactKeys(source, ['path', 'exportName', 'blobSha'], 'Wave-2 manifest source');
  const datasheet = record(parsed.datasheet, 'Wave-2 manifest datasheet');
  exactKeys(datasheet, ['path', 'blobSha'], 'Wave-2 manifest datasheet');
  const expectedSource = `services/worker/src/ai/eval/golden-dataset-s33-wave2-${slug}-heldout.ts`;
  const expectedTest = `services/worker/src/ai/eval/golden-dataset-s33-wave2-${slug}-heldout.test.ts`;
  const expectedDatasheet = `docs/lane4/s33-wave2-batches/${slug}/datasheet.json`;
  if (source.path !== expectedSource || parsed.testPath !== expectedTest || datasheet.path !== expectedDatasheet) {
    throw new Error('Wave-2 manifest declares an unauthorized source, test, or datasheet path');
  }
  const exportName = text(source.exportName, 'Wave-2 source exportName');
  if (!/^S33_WAVE2_[A-Z0-9_]+_HELDOUT$/u.test(exportName)) throw new Error('Wave-2 source exportName is invalid');
  const entryCount = positiveInteger(parsed.entryCount, 'Wave-2 manifest entryCount');
  if (entryCount > 2_000 || !Array.isArray(parsed.entries) || parsed.entries.length !== entryCount) {
    throw new Error('Wave-2 manifest entries must be one complete batch of at most 2000 rows');
  }
  const entries = parsed.entries.map((candidate, index): S33Wave2ManifestEntry => {
    const entry = record(candidate, `Wave-2 manifest entries[${index}]`);
    exactKeys(
      entry,
      ['id', 'domain', 'registryTypeId', 'credentialType', 'normalizedInputSha256'],
      `Wave-2 manifest entries[${index}]`,
    );
    return {
      id: text(entry.id, `Wave-2 manifest entries[${index}].id`),
      domain: text(entry.domain, `Wave-2 manifest entries[${index}].domain`),
      registryTypeId: text(entry.registryTypeId, `Wave-2 manifest entries[${index}].registryTypeId`),
      credentialType: text(entry.credentialType, `Wave-2 manifest entries[${index}].credentialType`),
      normalizedInputSha256: digest(entry.normalizedInputSha256, `Wave-2 manifest entries[${index}].normalizedInputSha256`),
    };
  });
  if (new Set(entries.map(({ id }) => id)).size !== entryCount
    || new Set(entries.map(({ normalizedInputSha256 }) => normalizedInputSha256)).size !== entryCount) {
    throw new Error('Wave-2 manifest contains duplicate ids or normalized inputs');
  }
  return deepFreeze({
    batchId: parsed.batchId as string,
    revision,
    baseRegistryDigestSha256: digest(parsed.baseRegistryDigestSha256, 'Wave-2 base registry digest'),
    source: { path: expectedSource, exportName, blobSha: objectId(source.blobSha, 'Wave-2 source blob') },
    datasheet: { path: expectedDatasheet, blobSha: objectId(datasheet.blobSha, 'Wave-2 datasheet blob') },
    testPath: expectedTest,
    entryCount,
    entries,
    rawSha256: document.rawSha256,
    canonicalSha256: document.canonicalSha256,
  });
}

interface ParsedDatasheetRow {
  id: string;
  domain: string;
  credentialType: string;
  subType: string;
  jurisdiction: string;
  edgeCase: boolean;
  authorshipMethod: 'real-source' | 'independently-authored';
}

interface ParsedCoverageRegistry {
  path: typeof COVERAGE_REGISTRY_PATH;
  rawSha256: string;
  canonicalSha256: string;
  mappingsByTypeId: ReadonlyMap<string, ReadonlySet<string>>;
}

function parseCoverageRegistry(content: string): ParsedCoverageRegistry {
  const document = parseStrictJsonDocument(content, 'Wave-2 top-15 coverage registry');
  const parsed = document.parsed as JsonRecord;
  exactKeys(parsed, [
    'schemaVersion', 'artifactType', 'status', 'decisionRecord', 'coveragePolicy',
    'acceptedBaseline', 'domains',
  ], 'Wave-2 top-15 coverage registry');
  if (parsed.schemaVersion !== 1 || parsed.artifactType !== 'arkova-s33-wave2-top15-registry'
    || parsed.status !== 'CTO_SIGNED_SCOPE' || !Array.isArray(parsed.domains) || parsed.domains.length !== 3) {
    throw new Error('Wave-2 top-15 coverage registry identity/status/domain tuple is invalid');
  }
  const policy = record(parsed.coveragePolicy, 'Wave-2 top-15 coverage policy');
  exactKeys(policy, [
    'minimumHeldoutPerType', 'targetEdgeCaseRatio', 'minimumProductionValidSubstantiveFields',
    'acceptedAuthorshipMethods', 'generatorDerivedAllowed', 'trainingExposedAllowed',
    'acceptanceLane',
  ], 'Wave-2 top-15 coverage policy');
  if (policy.minimumHeldoutPerType !== 12 || policy.targetEdgeCaseRatio !== 0.3
    || policy.minimumProductionValidSubstantiveFields !== 5
    || canonicaliseJson(policy.acceptedAuthorshipMethods) !== canonicaliseJson(['real-source', 'independently-authored'])
    || policy.generatorDerivedAllowed !== false || policy.trainingExposedAllowed !== false
    || policy.acceptanceLane !== 'lane3') {
    throw new Error('Wave-2 top-15 coverage policy does not match the CTO-approved scope');
  }
  const mappingsByTypeId = new Map<string, ReadonlySet<string>>();
  parsed.domains.forEach((candidate, domainIndex) => {
    const domain = record(candidate, `Wave-2 coverage domains[${domainIndex}]`);
    exactKeys(domain, ['id', 'order', 'types'], `Wave-2 coverage domains[${domainIndex}]`);
    if (domain.order !== domainIndex + 1 || !Array.isArray(domain.types) || domain.types.length !== 15) {
      throw new Error(`Wave-2 coverage domain ${domainIndex} must contain the ordered top 15`);
    }
    domain.types.forEach((typeCandidate, typeIndex) => {
      const type = record(typeCandidate, `Wave-2 coverage domains[${domainIndex}].types[${typeIndex}]`);
      exactKeys(type, ['id', 'order', 'documentType', 'mappings'], `Wave-2 coverage type ${typeIndex}`);
      const typeId = text(type.id, `Wave-2 coverage type ${typeIndex}.id`);
      if (type.order !== typeIndex + 1 || mappingsByTypeId.has(typeId)
        || !Array.isArray(type.mappings) || type.mappings.length < 1) {
        throw new Error(`Wave-2 coverage type ${typeId} order/id/mappings are invalid`);
      }
      text(type.documentType, `Wave-2 coverage type ${typeId}.documentType`);
      const mappings = new Set(type.mappings.map((mappingCandidate, mappingIndex) => {
        const mapping = record(mappingCandidate, `Wave-2 coverage type ${typeId}.mappings[${mappingIndex}]`);
        exactKeys(mapping, ['credentialType', 'subType'], `Wave-2 coverage type ${typeId} mapping`);
        return `${text(mapping.credentialType, 'Wave-2 mapping credentialType')}\u0000${text(mapping.subType, 'Wave-2 mapping subType')}`;
      }));
      if (mappings.size !== type.mappings.length) throw new Error(`Wave-2 coverage type ${typeId} has duplicate mappings`);
      mappingsByTypeId.set(typeId, mappings);
    });
  });
  if (mappingsByTypeId.size !== 45) throw new Error('Wave-2 coverage registry must contain exactly 45 unique types');
  return deepFreeze({
    path: COVERAGE_REGISTRY_PATH,
    rawSha256: document.rawSha256,
    canonicalSha256: document.canonicalSha256,
    mappingsByTypeId,
  }) as ParsedCoverageRegistry;
}

function parseDatasheet(
  content: string,
  manifest: ParsedS33Wave2BatchManifest,
): readonly ParsedDatasheetRow[] {
  const parsed = parseStrictJsonDocument(content, 'Wave-2 batch datasheet').parsed as JsonRecord;
  exactKeys(parsed, [
    'schemaVersion', 'artifactType', 'batchId', 'revision', 'producerLane',
    'acceptanceAuthority', 'status', 'containsProductionUserDocuments',
    'authorshipNote', 'entryCount', 'rows',
  ], 'Wave-2 batch datasheet');
  if (parsed.schemaVersion !== 1 || parsed.artifactType !== 'arkova-s33-wave2-batch-datasheet'
    || parsed.batchId !== manifest.batchId || parsed.revision !== manifest.revision
    || parsed.producerLane !== 'Lane 4' || parsed.acceptanceAuthority !== 'Lane 3'
    || parsed.status !== 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE'
    || parsed.containsProductionUserDocuments !== false
    || parsed.entryCount !== manifest.entryCount
    || !Array.isArray(parsed.rows) || parsed.rows.length !== manifest.entryCount) {
    throw new Error('Wave-2 datasheet identity/provenance/count tuple is invalid');
  }
  const authorshipNote = text(parsed.authorshipNote, 'Wave-2 datasheet authorshipNote').toLowerCase();
  if (!authorshipNote.includes('independent') && !authorshipNote.includes('real source')
    && !authorshipNote.includes('real-source')) {
    throw new Error('Wave-2 datasheet must document real-source or independent authorship');
  }
  return parsed.rows.map((candidate, index): ParsedDatasheetRow => {
    const row = record(candidate, `Wave-2 datasheet rows[${index}]`);
    exactKeys(row, [
      'id', 'domain', 'credentialType', 'subType', 'jurisdiction', 'edgeCase', 'edgeClass',
      'authorshipMethod', 'realOrSynthetic', 'independentlyCurated', 'generatorDerived',
      'trainingExposed', 'generatorName', 'generatorVersion', 'seed', 'templateId',
      'sourceGrounding', 'curationAuthor', 'curationDate', 'licenseConsentNote',
    ], `Wave-2 datasheet rows[${index}]`);
    const authorshipMethod = row.authorshipMethod;
    if (!['real-source', 'independently-authored'].includes(authorshipMethod as string)
      || row.generatorDerived !== false || row.trainingExposed !== false
      || row.generatorName !== null || row.generatorVersion !== null
      || row.seed !== null || row.templateId !== null) {
      throw new Error(`Wave-2 datasheet row ${index} is generator-derived or lacks independent provenance`);
    }
    const authorshipShapeValid = authorshipMethod === 'independently-authored'
      ? row.realOrSynthetic === 'synthetic-realistic' && row.independentlyCurated === true
      : row.realOrSynthetic === 'real' && row.independentlyCurated === false;
    if (!authorshipShapeValid) throw new Error(`Wave-2 datasheet row ${index} authorship fields disagree`);
    if (row.curationAuthor !== 'Arkova Lane 4'
      || !/^\d{4}-\d{2}-\d{2}$/u.test(text(row.curationDate, `Wave-2 datasheet rows[${index}].curationDate`))
      || text(row.sourceGrounding, `Wave-2 datasheet rows[${index}].sourceGrounding`).length < 20
      || text(row.licenseConsentNote, `Wave-2 datasheet rows[${index}].licenseConsentNote`).length < 20) {
      throw new Error(`Wave-2 datasheet row ${index} has missing provenance`);
    }
    if (typeof row.edgeCase !== 'boolean'
      || (row.edgeCase ? typeof row.edgeClass !== 'string' || row.edgeClass.trim().length === 0 : row.edgeClass !== null)) {
      throw new Error(`Wave-2 datasheet row ${index} edge-case declaration is invalid`);
    }
    return {
      id: text(row.id, `Wave-2 datasheet rows[${index}].id`),
      domain: text(row.domain, `Wave-2 datasheet rows[${index}].domain`),
      credentialType: text(row.credentialType, `Wave-2 datasheet rows[${index}].credentialType`),
      subType: text(row.subType, `Wave-2 datasheet rows[${index}].subType`),
      jurisdiction: text(row.jurisdiction, `Wave-2 datasheet rows[${index}].jurisdiction`),
      edgeCase: row.edgeCase,
      authorshipMethod: authorshipMethod as ParsedDatasheetRow['authorshipMethod'],
    };
  });
}

export function findS33Wave2PiiFindings(value: string): readonly string[] {
  const findings: string[] = [];
  const patterns: readonly [string, RegExp][] = [
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ['ssn', /\b\d{3}-\d{2}-\d{4}\b/u],
    ['phone', /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/u],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
    ['api-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
    ['wif-private-key', /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/u],
    ['raw-person-label', /\b(?:holder|recipient|registrant|candidate|student|attendee|participant)\s*:\s*(?!\[)[A-Z][a-z]+\s+[A-Z][a-z]+/u],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(value)) findings.push(label);
  return findings;
}

function validateCandidateRows(
  snapshot: S33Wave2CandidateSnapshot,
  manifest: ParsedS33Wave2BatchManifest,
  datasheet: readonly ParsedDatasheetRow[],
  registry: S33Wave2CorpusRegistry,
  coverageRegistry: ParsedCoverageRegistry,
): Readonly<{
  registryEntries: readonly S33Wave2RegistryEntry[];
  acceptanceEntries: readonly S33Wave2AcceptedEntryInput[];
}> {
  if (snapshot.parsedEntries.length !== manifest.entryCount) throw new Error('Wave-2 source row count is not the whole manifest batch');
  const knownIds = new Set(registry.entries.map(({ id }) => id));
  const knownInputs = new Set(registry.entries.map(({ normalizedInputSha256 }) => normalizedInputSha256));
  const acceptanceEntries: S33Wave2AcceptedEntryInput[] = [];
  const registryEntries = snapshot.parsedEntries.map((candidate, index): S33Wave2RegistryEntry => {
    const manifestEntry = manifest.entries[index];
    const datasheetRow = datasheet[index];
    const id = text(candidate.id, `Wave-2 source entries[${index}].id`);
    const strippedText = text(candidate.strippedText, `Wave-2 source entries[${index}].strippedText`);
    const groundTruth = record(candidate.groundTruth, `Wave-2 source entries[${index}].groundTruth`);
    const normalizedInputSha256 = sha256(normalizeForFingerprint(strippedText));
    if (id !== manifestEntry.id || id !== datasheetRow.id
      || manifestEntry.normalizedInputSha256 !== normalizedInputSha256
      || manifestEntry.domain !== datasheetRow.domain
      || manifestEntry.credentialType !== datasheetRow.credentialType
      || groundTruth.credentialType !== manifestEntry.credentialType
      || groundTruth.subType !== datasheetRow.subType
      || candidate.jurisdictionSlice !== datasheetRow.jurisdiction
      || candidate.edgeCase !== datasheetRow.edgeCase) {
      throw new Error(`Wave-2 manifest/source/datasheet bijection failed at ${id}`);
    }
    const allowedMappings = coverageRegistry.mappingsByTypeId.get(manifestEntry.registryTypeId);
    if (!allowedMappings?.has(`${manifestEntry.credentialType}\u0000${datasheetRow.subType}`)) {
      throw new Error(`Wave-2 entry ${id} does not match registry type ${manifestEntry.registryTypeId}`);
    }
    if (candidate.provenance !== 'authored-s33-lane4'
      || typeof candidate.source !== 'string'
      || !candidate.source.startsWith('authored/s33-wave2/')) {
      throw new Error(`Wave-2 entry ${id} has missing or unauthorized provenance`);
    }
    const tags = candidate.tags;
    if (!Array.isArray(tags)
      || !['held-out', 's33', 'authored'].every((tag) => tags.includes(tag))
      || tags.some((tag) => typeof tag === 'string' && /train|generator|template/iu.test(tag))) {
      throw new Error(`Wave-2 entry ${id} tags do not preserve held-out provenance`);
    }
    const piiFindings = findS33Wave2PiiFindings(strippedText);
    if (piiFindings.length > 0) throw new Error(`Wave-2 entry ${id} contains PII/secrets: ${piiFindings.join(', ')}`);
    if (typeof groundTruth.recipientIdentifier === 'string'
      && !/^\[[A-Z_]+_REDACTED\]$/u.test(groundTruth.recipientIdentifier)
      && !/^sha256:[0-9a-f]{64}$/u.test(groundTruth.recipientIdentifier)) {
      throw new Error(`Wave-2 entry ${id} contains an unredacted recipientIdentifier`);
    }
    assertS33HeldoutGroundTruthContract([{ id, groundTruth }]);
    if (knownIds.has(id)) throw new Error(`Wave-2 duplicate entry id: ${id}`);
    if (knownInputs.has(normalizedInputSha256)) throw new Error(`Wave-2 duplicate normalized input: ${id}`);
    knownIds.add(id);
    knownInputs.add(normalizedInputSha256);
    const productionValidSubstantiveFieldCount = countS33SubstantiveGroundTruthFields(
      groundTruth as unknown as GroundTruthFields,
    );
    acceptanceEntries.push({
      id,
      registryTypeId: manifestEntry.registryTypeId,
      batchId: manifest.batchId,
      revision: manifest.revision,
      credentialType: manifestEntry.credentialType,
      subType: datasheetRow.subType,
      normalizedInputSha256,
      groundTruthSha256: sha256(canonicaliseJson(groundTruth)),
      authorshipMethod: datasheetRow.authorshipMethod,
      generatorDerived: false,
      trainingExposed: false,
      intendedSplit: 'held-out',
      productionValidSubstantiveFieldCount,
      edgeCase: datasheetRow.edgeCase,
      sourceBlobSha: manifest.source.blobSha,
    });
    return {
      ...manifestEntry,
      batchId: manifest.batchId,
      revision: manifest.revision,
      sourcePath: manifest.source.path,
    };
  });
  const edgeCount = datasheet.filter(({ edgeCase }) => edgeCase).length;
  const edgeRatio = edgeCount / datasheet.length;
  if (datasheet.length >= 4 && (edgeRatio < 0.25 || edgeRatio > 0.4)) {
    throw new Error('Wave-2 batch edge-case share must remain approximately 30% (25%-40%)');
  }
  return deepFreeze({ registryEntries, acceptanceEntries });
}

/** Validate a candidate snapshot using only trusted-main evaluator code. */
export function preflightS33Wave2BatchCandidate(
  registry: S33Wave2CorpusRegistry,
  snapshot: S33Wave2CandidateSnapshot,
): S33Wave2BatchPreflight {
  if (snapshot.candidateBaseSha !== registry.verificationHeadSha) throw new Error('Wave-2 candidate base is stale');
  objectId(snapshot.candidateHeadSha, 'Wave-2 candidate head');
  objectId(snapshot.candidateTreeSha, 'Wave-2 candidate tree');
  const manifest = parseManifest(snapshot.manifestContent, snapshot.manifestPath);
  if (manifest.baseRegistryDigestSha256 !== registry.registryDigestSha256) throw new Error('Wave-2 candidate registry digest is stale');
  if (sha256(snapshot.sourceContent) === '' || snapshot.sourceContent.trim().length === 0 || snapshot.testContent.trim().length === 0) {
    throw new Error('Wave-2 source and non-executed test evidence must be non-empty');
  }
  const expectedPaths = [snapshot.manifestPath, manifest.datasheet.path, manifest.source.path, manifest.testPath].sort();
  const actualPaths = snapshot.changedPaths.map(({ path }) => path).sort();
  if (canonicaliseJson(actualPaths) !== canonicaliseJson(expectedPaths)
    || snapshot.changedPaths.some(({ status, mode, objectType }) => (
      status !== 'A' || mode !== '100644' || objectType !== 'blob'
    ))) {
    throw new Error('Wave-2 candidate contains unauthorized paths, statuses, modes, or object types');
  }
  const sourcePath = snapshot.changedPaths.find(({ path }) => path === manifest.source.path);
  const datasheetPath = snapshot.changedPaths.find(({ path }) => path === manifest.datasheet.path);
  if (!sourcePath || !datasheetPath) throw new Error('Wave-2 required packet paths are missing');
  const sourceBlob = objectId(manifest.source.blobSha, 'Wave-2 manifest source blob');
  const datasheetBlob = objectId(manifest.datasheet.blobSha, 'Wave-2 manifest datasheet blob');
  if (sourcePath.blobSha !== sourceBlob || datasheetPath.blobSha !== datasheetBlob) {
    throw new Error('Wave-2 source/datasheet blob does not match the exact candidate path');
  }
  if (sha256(snapshot.sourceContent) === sha256('') || sha256(snapshot.datasheetContent) === sha256('')) {
    throw new Error('Wave-2 packet source/datasheet is empty');
  }

  const datasheet = parseDatasheet(snapshot.datasheetContent, manifest);
  const coverageRegistry = parseCoverageRegistry(snapshot.coverageRegistryContent);
  const { registryEntries, acceptanceEntries } = validateCandidateRows(
    snapshot,
    manifest,
    datasheet,
    registry,
    coverageRegistry,
  );
  for (const root of ['training-data', 'src/ai', 'scripts'] as const) {
    if (!Number.isSafeInteger(snapshot.leakageCorpusRootCounts[root])
      || snapshot.leakageCorpusRootCounts[root] < 1) {
      throw new Error(`Wave-2 leakage corpus root is empty: ${root}`);
    }
  }
  if (snapshot.leakageCorpus.length === 0) throw new Error('Wave-2 leakage corpus is empty');
  const heldout = snapshot.parsedEntries.map((entry) => ({
    id: text(entry.id, 'Wave-2 leakage id'),
    strippedText: text(entry.strippedText, 'Wave-2 leakage text'),
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }));
  const directLeakage = checkHeldoutLeakage(heldout, snapshot.leakageCorpus);
  if (directLeakage.length > 0) throw new Error(`Wave-2 held-out full-text/id leakage detected (${directLeakage.length})`);
  const exactLeakage = scanS33ExactLexicalLeakage(
    heldout.map(({ id, strippedText }) => ({ id, text: strippedText })),
    snapshot.leakageCorpus.map(({ path, content }) => ({ id: path, text: content })),
  );
  if (exactLeakage.hits.length > 0) {
    const first = exactLeakage.hits[0];
    throw new Error(`Wave-2 exact lexical leakage at n=${first.n}: ${first.heldoutId} -> ${first.corpusId}`);
  }
  const batch: S33Wave2RegistryBatch = {
    batchId: manifest.batchId,
    revision: manifest.revision,
    manifestPath: snapshot.manifestPath,
    manifestRawSha256: manifest.rawSha256,
    sourcePath: manifest.source.path,
    sourceBlobSha: sourceBlob,
    datasheetPath: manifest.datasheet.path,
    datasheetBlobSha: datasheetBlob,
    entryCount: manifest.entryCount,
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    artifactType: 'arkova-s33-wave2-batch-preflight' as const,
    candidateBaseSha: snapshot.candidateBaseSha,
    candidateHeadSha: snapshot.candidateHeadSha,
    candidateTreeSha: snapshot.candidateTreeSha,
    manifestPath: snapshot.manifestPath,
    manifest,
    coverageRegistry: {
      path: coverageRegistry.path,
      rawSha256: coverageRegistry.rawSha256,
      canonicalSha256: coverageRegistry.canonicalSha256,
    },
    registryEntries,
    acceptanceEntries,
    batch,
    leakage: {
      corpusFileCount: snapshot.leakageCorpus.length,
      comparisons: exactLeakage.comparisons,
      exactMatchCount: 0 as const,
    },
  };
  return deepFreeze({ ...withoutDigest, artifactDigestSha256: sha256(canonicaliseJson(withoutDigest)) });
}

/** Authenticate Lane-3 authority and bind it to a recomputed whole-batch preflight. */
export function acceptS33Wave2BatchCandidate(input: Readonly<{
  registry: S33Wave2CorpusRegistry;
  snapshot: S33Wave2CandidateSnapshot;
  pullRequestNumber: number;
  authenticatedAcceptance: unknown;
  testOnlyTrustRoot?: S33Wave2AcceptanceTrustRoot;
}>): S33Wave2AuthenticatedBatchAcceptance {
  const preflight = preflightS33Wave2BatchCandidate(input.registry, input.snapshot);
  const resultingRegistry = extendS33Wave2CorpusRegistry(
    input.registry,
    preflight.batch,
    preflight.registryEntries,
  );
  const acceptedEntryOrderSha256 = computeS33Wave2AcceptedEntryOrderSha256(
    preflight.acceptanceEntries.map(({ id }) => id),
  );
  const verified = verifyS33Wave2AuthenticatedBatchAcceptance(
    input.authenticatedAcceptance,
    {
      repositoryIdentity: 'carson-see/ArkovaCarson',
      pullRequestNumber: input.pullRequestNumber,
      candidateBaseSha: input.snapshot.candidateBaseSha,
      candidateHeadSha: input.snapshot.candidateHeadSha,
      candidateTreeSha: input.snapshot.candidateTreeSha,
      batchId: preflight.manifest.batchId,
      revision: preflight.manifest.revision,
      manifestPath: preflight.manifestPath,
      manifestRawSha256: preflight.manifest.rawSha256,
      manifestCanonicalSha256: preflight.manifest.canonicalSha256,
      sourceBlobSha: preflight.manifest.source.blobSha,
      datasheetBlobSha: preflight.manifest.datasheet.blobSha,
      preflightArtifactDigestSha256: preflight.artifactDigestSha256,
      baseRegistryDigestSha256: input.registry.registryDigestSha256,
      resultingRegistryDigestSha256: resultingRegistry.registryDigestSha256,
      coverageRegistryPath: preflight.coverageRegistry.path,
      coverageRegistryRawSha256: preflight.coverageRegistry.rawSha256,
      coverageRegistryCanonicalSha256: preflight.coverageRegistry.canonicalSha256,
      acceptedEntryOrderSha256,
    },
    input.testOnlyTrustRoot ? { testOnlyTrustRoot: input.testOnlyTrustRoot } : undefined,
  );
  const signedEntries = verified.payload.acceptedEntries.map(({ entryCanonicalSha256: _fingerprint, ...entry }) => entry);
  if (canonicaliseJson(signedEntries) !== canonicaliseJson(preflight.acceptanceEntries)) {
    throw new Error('Wave-2 authenticated per-entry facts do not match trusted-main recomputation');
  }
  return verified;
}

export interface S33Wave2TrustedMainConsumption {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-wave2-trusted-main-consumption';
  readonly repositoryIdentity: 'carson-see/ArkovaCarson';
  readonly pullRequestNumber: number;
  readonly candidateHeadSha: string;
  readonly candidateTreeSha: string;
  readonly mergedMainHeadSha: string;
  readonly mergedMainTreeSha: string;
  readonly batchId: string;
  readonly revision: number;
  readonly acceptanceArtifactDigestSha256: string;
  readonly resultingRegistryDigestSha256: string;
  readonly packetBlobs: readonly Readonly<{ path: string; blobSha: string }>[];
  readonly artifactDigestSha256: string;
}

/** Prove that the exact authenticated candidate packet is now reachable from trusted main. */
export function verifyS33Wave2MergedBatch(input: Readonly<{
  mergedMainRepositoryRoot: string;
  mergedMainHeadSha: string;
  snapshot: S33Wave2CandidateSnapshot;
  acceptance: S33Wave2AuthenticatedBatchAcceptance;
}>): S33Wave2TrustedMainConsumption {
  objectId(input.mergedMainHeadSha, 'Wave-2 merged-main head');
  const repositoryRoot = realpathSync(input.mergedMainRepositoryRoot);
  const resolvedHead = git(repositoryRoot, ['rev-parse', `${input.mergedMainHeadSha}^{commit}`], 'utf8').trim();
  if (resolvedHead !== input.mergedMainHeadSha || git(repositoryRoot, ['rev-parse', 'HEAD'], 'utf8').trim() !== resolvedHead) {
    throw new Error('Wave-2 merged-main checkout is not the exact declared commit');
  }
  if (input.acceptance.payload.candidateHeadSha !== input.snapshot.candidateHeadSha
    || input.acceptance.payload.candidateTreeSha !== input.snapshot.candidateTreeSha) {
    throw new Error('Wave-2 acceptance does not bind the candidate snapshot being consumed');
  }
  try {
    git(repositoryRoot, ['merge-base', '--is-ancestor', input.snapshot.candidateHeadSha, resolvedHead]);
  } catch (error) {
    throw new Error('Wave-2 authenticated candidate head is not reachable from merged main', { cause: error });
  }
  const packetBlobs = input.snapshot.changedPaths.map(({ path, blobSha }) => {
    const merged = mergedPathEvidence(repositoryRoot, resolvedHead, path);
    if (merged.blobSha !== blobSha) throw new Error(`Wave-2 merged packet blob differs from accepted candidate: ${path}`);
    return { path, blobSha };
  });
  if (git(repositoryRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--',
    ...packetBlobs.map(({ path }) => path),
  ], 'utf8').trim().length > 0) {
    throw new Error('Wave-2 merged-main packet checkout is dirty');
  }
  const payload = input.acceptance.payload;
  const withoutDigest = {
    schemaVersion: 1 as const,
    artifactType: 'arkova-s33-wave2-trusted-main-consumption' as const,
    repositoryIdentity: 'carson-see/ArkovaCarson' as const,
    pullRequestNumber: payload.pullRequestNumber,
    candidateHeadSha: payload.candidateHeadSha,
    candidateTreeSha: payload.candidateTreeSha,
    mergedMainHeadSha: resolvedHead,
    mergedMainTreeSha: git(repositoryRoot, ['rev-parse', `${resolvedHead}^{tree}`], 'utf8').trim(),
    batchId: payload.batchId,
    revision: payload.revision,
    acceptanceArtifactDigestSha256: input.acceptance.artifactDigestSha256,
    resultingRegistryDigestSha256: payload.resultingRegistryDigestSha256,
    packetBlobs,
  };
  return deepFreeze({ ...withoutDigest, artifactDigestSha256: sha256(canonicaliseJson(withoutDigest)) });
}

function git(repositoryRoot: string, args: readonly string[], encoding: 'utf8'): string;
function git(repositoryRoot: string, args: readonly string[]): Buffer;
function git(repositoryRoot: string, args: readonly string[], encoding?: 'utf8'): string | Buffer {
  return execFileSync(GIT, ['-C', repositoryRoot, ...args], {
    encoding, env: GIT_ENV, maxBuffer: 32 * 1024 * 1024,
  });
}

function changedPaths(repositoryRoot: string, base: string, head: string): S33Wave2CandidateSnapshot['changedPaths'] {
  const raw = git(repositoryRoot, ['diff', '--raw', '-z', '--no-renames', base, head], 'utf8');
  const tokens = raw.split('\0').filter(Boolean);
  const changes: Array<{ status: string; path: string; mode: string; objectType: string; blobSha: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index];
    const path = tokens[index + 1];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/u.exec(header);
    if (!match || !path || match[5].startsWith('R') || match[5].startsWith('C')) {
      throw new Error('Wave-2 candidate diff contains malformed, rename, or copy records');
    }
    const [, , mode, , objectIdValue, status] = match;
    let objectType = 'missing';
    if (objectIdValue !== '0'.repeat(objectIdValue.length)) {
      objectType = git(repositoryRoot, ['cat-file', '-t', objectIdValue], 'utf8').trim();
    }
    changes.push({ status, path, mode, objectType, blobSha: objectIdValue });
  }
  return changes;
}

/** Read a PR head as inert Git objects. Candidate TypeScript is parsed, never imported or executed. */
export function loadS33Wave2CandidateSnapshot(input: Readonly<{
  trustedMainWorkerRoot: string;
  candidateRepositoryRoot: string;
  candidateBaseSha: string;
  candidateHeadSha: string;
  registry: S33Wave2CorpusRegistry;
}>): S33Wave2CandidateSnapshot {
  objectId(input.candidateBaseSha, 'Wave-2 candidate base');
  objectId(input.candidateHeadSha, 'Wave-2 candidate head');
  const repositoryRoot = realpathSync(input.candidateRepositoryRoot);
  if (input.candidateBaseSha !== input.registry.verificationHeadSha) throw new Error('Wave-2 candidate base is stale');
  try {
    git(repositoryRoot, ['merge-base', '--is-ancestor', input.candidateBaseSha, input.candidateHeadSha]);
  } catch (error) {
    throw new Error('Wave-2 candidate does not descend from the exact trusted-main base', { cause: error });
  }
  const changes = changedPaths(repositoryRoot, input.candidateBaseSha, input.candidateHeadSha);
  const manifests = changes.map(({ path }) => path).filter((path) => MANIFEST_PATH.test(path));
  if (manifests.length !== 1) throw new Error('Wave-2 candidate must add exactly one batch manifest');
  const manifestPath = manifests[0];
  const manifestContent = git(repositoryRoot, ['show', `${input.candidateHeadSha}:${manifestPath}`], 'utf8');
  const manifest = parseManifest(manifestContent, manifestPath);
  const sourceContent = git(repositoryRoot, ['show', `${input.candidateHeadSha}:${manifest.source.path}`], 'utf8');
  const datasheetContent = git(repositoryRoot, ['show', `${input.candidateHeadSha}:${manifest.datasheet.path}`], 'utf8');
  const testContent = git(repositoryRoot, ['show', `${input.candidateHeadSha}:${manifest.testPath}`], 'utf8');
  if (git(repositoryRoot, ['rev-parse', `${input.candidateHeadSha}:${manifest.source.path}`], 'utf8').trim() !== manifest.source.blobSha
    || git(repositoryRoot, ['rev-parse', `${input.candidateHeadSha}:${manifest.datasheet.path}`], 'utf8').trim() !== manifest.datasheet.blobSha) {
    throw new Error('Wave-2 source/datasheet blobs do not match the candidate manifest');
  }
  const parsedEntries = parseS33ProducerModuleWithLimit(
    sourceContent,
    manifest.source.path,
    manifest.source.exportName,
    manifest.entryCount,
  );
  const exclusions = input.registry.acceptedBatches
    .map(({ sourcePath }) => sourcePath)
    .filter((path) => path.startsWith('services/worker/'))
    .map((path) => path.slice('services/worker/'.length));
  const trustedMainWorkerRoot = realpathSync(input.trustedMainWorkerRoot);
  const trustedMainRepositoryRoot = realpathSync(join(trustedMainWorkerRoot, '..', '..'));
  if (git(trustedMainRepositoryRoot, ['rev-parse', 'HEAD'], 'utf8').trim() !== input.registry.verificationHeadSha
    || git(trustedMainRepositoryRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--',
      'services/worker/training-data', 'services/worker/src/ai', 'services/worker/scripts',
    ], 'utf8').trim().length > 0) {
    throw new Error('Wave-2 leakage corpus checkout is not the exact clean trusted-main head');
  }
  const leakageCorpus = loadLeakageCorpus(trustedMainWorkerRoot, {
    failOnUnreadable: true,
    additionalExactSelfExclusions: exclusions,
  });
  const leakageCorpusRootCounts = {
    'training-data': leakageCorpus.filter(({ path }) => path.startsWith('training-data/')).length,
    'src/ai': leakageCorpus.filter(({ path }) => path.startsWith('src/ai/')).length,
    scripts: leakageCorpus.filter(({ path }) => path.startsWith('scripts/')).length,
  };
  let coverageRegistryContent: string;
  try {
    coverageRegistryContent = git(
      trustedMainRepositoryRoot,
      ['show', `${input.registry.verificationHeadSha}:${COVERAGE_REGISTRY_PATH}`],
      'utf8',
    );
  } catch (error) {
    throw new Error(`Wave-2 CTO coverage registry is missing from trusted main: ${COVERAGE_REGISTRY_PATH}`, { cause: error });
  }
  return deepFreeze({
    candidateBaseSha: input.candidateBaseSha,
    candidateHeadSha: input.candidateHeadSha,
    candidateTreeSha: git(repositoryRoot, ['rev-parse', `${input.candidateHeadSha}^{tree}`], 'utf8').trim(),
    changedPaths: changes,
    manifestPath,
    manifestContent,
    sourceContent,
    datasheetContent,
    testContent,
    coverageRegistryContent,
    parsedEntries,
    leakageCorpus,
    leakageCorpusRootCounts,
  });
}

function mergedPathEvidence(
  repositoryRoot: string,
  head: string,
  path: string,
): Readonly<{ status: 'A'; path: string; mode: string; objectType: string; blobSha: string }> {
  const line = git(repositoryRoot, ['ls-tree', head, '--', path], 'utf8').trim();
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t([^\r\n]+)$/u.exec(line);
  if (!match || match[4] !== path) throw new Error(`Merged Wave-2 packet path is missing: ${path}`);
  return { status: 'A', path, mode: match[1], objectType: match[2], blobSha: match[3] };
}

/**
 * Re-consume every already-merged Wave-2 batch from trusted main. Manifests
 * form a single digest chain, so stale parallel batches and ambiguous forks
 * fail instead of silently producing a registry in directory order.
 */
export function consumeMergedS33Wave2Batches(input: Readonly<{
  trustedMainRepositoryRoot: string;
  registry: S33Wave2CorpusRegistry;
}>): S33Wave2CorpusRegistry {
  const repositoryRoot = realpathSync(input.trustedMainRepositoryRoot);
  const head = input.registry.verificationHeadSha;
  const manifestPaths = git(repositoryRoot, [
    'ls-tree', '-r', '--name-only', head, '--', 'docs/lane4/s33-wave2-batches',
  ], 'utf8').split(/\r?\n/u).filter((path) => MANIFEST_PATH.test(path));
  if (manifestPaths.length === 0) return input.registry;
  if (git(repositoryRoot, ['rev-parse', 'HEAD'], 'utf8').trim() !== head
    || git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--',
      'docs/lane4/s33-wave2-batches', 'services/worker/training-data',
      'services/worker/src/ai', 'services/worker/scripts',
    ], 'utf8').trim().length > 0) {
    throw new Error('Merged Wave-2 consumption requires the exact clean trusted-main checkout');
  }
  const pending = new Map(manifestPaths.map((manifestPath) => {
    const content = git(repositoryRoot, ['show', `${head}:${manifestPath}`], 'utf8');
    return [manifestPath, { content, manifest: parseManifest(content, manifestPath) }];
  }));
  const mergedHeldoutSourcePaths = [...pending.values()].map(({ manifest }) => manifest.source.path);
  let registry = input.registry;
  while (pending.size > 0) {
    const next = [...pending.entries()].filter(([, { manifest }]) => (
      manifest.baseRegistryDigestSha256 === registry.registryDigestSha256
    ));
    if (next.length !== 1) {
      throw new Error(next.length === 0
        ? 'Merged Wave-2 manifests contain a stale or broken registry-digest chain'
        : 'Merged Wave-2 manifests fork the registry-digest chain');
    }
    const [manifestPath, { content: manifestContent, manifest }] = next[0];
    const sourceContent = git(repositoryRoot, ['show', `${head}:${manifest.source.path}`], 'utf8');
    const datasheetContent = git(repositoryRoot, ['show', `${head}:${manifest.datasheet.path}`], 'utf8');
    const testContent = git(repositoryRoot, ['show', `${head}:${manifest.testPath}`], 'utf8');
    const parsedEntries = parseS33ProducerModuleWithLimit(
      sourceContent, manifest.source.path, manifest.source.exportName, manifest.entryCount,
    );
    const exclusions = [
      ...registry.acceptedBatches.map(({ sourcePath }) => sourcePath),
      ...mergedHeldoutSourcePaths,
    ].filter((path) => path.startsWith('services/worker/'))
      .map((path) => path.slice('services/worker/'.length));
    const leakageCorpus = loadLeakageCorpus(join(repositoryRoot, 'services', 'worker'), {
      failOnUnreadable: true,
      additionalExactSelfExclusions: exclusions,
    });
    const snapshot: S33Wave2CandidateSnapshot = {
      candidateBaseSha: head,
      candidateHeadSha: head,
      candidateTreeSha: git(repositoryRoot, ['rev-parse', `${head}^{tree}`], 'utf8').trim(),
      changedPaths: [
        mergedPathEvidence(repositoryRoot, head, manifestPath),
        mergedPathEvidence(repositoryRoot, head, manifest.datasheet.path),
        mergedPathEvidence(repositoryRoot, head, manifest.source.path),
        mergedPathEvidence(repositoryRoot, head, manifest.testPath),
      ],
      manifestPath,
      manifestContent,
      sourceContent,
      datasheetContent,
      testContent,
      coverageRegistryContent: git(repositoryRoot, ['show', `${head}:${COVERAGE_REGISTRY_PATH}`], 'utf8'),
      parsedEntries,
      leakageCorpus,
      leakageCorpusRootCounts: {
        'training-data': leakageCorpus.filter(({ path }) => path.startsWith('training-data/')).length,
        'src/ai': leakageCorpus.filter(({ path }) => path.startsWith('src/ai/')).length,
        scripts: leakageCorpus.filter(({ path }) => path.startsWith('scripts/')).length,
      },
    };
    const preflight = preflightS33Wave2BatchCandidate(registry, snapshot);
    registry = extendS33Wave2CorpusRegistry(registry, preflight.batch, preflight.registryEntries);
    pending.delete(manifestPath);
  }
  return registry;
}

export const S33_WAVE2_BATCH_PATHS = Object.freeze({
  manifestPattern: MANIFEST_PATH.source,
  workerRootFromRepositoryRoot: join('services', 'worker'),
});
