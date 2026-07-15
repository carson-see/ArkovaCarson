/**
 * Revision-12 dual-DAG verifier for the Sprint 3.3 Wave-1 corpus.
 *
 * The producer history and Lane-3 support history are independent. Provenance
 * is established by their pinned merge base plus a conflict-free virtual
 * merge, never by diffing the support tree directly against the producer tree.
 * Exact production SHAs and packet digests are deliberately supplied by a
 * code-owned descriptor only after Lane 4 freezes revision 12.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import type { GroundTruthFields } from './types.js';
import {
  evaluateS33HeldoutGroundTruthContract,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';
import {
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_CORPUS_SLICE_COUNTS,
  WAVE1_DOMAIN_COUNTS,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_ENTRY_IDS,
  WAVE1_KENYA_ENTRY_IDS,
  WAVE1_MANIFEST_PATH,
  WAVE1_OOD_ENTRY_IDS,
  WAVE1_SOURCE_BLOB_PATHS,
  WAVE1_TYPES_PATH,
  parseStrictJsonDocument,
} from './s33-batch-acceptance.js';
import { parseS33ProducerModule } from './s33-wave1-producer-parser.js';

const GIT_EXECUTABLE = '/usr/bin/git';
const GIT_ENV = Object.freeze({
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
});
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const HISTORICAL_STATUS = 'HISTORICAL_BLOCKED';
const HISTORICAL_ACCEPTANCE_STATUS = 'REJECTED_HISTORICAL_BLOCKED';

/**
 * Independently frozen Lane-3 support baseline. Candidate-dependent r11′,
 * r12, S12, and F12 pins are intentionally absent until Lane 4 freezes r12.
 */
export const S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE = deepFreeze({
  commitSha: 'e8a9ba3d2ba8023fe59781b6a0499c8208cc59af',
  treeSha: '9c797db5716062d8cef5bd54db7f952dde3bb7f4',
  typesBlobSha: 'fbc05660e4575c3c527204658571246f9294ceb9',
} as const);

const ACCEPTANCE_ONLY_CPE_IDS = deepFreeze([
  'GD-S33-NUR-001', 'GD-S33-NUR-002', 'GD-S33-NUR-003', 'GD-S33-NUR-005',
  'GD-S33-NUR-007', 'GD-S33-NUR-008', 'GD-S33-NUR-009', 'GD-S33-NUR-010',
  'GD-S33-NUR-011', 'GD-S33-NUR-012', 'GD-S33-PDH-001', 'GD-S33-PDH-003',
  'GD-S33-PDH-004', 'GD-S33-PDH-005', 'GD-S33-PDH-006', 'GD-S33-PDH-007',
  'GD-S33-PDH-008', 'GD-S33-PDH-010', 'GD-S33-PDH-011', 'GD-S33-PDH-012',
] as const);

/** Binding exact CPE20 universe owned by the production-depth contract. */
export const S33_WAVE1_R12_CPE_DEPTH_BINDING = deepFreeze({
  acceptanceOnlyCpeEntryCount: 20,
  acceptanceOnlyCpeEntryIdsSha256: '026f0d35107fb3f1eaefa8fdf2c8c9c205c74fbca4385ba6b24f09a752d2d27c',
  acceptanceOnlyCpeEntryIds: ACCEPTANCE_ONLY_CPE_IDS,
} as const);

/** Binding CTO adjudications; these are rulings, not candidate-dependent pins. */
export const S33_WAVE1_R12_BINDING_ADJUDICATIONS = deepFreeze({
  cpeSubtypeRatification: {
    status: 'PASS_ACCEPTANCE_EVALUATOR_ONLY',
    allowed: ['general_cpe', 'specialized_cpe', 'ethics_cpe'],
    scope: 'S3.3 Wave-1 acceptance/evaluator taxonomy only',
    v6SubtypeTaxonomyChanged: false,
    tuningExportApproved: false,
    modelMismatchDisposition: 'MODEL_HARD',
  },
  issuedDateAdjudicationSet: {
    status: 'PASS_CTO_L3_R12',
    entryIds: [
      'GD-S33-AU-002', 'GD-S33-AU-011', 'GD-S33-BAR-010', 'GD-S33-PDH-012',
    ],
    resolvedValues: {
      'GD-S33-AU-002': '2026-04-22',
      'GD-S33-AU-011': '2026-04-16',
      'GD-S33-BAR-010': '2026-01-05',
      'GD-S33-PDH-012': '2026-04-28',
    },
  },
  oodFiveFieldSemantics: {
    status: 'PASS_CTO_L3_R12_PURE_ABSTENTION',
    entryIds: WAVE1_OOD_ENTRY_IDS,
    producerTruth: 'Pure abstention labels contain only credentialType OTHER, subType other, and empty fraudSignals.',
    resolution: 'Binding CTO exception: these exact nine OOD rows are exempt from the covered-entry five-field and concrete-subtype floor; adding any other ground-truth key is forbidden.',
    authority: 'CTO ruling 2026-07-14',
  },
  taxonomyAdjudicationSet: {
    status: 'PASS_CTO_L3_R12',
    entryIds: [
      'GD-S33-KE-003', 'GD-S33-AU-003', 'GD-S33-KE-006', 'GD-S33-AU-010',
    ],
    resolvedValues: {
      'GD-S33-AU-003': 'LICENSE/law_bar_admission',
      'GD-S33-KE-003': 'LICENSE/law_bar_admission',
      'GD-S33-KE-006': 'IDENTITY/government_id',
      'GD-S33-AU-010': 'FINANCIAL/tax_return',
    },
  },
} as const);

export const S33_WAVE1_PACKET_PATHS = Object.freeze([
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  ...WAVE1_SOURCE_BLOB_PATHS,
].sort(compareCodeUnits));

/** Exact r11-prime -> r12 mutation edge; the unchanged OOD source is excluded. */
export const S33_WAVE1_R12_IMMEDIATE_CHANGED_PATHS = Object.freeze([
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_SOURCE_BLOB_PATHS[0],
  WAVE1_SOURCE_BLOB_PATHS[1],
].sort(compareCodeUnits));

const DUAL_DAG_SUPPORT_REVIEW_STATE = 'CTO_APPROVED_DUAL_DAG_R12_EVALUATOR_ROOT';
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'batchId', 'revision', 'producerLane', 'acceptanceAuthority', 'status',
  'corpusRevisionParentCommit', 'producerRevisionPredecessorCommit', 'lane3SupportBase',
  'corpusSourceBlobs', 'intendedSplit', 'reviewOrder', 'acceptanceScope', 'entryCount',
  'counts', 'kenyaEntryIds', 'selfChecks', 'entries',
]);
const SELF_CHECK_KEYS = Object.freeze([
  'exactCorpusManifestDatasheetBijection', 'normalizedInputFingerprintsPinned',
  'productionDepthContract', 'authorizedDocumentRevisions', 'withinTypeTokenOverlap',
  'oodFiveFieldSemantics', 'cpeSubtypeRatification', 'taxonomyAdjudicationSet',
  'issuedDateAdjudicationSet', 'batchScopeOnly', 'lane3Acceptance',
]);
const EXCLUDED_PACKET_PATHS = Object.freeze([
  '.sonarcloud.properties',
  'docs/lane4/s33-lane4-plan.md',
  'services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts',
  WAVE1_TYPES_PATH,
]);
const LEAKAGE_N_VALUES = Object.freeze([6, 7, 8, 9, 10, 11, 12, 13]);
const PRE_LEAKAGE_HITS_BY_N = Object.freeze({
  '6': 142, '7': 85, '8': 53, '9': 29, '10': 16, '11': 9, '12': 5, '13': 2,
});
const ZERO_LEAKAGE_HITS_BY_N = Object.freeze({
  '6': 0, '7': 0, '8': 0, '9': 0, '10': 0, '11': 0, '12': 0, '13': 0,
});
const LEAKAGE32_ENTRY_IDS = Object.freeze([
  'GD-S33-KE-001', 'GD-S33-KE-002', 'GD-S33-KE-003', 'GD-S33-KE-004',
  'GD-S33-KE-005', 'GD-S33-KE-007', 'GD-S33-KE-009', 'GD-S33-KE-010',
  'GD-S33-KE-011', 'GD-S33-AU-001', 'GD-S33-AU-003', 'GD-S33-AU-005',
  'GD-S33-AU-006', 'GD-S33-AU-007', 'GD-S33-BAR-001', 'GD-S33-BAR-002',
  'GD-S33-BAR-003', 'GD-S33-BAR-006', 'GD-S33-BAR-008', 'GD-S33-BAR-009',
  'GD-S33-BAR-010', 'GD-S33-CPA-001', 'GD-S33-CPA-003', 'GD-S33-CPA-006',
  'GD-S33-CPA-008', 'GD-S33-CPA-009', 'GD-S33-CPA-010', 'GD-S33-NUR-001',
  'GD-S33-NUR-004', 'GD-S33-NUR-006', 'GD-S33-NUR-010', 'GD-S33-PDH-009',
]);
const SEPARATELY_AUTHORIZED_NON_LEAKAGE_SOURCE_TRANSITION_IDS = Object.freeze([
  'GD-S33-KE-006',
]);
const EXACT_R12_SOURCE_TRANSITION_IDS = Object.freeze([
  ...LEAKAGE32_ENTRY_IDS,
  ...SEPARATELY_AUTHORIZED_NON_LEAKAGE_SOURCE_TRANSITION_IDS,
].sort(compareCodeUnits));
export const S33_WAVE1_R12_SOURCE_TRANSITION_BINDING = deepFreeze({
  leakage32EntryIds: LEAKAGE32_ENTRY_IDS,
  separatelyAuthorizedAuthority: 'CTO_R12_TAXONOMY_AND_DEPTH_ADJUDICATION',
  separatelyAuthorizedNonLeakageEntryIds: SEPARATELY_AUTHORIZED_NON_LEAKAGE_SOURCE_TRANSITION_IDS,
  exactSourceTransitionEntryIds: EXACT_R12_SOURCE_TRANSITION_IDS,
} as const);
const REVISION_HISTORY_KEYS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  2: ['revision', 'authority', 'changedEntryIds', 'normalizedInputChanged'],
  3: [
    'revision', 'authority', 'changedEntryIds', 'change', 'normalizedInputChanged',
    'remainingSubstantiveGroundTruthFields',
  ],
  4: [
    'revision', 'authority', 'changedEntryIds', 'changes', 'normalizedInputChanged',
    'remainingSubstantiveGroundTruthFields',
  ],
  5: [
    'revision', 'authority', 'changedEntryIds', 'changes', 'normalizedInputChanged',
    'normalizedInputChangedEntryIds', 'remainingSubstantiveGroundTruthFields',
  ],
  6: [
    'revision', 'authority', 'changedEntryIds', 'change', 'normalizedInputChanged',
    'recomputedNormalizedInputSha256', 'remainingSubstantiveGroundTruthFields',
  ],
  7: [
    'revision', 'authority', 'changedEntryIds', 'change', 'corpusDataChanged',
    'normalizedInputChanged', 'producerRevisionPredecessorCommit', 'directBaseCommit',
    'sourceBlobsUnchangedFromRevision6',
  ],
  8: [
    'revision', 'authority', 'changedEntryIds', 'changes', 'normalizedInputChanged',
    'normalizedInputChangedEntryIds', 'recomputedNormalizedInputSha256',
    'remainingSubstantiveGroundTruthFields', 'producerRevisionPredecessorCommit',
    'lane3SupportBaseCommit',
  ],
  9: [
    'revision', 'authority', 'changedEntryIds', 'verifiedUnchangedEntryIds', 'changes',
    'corpusSourceTextChanged', 'normalizedInputChanged',
    'normalizedInputPinsPreservedFromRevision8', 'remainingSubstantiveGroundTruthFields',
    'producerRevisionPredecessorCommit', 'lane3SupportBaseCommit',
  ],
  10: [
    'revision', 'authority', 'changedEntryIds', 'change', 'corpusDataChanged',
    'normalizedInputChanged', 'sourceBlobsUnchangedFromRevision9',
    'normalizedInputPinsPreservedFromRevision9', 'producerRevisionPredecessorCommit',
    'directBaseCommit', 'lane3SupportBaseCommit',
  ],
  11: [
    'revision', 'authority', 'changedEntryIds', 'changes', 'corpusSourceTextChanged',
    'normalizedInputChanged', 'normalizedInputPinsPreservedFromRevision10',
    'remainingSubstantiveGroundTruthFields', 'producerRevisionPredecessorCommit',
    'directBaseCommit', 'lane3SupportBaseCommit',
  ],
  12: [
    'revision', 'authority', 'changedEntryIds', 'adjudicatedUnchangedEntryIds', 'changes',
    'corpusSourceTextChanged', 'normalizedInputChanged', 'normalizedInputChangedEntryIds',
    'recomputedNormalizedInputSha256', 'productionContractResult',
    'producerRevisionPredecessorCommit', 'directBaseCommit', 'evaluatorSupportCommit',
    'sourceTextChangedEntryIds', 'lexicalLeakageRemediation',
  ],
});

