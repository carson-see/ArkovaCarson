import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import * as acceptanceModule from './s33-batch-acceptance.js';
import * as ledgerModule from './s33-acceptance-ledger.js';
// @ts-expect-error — the audit transcript state machine must remain module-private.
type _ForbiddenDirectLedgerImport = import('./s33-acceptance-ledger.js').DurableAcceptanceLedger;
import {
  canonicalManifestHash,
  compareEmbeddingLeakage,
  createProductionS33AcceptanceOrchestrator,
  createTestOnlyS33AcceptanceOrchestrator,
  parseBatchManifest,
  rawManifestHash,
  S33_WAVE1_REVISION10_PRODUCTION_PINS,
  scanEmbeddingLeakage,
  type EmbeddingBatchProvider,
  type ConsumptionRegistryRecord,
  type LexicalLeakagePolicyPayload,
  type ManifestFreezePayload,
  type SaltCommitmentPayload,
  type SaltRevealRecord,
  type SelectionPolicyPayload,
  type SignedPolicyArtifact,
  type SamplingTrustRoot,
  type S33AcceptanceOrchestrator,
  type Wave1Revision10Pins,
} from './s33-batch-acceptance.js';

// @ts-expect-error — callers cannot advance chronology with an arbitrary event.
type _ForbiddenOrchestratorAppend = S33AcceptanceOrchestrator['append'];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface ProductionManifestFixtureEntry {
  id: string;
  domain: 'au-ke-priority-documents' | 'professional-licensing' | 'out-of-distribution';
  credentialType: string;
  normalizedInputSha256: string;
}

const WAVE1_MANIFEST_PATH = 'docs/lane4/s33-wave1-batch-manifest.json';
const WAVE1_TYPES_PATH = 'services/worker/src/ai/eval/golden-dataset-s33-types.ts';
const WAVE1_SOURCE_PATHS = [
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
] as const;
const WAVE1_INITIAL_LANE3_SUPPORT_COMMIT = 'dd3ae1edecb005730762277daf17e15d8009459d';
const WAVE1_REVISION9_COMMIT = 'b9bb1d3221d3567dbb08e1b23cab4dd687486738';
const WAVE1_REVISION9_PREDECESSOR_COMMIT = '506ff62340db8f838ce68bc46ddfa6407735ce3c';
const WAVE1_R10_SUPPORT_REVIEW_STATE = 'LANE3_TOOLING_EXACT_HEAD_REVIEW_PASS';
const WAVE1_REVISION9_ENTRIES_SHA256 = '591b4f4b37e188f1ad7286f8bc2a7a6b407eb89674ed6321e898123c347800c0';
const WAVE1_REVISION9_NORMALIZED_PINS_SHA256 = '8b4af182dcc161a041a8d933ec5d7277f2131f32cc6709ad75a2cd5acde2e7e2';
const WAVE1_REVISION9_ENTRY_ROWS_SHA256 = '37f0e9d32b9f25422c93aeec985a624b2840deab3f33e7a453c14531591befdf';
const WAVE1_REVISION9_SOURCE_BLOBS = {
  [WAVE1_SOURCE_PATHS[0]]: '4ac117c1663c6aefb63c7715440744af0e0b6a23',
  [WAVE1_SOURCE_PATHS[1]]: '5000824f2bd4dd7ac9cd58243daeb7ba23c4c0cd',
  [WAVE1_SOURCE_PATHS[2]]: 'a261cf690c930040f7dee0361ed29d73d1d23426',
} as const;

interface ManifestFixtureBindings {
  supportCommit: string;
  supportTypesBlob: string;
  predecessorCommit: string;
  sourceBlobs: Record<(typeof WAVE1_SOURCE_PATHS)[number], string>;
}

const CORPUS_SLICE_BY_DOMAIN = {
  'au-ke-priority-documents': 's33-au-ke-heldout',
  'professional-licensing': 's33-licensing-heldout',
  'out-of-distribution': 's33-ood-negative',
} as const;

function countByFixtureField(
  entries: readonly ProductionManifestFixtureEntry[],
  field: 'domain' | 'credentialType',
): Record<string, number> {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry[field]] = (counts[entry[field]] ?? 0) + 1;
    return counts;
  }, {});
}

