/**
 * Trusted-main verifier for the Sprint 3.3 Wave-1 producer commit.
 *
 * Producer TypeScript is parsed as data and is never imported or executed.
 * Every Git fact is derived from the object database before mirrored manifest
 * or Markdown declarations are compared.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
  parseStrictJsonDocument,
  rawManifestHash,
  validateActiveS33Wave1PacketMirrors,
  type ParsedBatchManifest,
} from './s33-batch-acceptance.js';
import {
  S33_WAVE1_R12_EVIDENCE_PATH,
  S33_WAVE1_R12_EVIDENCE_REF,
  S33_WAVE1_R12_FREEZE_REF,
  verifyS33Wave1R12Evidence,
  type S33Wave1R12VerifiedEvidence,
} from './s33-wave1-dual-dag.js';
import {
  assertS33SourceParseDiagnostics,
  parseS33ProducerModule,
} from './s33-wave1-producer-parser.js';
export { assertS33SourceParseDiagnostics, parseS33ProducerModule };

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface ParsedProducerEntry {
  category: string;
  groundTruth: GroundTruthFields;
  id: string;
  sourcePath: string;
  strippedText: string;
}

export type S33Wave1ProducerManifestKind = 'legacy-blocked' | 'revision-12-dual-dag';

export const S33_WAVE1_R12_PRODUCER_TYPES_BLOB =
  'dcc94b716f18240787640ba07dcdd4ad46a7cfe6' as const;
export const S33_WAVE1_R12_CREDENTIAL_TYPE_COUNTS = Object.freeze({
  ATTESTATION: 3,
  BUSINESS_ENTITY: 2,
  CERTIFICATE: 4,
  CLE: 11,
  CPE: 31,
  DEGREE: 2,
  FINANCIAL: 1,
  IDENTITY: 1,
  LICENSE: 16,
  OTHER: 9,
  TRANSCRIPT: 1,
});

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
  dualDagEvidence: Readonly<S33Wave1DualDagEvidenceFacts> | null;
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

export interface S33Wave1DualDagEvidenceFacts {
  evidenceBlobSha: string;
  evidenceCanonicalSha256: string;
  evidenceCommitSha: string;
  evidencePath: typeof S33_WAVE1_R12_EVIDENCE_PATH;
  evidenceRawSha256: string;
  evidenceRef: typeof S33_WAVE1_R12_EVIDENCE_REF;
  evidenceTreeSha: string;
  finalCommitSha: string;
  finalRef: typeof S33_WAVE1_R12_FREEZE_REF;
  finalTreeSha: string;
  reportDigestSha256: string;
  revision12FailureCount: 0;
  revision12HeadSha: string;
  supportHeadSha: string;
  supportTreeSha: string;
  supportTypesBlobSha: string;
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
const WAVE1_PACKET_PATHS = Object.freeze([
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  ...WAVE1_SOURCE_BLOB_PATHS,
].sort(compareUtf16CodeUnits));

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
  const actual = Object.keys(value).sort(compareUtf16CodeUnits);
  const sortedExpected = [...expected].sort(compareUtf16CodeUnits);
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

function expectedCredentialCounts(status: unknown): Readonly<Record<string, number>> {
  return status === 'PRODUCER_R12_CANDIDATE_PENDING_L3_FORMAL_ACCEPTANCE'
    ? S33_WAVE1_R12_CREDENTIAL_TYPE_COUNTS
    : WAVE1_CREDENTIAL_TYPE_COUNTS;
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
  const actual = [...ids].sort(compareUtf16CodeUnits);
  const expected = [...WAVE1_ENTRY_IDS].sort(compareUtf16CodeUnits);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error('Producer corpus does not match the exact Wave-1 81-id universe');
  }
}

export function classifyS33Wave1ProducerManifest(
  manifestContent: string | Uint8Array,
): S33Wave1ProducerManifestKind {
  const document = parseStrictJsonDocument(manifestContent, 'Wave-1 producer dispatch manifest');
  const manifest = document.parsed;
  if (manifest.schemaVersion !== 1 || manifest.batchId !== 'S33-W1') {
    throw new Error('Wave-1 producer dispatch requires schemaVersion 1 and batchId S33-W1');
  }
  if (typeof manifest.revision !== 'number' || typeof manifest.status !== 'string') {
    throw new Error('Wave-1 producer dispatch requires the exact supported revision/status tuple');
  }
  if (manifest.revision === 10 && manifest.status === 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW') {
    return 'legacy-blocked';
  }
  if (manifest.revision === 12
    && manifest.status === 'PRODUCER_R12_CANDIDATE_PENDING_L3_FORMAL_ACCEPTANCE') {
    return 'revision-12-dual-dag';
  }
  throw new Error('Wave-1 producer dispatch status is not an approved contract');
}

interface VerifiedProducerProvenance {
  corpusSourceBlobs: Record<string, string>;
  producerChangedPaths: string[];
  producerParentSha: string;
  producerTreeSha: string;
  support: S33Wave1ProducerValidationReport['support'];
}

function r12ManifestFromVerifiedEvidence(
  manifestContent: Buffer,
  evidence: S33Wave1R12VerifiedEvidence,
): ParsedBatchManifest {
  const parsedJson = parseStrictJsonDocument(manifestContent, 'Verified revision-12 manifest').parsed;
  const entries = parsedJson.entries;
  if (!Array.isArray(entries) || entries.length !== 81) {
    throw new Error('Verified revision-12 manifest must contain exactly 81 entries');
  }
  const normalizedEntries = entries.map((value, index) => {
    if (!isRecord(value)) throw new Error(`Verified revision-12 manifest entry ${index} must be an object`);
    return {
      credentialType: requiredString(value.credentialType, `revision-12 manifest entry ${index}.credentialType`),
      domain: requiredString(value.domain, `revision-12 manifest entry ${index}.domain`),
      id: requiredString(value.id, `revision-12 manifest entry ${index}.id`),
      normalizedInputSha256: requiredString(
        value.normalizedInputSha256,
        `revision-12 manifest entry ${index}.normalizedInputSha256`,
      ),
    };
  });
  if (parsedJson.revision !== 12
    || parsedJson.batchId !== 'S33-W1'
    || parsedJson.schemaVersion !== 1
    || parsedJson.entryCount !== 81
    || parsedJson.intendedSplit !== 'held-out-candidate'
    || parsedJson.reviewOrder !== 'kenya-first'
    || parsedJson.acceptanceScope !== 'whole-batch-only') {
    throw new Error('Verified revision-12 manifest identity fields do not match the Wave-1 contract');
  }
  if (!isRecord(parsedJson.selfChecks)
    || !isRecord(parsedJson.selfChecks.lane3Acceptance)
    || parsedJson.selfChecks.lane3Acceptance.status !== 'NOT_RUN_PRODUCER_BOUNDARY') {
    throw new Error('Verified revision-12 manifest must remain NOT_RUN at the producer boundary');
  }
  if (evidence.report.revision12.headSha !== evidence.pins.revision12.headSha) {
    throw new Error('Verified revision-12 evidence report/pins disagree');
  }
  return {
    batchId: 'S33-W1',
    entries: normalizedEntries,
    entryCount: 81,
    intendedSplit: 'held-out-candidate',
    parsedJson: parsedJson as Record<string, unknown>,
    revision: 12,
    schemaVersion: 1,
  };
}

function r12Provenance(
  repositoryRoot: string,
  producerHeadSha: string,
  evidence: S33Wave1R12VerifiedEvidence,
): VerifiedProducerProvenance {
  const producerTreeSha = gitText(repositoryRoot, ['rev-parse', `${producerHeadSha}^{tree}`], 'r12 producer tree');
  assertGitObject(producerTreeSha, 'r12 producer tree');
  const corpusSourceBlobs = Object.fromEntries(WAVE1_SOURCE_BLOB_PATHS.map((path) => [
    path,
    evidence.report.revision12.packetBlobs[path],
  ]));
  const parentRetainedTypesBlob = gitBlob(
    repositoryRoot,
    evidence.pins.historical.headSha,
    WAVE1_TYPES_PATH,
    'r12 parent producer-tree types blob',
  );
  const producerTypesBlob = gitBlob(repositoryRoot, producerHeadSha, WAVE1_TYPES_PATH, 'r12 producer-tree types blob');
  if (parentRetainedTypesBlob !== S33_WAVE1_R12_PRODUCER_TYPES_BLOB
    || producerTypesBlob !== S33_WAVE1_R12_PRODUCER_TYPES_BLOB) {
    throw new Error('Revision-12 producer lineage must retain its exact independent dcc94b types blob');
  }
  return {
    corpusSourceBlobs,
    producerChangedPaths: [...evidence.report.revision12.immediateParentChangedPaths],
    producerParentSha: evidence.pins.historical.headSha,
    producerTreeSha,
    support: {
      commit: evidence.pins.supportBaseline.commitSha,
      parentRetainedTypesBlob,
      typesBlob: evidence.pins.supportBaseline.typesBlobSha,
      typesPath: WAVE1_TYPES_PATH,
    },
  };
}

function r12EvidenceFacts(
  repositoryRoot: string,
  evidence: S33Wave1R12VerifiedEvidence,
): Readonly<S33Wave1DualDagEvidenceFacts> {
  const evidenceTreeSha = gitText(
    repositoryRoot,
    ['rev-parse', `${evidence.commitSha}^{tree}`],
    'A12C evidence tree',
  );
  assertGitObject(evidenceTreeSha, 'A12C evidence tree');
  return deepFreeze({
    evidenceBlobSha: evidence.blobSha,
    evidenceCanonicalSha256: evidence.canonicalSha256,
    evidenceCommitSha: evidence.commitSha,
    evidencePath: S33_WAVE1_R12_EVIDENCE_PATH,
    evidenceRawSha256: evidence.rawSha256,
    evidenceRef: S33_WAVE1_R12_EVIDENCE_REF,
    evidenceTreeSha,
    finalCommitSha: evidence.report.final.headSha,
    finalRef: S33_WAVE1_R12_FREEZE_REF,
    finalTreeSha: evidence.report.final.treeSha,
    reportDigestSha256: evidence.report.reportDigestSha256,
    revision12FailureCount: evidence.report.revision12.failureCount,
    revision12HeadSha: evidence.report.revision12.headSha,
    supportHeadSha: evidence.report.support.headSha,
    supportTreeSha: evidence.report.support.treeSha,
    supportTypesBlobSha: evidence.report.support.typesBlobSha,
  });
}

function verifyProducerRevision(
  repositoryRoot: string,
  producerHeadSha: string,
  manifestContent: Buffer,
): Readonly<{
  dualDagEvidence: Readonly<S33Wave1DualDagEvidenceFacts> | null;
  manifest: ParsedBatchManifest;
  provenance: VerifiedProducerProvenance;
}> {
  if (classifyS33Wave1ProducerManifest(manifestContent) === 'legacy-blocked') {
    const manifest = validateActiveS33Wave1PacketMirrors(repositoryRoot, producerHeadSha, manifestContent);
    return {
      dualDagEvidence: null,
      manifest,
      provenance: verifyProvenance(repositoryRoot, producerHeadSha, manifest),
    };
  }
  const evidence = verifyS33Wave1R12Evidence({
    expectedProducerHeadSha: producerHeadSha,
    repositoryRoot,
  });
  return {
    dualDagEvidence: r12EvidenceFacts(repositoryRoot, evidence),
    manifest: r12ManifestFromVerifiedEvidence(manifestContent, evidence),
    provenance: r12Provenance(repositoryRoot, producerHeadSha, evidence),
  };
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
  }).sort(compareUtf16CodeUnits);
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
  const { dualDagEvidence, manifest, provenance } = verifyProducerRevision(
    input.repositoryRoot,
    input.producerHeadSha,
    manifestContent,
  );

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
  const expectedCredentialTypeCounts = expectedCredentialCounts(manifest.parsedJson.status);
  assertCountMap(byCredentialType, expectedCredentialTypeCounts, 'Actual producer credential-type counts');
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
    dualDagEvidence,
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

export function parseS33Wave1ProducerVerifierCliArgs(argv: readonly string[]): Readonly<{
  producerHeadSha: string;
  repositoryRoot: string;
}> {
  if (argv[0] !== 'verify') {
    throw new Error('S3.3 Wave-1 producer verifier requires the explicit verify command');
  }
  const values = new Map<string, string>();
  const args = argv.slice(1);
  if (args.length % 2 !== 0) {
    throw new Error('Invalid S3.3 Wave-1 producer verifier CLI arguments');
  }
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('Invalid or duplicated S3.3 Wave-1 producer verifier CLI argument');
    }
    values.set(key, value);
  }
  const allowed = ['--repository-root', '--producer-head'] as const;
  const unknown = [...values.keys()].filter((key) => !allowed.includes(key as (typeof allowed)[number]));
  const missing = allowed.filter((key) => !values.has(key));
  if (unknown.length > 0 || missing.length > 0 || values.size !== allowed.length) {
    throw new Error(
      `S3.3 Wave-1 producer verifier CLI arguments mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`,
    );
  }
  return Object.freeze({
    producerHeadSha: values.get('--producer-head')!,
    repositoryRoot: values.get('--repository-root')!,
  });
}

export function runS33Wave1ProducerVerifierCli(
  argv: readonly string[],
  write: (message: string) => void = (message): void => { process.stdout.write(message); },
): Readonly<S33Wave1ProducerValidationReport> {
  const input = parseS33Wave1ProducerVerifierCliArgs(argv);
  const report = verifyS33Wave1ProducerHead(input);
  write(
    `S3.3 Wave-1 producer verifier: PASS — producerHeadSha=${report.producerHeadSha}, reportDigestSha256=${report.reportDigestSha256}\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runS33Wave1ProducerVerifierCli(process.argv.slice(2));
}