type PacketPath = (typeof S33_WAVE1_PACKET_PATHS)[number];
type JsonRecord = Record<string, unknown>;

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

const ENTRY_ROW_REQUIRED_KEYS = [
  'id', 'domain', 'realOrSynthetic', 'authorshipMethod', 'generatorDerived',
  'sourceProvenance', 'lawfulBasis', 'generator', 'jurisdiction', 'jurisdictionDetail',
  'credentialType', 'subType', 'curationAuthor', 'curationDate', 'licenseConsentNote',
] as const;
const ENTRY_ROW_OPTIONAL_KEYS = ['priorityDocumentType', 'truthRevisionNote'] as const;

export interface S33Wave1PacketPins {
  packetBlobs: Record<PacketPath, string>;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  entryDatasheetRawSha256: string;
  entryDatasheetCanonicalSha256: string;
  entriesSha256: string;
  normalizedPinsSha256: string;
  entryRowsSha256: string;
}

export interface S33Wave1RevisionPins {
  headSha: string;
  revision: number;
  status: string;
  lane3AcceptanceStatus: string;
  adjudications: Readonly<Record<string, unknown>>;
  packet: S33Wave1PacketPins;
  expectedGroundTruthFailureIds: string[];
  expectedGroundTruthFailureDigestSha256: string;
}

export interface S33Wave1DualDagPins {
  schemaVersion: 1;
  supportBaseline: {
    commitSha: string;
    typesBlobSha: string;
  };
  support: {
    headSha: string;
    typesBlobSha: string;
  };
  mergeBaseSha: string;
  revision10: {
    headSha: string;
    declaredHistoricalChangedPaths: string[];
  };
  historical: S33Wave1RevisionPins;
  revision12: S33Wave1RevisionPins & {
    declaredImmediateParentChangedPaths: string[];
  };
  final: {
    headSha: string;
  };
}

export interface S33Wave1GroundTruthFailure {
  id: string;
  errors: readonly string[];
}

export interface S33Wave1PacketInspection {
  adjudications: Readonly<Record<string, unknown>>;
  declaredProducerParentSha: string;
  declaredProducerPredecessorSha: string;
  declaredProducerChangedPaths: readonly PacketPath[];
  declaredSupportBaselineCommitSha: string;
  declaredSupportTypesBlobSha: string;
  entryCount: 81;
  entriesSha256: string;
  entryDatasheetCanonicalSha256: string;
  entryDatasheetRawSha256: string;
  entryRowsSha256: string;
  groundTruthFailureDigestSha256: string;
  groundTruthFailures: readonly Readonly<S33Wave1GroundTruthFailure>[];
  lane3AcceptanceStatus: string;
  leakageTransitions: Readonly<Record<string, Readonly<LeakageTransition>>> | null;
  manifestCanonicalSha256: string;
  manifestRawSha256: string;
  normalizedPinsSha256: string;
  normalizedInputPins: Readonly<Record<string, string>>;
  packetBlobs: Readonly<Record<PacketPath, string>>;
  producerHeadSha: string;
  rawStrippedTextSha256ById: Readonly<Record<string, string>>;
  revision: number;
  status: string;
}

export interface S33Wave1DualDagReport {
  algorithmVersion: 's33-wave1-dual-dag-v1';
  supportBaseline: Readonly<{ commitSha: string; typesBlobSha: string }>;
  support: Readonly<{ headSha: string; treeSha: string; typesBlobSha: string }>;
  mergeBaseSha: string;
  revision10: Readonly<{ headSha: string }>;
  historical: Readonly<{
    disposition: 'HISTORICAL_BLOCKED';
    failureCount: number;
    failureDigestSha256: string;
    headSha: string;
  }>;
  revision12: Readonly<{
    disposition: 'STRUCTURALLY_VALID_ZERO_FAILURES';
    failureCount: 0;
    headSha: string;
    immediateParentChangedPaths: readonly PacketPath[];
    packetBlobs: Readonly<Record<PacketPath, string>>;
  }>;
  final: Readonly<{
    headSha: string;
    packetBlobs: Readonly<Record<PacketPath, string>>;
    treeSha: string;
    typesBlobSha: string;
    virtualMergeTreeSha: string;
  }>;
  reportDigestSha256: string;
}

export const S33_WAVE1_R12_EVIDENCE_PATH =
  'docs/lane3/evidence/s33-wave1-r12-dual-dag-verification.json' as const;
export const S33_WAVE1_R12_EVIDENCE_REF =
  'codex/s33-wave1-a12c-evidence-20260714' as const;
export const S33_WAVE1_R12_FREEZE_REF =
  'codex/s33-wave1-f12c-freeze-20260714' as const;

export interface S33Wave1R12EvidenceAnchor {
  blobSha: string;
  canonicalSha256: string;
  commitSha: string;
  finalCommitSha: string;
  finalTreeSha: string;
  freezeRefName: typeof S33_WAVE1_R12_FREEZE_REF;
  rawSha256: string;
  refName: typeof S33_WAVE1_R12_EVIDENCE_REF;
  reportDigestSha256?: string;
}

export interface S33Wave1R12VerifiedEvidence {
  blobSha: string;
  canonicalSha256: string;
  commitSha: string;
  evidenceBytes: Buffer;
  pins: Readonly<S33Wave1DualDagPins>;
  rawSha256: string;
  report: Readonly<S33Wave1DualDagReport>;
}

const S33_WAVE1_R12_PRODUCTION_EVIDENCE_ANCHOR = deepFreeze({
  blobSha: 'c74b9d6e001355d7701640b2d062473c8bcbed76',
  canonicalSha256: '8a98c148bce14678a94e5ac0b8bac97b76147ca93a8b0058169544d32d439b72',
  commitSha: '3508e5e9c7e100e9c55c0cba129d8d7b9d123bec',
  finalCommitSha: '447326ddd2225524895f35cbafda58b15555ed30',
  finalTreeSha: '52b6a2dd7201783f93325c24c999bc3e6bb8ee25',
  freezeRefName: S33_WAVE1_R12_FREEZE_REF,
  rawSha256: '02d8026546b14c64af447e8e12544b9e40d6618d9d1020a7a21086b83e425cb7',
  refName: S33_WAVE1_R12_EVIDENCE_REF,
  reportDigestSha256: '049ac9c08f168fc335cd277796c52f5fcc53bfe32097f7510ea0c609b5279a5e',
} as const satisfies S33Wave1R12EvidenceAnchor);

export const S33_WAVE1_R12_PRODUCTION_EVIDENCE = S33_WAVE1_R12_PRODUCTION_EVIDENCE_ANCHOR;

interface ParsedEntry {
  category: string;
  groundTruth: GroundTruthFields;
  id: string;
  sourcePath: (typeof WAVE1_SOURCE_BLOB_PATHS)[number];
  strippedText: string;
}