function productionManifestFixture(bindings: ManifestFixtureBindings = {
  supportCommit: 'd'.repeat(40),
  supportTypesBlob: 'c'.repeat(40),
  predecessorCommit: '5'.repeat(40),
  sourceBlobs: {
    [WAVE1_SOURCE_PATHS[0]]: '1'.repeat(40),
    [WAVE1_SOURCE_PATHS[1]]: '2'.repeat(40),
    [WAVE1_SOURCE_PATHS[2]]: '3'.repeat(40),
  },
}): Record<string, unknown> {
  const makeEntries = (
    prefix: string,
    count: number,
    domain: ProductionManifestFixtureEntry['domain'],
    credentialType: string,
  ): ProductionManifestFixtureEntry[] => Array.from({ length: count }, (_, index) => ({
    id: `GD-S33-${prefix}-${String(index + 1).padStart(3, '0')}`,
    domain,
    credentialType,
    normalizedInputSha256: ({
      'GD-S33-PDH-007': '647ce4116d8d36017f31e9cd9174157922592f1bc7e6c59135ae893d71e8d7c0',
      'GD-S33-NUR-004': '5cf701df727878e681e156e1c2f2cc1f8ad9df124e7668c6843e33eab806bc0d',
      'GD-S33-NUR-005': '68085d32defe764e6a6462a936c8493844e8c4213ff27943a51ff7026d0c90b9',
    } as Record<string, string>)[`GD-S33-${prefix}-${String(index + 1).padStart(3, '0')}`]
      ?? sha256(`${prefix.toLowerCase()}-${index + 1}`),
  }));
  const entries: ProductionManifestFixtureEntry[] = [
    ...makeEntries('KE', 11, 'au-ke-priority-documents', 'LICENSE'),
    ...makeEntries('NUR', 12, 'professional-licensing', 'CERTIFICATE'),
    ...makeEntries('CPA', 13, 'professional-licensing', 'CPE'),
    ...makeEntries('BAR', 13, 'professional-licensing', 'CLE'),
    ...makeEntries('PDH', 12, 'professional-licensing', 'CERTIFICATE'),
    ...makeEntries('AU', 11, 'au-ke-priority-documents', 'DEGREE'),
    ...makeEntries('OOD', 9, 'out-of-distribution', 'OTHER'),
  ];
  const kenyaEntryIds = entries.filter(({ id }) => id.startsWith('GD-S33-KE-')).map(({ id }) => id);
  const oodEntryIds = entries.filter(({ domain }) => domain === 'out-of-distribution').map(({ id }) => id);
  const byCorpusSlice = entries.reduce<Record<string, number>>((counts, entry) => {
    const slice = CORPUS_SLICE_BY_DOMAIN[entry.domain];
    counts[slice] = (counts[slice] ?? 0) + 1;
    return counts;
  }, {});
  const entryHash = (id: string): string => entries.find((entry) => entry.id === id)!.normalizedInputSha256;
  return {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 9,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    corpusRevisionParentCommit: bindings.predecessorCommit,
    producerRevisionPredecessorCommit: bindings.predecessorCommit,
    lane3SupportBase: {
      commit: bindings.supportCommit,
      typesPath: WAVE1_TYPES_PATH,
      typesBlob: bindings.supportTypesBlob,
      reviewState: 'PENDING_LANE3_REVIEW_PR',
    },
    corpusSourceBlobs: bindings.sourceBlobs,
    intendedSplit: 'held-out-candidate',
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    entryCount: 81,
    counts: {
      byDomain: countByFixtureField(entries, 'domain'),
      byCredentialType: countByFixtureField(entries, 'credentialType'),
      byCorpusSlice,
    },
    kenyaEntryIds,
    selfChecks: {
      exactCorpusManifestDatasheetBijection: { status: 'PASS', entryCount: 81 },
      normalizedInputFingerprintsPinned: {
        status: 'PASS',
        algorithm: 'sha256(normalizeForFingerprint(strippedText))',
      },
      authorizedDocumentRevisions: {
        status: 'PASS',
        revisions: [
          {
            revision: 2,
            authority: 'RTE protocol-required Wave 1 overlap revision',
            changedEntryIds: ['GD-S33-NUR-011', 'GD-S33-CPA-011', 'GD-S33-BAR-011', 'GD-S33-PDH-010'],
            normalizedInputChanged: true,
          },
          {
            revision: 3,
            authority: 'Lane 3 reject-and-return: material Kenya truth defect',
            changedEntryIds: ['GD-S33-KE-010'],
            change: 'removed ungrounded issuedDate 2013-11-30; source states only November 2013',
            normalizedInputChanged: false,
            remainingSubstantiveGroundTruthFields: 6,
          },
          {
            revision: 4,
            authority: 'Lane 3 reject-and-return: union sample grounded-truth adjudication',
            changedEntryIds: ['GD-S33-AU-007', 'GD-S33-NUR-003'],
            changes: [
              'AU-007 fieldOfStudy corrected from Commerce to text-grounded Accounting',
              'NUR-003 ungrounded ANCC accreditingBody removed',
            ],
            normalizedInputChanged: false,
            remainingSubstantiveGroundTruthFields: { 'GD-S33-AU-007': 7, 'GD-S33-NUR-003': 11 },
          },
          {
            revision: 5,
            authority: 'Lane 3 reject-and-return: full non-OOD grounded-truth review',
            changedEntryIds: ['GD-S33-AU-008', 'GD-S33-NUR-004', 'GD-S33-NUR-005', 'GD-S33-PDH-007'],
            changes: [
              'AU-008 unsupported courseId and deliveryMethod removed',
              'NUR-004 recommendation date not labeled as expiryDate and unstated deliveryMethod removed',
              'NUR-005 per-course completion date not labeled as transcript issuedDate and unstated deliveryMethod removed',
              'PDH-007 self-authored activity log replaced with provider-issued completion evidence under the existing CERTIFICATE/completion_certificate ontology',
            ],
            normalizedInputChanged: true,
            normalizedInputChangedEntryIds: ['GD-S33-PDH-007'],
            remainingSubstantiveGroundTruthFields: {
              'GD-S33-AU-008': 6, 'GD-S33-NUR-004': 7, 'GD-S33-NUR-005': 7, 'GD-S33-PDH-007': 11,
            },
          },
          {
            revision: 6,
            authority: 'Lane 3 internal review reject: PDH-007 grounded-truth jurisdiction',
            changedEntryIds: ['GD-S33-PDH-007'],
            change: 'removed unsupported jurisdiction United States because the source names no country or state; source text was not changed',
            normalizedInputChanged: false,
            recomputedNormalizedInputSha256: { 'GD-S33-PDH-007': entryHash('GD-S33-PDH-007') },
            remainingSubstantiveGroundTruthFields: { 'GD-S33-PDH-007': 10 },
          },
          {
            revision: 7,
            authority: 'RTE clean producer resubmission stacked on the Lane 3 support prerequisite',
            changedEntryIds: [],
            change: 'transplanted revision 6 corpus bytes onto Lane 3 support commit dd3ae1ed; producer packet metadata now proves the six-file protocol scope',
            corpusDataChanged: false,
            normalizedInputChanged: false,
            producerRevisionPredecessorCommit: 'dcbe0abd741a66401744a2cf916a583e865e2c9f',
            directBaseCommit: bindings.supportCommit,
            sourceBlobsUnchangedFromRevision6: true,
          },
          {
            revision: 8,
            authority: 'Team 4 same-lane review reject: NUR-004/NUR-005 grounded-truth correction',
            changedEntryIds: ['GD-S33-NUR-004', 'GD-S33-NUR-005'],
            changes: [
              'NUR-004 unsupported jurisdiction United States removed because the source names no country or state',
              'NUR-005 unsupported jurisdiction United States removed because the source names no country or state',
              'NUR-005 source minimally re-authored as an issuer-backed CERTIFICATE OF COMPLETION containing continuing-education transcript rows, grounding the existing CERTIFICATE/completion_certificate truth',
            ],
            normalizedInputChanged: true,
            normalizedInputChangedEntryIds: ['GD-S33-NUR-005'],
            recomputedNormalizedInputSha256: {
              'GD-S33-NUR-004': entryHash('GD-S33-NUR-004'),
              'GD-S33-NUR-005': entryHash('GD-S33-NUR-005'),
            },
            remainingSubstantiveGroundTruthFields: { 'GD-S33-NUR-004': 6, 'GD-S33-NUR-005': 6 },
            producerRevisionPredecessorCommit: 'c56bc9958f774471ff62a31418c304149afd4bc6',
            lane3SupportBaseCommit: bindings.supportCommit,
          },
          {
            revision: 9,
            authority: 'RTE Supermemory P1 truth correction and live PR review comment 3570778621',
            changedEntryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', ...oodEntryIds],
            verifiedUnchangedEntryIds: ['GD-S33-NUR-004', 'GD-S33-NUR-005', 'GD-S33-AU-008'],
            changes: [
              'All nine OOD entries now carry pure abstention ground truth only: credentialType OTHER, subType other, and empty fraudSignals',
              'AU-002 issuedDate now uses the explicit extract-generated date 2026-04-22 rather than historical First Registered date 2015-02-02',
              'AU-011 issuedDate now uses the explicit extract-prepared date 2026-04-16 rather than historical company registration date 2021-11-03',
              'NUR-004, NUR-005, and AU-008 were re-verified to contain no deliveryMethod and their already-correct corpus bytes were preserved',
            ],
            corpusSourceTextChanged: false,
            normalizedInputChanged: false,
            normalizedInputPinsPreservedFromRevision8: true,
            remainingSubstantiveGroundTruthFields: {
              'GD-S33-AU-002': 9, 'GD-S33-AU-011': 8, nonOodMinimum: 5, oodPureAbstention: 2,
            },
            producerRevisionPredecessorCommit: bindings.predecessorCommit,
            lane3SupportBaseCommit: bindings.supportCommit,
          },
        ],
      },
      withinTypeTokenOverlap: {
        status: 'PASS',
        threshold: 0.8,
        metric: 'multiset overlap coefficient (shared token occurrences / shorter input token count)',
        violations: [],
        remediatedPairScores: [
          { leftId: 'GD-S33-NUR-001', rightId: 'GD-S33-NUR-011', credentialType: 'CERTIFICATE', overlap: 0.34 },
          { leftId: 'GD-S33-CPA-001', rightId: 'GD-S33-CPA-011', credentialType: 'CPE', overlap: 0.37 },
          { leftId: 'GD-S33-BAR-001', rightId: 'GD-S33-BAR-011', credentialType: 'CLE', overlap: 0.4 },
          { leftId: 'GD-S33-PDH-001', rightId: 'GD-S33-PDH-010', credentialType: 'CERTIFICATE', overlap: 0.28 },
        ],
      },
      oodFiveFieldSemantics: {
        status: 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3',
        entryIds: oodEntryIds,
        producerTruth: 'Pure abstention labels contain only the protocol-declared fields.',
        contradiction: 'The producer must not invent extraction labels to pad abstention truth.',
        resolutionOwner: 'Lane 3 / CTO',
      },
      cpeSubtypeRatification: { status: 'BLOCKED_CTO_L3' },
      taxonomyAdjudicationSet: {
        status: 'BLOCKED_CTO_L3',
        entryIds: ['GD-S33-KE-003', 'GD-S33-AU-003', 'GD-S33-KE-006', 'GD-S33-AU-010'],
      },
      issuedDateAdjudicationSet: {
        status: 'BLOCKED_CTO_L3',
        entryIds: ['GD-S33-BAR-010', 'GD-S33-PDH-012'],
        resolvedEntryIdsInRevision9: ['GD-S33-AU-002', 'GD-S33-AU-011'],
      },
      batchScopeOnly: {
        status: 'PASS',
        excludedFromBatch: [
          '.sonarcloud.properties',
          'docs/lane4/s33-lane4-plan.md',
          'services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts',
          WAVE1_TYPES_PATH,
        ],
        protocolAllowedDiffPaths: [
          'docs/lane4/s33-corpus-datasheet.md',
          WAVE1_MANIFEST_PATH,
          'docs/lane4/s33-wave1-entry-datasheet.json',
          'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
          'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
          'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
        ],
        dependency: {
          owner: 'Lane 3',
          branch: 'codex/s33-l3-acceptance-tooling',
          commit: bindings.supportCommit,
          typesPath: WAVE1_TYPES_PATH,
          typesBlob: bindings.supportTypesBlob,
          presentIdenticallyInBase: true,
          includedInProducerDiff: false,
          reviewState: 'PENDING_LANE3_REVIEW_PR',
        },
        reason: 'The producer diff is limited to the protocol-owned corpus packet.',
        authority: 'Batch protocol section 1',
      },
      lane3Acceptance: { status: 'NOT_RUN_PRODUCER_BOUNDARY' },
    },
    entries,
  };
}

function repositoryRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function revision10ManifestFixture(bindings: ManifestFixtureBindings): Record<string, unknown> {
  const manifest = productionManifestFixture({
    supportCommit: WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
    supportTypesBlob: bindings.supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_PREDECESSOR_COMMIT,
    sourceBlobs: bindings.sourceBlobs,
  });
  manifest.revision = 10;
  manifest.corpusRevisionParentCommit = bindings.supportCommit;
  manifest.producerRevisionPredecessorCommit = WAVE1_REVISION9_COMMIT;
  manifest.corpusSourceBlobs = bindings.sourceBlobs;

  const support = manifest.lane3SupportBase as Record<string, unknown>;
  support.commit = bindings.supportCommit;
  support.typesBlob = bindings.supportTypesBlob;
  support.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;

  const selfChecks = manifest.selfChecks as Record<string, unknown>;
  const revisions = (selfChecks.authorizedDocumentRevisions as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  revisions.push({
    revision: 10,
    authority: 'RTE history-preserving restack onto the reviewed final Team 3 prerequisite',
    changedEntryIds: [],
    change: 'transplanted revision 9 corpus truth onto the reviewed final Team 3 prerequisite without changing corpus source blobs or normalized-input pins',
    corpusDataChanged: false,
    normalizedInputChanged: false,
    sourceBlobsUnchangedFromRevision9: true,
    normalizedInputPinsPreservedFromRevision9: true,
    producerRevisionPredecessorCommit: WAVE1_REVISION9_COMMIT,
    directBaseCommit: bindings.supportCommit,
    lane3SupportBaseCommit: bindings.supportCommit,
  });
  const dependency = (selfChecks.batchScopeOnly as {
    dependency: Record<string, unknown>;
  }).dependency;
  dependency.commit = bindings.supportCommit;
  dependency.typesBlob = bindings.supportTypesBlob;
  dependency.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;
  return manifest;
}

function revision10ParserFixture(): Record<string, unknown> {
  return revision10ManifestFixture({
    supportCommit: 'a'.repeat(40),
    supportTypesBlob: 'c'.repeat(40),
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs: { ...WAVE1_REVISION9_SOURCE_BLOBS },
  });
}

function syntheticEntryDatasheetRows(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  return (manifest.entries as ProductionManifestFixtureEntry[]).map(({ id }, index) => ({
    id,
    reviewPosition: index + 1,
    fixtureKind: 'synthetic-test-only',
  }));
}

function syntheticRevision10Pins(
  manifest: Record<string, unknown>,
  rows: readonly Record<string, unknown>[] = syntheticEntryDatasheetRows(manifest),
  sourceBlobs: ManifestFixtureBindings['sourceBlobs'] = manifest.corpusSourceBlobs as ManifestFixtureBindings['sourceBlobs'],
): Wave1Revision10Pins {
  const entries = manifest.entries as ProductionManifestFixtureEntry[];
  return {
    sourceBlobs: { ...sourceBlobs },
    entriesSha256: sha256(canonicaliseJson(entries)),
    normalizedPinsSha256: sha256(canonicaliseJson(entries.map(({ id, normalizedInputSha256 }) => ({
      id,
      normalizedInputSha256,
    })))),
    entryRowsSha256: sha256(canonicaliseJson(rows)),
  };
}

function parseRevision10WithSyntheticPins(manifest: Record<string, unknown>) {
  const { trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-parser-'));
  tempRoots.push(evidenceRoot);
  return createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry: new TestConsumptionRegistry(),
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repositoryRoot(),
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot(),
      encoding: 'utf8',
    }).trim(),
    revision10Pins: syntheticRevision10Pins(revision10ParserFixture()),
  }).parseBatchManifestForTest(JSON.stringify(manifest));
}

function manifestContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...productionManifestFixture(), ...overrides }, null, 2);
}

function testKey(): {
  privateKey: KeyObject;
  trustRoot: SamplingTrustRoot;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    trustRoot: {
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      publicKeyPem,
      publicKeyFingerprintSha256: sha256(publicKeyDer),
    },
  };
}

interface SignedArtifactFixture<P extends object> {
  object: SignedPolicyArtifact<P>;
  content: string;
}

function signedArtifact<P extends object>(
  payload: P,
  privateKey: KeyObject,
): SignedArtifactFixture<P> {
  const payloadDigestSha256 = sha256(canonicaliseJson(payload));
  const signature = {
    algorithm: 'Ed25519' as const,
    value: sign(
      null,
      Buffer.from(canonicaliseJson({ payload, payloadDigestSha256 }), 'utf8'),
      privateKey,
    ).toString('base64url'),
  };
  const object = {
    payload,
    payloadDigestSha256,
    signature,
    artifactDigestSha256: sha256(canonicaliseJson({ payload, payloadDigestSha256, signature })),
  };
  return { object, content: JSON.stringify(object, null, 2) };
}

class TestConsumptionRegistry {
  readonly keys = new Set<string>();

  async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
    if (this.keys.has(record.uniqueKey)) return false;
    this.keys.add(record.uniqueKey);
    return true;
  }
}

type ManifestMutator = (manifest: Record<string, unknown>) => void;

interface GitFixtureMutation {
  setupSupport?: (root: string) => void;
  mutateFreezeTree?: (root: string) => void;
  mutateFreezeIndex?: (root: string, predecessorCommit: string) => void;
}

function gitRepo(mutateManifest?: ManifestMutator, mutateGit?: GitFixtureMutation): {
  root: string;
  manifest: string;
  manifestPath: string;
  freezeCommitSha: string;
  verificationCommitSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-git-'));
  tempRoots.push(root);
  const manifestPath = WAVE1_MANIFEST_PATH;
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });

  mkdirSync(join(root, 'services/worker/src/ai/eval'), { recursive: true });
  writeFileSync(join(root, WAVE1_TYPES_PATH), 'export type Wave1FixtureType = string;\n', 'utf8');
  mutateGit?.setupSupport?.(root);
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'lane 3 support base'], { cwd: root });
  const supportCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const supportTypesBlob = execFileSync('git', ['rev-parse', `${supportCommit}:${WAVE1_TYPES_PATH}`], {
    cwd: root, encoding: 'utf8',
  }).trim();

  for (const [index, path] of WAVE1_SOURCE_PATHS.entries()) {
    writeFileSync(join(root, path), `export const initialFixture${index} = ${index};\n`, 'utf8');
  }
  execFileSync('git', ['add', ...WAVE1_SOURCE_PATHS], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'producer revision predecessor'], { cwd: root });
  const predecessorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  mkdirSync(join(root, 'docs/lane4'), { recursive: true });
  writeFileSync(join(root, 'docs/lane4/s33-corpus-datasheet.md'), '# Corpus datasheet\n', 'utf8');
  writeFileSync(join(root, 'docs/lane4/s33-wave1-entry-datasheet.json'), '{"entries":81}\n', 'utf8');
  writeFileSync(join(root, WAVE1_SOURCE_PATHS[1]), 'export const revisedAuKeFixture = 9;\n', 'utf8');
  writeFileSync(join(root, WAVE1_SOURCE_PATHS[2]), 'export const revisedOodFixture = 9;\n', 'utf8');
  mutateGit?.mutateFreezeTree?.(root);
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const manifestObject = productionManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit,
    sourceBlobs,
  });
  mutateManifest?.(manifestObject);
  const manifest = JSON.stringify(manifestObject, null, 2);
  writeFileSync(join(root, manifestPath), manifest, 'utf8');
  execFileSync('git', ['add', '--all'], { cwd: root });
  mutateGit?.mutateFreezeIndex?.(root, predecessorCommit);
  execFileSync('git', ['commit', '-qm', 'freeze manifest'], { cwd: root });
  const freezeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'verification.txt'), 'verification descendant\n', 'utf8');
  execFileSync('git', ['add', 'verification.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'verification descendant'], { cwd: root });
  const verificationCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, manifest, manifestPath, freezeCommitSha, verificationCommitSha };
}

interface Revision10GitMutation {
  mergeFreezeCommit?: boolean;
  mutateEntryDatasheet?: ManifestMutator;
  mutateManifest?: ManifestMutator;
  mutateSourceBytes?: boolean;
}