interface DiffEntry {
  path: string;
  status: 'A' | 'M';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest`);
  }
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

function assertCommit(repositoryRoot: string, commit: string, label: string): void {
  assertGitObject(commit, label);
  if (gitText(repositoryRoot, ['cat-file', '-t', commit], `${label} object type`) !== 'commit') {
    throw new Error(`${label} must name a Git commit`);
  }
}

function commitTree(repositoryRoot: string, commit: string, label: string): string {
  const tree = gitText(repositoryRoot, ['rev-parse', `${commit}^{tree}`], `${label} tree`);
  assertGitObject(tree, `${label} tree`);
  return tree;
}

function singleParent(repositoryRoot: string, commit: string, label: string): string {
  const lineage = gitText(
    repositoryRoot,
    ['rev-list', '--parents', '-n', '1', commit],
    `${label} single-parent lineage`,
  ).split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== commit) {
    throw new Error(`${label} must be an exact single-parent commit`);
  }
  assertGitObject(lineage[1], `${label} parent`);
  return lineage[1];
}

function gitBlob(repositoryRoot: string, commit: string, path: string, label: string): string {
  const row = gitBuffer(
    repositoryRoot,
    ['ls-tree', '-z', commit, '--', path],
    label,
  ).toString('utf8');
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u.exec(row);
  if (!match || match[4] !== path) throw new Error(`${label} is missing or ambiguous`);
  if (match[1] !== '100644' || match[2] !== 'blob') {
    throw new Error(`${label} must be a regular non-executable 100644 blob`);
  }
  return match[3];
}

function readGitPath(repositoryRoot: string, commit: string, path: string): Buffer {
  return gitBuffer(repositoryRoot, ['show', `${commit}:${path}`], `${path} at ${commit}`);
}

function packetBlobs(repositoryRoot: string, commit: string): Record<PacketPath, string> {
  return Object.fromEntries(S33_WAVE1_PACKET_PATHS.map((path) => [
    path,
    gitBlob(repositoryRoot, commit, path, `${path} packet blob`),
  ])) as Record<PacketPath, string>;
}

function parseDiff(repositoryRoot: string, from: string, to: string, label: string): DiffEntry[] {
  const tokens = gitBuffer(repositoryRoot, [
    'diff-tree', '--no-commit-id', '--name-status', '-r', '-z',
    '--find-renames', '--find-copies-harder', from, to, '--',
  ], label).toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const result: DiffEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (status !== 'A' && status !== 'M') {
      throw new Error(`${label} contains a deletion, rename, copy, type change, submodule, or unsupported status: ${status}`);
    }
    const path = tokens[index++];
    if (!path) throw new Error(`${label} contains a malformed changed path`);
    if (status === 'M') {
      gitBlob(repositoryRoot, from, path, `${label} changed path ${path} old endpoint`);
    }
    gitBlob(repositoryRoot, to, path, `${label} changed path ${path}`);
    result.push({ path, status });
  }
  return result.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertDiff(
  repositoryRoot: string,
  from: string,
  to: string,
  expectedPaths: readonly string[],
  allowedStatuses: readonly ('A' | 'M')[],
  label: string,
): readonly PacketPath[] {
  const expected = [...expectedPaths].sort(compareCodeUnits);
  if (new Set(expected).size !== expected.length) throw new Error(`${label} declared paths contain duplicates`);
  const actual = parseDiff(repositoryRoot, from, to, label);
  if (!sameStrings(actual.map(({ path }) => path), expected)) {
    throw new Error(`${label} does not match the declared exact changed paths`);
  }
  if (actual.some(({ status }) => !allowedStatuses.includes(status))) {
    throw new Error(`${label} contains a status outside [${allowedStatuses.join(',')}]`);
  }
  return deepFreeze(actual.map(({ path }) => path as PacketPath));
}

function assertPacketSubset(paths: readonly string[], label: string): void {
  if (paths.length === 0) throw new Error(`${label} must be a nonempty declared subset of the six-path packet`);
  for (const path of paths) {
    if (!S33_WAVE1_PACKET_PATHS.includes(path as PacketPath)) {
      throw new Error(`${label} contains an outside path: ${path}`);
    }
  }
}

function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync(GIT_EXECUTABLE, [
      '-C', repositoryRoot, 'merge-base', '--is-ancestor', ancestor, descendant,
    ], { env: GIT_ENV, stdio: 'ignore' });
    return true;
  } catch (error) {
    const status = record(error, 'Git merge-base error').status;
    if (status === 1) return false;
    throw new Error('Unable to derive Git ancestry', { cause: error });
  }
}

function countValues(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareCodeUnits(left, right)));
}

function assertCanonicalEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicaliseJson(actual) !== canonicaliseJson(expected)) {
    throw new Error(`${label} does not match the pinned exact value`);
  }
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const exact = [...expected].sort(compareCodeUnits);
  if (!sameStrings(actual, exact)) {
    throw new Error(`${label} must contain the exact key set; actual=[${actual}], expected=[${exact}]`);
  }
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function exactInteger(value: unknown, expected: number, label: string): void {
  if (value !== expected) throw new Error(`${label} must equal ${expected}`);
}

function nonEmptyStringArray(value: unknown, label: string, allowEmpty = false): string[] {
  const values = exactStringArray(value, label);
  if (!allowEmpty && values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

function assertKnownIds(ids: readonly string[], label: string): void {
  const known = new Set(WAVE1_ENTRY_IDS);
  for (const id of ids) {
    if (!known.has(id as (typeof WAVE1_ENTRY_IDS)[number])) throw new Error(`${label} contains unknown id ${id}`);
  }
}

function exactShaMap(value: unknown, label: string): Record<string, string> {
  const candidate = record(value, label);
  const result: Record<string, string> = {};
  for (const [id, digest] of Object.entries(candidate)) {
    if (!WAVE1_ENTRY_IDS.includes(id as (typeof WAVE1_ENTRY_IDS)[number])) {
      throw new Error(`${label} contains unknown id ${id}`);
    }
    assertSha256(digest, `${label}.${id}`);
    result[id] = digest;
  }
  return result;
}

function exactIntegerMap(value: unknown, label: string): Record<string, number> {
  const candidate = record(value, label);
  const result: Record<string, number> = {};
  for (const [key, integer] of Object.entries(candidate)) {
    if (!Number.isSafeInteger(integer) || Number(integer) < 0) {
      throw new Error(`${label}.${key} must be a nonnegative safe integer`);
    }
    result[key] = Number(integer);
  }
  return result;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const strings = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new Error(`${label} must contain unique values`);
  return strings;
}

/**
 * Bind revision 12 to the CTO's semantic adjudications independently of the
 * candidate-specific descriptor supplied by the caller. A caller therefore
 * cannot make a self-consistent but unauthorized manifest/pin pair pass.
 */
function validateRevision12BindingAdjudications(
  selfChecks: JsonRecord,
  entries: readonly Readonly<{ credentialType: string; id: string }>[],
  producerById: ReadonlyMap<string, ParsedEntry>,
): void {
  for (const [key, expected] of Object.entries(S33_WAVE1_R12_BINDING_ADJUDICATIONS)) {
    if (!Object.hasOwn(selfChecks, key)) {
      throw new Error(`Revision 12 is missing binding CTO adjudication ${key}`);
    }
    assertCanonicalEqual(selfChecks[key], expected, `Revision 12 binding CTO adjudication ${key}`);
  }

  const cpe = record(selfChecks.cpeSubtypeRatification, 'Revision 12 CPE subtype ratification');
  const depth = record(selfChecks.productionDepthContract, 'Revision 12 production-depth contract');
  const cpeIds = exactStringArray(
    depth.acceptanceOnlyCpeEntryIds,
    'Revision 12 acceptance-only CPE entry ids',
  );
  if (depth.acceptanceOnlyCpeEntryCount !== cpeIds.length || cpeIds.length !== 20) {
    throw new Error('Revision 12 acceptance-only CPE entry count must be exactly 20');
  }
  assertSha256(
    depth.acceptanceOnlyCpeEntryIdsSha256,
    'Revision 12 acceptance-only CPE entry-id digest',
  );
  if (sha256(canonicaliseJson(cpeIds)) !== depth.acceptanceOnlyCpeEntryIdsSha256) {
    throw new Error('Revision 12 acceptance-only CPE entry-id digest does not match its exact id list');
  }
  if (cpe.v6SubtypeTaxonomyChanged !== false || cpe.tuningExportApproved !== false) {
    throw new Error('Revision 12 CPE adjudication cannot change the v6 prompt taxonomy or approve tuning export');
  }
  const allowedCpeSubtypes = exactStringArray(cpe.allowed, 'Revision 12 allowed CPE subtypes');
  for (const id of cpeIds) {
    const producer = producerById.get(id);
    if (!producer || producer.groundTruth.credentialType !== 'CPE') {
      throw new Error(`Revision 12 binding CPE row is missing or not typed CPE: ${id}`);
    }
  }
  for (const { id } of entries.filter(({ credentialType }) => credentialType === 'CPE')) {
    const producer = producerById.get(id);
    if (!producer
      || typeof producer.groundTruth.subType !== 'string'
      || !allowedCpeSubtypes.includes(producer.groundTruth.subType)) {
      throw new Error(`Revision 12 binding CPE row has an unauthorized subtype: ${id}`);
    }
  }

  const taxonomy = record(selfChecks.taxonomyAdjudicationSet, 'Revision 12 taxonomy adjudication');
  const taxonomyIds = exactStringArray(taxonomy.entryIds, 'Revision 12 taxonomy adjudication ids');
  const taxonomyValues = record(taxonomy.resolvedValues, 'Revision 12 taxonomy resolved values');
  for (const id of taxonomyIds) {
    const producer = producerById.get(id);
    const resolved = nonEmptyString(taxonomyValues[id], `Revision 12 taxonomy value for ${id}`);
    const separator = resolved.indexOf('/');
    if (!producer || separator < 1 || separator === resolved.length - 1
      || producer.groundTruth.credentialType !== resolved.slice(0, separator)
      || producer.groundTruth.subType !== resolved.slice(separator + 1)) {
      throw new Error(`Revision 12 producer truth does not implement the binding taxonomy value for ${id}`);
    }
  }

  const issuedDates = record(
    selfChecks.issuedDateAdjudicationSet,
    'Revision 12 issued-date adjudication',
  );
  const issuedDateIds = exactStringArray(
    issuedDates.entryIds,
    'Revision 12 issued-date adjudication ids',
  );
  const issuedDateValues = record(
    issuedDates.resolvedValues,
    'Revision 12 issued-date resolved values',
  );
  for (const id of issuedDateIds) {
    const producer = producerById.get(id);
    const resolved = nonEmptyString(
      issuedDateValues[id],
      `Revision 12 issued-date value for ${id}`,
    );
    if (!producer || producer.groundTruth.issuedDate !== resolved) {
      throw new Error(`Revision 12 producer truth does not implement the binding issued date for ${id}`);
    }
  }

  const ood = record(selfChecks.oodFiveFieldSemantics, 'Revision 12 OOD adjudication');
  const oodIds = exactStringArray(ood.entryIds, 'Revision 12 OOD adjudication ids');
  for (const id of oodIds) {
    const producer = producerById.get(id);
    const truth = producer?.groundTruth;
    const keys = truth ? Object.keys(truth).sort(compareCodeUnits) : [];
    if (!truth
      || !sameStrings(keys, ['credentialType', 'fraudSignals', 'subType'])
      || truth.credentialType !== 'OTHER'
      || truth.subType !== 'other'
      || !Array.isArray(truth.fraudSignals)
      || truth.fraudSignals.length !== 0) {
      throw new Error(`Revision 12 OOD row must remain an exact pure-abstention truth: ${id}`);
    }
  }
}

interface LeakageTransition {
  from: string;
  to: string;
}

interface SelfCheckInspection {
  declaredProducerChangedPaths: readonly PacketPath[];
  leakageTransitions: Readonly<Record<string, Readonly<LeakageTransition>>> | null;
}

function validateHistoricalAdjudications(selfChecks: JsonRecord): void {
  const cpe = record(selfChecks.cpeSubtypeRatification, 'Historical CPE adjudication');
  assertExactKeys(cpe, ['status'], 'Historical CPE adjudication');
  if (cpe.status !== 'BLOCKED_CTO_L3') throw new Error('Historical CPE adjudication must remain blocked');

  for (const [key, expectedIds] of [
    ['taxonomyAdjudicationSet', S33_WAVE1_R12_BINDING_ADJUDICATIONS.taxonomyAdjudicationSet.entryIds],
    ['issuedDateAdjudicationSet', S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.entryIds],
  ] as const) {
    const adjudication = record(selfChecks[key], `Historical ${key}`);
    assertExactKeys(adjudication, ['status', 'entryIds'], `Historical ${key}`);
    if (adjudication.status !== 'BLOCKED_CTO_L3') throw new Error(`Historical ${key} must remain blocked`);
    const ids = exactStringArray(adjudication.entryIds, `Historical ${key}.entryIds`);
    if (!sameStrings(ids, expectedIds)) throw new Error(`Historical ${key} ids must remain exact`);
  }

  const ood = record(selfChecks.oodFiveFieldSemantics, 'Historical OOD adjudication');
  assertExactKeys(
    ood,
    ['status', 'entryIds', 'producerTruth', 'contradiction', 'resolutionOwner'],
    'Historical OOD adjudication',
  );
  if (ood.status !== 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3') {
    throw new Error('Historical OOD adjudication must retain its blocked contradiction');
  }
  if (!sameStrings(exactStringArray(ood.entryIds, 'Historical OOD ids'), WAVE1_OOD_ENTRY_IDS)) {
    throw new Error('Historical OOD adjudication ids must remain exact');
  }
  for (const key of ['producerTruth', 'contradiction', 'resolutionOwner']) {
    nonEmptyString(ood[key], `Historical OOD adjudication.${key}`);
  }
}

function validateProductionDepthContract(
  value: unknown,
  revision: number,
  supportCommit: string,
  failureIds: readonly string[],
): void {
  const depth = record(value, `Revision ${revision} production-depth contract`);
  if (revision === 11) {
    assertExactKeys(depth, [
      'status', 'evaluatorSupportCommit', 'postValidationMinimum', 'failedEntryCount',
      'failedEntryIdsSha256', 'failedEntryIds',
    ], 'Historical production-depth contract');
    if (depth.status !== HISTORICAL_STATUS) throw new Error('Historical production-depth status must remain blocked');
    const declaredFailureIds = exactStringArray(depth.failedEntryIds, 'Historical production-depth failure ids');
    assertKnownIds(declaredFailureIds, 'Historical production-depth failure ids');
    if (!sameStrings(declaredFailureIds, failureIds)) {
      throw new Error('Historical production-depth failure ids do not equal the independently evaluated failures');
    }
    assertSha256(depth.failedEntryIdsSha256, 'Historical production-depth failure-id digest');
    if (depth.failedEntryIdsSha256 !== sha256(canonicaliseJson(declaredFailureIds))) {
      throw new Error('Historical production-depth failure-id digest is inconsistent');
    }
  } else {
    assertExactKeys(depth, [
      'status', 'evaluatorSupportCommit', 'postValidationMinimum', 'failedEntryCount',
      'failedEntryIds', 'acceptanceOnlyCpeEntryCount', 'acceptanceOnlyCpeEntryIdsSha256',
      'acceptanceOnlyCpeEntryIds',
    ], 'Revision 12 production-depth contract');
    if (depth.status !== 'PASS') throw new Error('Revision 12 production-depth status must be PASS');
    const declaredFailureIds = exactStringArray(depth.failedEntryIds, 'Revision 12 production-depth failure ids');
    if (declaredFailureIds.length !== 0 || failureIds.length !== 0) {
      throw new Error('Revision 12 production-depth contract must have zero failures');
    }
    const declaredCpeIds = exactStringArray(
      depth.acceptanceOnlyCpeEntryIds,
      'Revision 12 production-depth CPE ids',
    );
    const binding = S33_WAVE1_R12_CPE_DEPTH_BINDING;
    assertSha256(
      depth.acceptanceOnlyCpeEntryIdsSha256,
      'Revision 12 production-depth CPE entry-id digest',
    );
    if (depth.acceptanceOnlyCpeEntryCount !== declaredCpeIds.length
      || depth.acceptanceOnlyCpeEntryCount !== binding.acceptanceOnlyCpeEntryCount
      || depth.acceptanceOnlyCpeEntryIdsSha256 !== sha256(canonicaliseJson(declaredCpeIds))
      || depth.acceptanceOnlyCpeEntryIdsSha256 !== binding.acceptanceOnlyCpeEntryIdsSha256
      || canonicaliseJson(declaredCpeIds)
        !== canonicaliseJson(binding.acceptanceOnlyCpeEntryIds)) {
      throw new Error('Revision 12 production-depth CPE universe must match the binding adjudication');
    }
  }
  if (depth.evaluatorSupportCommit !== supportCommit
    || depth.postValidationMinimum !== 5
    || depth.failedEntryCount !== failureIds.length) {
    throw new Error(`Revision ${revision} production-depth summary does not reconcile`);
  }
}

function validateLeakageContract(
  value: unknown,
  entriesById: ReadonlyMap<string, { normalizedInputSha256: string }>,
  sourceTextChangedEntryIds: readonly string[],
): Readonly<Record<string, Readonly<LeakageTransition>>> {
  const leakage = record(value, 'Revision 12 lexical-leakage remediation');
  assertExactKeys(leakage, [
    'decision', 'mergedLeakageScannerCommit', 'evaluatorScannerCommit', 'heldoutLeakageBlob',
    'algorithm', 'normalization', 'n', 'preRemediation', 'postRemediation',
    'separatelyAuthorizedNonLeakageSourceTransitions',
    'parentToRevision12FingerprintTransitions',
  ], 'Revision 12 lexical-leakage remediation');
  if (leakage.decision !== 'B_REAUTHOR_EXACT_32_SOURCES_IN_R12_PRECOMMIT'
    || leakage.mergedLeakageScannerCommit !== '48b562c2fa945bbcb60af141dd38a0cc49b4a737'
    || leakage.evaluatorScannerCommit !== S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE.commitSha
    || leakage.heldoutLeakageBlob !== '908e52a16e27c1a269f0526d449f30dcf9555ee0'
    || leakage.algorithm !== 'normalized-token-exact-ngram-v1'
    || leakage.normalization !== 'NFKC;lowercase;non-alphanumeric-space;whitespace-collapse'
    || canonicaliseJson(leakage.n) !== canonicaliseJson(LEAKAGE_N_VALUES)) {
    throw new Error('Revision 12 lexical-leakage algorithm/provenance contract is not exact');
  }

  const pre = record(leakage.preRemediation, 'Revision 12 pre-remediation leakage');
  assertExactKeys(pre, [
    'status', 'trainingCorpusFileCount', 'trainingManifestCanonicalSha256',
    'exactMatchCount', 'affectedEntryCount', 'hitsByN', 'affectedEntryIds',
  ], 'Revision 12 pre-remediation leakage');
  const affectedIds = exactStringArray(pre.affectedEntryIds, 'Revision 12 pre-remediation affected ids');
  assertKnownIds(affectedIds, 'Revision 12 pre-remediation affected ids');
  if (pre.status !== 'RED'
    || pre.trainingCorpusFileCount !== 307
    || pre.trainingManifestCanonicalSha256 !== '28c1de452ab2c472e68a6a2f3a2cc69c0945446f7db004a16411f204673a141b'
    || pre.exactMatchCount !== 341
    || pre.affectedEntryCount !== 32
    || affectedIds.length !== 32
    || canonicaliseJson(pre.hitsByN) !== canonicaliseJson(PRE_LEAKAGE_HITS_BY_N)) {
    throw new Error('Revision 12 pre-remediation RED341/32 leakage evidence is not exact');
  }
  if (!sameStrings(
    [...affectedIds].sort(compareCodeUnits),
    [...LEAKAGE32_ENTRY_IDS].sort(compareCodeUnits),
  )) {
    throw new Error('Revision 12 pre-remediation affected ids must equal the code-owned LEAKAGE32 set');
  }

  const separatelyAuthorized = record(
    leakage.separatelyAuthorizedNonLeakageSourceTransitions,
    'Revision 12 separately authorized non-leakage source transitions',
  );
  assertExactKeys(separatelyAuthorized, [
    'authority', 'entryIds', 'disjointFromLeakageAffectedEntryIds',
  ], 'Revision 12 separately authorized non-leakage source transitions');
  const separatelyAuthorizedIds = exactStringArray(
    separatelyAuthorized.entryIds,
    'Revision 12 separately authorized non-leakage source-transition ids',
  );
  if (separatelyAuthorized.authority
      !== S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.separatelyAuthorizedAuthority
    || separatelyAuthorized.disjointFromLeakageAffectedEntryIds !== true
    || !sameStrings(
      [...separatelyAuthorizedIds].sort(compareCodeUnits),
      [...SEPARATELY_AUTHORIZED_NON_LEAKAGE_SOURCE_TRANSITION_IDS].sort(compareCodeUnits),
    )
    || separatelyAuthorizedIds.some((id) => affectedIds.includes(id))) {
    throw new Error('Revision 12 separately authorized non-leakage transition must be exact, CTO-authorized, and disjoint from LEAKAGE32');
  }
  if (!sameStrings(
    [...sourceTextChangedEntryIds].sort(compareCodeUnits),
    [...EXACT_R12_SOURCE_TRANSITION_IDS].sort(compareCodeUnits),
  )) {
    throw new Error('Revision 12 source-text changes must equal exact LEAKAGE32 plus sole authorized KE-006');
  }

  const post = record(leakage.postRemediation, 'Revision 12 post-remediation leakage');
  assertExactKeys(post, [
    'status', 'trainingCorpusFileCount', 'exactMatchCount', 'affectedEntryCount',
    'hitsByN', 'rteIndependentGroundTruthContractPassEntryCount',
  ], 'Revision 12 post-remediation leakage');
  if (post.status !== 'PASS_PRODUCER_AND_RTE_INDEPENDENT_PENDING_L3'
    || post.trainingCorpusFileCount !== 307
    || post.exactMatchCount !== 0
    || post.affectedEntryCount !== 0
    || post.rteIndependentGroundTruthContractPassEntryCount !== 81
    || canonicaliseJson(post.hitsByN) !== canonicaliseJson(ZERO_LEAKAGE_HITS_BY_N)) {
    throw new Error('Revision 12 post-remediation leakage evidence must be exact GREEN0 pending Lane 3');
  }

  const transitionsValue = record(
    leakage.parentToRevision12FingerprintTransitions,
    'Revision 12 leakage fingerprint transitions',
  );
  const transitionIds = Object.keys(transitionsValue);
  if (!sameStrings([...transitionIds].sort(compareCodeUnits), [...EXACT_R12_SOURCE_TRANSITION_IDS])) {
    throw new Error('Revision 12 fingerprint transitions must equal exact LEAKAGE32 plus sole authorized KE-006');
  }
  const transitions: Record<string, Readonly<LeakageTransition>> = {};
  for (const id of transitionIds) {
    const transition = record(transitionsValue[id], `Revision 12 leakage transition ${id}`);
    assertExactKeys(transition, ['from', 'to'], `Revision 12 leakage transition ${id}`);
    assertSha256(transition.from, `Revision 12 leakage transition ${id}.from`);
    assertSha256(transition.to, `Revision 12 leakage transition ${id}.to`);
    if (transition.from === transition.to || transition.to !== entriesById.get(id)?.normalizedInputSha256) {
      throw new Error(`Revision 12 leakage transition ${id} is not bound to changed r12 content`);
    }
    transitions[id] = deepFreeze({ from: transition.from, to: transition.to });
  }
  if (affectedIds.some((id) => !Object.hasOwn(transitions, id))) {
    throw new Error('Every pre-remediation leakage hit must have a fingerprint transition');
  }
  return deepFreeze(transitions);
}

function validateAuthorizedRevisionHistory(
  value: unknown,
  revision: number,
  entries: readonly Readonly<{
    credentialType: string;
    id: string;
    normalizedInputSha256: string;
  }>[],
  producerParentSha: string,
  supportCommit: string,
): Readonly<Record<string, Readonly<LeakageTransition>>> | null {
  const history = record(value, `Revision ${revision} authorized revision history`);
  assertExactKeys(history, ['status', 'revisions'], `Revision ${revision} authorized revision history`);
  if (history.status !== 'PASS' || !Array.isArray(history.revisions)) {
    throw new Error(`Revision ${revision} authorized revision history must be a PASS array`);
  }
  const expectedRevisions = Array.from({ length: revision - 1 }, (_, index) => index + 2);
  if (history.revisions.length !== expectedRevisions.length) {
    throw new Error(`Revision ${revision} authorized history must be contiguous from revision 2`);
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let leakageTransitions: Readonly<Record<string, Readonly<LeakageTransition>>> | null = null;
  history.revisions.forEach((candidate, index) => {
    const label = `Revision ${revision} authorized history[${index}]`;
    const item = record(candidate, label);
    const itemRevision = positiveInteger(item.revision, `${label}.revision`);
    if (itemRevision !== expectedRevisions[index]) throw new Error(`${label} is not contiguous`);
    const keys = REVISION_HISTORY_KEYS[itemRevision];
    if (!keys) throw new Error(`${label} has no ratified schema`);
    assertExactKeys(item, keys, label);
    nonEmptyString(item.authority, `${label}.authority`);
    const changedIds = exactStringArray(item.changedEntryIds, `${label}.changedEntryIds`);
    assertKnownIds(changedIds, `${label}.changedEntryIds`);
    booleanValue(item.normalizedInputChanged, `${label}.normalizedInputChanged`);
    if (Object.hasOwn(item, 'change')) nonEmptyString(item.change, `${label}.change`);
    if (Object.hasOwn(item, 'changes')) nonEmptyStringArray(item.changes, `${label}.changes`);
    for (const key of ['normalizedInputChangedEntryIds', 'verifiedUnchangedEntryIds', 'adjudicatedUnchangedEntryIds', 'sourceTextChangedEntryIds']) {
      if (Object.hasOwn(item, key)) {
        const ids = exactStringArray(item[key], `${label}.${key}`);
        assertKnownIds(ids, `${label}.${key}`);
      }
    }
    for (const key of [
      'corpusDataChanged', 'sourceBlobsUnchangedFromRevision6', 'corpusSourceTextChanged',
      'normalizedInputPinsPreservedFromRevision8', 'sourceBlobsUnchangedFromRevision9',
      'normalizedInputPinsPreservedFromRevision9', 'normalizedInputPinsPreservedFromRevision10',
    ]) {
      if (Object.hasOwn(item, key)) booleanValue(item[key], `${label}.${key}`);
    }
    for (const key of ['producerRevisionPredecessorCommit', 'directBaseCommit', 'lane3SupportBaseCommit', 'evaluatorSupportCommit']) {
      if (Object.hasOwn(item, key)) assertGitObject(item[key], `${label}.${key}`);
    }
    if (Object.hasOwn(item, 'recomputedNormalizedInputSha256')) {
      exactShaMap(item.recomputedNormalizedInputSha256, `${label}.recomputedNormalizedInputSha256`);
    }
    if (Object.hasOwn(item, 'remainingSubstantiveGroundTruthFields')) {
      if (typeof item.remainingSubstantiveGroundTruthFields === 'number') {
        positiveInteger(item.remainingSubstantiveGroundTruthFields, `${label}.remainingSubstantiveGroundTruthFields`);
      } else {
        exactIntegerMap(item.remainingSubstantiveGroundTruthFields, `${label}.remainingSubstantiveGroundTruthFields`);
      }
    }

    if (itemRevision === 12) {
      if (item.producerRevisionPredecessorCommit !== producerParentSha
        || item.directBaseCommit !== producerParentSha
        || item.evaluatorSupportCommit !== supportCommit
        || item.corpusSourceTextChanged !== true
        || item.normalizedInputChanged !== true) {
        throw new Error('Revision 12 history record is not bound to its exact parent and support root');
      }
      const adjudicated = exactStringArray(item.adjudicatedUnchangedEntryIds, `${label}.adjudicatedUnchangedEntryIds`);
      if (!sameStrings(adjudicated, ['GD-S33-AU-002', 'GD-S33-AU-011'])) {
        throw new Error('Revision 12 adjudicated-unchanged ids must remain exact');
      }
      const normalizedChanged = exactStringArray(
        item.normalizedInputChangedEntryIds,
        `${label}.normalizedInputChangedEntryIds`,
      );
      const sourceChanged = exactStringArray(item.sourceTextChangedEntryIds, `${label}.sourceTextChangedEntryIds`);
      if (!sameStrings(normalizedChanged, sourceChanged)) {
        throw new Error('Revision 12 normalized-input and source-text change sets must be identical');
      }
      const recomputed = exactShaMap(item.recomputedNormalizedInputSha256, `${label}.recomputedNormalizedInputSha256`);
      if (!sameStrings(Object.keys(recomputed), normalizedChanged)) {
        throw new Error('Revision 12 recomputed fingerprint map must follow the exact changed-id order');
      }
      for (const [id, digest] of Object.entries(recomputed)) {
        if (digest !== entriesById.get(id)?.normalizedInputSha256) {
          throw new Error(`Revision 12 recomputed fingerprint is not bound to manifest entry ${id}`);
        }
      }
      const result = record(item.productionContractResult, 'Revision 12 production contract result');
      assertExactKeys(result, [
        'coveredEntryCount', 'failedEntryCountBefore', 'failedEntryCountAfter',
        'postValidationMinimum', 'cpeTypeCorrectionsWithinRed32',
        'groundedCurationsWithinRed32', 'additionalTruthfulCpeTypeCorrections',
      ], 'Revision 12 production contract result');
      for (const [key, expected] of Object.entries({
        coveredEntryCount: 72,
        failedEntryCountBefore: 32,
        failedEntryCountAfter: 0,
        postValidationMinimum: 5,
        cpeTypeCorrectionsWithinRed32: 18,
        groundedCurationsWithinRed32: 14,
        additionalTruthfulCpeTypeCorrections: 2,
      })) exactInteger(result[key], expected, `Revision 12 production contract result.${key}`);
      leakageTransitions = validateLeakageContract(
        item.lexicalLeakageRemediation,
        entriesById,
        sourceChanged,
      );
    }
  });
  if (revision === 12 && leakageTransitions === null) {
    throw new Error('Revision 12 authorized history is missing its lexical-leakage contract');
  }
  return leakageTransitions;
}

function validateOverlap(value: unknown): void {
  const overlap = record(value, 'Revision packet within-type overlap self-check');
  assertExactKeys(
    overlap,
    ['status', 'threshold', 'metric', 'violations', 'remediatedPairScores'],
    'Revision packet within-type overlap self-check',
  );
  if (overlap.status !== 'PASS' || !Object.is(overlap.threshold, 0.8)) {
    throw new Error('Revision packet within-type overlap must PASS at threshold 0.8');
  }
  nonEmptyString(overlap.metric, 'Revision packet within-type overlap metric');
  if (!Array.isArray(overlap.violations) || overlap.violations.length !== 0
    || !Array.isArray(overlap.remediatedPairScores)) {
    throw new Error('Revision packet overlap violations must be empty and pair scores must be an array');
  }
  const pairs = new Set<string>();
  overlap.remediatedPairScores.forEach((candidate, index) => {
    const pair = record(candidate, `Revision packet overlap pair[${index}]`);
    assertExactKeys(pair, ['leftId', 'rightId', 'credentialType', 'overlap'], `Revision packet overlap pair[${index}]`);
    const leftId = nonEmptyString(pair.leftId, `Revision packet overlap pair[${index}].leftId`);
    const rightId = nonEmptyString(pair.rightId, `Revision packet overlap pair[${index}].rightId`);
    assertKnownIds([leftId, rightId], `Revision packet overlap pair[${index}]`);
    nonEmptyString(pair.credentialType, `Revision packet overlap pair[${index}].credentialType`);
    if (typeof pair.overlap !== 'number' || !Number.isFinite(pair.overlap)
      || pair.overlap < 0 || pair.overlap >= 0.8 || leftId === rightId) {
      throw new Error(`Revision packet overlap pair[${index}] is invalid`);
    }
    const key = `${leftId}\0${rightId}`;
    if (pairs.has(key)) throw new Error('Revision packet overlap pairs must be unique');
    pairs.add(key);
  });
}

function validateBatchScope(
  value: unknown,
  supportDeclaration: JsonRecord,
): readonly PacketPath[] {
  const scope = record(value, 'Revision packet batch-scope self-check');
  assertExactKeys(scope, [
    'status', 'producerChangedPaths', 'excludedFromBatch', 'protocolAllowedDiffPaths',
    'dependency', 'reason', 'authority',
  ], 'Revision packet batch-scope self-check');
  if (scope.status !== 'PASS') throw new Error('Revision packet batch-scope self-check must PASS');
  const changedPaths = exactStringArray(scope.producerChangedPaths, 'Revision packet producerChangedPaths');
  assertPacketSubset(changedPaths, 'Revision packet producerChangedPaths');
  const protocolPaths = exactStringArray(scope.protocolAllowedDiffPaths, 'Revision packet protocol paths');
  if (!sameStrings([...protocolPaths].sort(compareCodeUnits), [...S33_WAVE1_PACKET_PATHS])) {
    throw new Error('Revision packet protocolAllowedDiffPaths must be the exact six-path set');
  }
  const excluded = exactStringArray(scope.excludedFromBatch, 'Revision packet excluded paths');
  if (!sameStrings([...excluded].sort(compareCodeUnits), [...EXCLUDED_PACKET_PATHS].sort(compareCodeUnits))) {
    throw new Error('Revision packet excludedFromBatch must be the exact non-packet set');
  }
  const dependency = record(scope.dependency, 'Revision packet batch-scope dependency');
  assertExactKeys(dependency, [
    'owner', 'branch', 'commit', 'typesPath', 'typesBlob', 'presentIdenticallyInBase',
    'includedInProducerDiff', 'reviewState',
  ], 'Revision packet batch-scope dependency');
  if (dependency.owner !== 'Lane 3'
    || dependency.commit !== supportDeclaration.commit
    || dependency.typesPath !== supportDeclaration.typesPath
    || dependency.typesBlob !== supportDeclaration.typesBlob
    || dependency.reviewState !== supportDeclaration.reviewState
    || dependency.presentIdenticallyInBase !== false
    || dependency.includedInProducerDiff !== false) {
    throw new Error('Revision packet dependency must exactly mirror the separate support DAG');
  }
  nonEmptyString(dependency.branch, 'Revision packet dependency.branch');
  nonEmptyString(scope.reason, 'Revision packet batch-scope reason');
  nonEmptyString(scope.authority, 'Revision packet batch-scope authority');
  return deepFreeze([...changedPaths].sort(compareCodeUnits) as PacketPath[]);
}

function validateSelfChecks(
  selfChecks: JsonRecord,
  revision: number,
  expectedLane3AcceptanceStatus: string,
  supportDeclaration: JsonRecord,
  entries: readonly Readonly<{
    credentialType: string;
    id: string;
    normalizedInputSha256: string;
  }>[],
  failureIds: readonly string[],
  producerParentSha: string,
  producerById: ReadonlyMap<string, ParsedEntry>,
): SelfCheckInspection {
  assertExactKeys(selfChecks, SELF_CHECK_KEYS, `Revision ${revision} selfChecks`);
  const bijection = record(selfChecks.exactCorpusManifestDatasheetBijection, `Revision ${revision} bijection self-check`);
  assertExactKeys(bijection, ['status', 'entryCount'], `Revision ${revision} bijection self-check`);
  if (bijection.status !== 'PASS' || bijection.entryCount !== 81) {
    throw new Error(`Revision ${revision} bijection self-check must PASS for 81 entries`);
  }
  const fingerprints = record(selfChecks.normalizedInputFingerprintsPinned, `Revision ${revision} fingerprint self-check`);
  assertExactKeys(fingerprints, ['status', 'algorithm'], `Revision ${revision} fingerprint self-check`);
  if (fingerprints.status !== 'PASS'
    || fingerprints.algorithm !== 'sha256(normalizeForFingerprint(strippedText))') {
    throw new Error(`Revision ${revision} normalized-input fingerprint contract is not exact`);
  }
  const supportCommit = nonEmptyString(supportDeclaration.commit, `Revision ${revision} support commit`);
  validateProductionDepthContract(selfChecks.productionDepthContract, revision, supportCommit, failureIds);
  const leakageTransitions = validateAuthorizedRevisionHistory(
    selfChecks.authorizedDocumentRevisions,
    revision,
    entries,
    producerParentSha,
    supportCommit,
  );
  validateOverlap(selfChecks.withinTypeTokenOverlap);
  if (revision === 12) validateRevision12BindingAdjudications(selfChecks, entries, producerById);
  else validateHistoricalAdjudications(selfChecks);
  const declaredProducerChangedPaths = validateBatchScope(selfChecks.batchScopeOnly, supportDeclaration);
  const acceptance = record(selfChecks.lane3Acceptance, `Revision ${revision} Lane-3 acceptance`);
  assertExactKeys(acceptance, ['status'], `Revision ${revision} Lane-3 acceptance`);
  if (acceptance.status !== expectedLane3AcceptanceStatus) {
    throw new Error(`Revision ${revision} Lane-3 acceptance status does not match the exact contract`);
  }
  return deepFreeze({ declaredProducerChangedPaths, leakageTransitions });
}

function parsedEntry(value: JsonRecord, sourcePath: (typeof WAVE1_SOURCE_BLOB_PATHS)[number]): ParsedEntry {
  const id = nonEmptyString(value.id, `${sourcePath} entry.id`);
  return {
    category: nonEmptyString(value.category, `${sourcePath} ${id}.category`),
    groundTruth: record(value.groundTruth, `${sourcePath} ${id}.groundTruth`) as GroundTruthFields,
    id,
    sourcePath,
    strippedText: nonEmptyString(value.strippedText, `${sourcePath} ${id}.strippedText`),
  };
}

function manifestEntries(value: unknown): Array<{
  credentialType: string;
  domain: string;
  id: string;
  normalizedInputSha256: string;
}> {
  if (!Array.isArray(value) || value.length !== 81) {
    throw new Error('Revision packet manifest must contain exactly 81 entries');
  }
  const entries = value.map((candidate, index) => {
    const entry = record(candidate, `Manifest entries[${index}]`);
    assertExactKeys(
      entry,
      ['id', 'domain', 'credentialType', 'normalizedInputSha256'],
      `Manifest entries[${index}]`,
    );
    const normalizedInputSha256 = entry.normalizedInputSha256;
    assertSha256(normalizedInputSha256, `Manifest entries[${index}].normalizedInputSha256`);
    return {
      credentialType: nonEmptyString(entry.credentialType, `Manifest entries[${index}].credentialType`),
      domain: nonEmptyString(entry.domain, `Manifest entries[${index}].domain`),
      id: nonEmptyString(entry.id, `Manifest entries[${index}].id`),
      normalizedInputSha256,
    };
  });
  if (!sameStrings(entries.map(({ id }) => id), WAVE1_ENTRY_IDS)) {
    throw new Error('Revision packet manifest must preserve the exact ordered 81-id universe');
  }
  return entries;
}

function assertEntryRowSchema(row: JsonRecord, index: number): void {
  const keys = Object.keys(row);
  const allowed = new Set<string>([...ENTRY_ROW_REQUIRED_KEYS, ...ENTRY_ROW_OPTIONAL_KEYS]);
  const missing = ENTRY_ROW_REQUIRED_KEYS.filter((key) => !Object.hasOwn(row, key));
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Entry datasheet rows[${index}] schema mismatch; missing=[${missing}], unknown=[${unknown}]`);
  }
  if (row.realOrSynthetic !== 'synthetic'
    || row.authorshipMethod !== 'independently-authored'
    || row.generatorDerived !== false) {
    throw new Error(`Entry datasheet rows[${index}] must remain independently-authored, non-generator synthetic data`);
  }
  const generator = record(row.generator, `Entry datasheet rows[${index}].generator`);
  assertExactKeys(
    generator,
    ['name', 'version', 'seed', 'templateId'],
    `Entry datasheet rows[${index}].generator`,
  );
  assertCanonicalEqual(generator, {
    name: 'none-independent-human-authorship',
    version: 'not-applicable-no-generator',
    seed: 'not-applicable-no-rng',
    templateId: 'not-applicable-no-template',
  }, `Entry datasheet rows[${index}].generator`);
  for (const key of [
    'sourceProvenance', 'lawfulBasis', 'jurisdiction', 'subType',
    'curationAuthor', 'curationDate', 'licenseConsentNote',
  ]) nonEmptyString(row[key], `Entry datasheet rows[${index}].${key}`);
  if (row.jurisdictionDetail === null) {
    if (row.domain !== 'out-of-distribution') {
      throw new Error(`Entry datasheet rows[${index}].jurisdictionDetail may be null only for OOD`);
    }
  } else {
    nonEmptyString(row.jurisdictionDetail, `Entry datasheet rows[${index}].jurisdictionDetail`);
  }
  for (const key of ENTRY_ROW_OPTIONAL_KEYS) {
    if (Object.hasOwn(row, key)) nonEmptyString(row[key], `Entry datasheet rows[${index}].${key}`);
  }
}