function revision10GitRepo(mutation: Revision10GitMutation = {}): {
  root: string;
  manifest: string;
  manifestPath: string;
  supportCommit: string;
  revision10Pins: Wave1Revision10Pins;
  freezeCommitSha: string;
  verificationCommitSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-git-'));
  tempRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['fetch', '-q', '--no-tags', repositoryRoot(), 'HEAD'], { cwd: root });
  execFileSync('git', ['switch', '-q', '--detach', 'FETCH_HEAD'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });
  const supportCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const supportTypesBlob = execFileSync('git', ['rev-parse', `${supportCommit}:${WAVE1_TYPES_PATH}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  for (const [index, path] of WAVE1_SOURCE_PATHS.entries()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `export const syntheticRevision10Fixture${index} = 'test-only-${index}';\n`,
      'utf8',
    );
  }
  const pinnedSourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const pinnedManifest = revision10ManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs: pinnedSourceBlobs,
  });
  const pinnedRows = syntheticEntryDatasheetRows(pinnedManifest);
  const revision10Pins = syntheticRevision10Pins(pinnedManifest, pinnedRows, pinnedSourceBlobs);
  if (mutation.mutateSourceBytes) {
    writeFileSync(join(root, WAVE1_SOURCE_PATHS[0]), 'export const changedAfterRevision9 = true;\n', 'utf8');
  }
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const manifestObject = revision10ManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs,
  });
  mutation.mutateManifest?.(manifestObject);
  const manifest = JSON.stringify(manifestObject, null, 2);
  const manifestPath = WAVE1_MANIFEST_PATH;
  mkdirSync(join(root, 'docs/lane4'), { recursive: true });
  writeFileSync(join(root, manifestPath), manifest, 'utf8');
  const entryDatasheetPath = 'docs/lane4/s33-wave1-entry-datasheet.json';
  const entryDatasheet: Record<string, unknown> = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 10,
    manifestSha256: sha256(manifest),
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    entryCount: 81,
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    authorshipNote: 'All rows are independently authored synthetic-realistic heldout candidates; no template generator or random seed was used.',
    rows: pinnedRows,
  };
  mutation.mutateEntryDatasheet?.(entryDatasheet);
  writeFileSync(join(root, entryDatasheetPath), JSON.stringify(entryDatasheet, null, 2), 'utf8');
  const corpusDatasheetPath = 'docs/lane4/s33-corpus-datasheet.md';
  writeFileSync(
    join(root, corpusDatasheetPath),
    '# Synthetic revision-10 corpus datasheet\n\nTooling review only; formal Lane-3 acceptance remains NOT_RUN.\n',
    'utf8',
  );
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'revision 10 metadata-only restack'], { cwd: root });
  let freezeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  if (mutation.mergeFreezeCommit) {
    const tree = execFileSync('git', ['rev-parse', `${freezeCommitSha}^{tree}`], {
      cwd: root, encoding: 'utf8',
    }).trim();
    freezeCommitSha = execFileSync('git', [
      'commit-tree', tree, '-p', supportCommit, '-p', WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
    ], { cwd: root, encoding: 'utf8', input: 'invalid merge-parent freeze\n' }).trim();
    const verificationCommitSha = execFileSync('git', [
      'commit-tree', tree, '-p', freezeCommitSha,
    ], { cwd: root, encoding: 'utf8', input: 'verification descendant\n' }).trim();
    return { root, manifest, manifestPath, supportCommit, revision10Pins, freezeCommitSha, verificationCommitSha };
  }
  writeFileSync(join(root, 'verification.txt'), 'verification descendant\n', 'utf8');
  execFileSync('git', ['add', 'verification.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'verification descendant'], { cwd: root });
  const verificationCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return { root, manifest, manifestPath, supportCommit, revision10Pins, freezeCommitSha, verificationCommitSha };
}

function revision10Ceremony(mutation: Revision10GitMutation = {}) {
  const repo = revision10GitRepo(mutation);
  const { privateKey, trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-ledger-'));
  tempRoots.push(evidenceRoot);
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry: new TestConsumptionRegistry(),
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repo.root,
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: repo.verificationCommitSha,
    revision10Pins: repo.revision10Pins,
  });
  const commitment = signedArtifact<SaltCommitmentPayload>({
    artifactType: 'arkova-s33-salt-commitment',
    artifactVersion: '1.0.0',
    commitmentId: 'S33-W1-r10-commitment-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T14:00:00.000Z',
    saltCommitment: { algorithm: 'sha256', value: sha256('33'.repeat(32)) },
  }, privateKey);
  const freeze = signedArtifact<ManifestFreezePayload>({
    artifactType: 'arkova-s33-manifest-freeze',
    artifactVersion: '1.0.0',
    freezeId: 'S33-W1-r10-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T14:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 10,
    manifestRawSha256: rawManifestHash(repo.manifest),
    manifestCanonicalSha256: canonicalManifestHash(repo.manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  return { repo, orchestrator, commitment, freeze };
}

function ceremony(mutateManifest?: ManifestMutator, mutateGit?: GitFixtureMutation) {
  const repo = gitRepo(mutateManifest, mutateGit);
  const manifest = repo.manifest;
  const { privateKey, trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-ledger-'));
  tempRoots.push(evidenceRoot);
  const consumptionRegistry = new TestConsumptionRegistry();
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry,
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repo.root,
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: repo.verificationCommitSha,
  });
  const salt = '11'.repeat(32);
  const commitment = signedArtifact<SaltCommitmentPayload>({
    artifactType: 'arkova-s33-salt-commitment',
    artifactVersion: '1.0.0',
    commitmentId: 'S33-W1-commitment-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:00:00.000Z',
    saltCommitment: { algorithm: 'sha256', value: sha256(salt) },
  }, privateKey);
  const freeze = signedArtifact<ManifestFreezePayload>({
    artifactType: 'arkova-s33-manifest-freeze',
    artifactVersion: '1.0.0',
    freezeId: 'S33-W1-r9-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 9,
    manifestRawSha256: rawManifestHash(manifest),
    manifestCanonicalSha256: canonicalManifestHash(manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  const policy = signedArtifact<SelectionPolicyPayload>({
    artifactType: 'arkova-s33-selection-policy',
    artifactVersion: '1.0.0',
    policyId: 'S33-W1-r9-selection-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:02:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    batchId: 'S33-W1',
    revision: 9,
    prng: 'xorshift32-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
  }, privateKey);
  const reveal: SaltRevealRecord = {
    schemaVersion: 1,
    revealId: 'S33-W1-r9-reveal-1',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    policyArtifactCanonicalSha256: canonicalManifestHash(policy.content),
    salt,
    revealedAtUtc: '2026-07-13T13:03:00.000Z',
  };
  const revealContent = JSON.stringify(reveal, null, 2);
  return {
    orchestrator,
    manifest,
    repo,
    privateKey,
    trustRoot,
    consumptionRegistry,
    commitment,
    freeze,
    policy,
    reveal,
    revealContent,
    evidenceRoot,
  };
}

function recordThroughReveal(context: ReturnType<typeof ceremony>): void {
  context.orchestrator.recordSaltCommitment(context.commitment.content);
  context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
  context.orchestrator.recordSelectionPolicy(context.policy.content);
  context.orchestrator.recordSaltReveal(context.revealContent);
}

describe('S3.3 authenticated, durable sampling ceremony', { timeout: 30_000 }, () => {
  it('requires an atomic registry with a callable create-if-absent operation', () => {
    const context = ceremony();
    expect(() => createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: {},
      ledgerPath: join(context.evidenceRoot, 'invalid-registry-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    } as never)).toThrow(TypeError);
  });

  it('does not expose a ledger or arbitrary event append capability', () => {
    const context = ceremony();
    expect(ledgerModule).not.toHaveProperty('DurableAcceptanceLedger');
    expect(context.orchestrator).not.toHaveProperty('append');
    expect(context.orchestrator).not.toHaveProperty('transcript');
    expect(() => (context.orchestrator as unknown as { append(): void }).append()).toThrow(/not a function/i);
  });

  it('uses the injected monotonic registry as the one-time consumption authority', async () => {
    const context = ceremony();
    const createIfAbsent = vi.fn(async (record: Readonly<ConsumptionRegistryRecord>) => {
      expect(Object.isFrozen(record)).toBe(true);
      return true;
    });
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      ledgerPath: join(context.evidenceRoot, 'registry-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
      consumptionRegistry: { createIfAbsent },
    } as never);
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(createIfAbsent).toHaveBeenCalledOnce();
  });

  it('keeps the external key consumed when transcript append fails before return', async () => {
    const context = ceremony();
    const transcriptPath = join(context.evidenceRoot, 'crash-ledger.jsonl');
    const keys = new Set<string>();
    let transcriptBeforeConsumption = '';
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        transcriptBeforeConsumption = readFileSync(transcriptPath, 'utf8');
        writeFileSync(transcriptPath, `${transcriptBeforeConsumption.slice(0, -2)}X\n`, 'utf8');
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: transcriptPath,
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/transcript|JSON|digest/i);
    expect(keys.size).toBe(1);
    writeFileSync(transcriptPath, transcriptBeforeConsumption, 'utf8');
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('fails closed when the external registry loses its acknowledgement after atomic create', async () => {
    const context = ceremony();
    const keys = new Set<string>();
    let loseAcknowledgement = true;
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('simulated lost acknowledgement after atomic create');
        }
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'lost-ack-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/lost acknowledgement/i);
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('rejects live getter/proxy signed-artifact objects before reading them', () => {
    const context = ceremony();
    let reads = 0;
    const liveArtifact = new Proxy(context.commitment.object, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(liveArtifact as never))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
    const proxiedBytes = new Proxy(Buffer.from(context.commitment.content, 'utf8'), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(proxiedBytes))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
  });

  it('never rereads mutable caller bytes after producing verified frozen snapshots', async () => {
    const context = ceremony();
    let releaseRegistry: ((created: boolean) => void) | undefined;
    const consumptionRegistry = {
      createIfAbsent(): Promise<boolean> {
        return new Promise((resolve) => {
          releaseRegistry = resolve;
        });
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'immutable-snapshot-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const inputs = {
      manifestContent: Buffer.from(context.manifest),
      commitmentArtifactContent: Buffer.from(context.commitment.content),
      freezeArtifactContent: Buffer.from(context.freeze.content),
      policyArtifactContent: Buffer.from(context.policy.content),
      revealContent: Buffer.from(context.revealContent),
    };
    const pending = orchestrator.selectAndConsumeSample(inputs);
    for (const input of Object.values(inputs)) input.fill(0x58);
    expect(releaseRegistry).toBeTypeOf('function');
    releaseRegistry?.(true);
    const result = await pending;
    expect(result.manifest).toEqual({ batchId: 'S33-W1', revision: 9, entryCount: 81 });
  });

  it('deep-freezes the returned selection graph and keeps its registry evidence digest stable', async () => {
    const context = ceremony();
    let registryRecord: Readonly<ConsumptionRegistryRecord> | undefined;
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: {
        async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
          registryRecord = record;
          return true;
        },
      },
      ledgerPath: join(context.evidenceRoot, 'frozen-result-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const result = await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sampleEntryIds)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.durableSequence)).toBe(true);
    expect(() => (result.sampleEntryIds as string[]).push('attacker-selected-id')).toThrow(TypeError);
    expect(() => {
      (result.evidence as { sampleSize: number }).sampleSize = 1;
    }).toThrow(TypeError);

    const reconstructedConsumptionEvidence = {
      commitmentArtifactCanonicalSha256: result.evidence.commitmentArtifactCanonicalSha256,
      commitmentArtifactRawSha256: result.evidence.commitmentArtifactRawSha256,
      freezeArtifactCanonicalSha256: result.evidence.freezeArtifactCanonicalSha256,
      freezeArtifactRawSha256: result.evidence.freezeArtifactRawSha256,
      policyArtifactCanonicalSha256: result.evidence.policyArtifactCanonicalSha256,
      policyArtifactRawSha256: result.evidence.policyArtifactRawSha256,
      revealCanonicalSha256: result.evidence.revealCanonicalSha256,
      revealRawSha256: result.evidence.revealRawSha256,
      manifestRawSha256: result.evidence.manifestRawSha256,
      manifestCanonicalSha256: result.evidence.manifestCanonicalSha256,
      sampleEntryIdsSha256: sha256(canonicaliseJson(result.sampleEntryIds)),
      sampleSize: result.evidence.sampleSize,
    };
    expect(registryRecord).toBeDefined();
    expect(sha256(canonicaliseJson(reconstructedConsumptionEvidence)))
      .toBe(registryRecord?.evidenceCanonicalSha256);
  });

  it('strict-parses the complete Wave-1 production manifest contract and Kenya-first order', () => {
    const parsed = parseBatchManifest(manifestContent());
    const manifest = parsed.parsedJson;
    expect(Object.keys(manifest).sort()).toEqual([
      'acceptanceAuthority', 'acceptanceScope', 'batchId', 'corpusRevisionParentCommit',
      'corpusSourceBlobs', 'counts', 'entries', 'entryCount', 'intendedSplit', 'kenyaEntryIds',
      'lane3SupportBase', 'producerLane', 'producerRevisionPredecessorCommit', 'reviewOrder',
      'revision', 'schemaVersion', 'selfChecks', 'status',
    ].sort());
    expect(parsed.entryCount).toBe(81);
    expect(parsed.entries.slice(0, 11).map(({ id }) => id))
      .toEqual((manifest.kenyaEntryIds as string[]));
    expect((manifest.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice)
      .toEqual({
        's33-au-ke-heldout': 22,
        's33-licensing-heldout': 50,
        's33-ood-negative': 9,
      });
    expect((manifest.selfChecks as Record<string, { status: string }>).oodFiveFieldSemantics.status)
      .toBe('BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3');
    expect((manifest.selfChecks as Record<string, { status: string }>).lane3Acceptance.status)
      .toBe('NOT_RUN_PRODUCER_BOUNDARY');
  });

  it('locks immutable exact production r9 pins without resolving the logical r9 Git object', () => {
    expect(S33_WAVE1_REVISION10_PRODUCTION_PINS).toEqual({
      sourceBlobs: WAVE1_REVISION9_SOURCE_BLOBS,
      entriesSha256: WAVE1_REVISION9_ENTRIES_SHA256,
      normalizedPinsSha256: WAVE1_REVISION9_NORMALIZED_PINS_SHA256,
      entryRowsSha256: WAVE1_REVISION9_ENTRY_ROWS_SHA256,
    });
    expect(Object.isFrozen(S33_WAVE1_REVISION10_PRODUCTION_PINS)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_REVISION10_PRODUCTION_PINS.sourceBlobs)).toBe(true);
    expect(() => {
      (S33_WAVE1_REVISION10_PRODUCTION_PINS.sourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = '0'.repeat(40);
    }).toThrow(TypeError);
  });

  it('cannot override production r10 pins through the public parser or production factory', () => {
    const manifest = revision10ParserFixture();
    const syntheticPins = syntheticRevision10Pins(manifest);
    expect(() => parseRevision10WithSyntheticPins(manifest)).not.toThrow();

    const adversarialPublicParser = parseBatchManifest as unknown as (
      content: string,
      pins: Wave1Revision10Pins,
    ) => unknown;
    expect(() => adversarialPublicParser(JSON.stringify(manifest), syntheticPins))
      .toThrow(/revision-10 .*reviewed revision-9/i);

    const productionInput: Parameters<typeof createProductionS33AcceptanceOrchestrator>[0] = {
      ledgerPath: join(tmpdir(), 'must-not-create.jsonl'),
      repositoryRoot: repositoryRoot(),
      verificationCommitSha: 'a'.repeat(40),
      // @ts-expect-error — production input intentionally exposes no test-pin seam.
      revision10Pins: syntheticPins,
    };
    expect(() => createProductionS33AcceptanceOrchestrator(productionInput))
      .toThrow(/production.*not configured.*fail closed/i);
  });

  it('accepts only the history-preserving r10 restack onto the exact reviewed Team-3 support head', () => {
    const context = revision10Ceremony();
    const parsed = context.orchestrator.parseBatchManifestForTest(context.repo.manifest).parsedJson;
    const support = parsed.lane3SupportBase as Record<string, unknown>;
    const revisions = ((parsed.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const revision10 = revisions.at(-1)!;
    expect(parsed.revision).toBe(10);
    expect(parsed.corpusRevisionParentCommit).toBe(context.repo.supportCommit);
    expect(parsed.producerRevisionPredecessorCommit).toBe(WAVE1_REVISION9_COMMIT);
    expect(support.commit).toBe(context.repo.supportCommit);
    expect(support.reviewState).toBe(WAVE1_R10_SUPPORT_REVIEW_STATE);
    expect(revisions[5].directBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revisions[6].lane3SupportBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revisions[7].producerRevisionPredecessorCommit).toBe(WAVE1_REVISION9_PREDECESSOR_COMMIT);
    expect(revisions[7].lane3SupportBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revision10).toMatchObject({
      revision: 10,
      changedEntryIds: [],
      corpusDataChanged: false,
      normalizedInputChanged: false,
      sourceBlobsUnchangedFromRevision9: true,
      normalizedInputPinsPreservedFromRevision9: true,
      producerRevisionPredecessorCommit: WAVE1_REVISION9_COMMIT,
      directBaseCommit: context.repo.supportCommit,
      lane3SupportBaseCommit: context.repo.supportCommit,
    });

    const freezeLineage = execFileSync('git', [
      'rev-list', '--parents', '-n', '1', context.repo.freezeCommitSha,
    ], { cwd: context.repo.root, encoding: 'utf8' }).trim().split(/\s+/);
    expect(freezeLineage).toEqual([context.repo.freezeCommitSha, context.repo.supportCommit]);
    expect(() => execFileSync('git', [
      'cat-file', '-e', `${WAVE1_REVISION9_COMMIT}^{commit}`,
    ], { cwd: context.repo.root, stdio: 'ignore' })).toThrow();
    const rawDiff = execFileSync('git', [
      'diff', '--raw', '--no-abbrev', context.repo.supportCommit, context.repo.freezeCommitSha,
    ], { cwd: context.repo.root, encoding: 'utf8' }).trim().split('\n');
    expect(rawDiff).toHaveLength(6);
    expect(rawDiff.every((line) => /^:000000 100644 [0-9a-f]{40} [0-9a-f]{40} A\t/u.test(line))).toBe(true);

    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .not.toThrow();
  });

  it.each([
    ['revision', 11],
    ['authority', 'unreviewed restack'],
    ['changedEntryIds', ['GD-S33-KE-001']],
    ['change', 'corpus bytes may have changed'],
    ['corpusDataChanged', true],
    ['normalizedInputChanged', true],
    ['sourceBlobsUnchangedFromRevision9', false],
    ['normalizedInputPinsPreservedFromRevision9', false],
    ['producerRevisionPredecessorCommit', 'd'.repeat(40)],
    ['directBaseCommit', 'd'.repeat(40)],
    ['lane3SupportBaseCommit', 'd'.repeat(40)],
  ] satisfies Array<[string, unknown]>)('rejects an r10 history mutation of %s', (field, replacement) => {
    const manifest = revision10ParserFixture();
    const revisions = ((manifest.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    revisions.at(-1)![field] = replacement;
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it.each([
    ['corpus parent', (manifest: Record<string, unknown>) => {
      manifest.corpusRevisionParentCommit = 'd'.repeat(40);
    }],
    ['logical predecessor', (manifest: Record<string, unknown>) => {
      manifest.producerRevisionPredecessorCommit = WAVE1_REVISION9_PREDECESSOR_COMMIT;
    }],
    ['support commit', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).commit = 'd'.repeat(40);
    }],
    ['support types path', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).typesPath = 'services/worker/src/ai/eval/other.ts';
    }],
    ['support types blob', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).typesBlob = 'd'.repeat(40);
    }],
    ['support review state', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).reviewState = 'PENDING_LANE3_REVIEW_PR';
    }],
    ['dependency commit', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).commit = 'd'.repeat(40);
    }],
    ['dependency types path', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).typesPath = 'other.ts';
    }],
    ['dependency types blob', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).typesBlob = 'd'.repeat(40);
    }],
    ['dependency review state', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).reviewState = 'PENDING_LANE3_REVIEW_PR';
    }],
    ['dependency presence flag', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).presentIdenticallyInBase = false;
    }],
    ['dependency diff flag', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).includedInProducerDiff = true;
    }],
  ] satisfies Array<[string, ManifestMutator]>)('rejects an r10 binding mutation of %s', (_case, mutate) => {
    const manifest = revision10ParserFixture();
    mutate(manifest);
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it.each([
    ['revision-7 initial support', 5, 'directBaseCommit'],
    ['revision-8 initial support', 6, 'lane3SupportBaseCommit'],
    ['revision-9 predecessor', 7, 'producerRevisionPredecessorCommit'],
    ['revision-9 initial support', 7, 'lane3SupportBaseCommit'],
  ] satisfies Array<[string, number, string]>)('rejects an r10 restack that rewrites the %s anchor', (
    _case,
    revisionIndex,
    field,
  ) => {
    const manifest = revision10ParserFixture();
    const revisions = ((manifest.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    revisions[revisionIndex][field] = 'd'.repeat(40);
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it('rejects an r10 freeze with multiple physical parents', () => {
    const context = revision10Ceremony({ mergeFreezeCommit: true });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/exactly one parent|lineage/i);
  });

  it('rejects r10 corpus-source blob drift from the reviewed r9 commit', () => {
    const context = revision10Ceremony({ mutateSourceBytes: true });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 corpus source blob.*reviewed revision-9 pin/i);
  });

  it('rejects r10 entry-datasheet row drift from the reviewed r9 packet', () => {
    const context = revision10Ceremony({
      mutateEntryDatasheet(datasheet): void {
        const rows = datasheet.rows as Array<Record<string, unknown>>;
        rows[0].jurisdiction = 'US';
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/entry datasheet rows.*reviewed revision-9 canonical row set/i);
  });

  it.each([
    ['stale revision', (datasheet: Record<string, unknown>) => { datasheet.revision = 9; }],
    ['wrong manifest hash', (datasheet: Record<string, unknown>) => { datasheet.manifestSha256 = '0'.repeat(64); }],
    ['unknown approval field', (datasheet: Record<string, unknown>) => { datasheet.operatorApproval = true; }],
    ['false acceptance status', (datasheet: Record<string, unknown>) => { datasheet.status = 'ACCEPTED'; }],
  ] satisfies Array<[string, ManifestMutator]>)('rejects r10 entry-datasheet %s metadata', (_case, mutate) => {
    const context = revision10Ceremony({ mutateEntryDatasheet: mutate });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 entry datasheet/i);
  });

  it('rejects r10 normalized-input pin drift from the reviewed r9 manifest', () => {
    const context = revision10Ceremony({
      mutateManifest(manifest): void {
        const entries = manifest.entries as Array<Record<string, unknown>>;
        entries[0].normalizedInputSha256 = 'f'.repeat(64);
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 normalized-input pins.*reviewed revision-9 pin set/i);
  });

  it('rejects r10 non-pin ground-truth drift from the reviewed r9 manifest', () => {
    const context = revision10Ceremony({
      mutateManifest(manifest): void {
        const entries = manifest.entries as Array<Record<string, unknown>>;
        entries[0].credentialType = 'CERTIFICATE';
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 entries.*reviewed revision-9 ground-truth set/i);
  });

  it('rejects missing or unknown nested production fields, count drift, and Kenya order drift', () => {
    const withUnknown = productionManifestFixture();
    (withUnknown.lane3SupportBase as Record<string, unknown>).reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(withUnknown)))
      .toThrow(/lane3SupportBase.*unknown.*reviewerOverride/i);

    const missingSource = productionManifestFixture();
    delete (missingSource.corpusSourceBlobs as Record<string, unknown>)[
      'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts'
    ];
    expect(() => parseBatchManifest(JSON.stringify(missingSource)))
      .toThrow(/corpusSourceBlobs.*missing.*ood-negatives/i);

    const unknownSelfCheck = productionManifestFixture();
    const unknownSelfChecks = unknownSelfCheck.selfChecks as {
      withinTypeTokenOverlap: Record<string, unknown>;
    };
    unknownSelfChecks.withinTypeTokenOverlap.reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(unknownSelfCheck)))
      .toThrow(/withinTypeTokenOverlap.*unknown.*reviewerOverride/i);

    const missingSelfCheck = productionManifestFixture();
    const missingSelfChecks = missingSelfCheck.selfChecks as {
      batchScopeOnly: Record<string, unknown>;
    };
    delete missingSelfChecks.batchScopeOnly.dependency;
    expect(() => parseBatchManifest(JSON.stringify(missingSelfCheck)))
      .toThrow(/batchScopeOnly.*missing.*dependency/i);

    const countDrift = productionManifestFixture();
    const countMap = (countDrift.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice;
    countMap['s33-au-ke-heldout'] += 1;
    expect(() => parseBatchManifest(JSON.stringify(countDrift)))
      .toThrow(/byCorpusSlice.*reconcile/i);

    const kenyaOrderDrift = productionManifestFixture();
    (kenyaOrderDrift.kenyaEntryIds as string[]).reverse();
    expect(() => parseBatchManifest(JSON.stringify(kenyaOrderDrift)))
      .toThrow(/Kenya.*order/i);
  });

  it('rejects duplicate JSON keys and unknown nested manifest fields', () => {
    const duplicate = manifestContent().replace('"revision": 9,', '"revision": 9,\n  "revision": 9,');
    expect(() => parseBatchManifest(duplicate)).toThrow(/duplicate.*revision/i);
    const withUnknown = manifestContent({
      entries: Array.from({ length: 6 }, (_, index) => ({
        id: `GD-S33-${String(index + 1).padStart(3, '0')}`,
        domain: 'professional-licensing',
        credentialType: 'LICENSE',
        normalizedInputSha256: sha256(`entry-${index + 1}`),
        reviewerOverride: true,
      })),
    });
    expect(() => parseBatchManifest(withUnknown)).toThrow(/unknown.*reviewerOverride/i);
  });

  it('rejects incomplete revision history and false or incomplete declared Wave-1 sets', () => {
    const incompleteHistory = productionManifestFixture();
    const history = ((incompleteHistory.selfChecks as Record<string, unknown>)
      .authorizedDocumentRevisions as { revisions: unknown[] }).revisions;
    history.splice(3, 1);
    expect(() => parseBatchManifest(JSON.stringify(incompleteHistory)))
      .toThrow(/revision history.*contiguous|revisions.*2.*9/i);

    const fabricatedScope = productionManifestFixture();
    const scope = ((fabricatedScope.selfChecks as Record<string, unknown>)
      .batchScopeOnly as { protocolAllowedDiffPaths: string[] });
    scope.protocolAllowedDiffPaths[0] = 'docs/lane4/fabricated-datasheet.md';
    expect(() => parseBatchManifest(JSON.stringify(fabricatedScope)))
      .toThrow(/protocolAllowedDiffPaths.*complete.*scope|six-path/i);

    const falseTaxonomy = productionManifestFixture();
    const taxonomy = ((falseTaxonomy.selfChecks as Record<string, unknown>)
      .taxonomyAdjudicationSet as { entryIds: string[] });
    taxonomy.entryIds[0] = 'GD-S33-KE-004';
    expect(() => parseBatchManifest(JSON.stringify(falseTaxonomy)))
      .toThrow(/taxonomy.*complete.*set/i);

    const missingIssuedDate = productionManifestFixture();
    const issuedDate = ((missingIssuedDate.selfChecks as Record<string, unknown>)
      .issuedDateAdjudicationSet as { entryIds: string[] });
    issuedDate.entryIds.pop();
    expect(() => parseBatchManifest(JSON.stringify(missingIssuedDate)))
      .toThrow(/issuedDate.*complete.*set/i);

    const extraOverlapPair = productionManifestFixture();
    const pairScores = ((extraOverlapPair.selfChecks as Record<string, unknown>)
      .withinTypeTokenOverlap as { remediatedPairScores: unknown[] }).remediatedPairScores;
    pairScores.push({
      leftId: 'GD-S33-KE-001', rightId: 'GD-S33-KE-002', credentialType: 'LICENSE', overlap: 0.1,
    });
    expect(() => parseBatchManifest(JSON.stringify(extraOverlapPair)))
      .toThrow(/remediated.*pair.*complete.*set/i);

    const nearThreshold = productionManifestFixture();
    ((nearThreshold.selfChecks as Record<string, unknown>)
      .withinTypeTokenOverlap as { threshold: number }).threshold = 0.8000000000000002;
    expect(() => parseBatchManifest(JSON.stringify(nearThreshold)))
      .toThrow(/overlap threshold must be 0\.8/i);
  });

  it('rejects every one-field mutation of the exact r2-r9 revision-history contract', () => {
    type JsonPath = Array<string | number>;
    const base = productionManifestFixture();
    const authoritative = ((base.selfChecks as Record<string, unknown>)
      .authorizedDocumentRevisions as Record<string, unknown>);
    const leaves: JsonPath[] = [];
    const collectLeaves = (value: unknown, path: JsonPath): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectLeaves(entry, [...path, index]));
      } else if (value !== null && typeof value === 'object') {
        Object.entries(value as Record<string, unknown>)
          .forEach(([key, entry]) => collectLeaves(entry, [...path, key]));
      } else {
        leaves.push(path);
      }
    };
    collectLeaves(authoritative, []);

    for (const path of leaves) {
      const mutated = structuredClone(base);
      let target = ((mutated.selfChecks as Record<string, unknown>)
        .authorizedDocumentRevisions as Record<string, unknown> | unknown[]);
      for (const segment of path.slice(0, -1)) {
        target = (target as Record<string | number, Record<string, unknown> | unknown[]>)[segment];
      }
      const leaf = path.at(-1)!;
      const current = (target as Record<string | number, unknown>)[leaf];
      let replacement: unknown;
      if (typeof current === 'boolean') {
        replacement = !current;
      } else if (typeof current === 'number') {
        replacement = current + 1;
      } else if (typeof current === 'string' && current.startsWith('GD-S33-')) {
        replacement = current === 'GD-S33-KE-001' ? 'GD-S33-KE-002' : 'GD-S33-KE-001';
      } else if (typeof current === 'string' && /^[0-9a-f]{40,64}$/.test(current)) {
        replacement = (current.startsWith('a') ? 'b' : 'a').repeat(current.length);
      } else {
        replacement = `${String(current)} [mutated]`;
      }
      (target as Record<string | number, unknown>)[leaf] = replacement;
      expect.soft(
        () => parseBatchManifest(JSON.stringify(mutated)),
        `mutation at authorizedDocumentRevisions.${path.join('.')}`,
      ).toThrow();
    }
  });

  it('rejects truncated Git declarations before any ceremony record is written', () => {
    const truncated = productionManifestFixture();
    (truncated.corpusSourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = 'a'.repeat(39);
    expect(() => parseBatchManifest(JSON.stringify(truncated)))
      .toThrow(/corpusSourceBlobs.*exact hexadecimal Git object/i);
  });

  it('durably records commitment < freeze < policy < reveal < verification and selects the fixed floor', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(result.sampleEntryIds).toHaveLength(9);
    expect(new Set(result.sampleEntryIds)).toHaveLength(9);
    expect(result.evidence.durableSequence).toEqual([
      'salt-commitment-recorded',
      'manifest-freeze-recorded',
      'selection-policy-recorded',
      'salt-reveal-recorded',
      'selection-consumed',
    ]);
    expect(result.evidence.freezeCommitSha).toBe(context.repo.freezeCommitSha);
    const ledger = readFileSync(join(context.evidenceRoot, 'acceptance-ledger.jsonl'), 'utf8');
    expect(ledger.trim().split('\n')).toHaveLength(5);
  });

  it('keeps the signed salt commitment strictly manifest-free', () => {
    const context = ceremony();
    const poisonedPayload = {
      ...context.commitment.object.payload,
      manifestSha256: rawManifestHash(context.manifest),
    };
    const poisoned = signedArtifact(poisonedPayload, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(poisoned.content))
      .toThrow(/manifest-free|unknown.*manifestSha256/i);
  });

  it('strict-parses signed artifacts and rejects duplicate or unknown nested fields', () => {
    const context = ceremony();
    const duplicate = context.commitment.content.replace(
      '"commitmentId": "S33-W1-commitment-1",',
      '"commitmentId": "S33-W1-commitment-1",\n    "commitmentId": "S33-W1-commitment-1",',
    );
    expect(() => context.orchestrator.recordSaltCommitment(duplicate)).toThrow(/duplicate.*commitmentId/i);
    const nestedUnknown = signedArtifact({
      ...context.commitment.object.payload,
      saltCommitment: {
        ...context.commitment.object.payload.saltCommitment,
        operatorOverride: true,
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(nestedUnknown.content))
      .toThrow(/unknown.*operatorOverride/i);
  });

  it('rejects freeze or reveal when durable predecessor records do not exist', () => {
    const context = ceremony();
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/commitment.*durably recorded/i);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordSaltReveal(context.revealContent))
      .toThrow(/freeze|policy.*durably recorded/i);
  });

  it('rejects a reveal that does not open the durably recorded signed commitment', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    context.orchestrator.recordSelectionPolicy(context.policy.content);
    expect(() => context.orchestrator.recordSaltReveal(JSON.stringify({
      ...context.reveal,
      salt: '22'.repeat(32),
    }))).toThrow(/does not match.*durably recorded.*commitment/i);
  });

  it('verifies the frozen Git blob and ancestor relation, not asserted timestamps alone', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const wrongCommit = signedArtifact<ManifestFreezePayload>({
      ...context.freeze.object.payload,
      gitEvidence: {
        ...context.freeze.object.payload.gitEvidence,
        freezeCommitSha: '00'.repeat(20),
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordManifestFreeze(wrongCommit.content, context.manifest))
      .toThrow(/git|commit|ancestor/i);
  });

  it('ignores PATH-shadowed Git executables at the freeze trust boundary', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const hostileBin = mkdtempSync(join(tmpdir(), 'arkova-s33-hostile-path-'));
    tempRoots.push(hostileBin);
    const hostileGit = join(hostileBin, 'git');
    writeFileSync(hostileGit, '#!/bin/sh\nexit 97\n', 'utf8');
    chmodSync(hostileGit, 0o755);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = hostileBin;
      expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
        .not.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('binds the freeze parent, support ancestry, and every declared source blob to Git truth', () => {
    const zeroParent = ceremony((manifest) => {
      const zero = '0'.repeat(40);
      manifest.corpusRevisionParentCommit = zero;
      manifest.producerRevisionPredecessorCommit = zero;
      const revisions = (((manifest.selfChecks as Record<string, unknown>)
        .authorizedDocumentRevisions as { revisions: Array<Record<string, unknown>> }).revisions);
      revisions.at(-1)!.producerRevisionPredecessorCommit = zero;
    });
    zeroParent.orchestrator.recordSaltCommitment(zeroParent.commitment.content);
    expect(() => zeroParent.orchestrator.recordManifestFreeze(zeroParent.freeze.content, zeroParent.manifest))
      .toThrow(/predecessor|parent.*Git|missing.*commit/i);

    const foreignSupport = ceremony((manifest) => {
      const foreign = 'f'.repeat(40);
      const support = manifest.lane3SupportBase as Record<string, unknown>;
      support.commit = foreign;
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      const dependency = (selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency;
      dependency.commit = foreign;
      const revisions = (selfChecks.authorizedDocumentRevisions as {
        revisions: Array<Record<string, unknown>>;
      }).revisions;
      revisions[5].directBaseCommit = foreign;
      revisions[6].lane3SupportBaseCommit = foreign;
      revisions.at(-1)!.lane3SupportBaseCommit = foreign;
    });
    foreignSupport.orchestrator.recordSaltCommitment(foreignSupport.commitment.content);
    expect(() => foreignSupport.orchestrator.recordManifestFreeze(foreignSupport.freeze.content, foreignSupport.manifest))
      .toThrow(/support.*commit|support.*ancestor|missing.*Git/i);

    const foreignBlob = ceremony((manifest) => {
      const support = manifest.lane3SupportBase as { typesBlob: string };
      (manifest.corpusSourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = support.typesBlob;
    });
    foreignBlob.orchestrator.recordSaltCommitment(foreignBlob.commitment.content);
    expect(() => foreignBlob.orchestrator.recordManifestFreeze(foreignBlob.freeze.content, foreignBlob.manifest))
      .toThrow(/source blob.*does not match|blob.*path/i);
  });

  it.each([
    ['a seventh path', {
      mutateFreezeTree(root: string): void {
        writeFileSync(join(root, 'docs/lane4/seventh-path.txt'), 'not authorized\n', 'utf8');
      },
    }],
    ['a copy from an unchanged support-tree source', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/unchanged-copy-source.md'), '# Corpus datasheet\n', 'utf8');
      },
    }],
    ['a deletion', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/support-only.txt'), 'must not be deleted\n', 'utf8');
      },
      mutateFreezeTree(root: string): void {
        rmSync(join(root, 'docs/lane4/support-only.txt'));
      },
    }],
    ['a rename', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/pre-rename.txt'), 'renamed content\n', 'utf8');
      },
      mutateFreezeTree(root: string): void {
        renameSync(
          join(root, 'docs/lane4/pre-rename.txt'),
          join(root, 'docs/lane4/post-rename.txt'),
        );
      },
    }],
    ['an executable mode', {
      mutateFreezeTree(root: string): void {
        chmodSync(join(root, 'docs/lane4/s33-corpus-datasheet.md'), 0o755);
      },
    }],
    ['a symbolic-link mode', {
      mutateFreezeTree(root: string): void {
        const path = join(root, 'docs/lane4/s33-corpus-datasheet.md');
        rmSync(path);
        symlinkSync('s33-wave1-batch-manifest.json', path);
      },
    }],
    ['a submodule/gitlink mode', {
      mutateFreezeIndex(root: string, predecessorCommit: string): void {
        execFileSync('git', [
          'update-index', '--add', '--cacheinfo', '160000', predecessorCommit,
          'docs/lane4/s33-corpus-datasheet.md',
        ], { cwd: root });
      },
    }],
  ] satisfies Array<[string, GitFixtureMutation]>)('rejects a support-to-freeze diff containing %s', (
    _case,
    mutateGit,
  ) => {
    const context = ceremony(undefined, mutateGit);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/producer diff|six authorized paths|status|mode|rename|deletion/i);
  });

  it('atomically consumes each policy/batch/revision once across contenders', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    const contender = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: context.consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'acceptance-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    const attempts = await Promise.allSettled([
      context.orchestrator.selectAndConsumeSample(input),
      contender.selectAndConsumeSample(input),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' ? winner.value.sampleEntryIds : []).toHaveLength(9);
    expect(context.consumptionRegistry.keys.size).toBe(1);
  });

  it('binds raw bytes separately from canonical content before consuming a registry key', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const rawVariant = `${context.commitment.content}\n`;
    expect(canonicalManifestHash(rawVariant)).toBe(canonicalManifestHash(context.commitment.content));
    expect(rawManifestHash(rawVariant)).not.toBe(rawManifestHash(context.commitment.content));
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: rawVariant,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    })).rejects.toThrow(/raw artifact bytes.*transcript/i);
    expect(context.consumptionRegistry.keys.size).toBe(0);
  });

  it('fails closed when the append-only ledger hash chain is modified', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const ledgerPath = join(context.evidenceRoot, 'acceptance-ledger.jsonl');
    const tampered = readFileSync(ledgerPath, 'utf8').replace('commitment-1', 'commitment-X');
    writeFileSync(ledgerPath, tampered, 'utf8');
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/transcript|digest|tamper/i);
  });

  it('rejects an adversarial transcript symlink swap and permissive file mode', () => {
    const swapped = ceremony();
    swapped.orchestrator.recordSaltCommitment(swapped.commitment.content);
    const swappedPath = join(swapped.evidenceRoot, 'acceptance-ledger.jsonl');
    const originalPath = join(swapped.evidenceRoot, 'acceptance-ledger-original.jsonl');
    renameSync(swappedPath, originalPath);
    symlinkSync(originalPath, swappedPath);
    expect(() => swapped.orchestrator.recordManifestFreeze(swapped.freeze.content, swapped.manifest))
      .toThrow(/symbolic|regular file|nofollow/i);

    const parentSwapped = ceremony();
    parentSwapped.orchestrator.recordSaltCommitment(parentSwapped.commitment.content);
    const originalDirectory = `${parentSwapped.evidenceRoot}-original`;
    const attackerDirectory = `${parentSwapped.evidenceRoot}-attacker`;
    tempRoots.push(originalDirectory, attackerDirectory);
    const validTranscript = readFileSync(
      join(parentSwapped.evidenceRoot, 'acceptance-ledger.jsonl'),
      'utf8',
    );
    renameSync(parentSwapped.evidenceRoot, originalDirectory);
    mkdirSync(attackerDirectory, { mode: 0o700 });
    writeFileSync(join(attackerDirectory, 'acceptance-ledger.jsonl'), validTranscript, { mode: 0o600 });
    symlinkSync(attackerDirectory, parentSwapped.evidenceRoot, 'dir');
    expect(() => parentSwapped.orchestrator.recordManifestFreeze(
      parentSwapped.freeze.content,
      parentSwapped.manifest,
    )).toThrow(/containment|directory/i);

    const permissive = ceremony();
    permissive.orchestrator.recordSaltCommitment(permissive.commitment.content);
    chmodSync(join(permissive.evidenceRoot, 'acceptance-ledger.jsonl'), 0o644);
    expect(() => permissive.orchestrator.recordManifestFreeze(permissive.freeze.content, permissive.manifest))
      .toThrow(/permissions|mode|0600/i);
  });

  it('rejects transcript hard links and non-regular replacements', () => {
    const hardLinked = ceremony();
    hardLinked.orchestrator.recordSaltCommitment(hardLinked.commitment.content);
    const hardLinkedPath = join(hardLinked.evidenceRoot, 'acceptance-ledger.jsonl');
    linkSync(hardLinkedPath, join(hardLinked.evidenceRoot, 'acceptance-ledger-alias.jsonl'));
    expect(() => hardLinked.orchestrator.recordManifestFreeze(hardLinked.freeze.content, hardLinked.manifest))
      .toThrow(/exactly one filesystem link|hard.?link/i);

    const nonRegular = ceremony();
    nonRegular.orchestrator.recordSaltCommitment(nonRegular.commitment.content);
    const nonRegularPath = join(nonRegular.evidenceRoot, 'acceptance-ledger.jsonl');
    renameSync(nonRegularPath, `${nonRegularPath}.original`);
    mkdirSync(nonRegularPath, { mode: 0o600 });
    expect(() => nonRegular.orchestrator.recordManifestFreeze(nonRegular.freeze.content, nonRegular.manifest))
      .toThrow(/regular file/i);
  });

  it('uses one validated transcript descriptor for read and append under the lock', () => {
    const source = readFileSync(new URL('./s33-batch-acceptance.ts', import.meta.url), 'utf8');
    expect(source.match(/openSync\(\s*this\.transcriptPath/g) ?? []).toHaveLength(1);
  });

  it('production loader fails closed because no CTO root or monotonic registry is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'arkova-s33-production-'));
    tempRoots.push(root);
    expect(() => createProductionS33AcceptanceOrchestrator({
      ledgerPath: join(root, 'ledger.jsonl'),
      repositoryRoot: root,
      verificationCommitSha: '00'.repeat(20),
    })).toThrow(/CTO trust root.*monotonic consumption registry.*not configured|fail closed/i);
  });

  it('parses the complete 81-entry Wave-1 universe and cannot lower its fixed sample floor', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
      sampleRatio: 0.01,
      entryIds: ['GD-S33-001'],
    } as never)).rejects.toThrow(/unknown caller controls.*sampleRatio.*entryIds/i);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(result.sampleEntryIds).toHaveLength(9);
    expect(parseBatchManifest(context.manifest).entries).toHaveLength(81);
  });
});

function lexicalTextArtifact(
  role: 'heldout' | 'corpus',
  records: Array<{ id: string; text: string }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithmVersion: 's33-lexical-text-artifact-v1',
    artifactId: `S33-${role}-1`,
    role,
    records: records.map(({ id, text }) => ({ id, text, contentSha256: sha256(text) })),
  }, null, 2);
}

describe('S3.3 authenticated lexical scan boundary', () => {
  it('loads authenticated text artifacts and recomputes n=6..13 before verdict', () => {
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{
      id: 'KE-001',
      text: 'Nursing Council registration certificate for a licensed practitioner in Nairobi County',
    }]);
    const corpus = lexicalTextArtifact('corpus', [{
      id: 'training/example:4',
      text: 'A nursing council registration certificate for a licensed practitioner in Nairobi County was supplied',
    }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-1',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: {
        unicodeForm: 'NFKC',
        caseFold: 'lowercase',
        nonAlphanumeric: 'space',
        whitespace: 'collapse',
      },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 3,
      minimumHeldoutContainment: 0.5,
      combination: 'all',
    }, context.privateKey);
    const result = context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    });
    expect(result.metrics).toHaveLength(8);
    expect(result.hits.some((hit) => hit.n === 6)).toBe(true);
    expect(result.evidence.metricAlgorithmVersion).toBe('token-set-ngram-v1');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.metrics[0])).toBe(true);
    expect(Object.isFrozen(result.hits)).toBe(true);
    expect(Object.isFrozen(result.hits[0])).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(() => (result.metrics as unknown[]).pop()).toThrow(TypeError);
    expect(() => {
      (result.evidence as { metricCount: number }).metricCount = 0;
    }).toThrow(TypeError);
    const duplicateHeldout = heldout.replace('"id": "KE-001",', '"id": "KE-001",\n      "id": "KE-001",');
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: duplicateHeldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/duplicate.*id/i);
  });

  it('has no public policy-only API and rejects a complete fabricated all-zero matrix', () => {
    expect(acceptanceModule).not.toHaveProperty('applyLexicalLeakagePolicy');
    expect(acceptanceModule).not.toHaveProperty('computeLexicalLeakageMetrics');
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six seven eight' }]);
    const corpus = lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six seven eight' }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-2',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1,
      combination: 'all',
    }, context.privateKey);
    const fabricated = Array.from({ length: 8 }, (_, index) => ({
      heldoutId: 'H', corpusId: 'C', n: index + 6,
      heldoutNgrams: 0, corpusNgrams: 0, sharedNgrams: 0,
      heldoutContainment: 0, jaccard: 0,
    }));
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
      metrics: fabricated,
    } as never)).toThrow(/unknown.*metrics|precomputed.*not accepted/i);
  });

  it('rejects text-content hash or signed artifact binding mismatches', () => {
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six' }]);
    const corpusObject = JSON.parse(lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six' }])) as {
      records: Array<{ text: string }>;
    };
    corpusObject.records[0].text = 'tampered text with unchanged content hash';
    const corpus = JSON.stringify(corpusObject);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy', artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-3', signerIdentity: 'Arkova CTO', signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z', metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1', heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout), corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus), corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13], minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1, combination: 'all',
    }, context.privateKey);
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/content hash/i);
  });
});

describe('S3.3 embedding arithmetic', () => {
  it('rejects non-finite derived dot/norm/cosine arithmetic', () => {
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1e308, 1e308] }],
      [{ id: 'corpus', model: 'model-a', vector: [1e308, 1e308] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/overflow|non-finite|arithmetic/i);
  });

  it('propagates provider failures and rejects incomplete output', async () => {
    const failedProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      failedProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/provider unavailable/i);
  });
});