/**
 * Inspect one frozen revision without executing producer TypeScript. The caller
 * supplies expected governance statuses; the dual-DAG production wrapper later
 * supplies those values from a code-owned exact descriptor.
 */
export function inspectS33Wave1PacketRevision(input: Readonly<{
  repositoryRoot: string;
  producerHeadSha: string;
  expectedRevision: number;
  expectedStatus: string;
  expectedLane3AcceptanceStatus: string;
  expectedAdjudications: Readonly<Record<string, unknown>>;
}>): Readonly<S33Wave1PacketInspection> {
  assertCommit(input.repositoryRoot, input.producerHeadSha, 'Revision packet producer head');
  const packet = packetBlobs(input.repositoryRoot, input.producerHeadSha);
  const manifestBytes = readGitPath(input.repositoryRoot, input.producerHeadSha, WAVE1_MANIFEST_PATH);
  const manifestDocument = parseStrictJsonDocument(manifestBytes, 'Revision packet manifest');
  const manifest = manifestDocument.parsed;
  assertExactKeys(manifest, MANIFEST_KEYS, 'Revision packet manifest');
  if (manifest.batchId !== 'S33-W1' || manifest.schemaVersion !== 1) {
    throw new Error('Revision packet manifest must be schemaVersion=1 and batchId=S33-W1');
  }
  const revision = positiveInteger(manifest.revision, 'Revision packet manifest revision');
  if (revision !== input.expectedRevision) throw new Error(`Revision packet manifest must be revision ${input.expectedRevision}`);
  const status = nonEmptyString(manifest.status, 'Revision packet manifest status');
  if (status !== input.expectedStatus) throw new Error('Revision packet manifest status does not match the pinned contract');
  if (manifest.producerLane !== 'Lane 4' || manifest.acceptanceAuthority !== 'Lane 3') {
    throw new Error('Revision packet must preserve Lane 4 production and Lane 3 acceptance authority');
  }
  if (manifest.reviewOrder !== 'kenya-first' || manifest.acceptanceScope !== 'whole-batch-only') {
    throw new Error('Revision packet must remain Kenya-first and whole-batch-only');
  }
  const declaredProducerParentSha = nonEmptyString(
    manifest.corpusRevisionParentCommit,
    'Revision packet corpusRevisionParentCommit',
  );
  const declaredProducerPredecessorSha = nonEmptyString(
    manifest.producerRevisionPredecessorCommit,
    'Revision packet producerRevisionPredecessorCommit',
  );
  assertGitObject(declaredProducerParentSha, 'Revision packet corpusRevisionParentCommit');
  assertGitObject(declaredProducerPredecessorSha, 'Revision packet producerRevisionPredecessorCommit');
  const supportDeclaration = record(manifest.lane3SupportBase, 'Revision packet lane3SupportBase');
  assertExactKeys(
    supportDeclaration,
    ['commit', 'typesPath', 'typesBlob', 'reviewState'],
    'Revision packet lane3SupportBase',
  );
  const declaredSupportBaselineCommitSha = nonEmptyString(
    supportDeclaration.commit,
    'Revision packet lane3SupportBase.commit',
  );
  const declaredSupportTypesBlobSha = nonEmptyString(
    supportDeclaration.typesBlob,
    'Revision packet lane3SupportBase.typesBlob',
  );
  assertGitObject(declaredSupportBaselineCommitSha, 'Revision packet lane3SupportBase.commit');
  assertGitObject(declaredSupportTypesBlobSha, 'Revision packet lane3SupportBase.typesBlob');
  if (supportDeclaration.typesPath !== WAVE1_TYPES_PATH) {
    throw new Error('Revision packet lane3SupportBase.typesPath must identify the fixed support types file');
  }
  if (supportDeclaration.reviewState !== DUAL_DAG_SUPPORT_REVIEW_STATE) {
    throw new Error('Revision packet support reviewState must be the binding CTO dual-DAG state');
  }
  if (manifest.intendedSplit !== 'held-out-candidate') {
    throw new Error('Revision packet intendedSplit must be held-out-candidate');
  }
  if (manifest.entryCount !== 81) throw new Error('Revision packet manifest entryCount must be 81');
  const entries = manifestEntries(manifest.entries);
  if (!Array.isArray(manifest.kenyaEntryIds)
    || !sameStrings(manifest.kenyaEntryIds.map(String), WAVE1_KENYA_ENTRY_IDS)) {
    throw new Error('Revision packet manifest must preserve the exact Kenya-first id set');
  }

  const declaredSourceBlobs = record(manifest.corpusSourceBlobs, 'Revision packet corpusSourceBlobs');
  assertExactKeys(declaredSourceBlobs, WAVE1_SOURCE_BLOB_PATHS, 'Revision packet corpusSourceBlobs');
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    assertGitObject(declaredSourceBlobs[path], `Revision packet corpusSourceBlobs.${path}`);
    if (declaredSourceBlobs[path] !== packet[path]) {
      throw new Error(`Revision packet declared source blob does not match Git: ${path}`);
    }
  }

  const parsedEntries: ParsedEntry[] = [];
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const contract = SOURCE_CONTRACTS[path];
    const source = readGitPath(input.repositoryRoot, input.producerHeadSha, path).toString('utf8');
    const moduleEntries = parseS33ProducerModule(source, path, contract.exportName)
      .map((candidate) => parsedEntry(candidate, path));
    for (const entry of moduleEntries) {
      if (entry.category !== contract.category) {
        throw new Error(`${entry.id} category does not match its fixed source module`);
      }
    }
    parsedEntries.push(...moduleEntries);
  }
  if (parsedEntries.length !== 81 || new Set(parsedEntries.map(({ id }) => id)).size !== 81) {
    throw new Error('Revision packet producer modules must contain exactly 81 unique entries');
  }
  const producerById = new Map(parsedEntries.map((entry) => [entry.id, entry]));
  if (!sameStrings([...producerById.keys()].sort(compareCodeUnits), [...WAVE1_ENTRY_IDS].sort(compareCodeUnits))) {
    throw new Error('Revision packet producer modules do not match the fixed 81-id universe');
  }

  for (const manifestEntry of entries) {
    const producer = producerById.get(manifestEntry.id)!;
    const contract = SOURCE_CONTRACTS[producer.sourcePath];
    if (manifestEntry.domain !== contract.domain
      || manifestEntry.credentialType !== producer.groundTruth.credentialType) {
      throw new Error(`${producer.id} manifest/source domain or credential type mismatch`);
    }
    if (manifestEntry.normalizedInputSha256 !== sha256(normalizeForFingerprint(producer.strippedText))) {
      throw new Error(`${producer.id} normalized input fingerprint mismatch`);
    }
  }
  const failures: S33Wave1GroundTruthFailure[] = [];
  for (const producer of parsedEntries) {
    const result = evaluateS33HeldoutGroundTruthContract(producer);
    if (!result.accepted) failures.push({ id: producer.id, errors: [...result.errors] });
  }

  const declaredCounts = record(manifest.counts, 'Revision packet manifest counts');
  assertExactKeys(
    declaredCounts,
    ['byDomain', 'byCredentialType', 'byCorpusSlice'],
    'Revision packet manifest counts',
  );
  const actualCounts = {
    byDomain: countValues(entries.map(({ domain }) => domain)),
    byCredentialType: countValues(entries.map(({ credentialType }) => credentialType)),
    byCorpusSlice: countValues(parsedEntries.map(({ category }) => category)),
  };
  assertCanonicalEqual(declaredCounts, actualCounts, 'Revision packet manifest counts');
  assertCanonicalEqual(actualCounts.byDomain, WAVE1_DOMAIN_COUNTS, 'Revision packet domain counts');
  assertCanonicalEqual(actualCounts.byCorpusSlice, WAVE1_CORPUS_SLICE_COUNTS, 'Revision packet corpus-slice counts');

  const selfChecks = record(manifest.selfChecks, 'Revision packet selfChecks');
  const selfCheckInspection = validateSelfChecks(
    selfChecks,
    revision,
    input.expectedLane3AcceptanceStatus,
    supportDeclaration,
    entries,
    failures.map(({ id }) => id),
    declaredProducerParentSha,
    producerById,
  );
  const lane3AcceptanceStatus = input.expectedLane3AcceptanceStatus;
  const adjudications: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(input.expectedAdjudications)) {
    if (!Object.hasOwn(selfChecks, key)) throw new Error(`Revision packet is missing adjudication ${key}`);
    assertCanonicalEqual(selfChecks[key], expected, `Revision packet adjudication ${key}`);
    adjudications[key] = selfChecks[key];
  }

  const entryDatasheetBytes = readGitPath(
    input.repositoryRoot,
    input.producerHeadSha,
    WAVE1_ENTRY_DATASHEET_PATH,
  );
  const entryDatasheetDocument = parseStrictJsonDocument(entryDatasheetBytes, 'Revision entry datasheet');
  const datasheet = entryDatasheetDocument.parsed;
  assertExactKeys(datasheet, [
    'schemaVersion', 'batchId', 'revision', 'manifestSha256', 'producerLane',
    'acceptanceAuthority', 'status', 'entryCount', 'reviewOrder', 'acceptanceScope',
    'authorshipNote', 'rows',
  ], 'Revision entry datasheet');
  if (datasheet.schemaVersion !== 1
    || datasheet.batchId !== 'S33-W1'
    || datasheet.revision !== revision
    || datasheet.status !== status
    || datasheet.producerLane !== 'Lane 4'
    || datasheet.acceptanceAuthority !== 'Lane 3'
    || datasheet.entryCount !== 81
    || datasheet.reviewOrder !== 'kenya-first'
    || datasheet.acceptanceScope !== 'whole-batch-only') {
    throw new Error('Revision entry datasheet envelope does not match the manifest contract');
  }
  nonEmptyString(datasheet.authorshipNote, 'Revision entry datasheet authorshipNote');
  if (datasheet.manifestSha256 !== manifestDocument.rawSha256) {
    throw new Error('Revision entry datasheet manifestSha256 does not match raw manifest bytes');
  }
  if (!Array.isArray(datasheet.rows) || datasheet.rows.length !== 81) {
    throw new Error('Revision entry datasheet must contain exactly 81 rows');
  }
  const rows = datasheet.rows.map((candidate, index) => {
    const row = record(candidate, `Entry datasheet rows[${index}]`);
    assertEntryRowSchema(row, index);
    const manifestEntry = entries[index];
    const producer = producerById.get(manifestEntry.id)!;
    if (row.id !== manifestEntry.id
      || row.domain !== manifestEntry.domain
      || row.credentialType !== manifestEntry.credentialType
      || row.subType !== producer.groundTruth.subType) {
      throw new Error(`Entry datasheet row ${index} breaks the manifest/source bijection`);
    }
    return row;
  });

  const markdown = readGitPath(
    input.repositoryRoot,
    input.producerHeadSha,
    WAVE1_CORPUS_DATASHEET_PATH,
  ).toString('utf8');
  for (const [fragment, label] of [
    [`# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision ${revision})`, 'revision title'],
    [`Current producer revision: \`S33-W1\` revision ${revision}`, 'producer revision'],
    [`exact raw-file SHA-256 \`${manifestDocument.rawSha256}\``, 'manifest digest'],
    ['The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.', '81-row bijection'],
    [`blob \`${declaredSupportTypesBlobSha}\` on commit \`${declaredSupportBaselineCommitSha}\``, 'support binding'],
    [
      `Revision ${revision} has sole physical parent and direct base \`${declaredProducerParentSha}\`; its logical producer predecessor is exact commit \`${declaredProducerPredecessorSha}\`. The separate Lane-3 evaluator root is \`${declaredSupportBaselineCommitSha}\`.`,
      'producer lineage',
    ],
  ] as const) {
    const first = markdown.indexOf(fragment);
    if (first < 0 || markdown.indexOf(fragment, first + fragment.length) >= 0) {
      throw new Error(`Revision corpus datasheet ${label} marker must occur exactly once`);
    }
  }

  const failureDigest = sha256(canonicaliseJson(failures));
  return deepFreeze({
    adjudications,
    declaredProducerChangedPaths: selfCheckInspection.declaredProducerChangedPaths,
    declaredProducerParentSha,
    declaredProducerPredecessorSha,
    declaredSupportBaselineCommitSha,
    declaredSupportTypesBlobSha,
    entryCount: 81 as const,
    entriesSha256: sha256(canonicaliseJson(entries)),
    entryDatasheetCanonicalSha256: entryDatasheetDocument.canonicalSha256,
    entryDatasheetRawSha256: entryDatasheetDocument.rawSha256,
    entryRowsSha256: sha256(canonicaliseJson(rows)),
    groundTruthFailureDigestSha256: failureDigest,
    groundTruthFailures: failures,
    lane3AcceptanceStatus,
    leakageTransitions: selfCheckInspection.leakageTransitions,
    manifestCanonicalSha256: manifestDocument.canonicalSha256,
    manifestRawSha256: manifestDocument.rawSha256,
    normalizedPinsSha256: sha256(canonicaliseJson(entries.map(({ id, normalizedInputSha256 }) => ({
      id,
      normalizedInputSha256,
    })))),
    normalizedInputPins: Object.fromEntries(entries.map(({ id, normalizedInputSha256 }) => [
      id,
      normalizedInputSha256,
    ])),
    packetBlobs: packet,
    producerHeadSha: input.producerHeadSha,
    rawStrippedTextSha256ById: Object.fromEntries(parsedEntries.map(({ id, strippedText }) => [
      id,
      sha256(strippedText),
    ])),
    revision,
    status,
  });
}

function assertPacketPins(
  inspection: Readonly<S33Wave1PacketInspection>,
  pins: Readonly<S33Wave1RevisionPins>,
  label: string,
): void {
  const actual = {
    packetBlobs: inspection.packetBlobs,
    manifestRawSha256: inspection.manifestRawSha256,
    manifestCanonicalSha256: inspection.manifestCanonicalSha256,
    entryDatasheetRawSha256: inspection.entryDatasheetRawSha256,
    entryDatasheetCanonicalSha256: inspection.entryDatasheetCanonicalSha256,
    entriesSha256: inspection.entriesSha256,
    normalizedPinsSha256: inspection.normalizedPinsSha256,
    entryRowsSha256: inspection.entryRowsSha256,
  };
  for (const [key, value] of Object.entries(pins.packet)) {
    if (key !== 'packetBlobs') assertSha256(value, `${label} ${key}`);
  }
  assertCanonicalEqual(actual, pins.packet, `${label} packet/digest pins`);
  const failureIds = inspection.groundTruthFailures.map(({ id }) => id);
  if (!sameStrings(failureIds, pins.expectedGroundTruthFailureIds)) {
    throw new Error(`${label} exact ground-truth failure set does not match the pinned contract`);
  }
  assertSha256(pins.expectedGroundTruthFailureDigestSha256, `${label} expected failure digest`);
  if (inspection.groundTruthFailureDigestSha256 !== pins.expectedGroundTruthFailureDigestSha256) {
    throw new Error(`${label} ground-truth failure digest does not match the pinned contract`);
  }
}

/** Verify the complete pinned producer/support dual-DAG and materialized F12. */
export function verifyS33Wave1DualDagContract(input: Readonly<{
  repositoryRoot: string;
  pins: S33Wave1DualDagPins;
}>): Readonly<S33Wave1DualDagReport> {
  const { pins, repositoryRoot } = input;
  if (pins.schemaVersion !== 1) throw new Error('Dual-DAG pins schemaVersion must be 1');
  for (const [label, value] of [
    ['support baseline', pins.supportBaseline.commitSha],
    ['support head', pins.support.headSha],
    ['merge base', pins.mergeBaseSha],
    ['revision 10 producer', pins.revision10.headSha],
    ['historical producer', pins.historical.headSha],
    ['revision 12 producer', pins.revision12.headSha],
    ['final materialized producer', pins.final.headSha],
  ] as const) assertCommit(repositoryRoot, value, label);

  if (singleParent(repositoryRoot, pins.support.headSha, 'Lane-3 support head')
    !== pins.supportBaseline.commitSha) {
    throw new Error('Lane-3 support head must be a single-parent child of the separately pinned support baseline');
  }
  const baselineTypesBlob = gitBlob(
    repositoryRoot,
    pins.supportBaseline.commitSha,
    WAVE1_TYPES_PATH,
    'support-baseline types blob',
  );
  if (baselineTypesBlob !== pins.supportBaseline.typesBlobSha) {
    throw new Error('Support-baseline types blob does not match its separate pin');
  }
  const supportTypesBlob = gitBlob(
    repositoryRoot,
    pins.support.headSha,
    WAVE1_TYPES_PATH,
    'support-head types blob',
  );
  if (supportTypesBlob !== pins.support.typesBlobSha) {
    throw new Error('Support-head types blob does not match its pin');
  }
  const supportPacketPaths = gitBuffer(repositoryRoot, [
    'ls-tree', '-r', '-z', '--name-only', pins.support.headSha, '--', ...S33_WAVE1_PACKET_PATHS,
  ], 'support-head packet absence').toString('utf8');
  if (supportPacketPaths.length > 0) {
    throw new Error('Lane-3 support head must not contain producer packet paths');
  }

  if (pins.historical.revision !== 11
    || pins.historical.status !== HISTORICAL_STATUS
    || pins.historical.lane3AcceptanceStatus !== HISTORICAL_ACCEPTANCE_STATUS) {
    throw new Error('Historical revision 11 prime must be HISTORICAL_BLOCKED with final acceptance rejection');
  }
  if (singleParent(repositoryRoot, pins.historical.headSha, 'Historical revision 11 prime')
    !== pins.revision10.headSha) {
    throw new Error('Historical revision 11 prime must be the exact direct single-parent child of pinned revision 10');
  }
  assertPacketSubset(
    pins.revision10.declaredHistoricalChangedPaths,
    'Revision 10 to historical revision 11 prime declared changed paths',
  );
  const historicalEdgePaths = assertDiff(
    repositoryRoot,
    pins.revision10.headSha,
    pins.historical.headSha,
    pins.revision10.declaredHistoricalChangedPaths,
    ['A', 'M'],
    'Revision 10 to historical revision 11 prime declared changed paths',
  );
  if (pins.revision12.revision !== 12) throw new Error('Active producer contract must be revision 12');
  if (singleParent(repositoryRoot, pins.revision12.headSha, 'Revision 12 producer')
    !== pins.historical.headSha) {
    throw new Error('Revision 12 producer must be the direct single-parent child of revision 11 prime');
  }
  assertPacketSubset(
    pins.revision12.declaredImmediateParentChangedPaths,
    'Revision 12 declared immediate-parent changed paths',
  );
  if (!sameStrings(
    [...pins.revision12.declaredImmediateParentChangedPaths].sort(compareCodeUnits),
    [...S33_WAVE1_R12_IMMEDIATE_CHANGED_PATHS],
  )) {
    throw new Error('Revision 12 immediate-parent edge must be the exact code-owned five-path set');
  }
  const immediatePaths = assertDiff(
    repositoryRoot,
    pins.historical.headSha,
    pins.revision12.headSha,
    pins.revision12.declaredImmediateParentChangedPaths,
    ['M'],
    'Revision 12 declared immediate-parent changed paths',
  );

  const mergeBases = gitText(
    repositoryRoot,
    ['merge-base', '--all', pins.support.headSha, pins.revision12.headSha],
    'unique pinned dual-DAG merge base',
  ).split(/\s+/u).filter(Boolean);
  if (mergeBases.length !== 1 || mergeBases[0] !== pins.mergeBaseSha) {
    throw new Error('Support/producer histories do not have the unique pinned merge base');
  }
  if (isAncestor(repositoryRoot, pins.support.headSha, pins.revision12.headSha)) {
    throw new Error('Two-tree support..producer provenance is forbidden; support and producer must remain independent DAGs');
  }
  assertDiff(
    repositoryRoot,
    pins.mergeBaseSha,
    pins.revision12.headSha,
    S33_WAVE1_PACKET_PATHS,
    ['A'],
    'Merge-base to revision-12 exact six-path packet additions',
  );

  const historicalInspection = inspectS33Wave1PacketRevision({
    repositoryRoot,
    producerHeadSha: pins.historical.headSha,
    expectedRevision: 11,
    expectedStatus: HISTORICAL_STATUS,
    expectedLane3AcceptanceStatus: HISTORICAL_ACCEPTANCE_STATUS,
    expectedAdjudications: pins.historical.adjudications,
  });
  assertPacketPins(historicalInspection, pins.historical, 'Historical revision 11 prime');
  if (historicalInspection.declaredProducerParentSha !== pins.revision10.headSha
    || historicalInspection.declaredProducerPredecessorSha !== pins.revision10.headSha) {
    throw new Error('Historical revision 11 prime must declare its exact pinned revision-10 parent/predecessor');
  }
  if (!sameStrings(historicalInspection.declaredProducerChangedPaths, historicalEdgePaths)) {
    throw new Error('Historical revision 11 prime batch-scope paths do not match its authenticated revision-10 edge');
  }
  if (historicalInspection.groundTruthFailures.length === 0) {
    throw new Error('Historical revision 11 prime must retain its exact nonempty blocked failure set');
  }

  const revision12Inspection = inspectS33Wave1PacketRevision({
    repositoryRoot,
    producerHeadSha: pins.revision12.headSha,
    expectedRevision: 12,
    expectedStatus: pins.revision12.status,
    expectedLane3AcceptanceStatus: pins.revision12.lane3AcceptanceStatus,
    expectedAdjudications: pins.revision12.adjudications,
  });
  assertPacketPins(revision12Inspection, pins.revision12, 'Revision 12');
  if (revision12Inspection.declaredProducerParentSha !== pins.historical.headSha
    || revision12Inspection.declaredProducerPredecessorSha !== pins.historical.headSha) {
    throw new Error('Revision 12 manifest must declare revision 11 prime as its exact producer parent/predecessor');
  }
  for (const inspection of [historicalInspection, revision12Inspection]) {
    if (inspection.declaredSupportBaselineCommitSha !== pins.supportBaseline.commitSha
      || inspection.declaredSupportTypesBlobSha !== pins.supportBaseline.typesBlobSha) {
      throw new Error('Producer revisions must declare the separately pinned Lane-3 support baseline and types blob');
    }
  }
  if (revision12Inspection.groundTruthFailures.length !== 0) {
    throw new Error('Revision 12 must have zero post-validation ground-truth failures');
  }
  if (!sameStrings(revision12Inspection.declaredProducerChangedPaths, immediatePaths)) {
    throw new Error('Revision 12 batch-scope paths do not match its authenticated immediate producer edge');
  }
  if (revision12Inspection.leakageTransitions === null) {
    throw new Error('Revision 12 is missing its exact lexical-leakage transition contract');
  }
  for (const [id, transition] of Object.entries(revision12Inspection.leakageTransitions)) {
    if (historicalInspection.normalizedInputPins[id] !== transition.from
      || revision12Inspection.normalizedInputPins[id] !== transition.to) {
      throw new Error(`Revision 12 leakage transition ${id} is not bound across r11 prime to r12`);
    }
  }
  for (const id of WAVE1_ENTRY_IDS) {
    if (!Object.hasOwn(revision12Inspection.leakageTransitions, id)
      && historicalInspection.normalizedInputPins[id]
        !== revision12Inspection.normalizedInputPins[id]) {
      throw new Error(`Revision 12 contains an unauthorized normalized-input change outside exact LEAKAGE32 plus KE-006: ${id}`);
    }
  }
  const rawSourceTextChanges = WAVE1_ENTRY_IDS.filter((id) => (
    historicalInspection.rawStrippedTextSha256ById[id]
      !== revision12Inspection.rawStrippedTextSha256ById[id]
  )).sort(compareCodeUnits);
  if (!sameStrings(rawSourceTextChanges, [...EXACT_R12_SOURCE_TRANSITION_IDS])) {
    throw new Error('Revision 12 raw strippedText changes must equal exact LEAKAGE32 plus sole authorized KE-006');
  }

  const mergeTreeOutput = gitText(
    repositoryRoot,
    ['merge-tree', '--write-tree', pins.support.headSha, pins.revision12.headSha],
    'conflict-free support/revision-12 virtual merge tree',
  ).split('\n').filter(Boolean);
  if (mergeTreeOutput.length !== 1) {
    throw new Error('Support/revision-12 merge-tree must be conflict-free and emit exactly one virtual tree');
  }
  const virtualMergeTreeSha = mergeTreeOutput[0];
  assertGitObject(virtualMergeTreeSha, 'Virtual merge tree');

  if (singleParent(repositoryRoot, pins.final.headSha, 'Final materialized revision 12')
    !== pins.support.headSha) {
    throw new Error('Final materialized revision 12 must be a single-parent child of the support head');
  }
  const finalTreeSha = commitTree(repositoryRoot, pins.final.headSha, 'Final materialized revision 12');
  if (finalTreeSha !== virtualMergeTreeSha) {
    throw new Error('Final materialized revision-12 tree must equal the conflict-free virtual merge tree');
  }
  assertDiff(
    repositoryRoot,
    pins.support.headSha,
    pins.final.headSha,
    S33_WAVE1_PACKET_PATHS,
    ['A'],
    'Support head to final exact six-path packet additions',
  );
  const finalPacketBlobs = packetBlobs(repositoryRoot, pins.final.headSha);
  assertCanonicalEqual(
    finalPacketBlobs,
    revision12Inspection.packetBlobs,
    'Final six packet blobs versus revision-12 producer blobs',
  );
  const finalTypesBlob = gitBlob(
    repositoryRoot,
    pins.final.headSha,
    WAVE1_TYPES_PATH,
    'final retained support types blob',
  );
  if (finalTypesBlob !== supportTypesBlob) {
    throw new Error('Final materialized revision 12 must retain the support-head types blob');
  }

  const withoutDigest = {
    algorithmVersion: 's33-wave1-dual-dag-v1' as const,
    supportBaseline: {
      commitSha: pins.supportBaseline.commitSha,
      typesBlobSha: baselineTypesBlob,
    },
    support: {
      headSha: pins.support.headSha,
      treeSha: commitTree(repositoryRoot, pins.support.headSha, 'Lane-3 support head'),
      typesBlobSha: supportTypesBlob,
    },
    mergeBaseSha: pins.mergeBaseSha,
    revision10: { headSha: pins.revision10.headSha },
    historical: {
      disposition: HISTORICAL_STATUS as 'HISTORICAL_BLOCKED',
      failureCount: historicalInspection.groundTruthFailures.length,
      failureDigestSha256: historicalInspection.groundTruthFailureDigestSha256,
      headSha: pins.historical.headSha,
    },
    revision12: {
      disposition: 'STRUCTURALLY_VALID_ZERO_FAILURES' as const,
      failureCount: 0 as const,
      headSha: pins.revision12.headSha,
      immediateParentChangedPaths: immediatePaths,
      packetBlobs: revision12Inspection.packetBlobs,
    },
    final: {
      headSha: pins.final.headSha,
      packetBlobs: finalPacketBlobs,
      treeSha: finalTreeSha,
      typesBlobSha: finalTypesBlob,
      virtualMergeTreeSha,
    },
  };
  return deepFreeze({
    ...withoutDigest,
    reportDigestSha256: sha256(canonicaliseJson(withoutDigest)),
  });
}

const EVIDENCE_TOP_LEVEL_KEYS = Object.freeze([
  'artifactType', 'schemaVersion', 'selfPinned', 'bindingContext', 'pins', 'report',
]);
const EVIDENCE_BINDING_CONTEXT_KEYS = Object.freeze([
  'supportBaselineTreeSha', 'evidenceCommitPolicy',
]);
const EVIDENCE_COMMIT_POLICY =
  'A12C is a child of F12C and does not pin itself; it changes no packet path or verifier implementation path.';

function verifyEvidenceAnchorTopology(
  repositoryRoot: string,
  anchor: Readonly<S33Wave1R12EvidenceAnchor>,
): string {
  assertGitObject(anchor.commitSha, 'A12C compiled commit');
  assertGitObject(anchor.blobSha, 'A12C compiled evidence blob');
  assertGitObject(anchor.finalCommitSha, 'F12C compiled commit');
  assertGitObject(anchor.finalTreeSha, 'F12C compiled tree');
  assertSha256(anchor.rawSha256, 'A12C compiled raw evidence digest');
  assertSha256(anchor.canonicalSha256, 'A12C compiled canonical evidence digest');
  if (anchor.reportDigestSha256 !== undefined) {
    assertSha256(anchor.reportDigestSha256, 'A12C compiled report digest');
  }
  if (anchor.refName !== S33_WAVE1_R12_EVIDENCE_REF
    || anchor.freezeRefName !== S33_WAVE1_R12_FREEZE_REF) {
    throw new Error('A12C/F12C evidence refs do not match their code-owned fixed names');
  }
  const resolvedRef = gitText(
    repositoryRoot,
    ['rev-parse', '--verify', `refs/heads/${anchor.refName}`],
    'A12C fixed ref',
  );
  if (resolvedRef !== anchor.commitSha) throw new Error('A12C fixed ref moved from its compiled commit');
  assertCommit(repositoryRoot, anchor.commitSha, 'A12C evidence commit');
  const finalHeadSha = singleParent(repositoryRoot, anchor.commitSha, 'A12C evidence commit');
  const resolvedFreezeRef = gitText(
    repositoryRoot,
    ['rev-parse', '--verify', `refs/heads/${anchor.freezeRefName}`],
    'F12C fixed ref',
  );
  if (resolvedFreezeRef !== anchor.finalCommitSha || finalHeadSha !== anchor.finalCommitSha) {
    throw new Error('F12C fixed ref/A12C parent moved from the compiled materialized commit');
  }
  if (commitTree(repositoryRoot, finalHeadSha, 'F12C materialized head') !== anchor.finalTreeSha) {
    throw new Error('F12C materialized tree moved from its compiled tree');
  }
  const evidencePaths = assertDiff(
    repositoryRoot, finalHeadSha, anchor.commitSha, [S33_WAVE1_R12_EVIDENCE_PATH], ['A'],
    'F12C to A12C exact evidence-only edge',
  );
  if (!sameStrings(evidencePaths, [S33_WAVE1_R12_EVIDENCE_PATH])) {
    throw new Error('A12C must add exactly one evidence path');
  }
  const treeEntry = gitText(
    repositoryRoot,
    ['ls-tree', anchor.commitSha, '--', S33_WAVE1_R12_EVIDENCE_PATH],
    'A12C evidence tree entry',
  );
  if (treeEntry !== `100644 blob ${anchor.blobSha}\t${S33_WAVE1_R12_EVIDENCE_PATH}`) {
    throw new Error('A12C evidence must be one regular non-executable 100644 blob at the exact path');
  }
  return finalHeadSha;
}

function parseAnchoredEvidenceDocument(
  repositoryRoot: string,
  anchor: Readonly<S33Wave1R12EvidenceAnchor>,
): Readonly<{
  canonicalSha256: string;
  evidence: JsonRecord;
  evidenceBytes: Buffer;
  rawSha256: string;
}> {
  const evidenceBytes = readGitPath(repositoryRoot, anchor.commitSha, S33_WAVE1_R12_EVIDENCE_PATH);
  const document = parseStrictJsonDocument(evidenceBytes, 'A12C dual-DAG evidence');
  if (document.rawSha256 !== anchor.rawSha256
    || document.canonicalSha256 !== anchor.canonicalSha256) {
    throw new Error('A12C evidence raw/canonical digest does not match the compiled anchor');
  }
  const evidence = document.parsed;
  assertExactKeys(evidence, EVIDENCE_TOP_LEVEL_KEYS, 'A12C evidence');
  if (evidence.artifactType !== 'arkova-s33-wave1-r12-dual-dag-verification'
    || evidence.schemaVersion !== 1
    || evidence.selfPinned !== false) {
    throw new Error('A12C evidence identity/schema/selfPinned contract is invalid');
  }
  if (!isRecord(evidence.bindingContext)) throw new Error('A12C evidence bindingContext must be an object');
  assertExactKeys(evidence.bindingContext, EVIDENCE_BINDING_CONTEXT_KEYS, 'A12C evidence bindingContext');
  if (evidence.bindingContext.evidenceCommitPolicy !== EVIDENCE_COMMIT_POLICY) {
    throw new Error('A12C evidence commit policy does not match the reviewed contract');
  }
  if (!isRecord(evidence.pins) || !isRecord(evidence.report)) {
    throw new Error('A12C evidence pins/report must be objects');
  }
  return {
    canonicalSha256: document.canonicalSha256,
    evidence,
    evidenceBytes,
    rawSha256: document.rawSha256,
  };
}

function recomputeAnchoredEvidenceReport(input: Readonly<{
  anchor: Readonly<S33Wave1R12EvidenceAnchor>;
  evidence: JsonRecord;
  expectedProducerHeadSha: string;
  finalHeadSha: string;
  repositoryRoot: string;
}>): Readonly<{ pins: S33Wave1DualDagPins; report: Readonly<S33Wave1DualDagReport> }> {
  const { anchor, evidence, expectedProducerHeadSha, finalHeadSha, repositoryRoot } = input;
  const pins = evidence.pins as unknown as S33Wave1DualDagPins;
  if (pins.final?.headSha !== finalHeadSha) {
    throw new Error('A12C must be the sole child of the exact materialized F12C head');
  }
  if (pins.revision12?.headSha !== expectedProducerHeadSha) {
    throw new Error('A12C evidence revision-12 producer does not match the requested frozen head');
  }
  const supportBaselineTreeSha = commitTree(
    repositoryRoot,
    pins.supportBaseline?.commitSha,
    'A12C support baseline',
  );
  const bindingContext = evidence.bindingContext as JsonRecord;
  if (bindingContext.supportBaselineTreeSha !== supportBaselineTreeSha) {
    throw new Error('A12C evidence support-baseline tree binding does not match Git');
  }
  const report = verifyS33Wave1DualDagContract({ repositoryRoot, pins });
  assertCanonicalEqual(evidence.report, report, 'A12C stored/recomputed dual-DAG report');
  if (anchor.reportDigestSha256 !== undefined
    && report.reportDigestSha256 !== anchor.reportDigestSha256) {
    throw new Error('A12C recomputed report digest does not match the compiled anchor');
  }
  return { pins, report };
}

function verifiedS33Wave1R12EvidenceWithAnchor(input: Readonly<{
  anchor: Readonly<S33Wave1R12EvidenceAnchor>;
  expectedProducerHeadSha: string;
  repositoryRoot: string;
}>): S33Wave1R12VerifiedEvidence {
  const { anchor, expectedProducerHeadSha, repositoryRoot } = input;
  assertGitObject(expectedProducerHeadSha, 'Expected revision-12 producer head');
  const finalHeadSha = verifyEvidenceAnchorTopology(repositoryRoot, anchor);
  const document = parseAnchoredEvidenceDocument(repositoryRoot, anchor);
  const { pins, report } = recomputeAnchoredEvidenceReport({
    anchor, evidence: document.evidence, expectedProducerHeadSha, finalHeadSha, repositoryRoot,
  });
  return {
    blobSha: anchor.blobSha,
    canonicalSha256: document.canonicalSha256,
    commitSha: anchor.commitSha,
    evidenceBytes: document.evidenceBytes,
    pins: deepFreeze(structuredClone(pins)),
    rawSha256: document.rawSha256,
    report,
  };
}

/** Production verifier: the evidence authority is compiled and cannot be caller supplied. */
export function verifyS33Wave1R12Evidence(input: Readonly<{
  expectedProducerHeadSha: string;
  repositoryRoot: string;
}>): S33Wave1R12VerifiedEvidence {
  return verifiedS33Wave1R12EvidenceWithAnchor({
    ...input,
    anchor: S33_WAVE1_R12_PRODUCTION_EVIDENCE_ANCHOR,
  });
}

/** Synthetic anchors exist only to exercise negative fixtures in the test process. */
export function createTestOnlyS33Wave1R12EvidenceVerifier(
  anchor: Readonly<S33Wave1R12EvidenceAnchor>,
): (input: Readonly<{
  expectedProducerHeadSha: string;
  repositoryRoot: string;
}>) => S33Wave1R12VerifiedEvidence {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Synthetic S33 Wave-1 evidence anchors are forbidden outside NODE_ENV=test');
  }
  const captured = deepFreeze(structuredClone(anchor));
  return (input) => verifiedS33Wave1R12EvidenceWithAnchor({ ...input, anchor: captured });
}
