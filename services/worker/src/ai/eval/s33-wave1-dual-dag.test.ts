import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_ENTRY_IDS,
  WAVE1_MANIFEST_PATH,
  WAVE1_SOURCE_BLOB_PATHS,
  WAVE1_TYPES_PATH,
} from './s33-batch-acceptance.js';
import {
  S33_WAVE1_R12_EVIDENCE_PATH,
  S33_WAVE1_R12_EVIDENCE_REF,
  S33_WAVE1_R12_FREEZE_REF,
  S33_WAVE1_R12_PRODUCTION_EVIDENCE,
  S33_WAVE1_R12_IMMEDIATE_CHANGED_PATHS,
  S33_WAVE1_PACKET_PATHS,
  S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE,
  S33_WAVE1_R12_CPE_DEPTH_BINDING,
  S33_WAVE1_R12_BINDING_ADJUDICATIONS,
  S33_WAVE1_R12_SOURCE_TRANSITION_BINDING,
  createTestOnlyS33Wave1R12EvidenceVerifier,
  inspectS33Wave1PacketRevision,
  verifyS33Wave1DualDagContract,
  type S33Wave1DualDagPins,
  type S33Wave1PacketInspection,
} from './s33-wave1-dual-dag.js';

const GIT = '/usr/bin/git';
const roots: string[] = [];
const HISTORICAL_STATUS = 'HISTORICAL_BLOCKED';
const HISTORICAL_ACCEPTANCE = 'REJECTED_HISTORICAL_BLOCKED';
const REVISION12_STATUS = 'PRODUCER_REVISION_12_CANDIDATE';
const REVISION12_ACCEPTANCE = 'NOT_RUN_PRODUCER_BOUNDARY';
const ADJUDICATIONS = S33_WAVE1_R12_BINDING_ADJUDICATIONS;
const TEST_CPE_IDS = new Set<string>(
  S33_WAVE1_R12_CPE_DEPTH_BINDING.acceptanceOnlyCpeEntryIds,
);
const TEST_LEAKAGE_IDS = [...S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.leakage32EntryIds];
const TEST_SOURCE_TRANSITION_IDS = [
  ...S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.exactSourceTransitionEntryIds,
];
const HISTORICAL_ADJUDICATIONS = {
  cpeSubtypeRatification: { status: 'BLOCKED_CTO_L3' },
  taxonomyAdjudicationSet: {
    status: 'BLOCKED_CTO_L3',
    entryIds: S33_WAVE1_R12_BINDING_ADJUDICATIONS.taxonomyAdjudicationSet.entryIds,
  },
  issuedDateAdjudicationSet: {
    status: 'BLOCKED_CTO_L3',
    entryIds: S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.entryIds,
  },
  oodFiveFieldSemantics: {
    status: 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3',
    entryIds: S33_WAVE1_R12_BINDING_ADJUDICATIONS.oodFiveFieldSemantics.entryIds,
    producerTruth: 'Pure abstention labels contain only OTHER, other, and empty fraudSignals.',
    contradiction: 'The historical five-field floor conflicts with pure abstention truth.',
    resolutionOwner: 'Lane 3 / CTO',
  },
} as const;
const HISTORICAL_CHANGED_PATHS = [
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_SOURCE_BLOB_PATHS[0],
  WAVE1_SOURCE_BLOB_PATHS[1],
];
const REVISION12_CHANGED_PATHS = [
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_MANIFEST_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_SOURCE_BLOB_PATHS[0],
  WAVE1_SOURCE_BLOB_PATHS[1],
];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(root: string, args: readonly string[], input?: string): string {
  return execFileSync(GIT, ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
    },
    input,
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function domainFor(id: string): string {
  if (id.includes('-OOD-')) return 'out-of-distribution';
  if (id.includes('-KE-') || id.includes('-AU-')) return 'au-ke-priority-documents';
  return 'professional-licensing';
}

function sourcePathFor(id: string): (typeof WAVE1_SOURCE_BLOB_PATHS)[number] {
  if (id.includes('-OOD-')) return WAVE1_SOURCE_BLOB_PATHS[2];
  if (id.includes('-KE-') || id.includes('-AU-')) return WAVE1_SOURCE_BLOB_PATHS[1];
  return WAVE1_SOURCE_BLOB_PATHS[0];
}

function categoryFor(path: (typeof WAVE1_SOURCE_BLOB_PATHS)[number]): string {
  if (path === WAVE1_SOURCE_BLOB_PATHS[0]) return 's33-licensing-heldout';
  if (path === WAVE1_SOURCE_BLOB_PATHS[1]) return 's33-au-ke-heldout';
  return 's33-ood-negative';
}

function exportNameFor(path: (typeof WAVE1_SOURCE_BLOB_PATHS)[number]): string {
  if (path === WAVE1_SOURCE_BLOB_PATHS[0]) return 'S33_LICENSING_HELDOUT';
  if (path === WAVE1_SOURCE_BLOB_PATHS[1]) return 'S33_AU_KE_HELDOUT';
  return 'S33_OOD_NEGATIVES';
}

function groundTruth(id: string, failing: boolean): Record<string, unknown> {
  if (id.includes('-OOD-')) {
    return { credentialType: 'OTHER', subType: 'other', fraudSignals: [] };
  }
  if (failing) {
    return { credentialType: 'LICENSE', subType: 'general', fraudSignals: [] };
  }
  if (TEST_CPE_IDS.has(id)) {
    return {
      credentialType: 'CPE',
      subType: 'general_cpe',
      issuerName: `Issuer ${id}`,
      recipientIdentifier: `recipient-${id}`,
      issuedDate: S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.resolvedValues[
        id as keyof typeof S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.resolvedValues
      ] ?? '2026-01-01',
      expiryDate: '2027-01-01',
      creditHours: 1,
      creditType: 'general',
      activityNumber: `ACT-${id}`,
      providerName: `Provider ${id}`,
      fraudSignals: [],
    };
  }
  const taxonomyValue = S33_WAVE1_R12_BINDING_ADJUDICATIONS.taxonomyAdjudicationSet.resolvedValues[
    id as keyof typeof S33_WAVE1_R12_BINDING_ADJUDICATIONS.taxonomyAdjudicationSet.resolvedValues
  ];
  const [credentialType = 'LICENSE', subType = 'general'] = taxonomyValue?.split('/') ?? [];
  const truth: Record<string, unknown> = {
    credentialType,
    subType,
    issuerName: `Issuer ${id}`,
    recipientIdentifier: `recipient-${id}`,
    issuedDate: S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.resolvedValues[
      id as keyof typeof S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet.resolvedValues
    ] ?? '2026-01-01',
    licenseNumber: `LIC-${id}`,
    fraudSignals: [],
  };
  if (!failing) {
    truth.expiryDate = '2027-01-01';
    truth.jurisdiction = 'US';
    if (credentialType === 'FINANCIAL') {
      truth.fieldOfStudy = 'Tax';
      truth.accreditingBody = 'Revenue Authority';
    }
  }
  return truth;
}

function strippedText(
  id: string,
  revision: 10 | 11 | 12,
  undeclaredFingerprintChange = false,
  normalizedEquivalentRawChange = false,
): string {
  const base = `independently authored fixture ${id} unique token ${id.replaceAll('-', ' ')}`;
  if (revision === 12 && normalizedEquivalentRawChange && id === 'GD-S33-KE-008') {
    return base.replace('independently', 'INDEPENDENTLY');
  }
  const changed = TEST_SOURCE_TRANSITION_IDS.includes(id)
    || (undeclaredFingerprintChange && id === 'GD-S33-KE-008');
  const suffix = revision === 12 && changed
    ? ' revision twelve reauthored'
    : '';
  return `${base}${suffix}`;
}

function packetEntries(
  failing: boolean,
  revision: 10 | 11 | 12,
  undeclaredFingerprintChange = false,
  normalizedEquivalentRawChange = false,
): Array<{
  category: string;
  groundTruth: Record<string, unknown>;
  id: string;
  strippedText: string;
}> {
  return WAVE1_ENTRY_IDS.map((id) => {
    const path = sourcePathFor(id);
    return {
      category: categoryFor(path),
      groundTruth: groundTruth(
        id,
        failing && (id === 'GD-S33-BAR-001' || id === 'GD-S33-KE-001'),
      ),
      id,
      strippedText: strippedText(
        id,
        revision,
        undeclaredFingerprintChange,
        normalizedEquivalentRawChange,
      ),
    };
  });
}

function entryRows(entries: ReturnType<typeof packetEntries>): Record<string, unknown>[] {
  return entries.map((entry) => ({
    id: entry.id,
    domain: domainFor(entry.id),
    realOrSynthetic: 'synthetic',
    authorshipMethod: 'independently-authored',
    generatorDerived: false,
    sourceProvenance: 'test-only independent authorship',
    lawfulBasis: 'test fixture',
    generator: {
      name: 'none-independent-human-authorship',
      version: 'not-applicable-no-generator',
      seed: 'not-applicable-no-rng',
      templateId: 'not-applicable-no-template',
    },
    jurisdiction: entry.id.includes('-OOD-') ? 'N/A' : 'US',
    jurisdictionDetail: entry.id.includes('-OOD-') ? null : 'Test jurisdiction',
    credentialType: entry.groundTruth.credentialType,
    subType: entry.groundTruth.subType,
    curationAuthor: 'Lane 4 test fixture',
    curationDate: '2026-07-14',
    licenseConsentNote: 'No real document',
  }));
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedSha(id: string, revision: 10 | 11 | 12): string {
  return sha256(strippedText(id, revision).toLowerCase().replace(/\s+/gu, ' ').trim());
}

function authorizedRevisionHistory(
  revision: 10 | 11 | 12,
  physicalParent: string,
  supportBaseline: string,
): Record<string, unknown>[] {
  const prior: Record<string, unknown>[] = [
    { revision: 2, authority: 'test authority 2', changedEntryIds: [], normalizedInputChanged: false },
    {
      revision: 3, authority: 'test authority 3', changedEntryIds: [], change: 'test change 3',
      normalizedInputChanged: false, remainingSubstantiveGroundTruthFields: 6,
    },
    {
      revision: 4, authority: 'test authority 4', changedEntryIds: [], changes: ['test change 4'],
      normalizedInputChanged: false, remainingSubstantiveGroundTruthFields: {},
    },
    {
      revision: 5, authority: 'test authority 5', changedEntryIds: [], changes: ['test change 5'],
      normalizedInputChanged: false, normalizedInputChangedEntryIds: [],
      remainingSubstantiveGroundTruthFields: {},
    },
    {
      revision: 6, authority: 'test authority 6', changedEntryIds: [], change: 'test change 6',
      normalizedInputChanged: false, recomputedNormalizedInputSha256: {},
      remainingSubstantiveGroundTruthFields: {},
    },
    {
      revision: 7, authority: 'test authority 7', changedEntryIds: [], change: 'test change 7',
      corpusDataChanged: false, normalizedInputChanged: false,
      producerRevisionPredecessorCommit: physicalParent, directBaseCommit: physicalParent,
      sourceBlobsUnchangedFromRevision6: true,
    },
    {
      revision: 8, authority: 'test authority 8', changedEntryIds: [], changes: ['test change 8'],
      normalizedInputChanged: false, normalizedInputChangedEntryIds: [],
      recomputedNormalizedInputSha256: {}, remainingSubstantiveGroundTruthFields: {},
      producerRevisionPredecessorCommit: physicalParent, lane3SupportBaseCommit: supportBaseline,
    },
    {
      revision: 9, authority: 'test authority 9', changedEntryIds: [], verifiedUnchangedEntryIds: [],
      changes: ['test change 9'], corpusSourceTextChanged: false, normalizedInputChanged: false,
      normalizedInputPinsPreservedFromRevision8: true, remainingSubstantiveGroundTruthFields: {},
      producerRevisionPredecessorCommit: physicalParent, lane3SupportBaseCommit: supportBaseline,
    },
    {
      revision: 10, authority: 'test authority 10', changedEntryIds: [], change: 'test change 10',
      corpusDataChanged: false, normalizedInputChanged: false, sourceBlobsUnchangedFromRevision9: true,
      normalizedInputPinsPreservedFromRevision9: true,
      producerRevisionPredecessorCommit: physicalParent, directBaseCommit: physicalParent,
      lane3SupportBaseCommit: supportBaseline,
    },
  ];
  if (revision === 10) return prior;
  prior.push({
    revision: 11,
    authority: 'test authority 11',
    changedEntryIds: ['GD-S33-KE-001'],
    changes: ['test historical blocked change'],
    corpusSourceTextChanged: false,
    normalizedInputChanged: false,
    normalizedInputPinsPreservedFromRevision10: true,
    remainingSubstantiveGroundTruthFields: {},
    producerRevisionPredecessorCommit: physicalParent,
    directBaseCommit: physicalParent,
    lane3SupportBaseCommit: supportBaseline,
  });
  if (revision === 11) return prior;

  const recomputed = Object.fromEntries(TEST_SOURCE_TRANSITION_IDS.map((id) => [id, normalizedSha(id, 12)]));
  const transitions = Object.fromEntries(TEST_SOURCE_TRANSITION_IDS.map((id) => [id, {
    from: normalizedSha(id, 11),
    to: normalizedSha(id, 12),
  }]));
  prior.push({
    revision: 12,
    authority: 'Binding CTO dual-DAG and leakage remediation test contract',
    changedEntryIds: TEST_SOURCE_TRANSITION_IDS,
    adjudicatedUnchangedEntryIds: ['GD-S33-AU-002', 'GD-S33-AU-011'],
    changes: ['test-only exact revision 12 semantic repair'],
    corpusSourceTextChanged: true,
    normalizedInputChanged: true,
    normalizedInputChangedEntryIds: TEST_SOURCE_TRANSITION_IDS,
    recomputedNormalizedInputSha256: recomputed,
    productionContractResult: {
      coveredEntryCount: 72,
      failedEntryCountBefore: 32,
      failedEntryCountAfter: 0,
      postValidationMinimum: 5,
      cpeTypeCorrectionsWithinRed32: 18,
      groundedCurationsWithinRed32: 14,
      additionalTruthfulCpeTypeCorrections: 2,
    },
    producerRevisionPredecessorCommit: physicalParent,
    directBaseCommit: physicalParent,
    evaluatorSupportCommit: supportBaseline,
    sourceTextChangedEntryIds: TEST_SOURCE_TRANSITION_IDS,
    lexicalLeakageRemediation: {
      decision: 'B_REAUTHOR_EXACT_32_SOURCES_IN_R12_PRECOMMIT',
      mergedLeakageScannerCommit: '48b562c2fa945bbcb60af141dd38a0cc49b4a737',
      evaluatorScannerCommit: S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE.commitSha,
      heldoutLeakageBlob: '908e52a16e27c1a269f0526d449f30dcf9555ee0',
      algorithm: 'normalized-token-exact-ngram-v1',
      normalization: 'NFKC;lowercase;non-alphanumeric-space;whitespace-collapse',
      n: [6, 7, 8, 9, 10, 11, 12, 13],
      preRemediation: {
        status: 'RED',
        trainingCorpusFileCount: 307,
        trainingManifestCanonicalSha256: '28c1de452ab2c472e68a6a2f3a2cc69c0945446f7db004a16411f204673a141b',
        exactMatchCount: 341,
        affectedEntryCount: 32,
        hitsByN: { '6': 142, '7': 85, '8': 53, '9': 29, '10': 16, '11': 9, '12': 5, '13': 2 },
        affectedEntryIds: TEST_LEAKAGE_IDS,
      },
      postRemediation: {
        status: 'PASS_PRODUCER_AND_RTE_INDEPENDENT_PENDING_L3',
        trainingCorpusFileCount: 307,
        exactMatchCount: 0,
        affectedEntryCount: 0,
        hitsByN: { '6': 0, '7': 0, '8': 0, '9': 0, '10': 0, '11': 0, '12': 0, '13': 0 },
        rteIndependentGroundTruthContractPassEntryCount: 81,
      },
      separatelyAuthorizedNonLeakageSourceTransitions: {
        authority: S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.separatelyAuthorizedAuthority,
        entryIds: S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.separatelyAuthorizedNonLeakageEntryIds,
        disjointFromLeakageAffectedEntryIds: true,
      },
      parentToRevision12FingerprintTransitions: transitions,
    },
  });
  return prior;
}

function selfChecks(
  root: string,
  revision: 10 | 11 | 12,
  lane3AcceptanceStatus: string,
  physicalParent: string,
  supportBaseline: string,
  failureIds: readonly string[],
  adjudications: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const producerChangedPaths = revision === 12
    ? REVISION12_CHANGED_PATHS
    : revision === 11
      ? HISTORICAL_CHANGED_PATHS
      : S33_WAVE1_PACKET_PATHS;
  const productionDepthContract = revision === 12
    ? {
        status: 'PASS', evaluatorSupportCommit: supportBaseline, postValidationMinimum: 5,
        failedEntryCount: 0, failedEntryIds: [],
        ...S33_WAVE1_R12_CPE_DEPTH_BINDING,
      }
    : {
        status: HISTORICAL_STATUS, evaluatorSupportCommit: supportBaseline, postValidationMinimum: 5,
        failedEntryCount: failureIds.length,
        failedEntryIdsSha256: sha256(canonicaliseJson(failureIds)),
        failedEntryIds: failureIds,
      };
  return {
    exactCorpusManifestDatasheetBijection: { status: 'PASS', entryCount: 81 },
    normalizedInputFingerprintsPinned: {
      status: 'PASS', algorithm: 'sha256(normalizeForFingerprint(strippedText))',
    },
    productionDepthContract,
    authorizedDocumentRevisions: {
      status: 'PASS', revisions: authorizedRevisionHistory(revision, physicalParent, supportBaseline),
    },
    withinTypeTokenOverlap: {
      status: 'PASS', threshold: 0.8, metric: 'test overlap metric',
      violations: [], remediatedPairScores: [],
    },
    ...adjudications,
    batchScopeOnly: {
      status: 'PASS',
      producerChangedPaths,
      excludedFromBatch: [
        '.sonarcloud.properties',
        'docs/lane4/s33-lane4-plan.md',
        'services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts',
        WAVE1_TYPES_PATH,
      ],
      protocolAllowedDiffPaths: S33_WAVE1_PACKET_PATHS,
      dependency: {
        owner: 'Lane 3', branch: 'test-support', commit: supportBaseline,
        typesPath: WAVE1_TYPES_PATH,
        typesBlob: git(root, ['rev-parse', `${supportBaseline}:${WAVE1_TYPES_PATH}`]),
        presentIdenticallyInBase: false, includedInProducerDiff: false,
        reviewState: 'CTO_APPROVED_DUAL_DAG_R12_EVALUATOR_ROOT',
      },
      reason: 'Test-only independent support DAG contract.',
      authority: 'Binding test protocol.',
    },
    lane3Acceptance: { status: lane3AcceptanceStatus },
  };
}

type SemanticMutation = NonNullable<FixtureOptions['semanticMutation']>;

function writePacket(
  root: string,
  revision: 10 | 11 | 12,
  status: string,
  lane3AcceptanceStatus: string,
  failing: boolean,
  physicalParent: string,
  supportBaseline: string,
  adjudications: Readonly<Record<string, unknown>> = ADJUDICATIONS,
  semanticMutation?: SemanticMutation,
): void {
  const entries = packetEntries(
    failing,
    revision,
    semanticMutation === 'undeclaredFingerprintChange',
    semanticMutation === 'normalizedEquivalentRawChange',
  );
  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const rows = entries.filter((entry) => sourcePathFor(entry.id) === path);
    write(root, path, `export const ${exportNameFor(path)} = ${JSON.stringify(rows, null, 2)} as const;\n`);
  }
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_BLOB_PATHS.map((path) => [
    path,
    git(root, ['hash-object', '-w', path]),
  ]));
  const manifestEntries = entries.map((entry) => ({
    id: entry.id,
    domain: domainFor(entry.id),
    credentialType: entry.groundTruth.credentialType,
    normalizedInputSha256: sha256(entry.strippedText.toLowerCase().replace(/\s+/gu, ' ').trim()),
  }));
  const manifest = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status,
    corpusRevisionParentCommit: physicalParent,
    producerRevisionPredecessorCommit: physicalParent,
    lane3SupportBase: {
      commit: supportBaseline,
      typesPath: WAVE1_TYPES_PATH,
      typesBlob: git(root, ['rev-parse', `${supportBaseline}:${WAVE1_TYPES_PATH}`]),
      reviewState: 'CTO_APPROVED_DUAL_DAG_R12_EVALUATOR_ROOT',
    },
    corpusSourceBlobs: sourceBlobs,
    intendedSplit: 'held-out-candidate',
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    entryCount: 81,
    counts: {
      byDomain: countBy(manifestEntries.map(({ domain }) => domain)),
      byCredentialType: countBy(manifestEntries.map(({ credentialType }) => String(credentialType))),
      byCorpusSlice: countBy(entries.map(({ category }) => category)),
    },
    kenyaEntryIds: WAVE1_ENTRY_IDS.filter((id) => id.includes('-KE-')),
    selfChecks: selfChecks(
      root,
      revision,
      lane3AcceptanceStatus,
      physicalParent,
      supportBaseline,
      failing ? ['GD-S33-BAR-001', 'GD-S33-KE-001'] : [],
      adjudications,
    ),
    entries: manifestEntries,
  };
  if (semanticMutation === 'unknownManifest') {
    Object.assign(manifest, { unexpectedManifestKey: true });
  } else if (semanticMutation === 'unknownSelfCheck') {
    Object.assign(manifest.selfChecks, { unexpectedSelfCheckKey: true });
  } else if (semanticMutation === 'unknownNested') {
    const batchScope = manifest.selfChecks.batchScopeOnly as Record<string, unknown>;
    const dependency = batchScope.dependency as Record<string, unknown>;
    dependency.unexpectedDependencyKey = true;
  } else if (semanticMutation === 'badLeakage') {
    const history = manifest.selfChecks.authorizedDocumentRevisions as Record<string, unknown>;
    const revisions = history.revisions as Record<string, unknown>[];
    const revision12 = revisions.at(-1) as Record<string, unknown>;
    const leakage = revision12.lexicalLeakageRemediation as Record<string, unknown>;
    const post = leakage.postRemediation as Record<string, unknown>;
    post.exactMatchCount = 1;
  } else if (semanticMutation === 'badCpeDepthDigest') {
    const depth = manifest.selfChecks.productionDepthContract as Record<string, unknown>;
    depth.acceptanceOnlyCpeEntryIdsSha256 = '0'.repeat(64);
  } else if (semanticMutation === 'leakageIncludesKe006') {
    const history = manifest.selfChecks.authorizedDocumentRevisions as Record<string, unknown>;
    const revision12 = (history.revisions as Record<string, unknown>[]).at(-1) as Record<string, unknown>;
    const leakage = revision12.lexicalLeakageRemediation as Record<string, unknown>;
    const pre = leakage.preRemediation as Record<string, unknown>;
    pre.affectedEntryIds = [...pre.affectedEntryIds as string[], 'GD-S33-KE-006'];
    pre.affectedEntryCount = 33;
  } else if (semanticMutation === 'missingAuthorizedKe006') {
    const history = manifest.selfChecks.authorizedDocumentRevisions as Record<string, unknown>;
    const revision12 = (history.revisions as Record<string, unknown>[]).at(-1) as Record<string, unknown>;
    const leakage = revision12.lexicalLeakageRemediation as Record<string, unknown>;
    const authorized = leakage.separatelyAuthorizedNonLeakageSourceTransitions as Record<string, unknown>;
    authorized.entryIds = [];
  } else if (semanticMutation === 'unauthorizedSourceTransition') {
    const history = manifest.selfChecks.authorizedDocumentRevisions as Record<string, unknown>;
    const revision12 = (history.revisions as Record<string, unknown>[]).at(-1) as Record<string, unknown>;
    const id = 'GD-S33-KE-008';
    const digest = manifestEntries.find((entry) => entry.id === id)!.normalizedInputSha256;
    revision12.sourceTextChangedEntryIds = [...revision12.sourceTextChangedEntryIds as string[], id];
    revision12.normalizedInputChangedEntryIds = [
      ...revision12.normalizedInputChangedEntryIds as string[], id,
    ];
    const recomputed = revision12.recomputedNormalizedInputSha256 as Record<string, unknown>;
    recomputed[id] = digest;
    const leakage = revision12.lexicalLeakageRemediation as Record<string, unknown>;
    const transitions = leakage.parentToRevision12FingerprintTransitions as Record<string, unknown>;
    transitions[id] = { from: '0'.repeat(64), to: digest };
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  write(root, WAVE1_MANIFEST_PATH, manifestText);
  const datasheet = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision,
    manifestSha256: sha256(manifestText),
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status,
    entryCount: 81,
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    authorshipNote: 'Test-only independent fixture.',
    rows: entryRows(entries),
  };
  if (semanticMutation === 'blankProvenance') datasheet.rows[0].sourceProvenance = '   ';
  write(root, WAVE1_ENTRY_DATASHEET_PATH, `${JSON.stringify(datasheet, null, 2)}\n`);
  write(
    root,
    WAVE1_CORPUS_DATASHEET_PATH,
    `# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision ${revision})\n\n`
      + `Current producer revision: \`S33-W1\` revision ${revision}; exact raw-file SHA-256 \`${sha256(manifestText)}\`.\n`
      + 'The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.\n'
      + `Shared types use blob \`${git(root, ['rev-parse', `${supportBaseline}:${WAVE1_TYPES_PATH}`])}\` on commit \`${supportBaseline}\`.\n`
      + `Revision ${revision} has sole physical parent and direct base \`${physicalParent}\`; its logical producer predecessor is exact commit \`${physicalParent}\`. The separate Lane-3 evaluator root is \`${supportBaseline}\`.\n`,
  );
}

function packetBlobs(root: string, head: string): Record<(typeof S33_WAVE1_PACKET_PATHS)[number], string> {
  return Object.fromEntries(S33_WAVE1_PACKET_PATHS.map((path) => [
    path,
    git(root, ['rev-parse', `${head}:${path}`]),
  ])) as Record<(typeof S33_WAVE1_PACKET_PATHS)[number], string>;
}

function pinsForInspection(
  inspection: S33Wave1PacketInspection,
  expectedFailureIds: readonly string[],
  adjudications: Readonly<Record<string, unknown>>,
): S33Wave1DualDagPins['historical'] {
  return {
    headSha: inspection.producerHeadSha,
    revision: inspection.revision,
    status: inspection.status,
    lane3AcceptanceStatus: inspection.lane3AcceptanceStatus,
    adjudications,
    packet: {
      packetBlobs: inspection.packetBlobs,
      manifestRawSha256: inspection.manifestRawSha256,
      manifestCanonicalSha256: inspection.manifestCanonicalSha256,
      entryDatasheetRawSha256: inspection.entryDatasheetRawSha256,
      entryDatasheetCanonicalSha256: inspection.entryDatasheetCanonicalSha256,
      entriesSha256: inspection.entriesSha256,
      normalizedPinsSha256: inspection.normalizedPinsSha256,
      entryRowsSha256: inspection.entryRowsSha256,
    },
    expectedGroundTruthFailureIds: [...expectedFailureIds],
    expectedGroundTruthFailureDigestSha256: inspection.groundTruthFailureDigestSha256,
  };
}

interface FixtureOptions {
  includeEvidence?: boolean;
  badCpeAdjudicationPolicy?: boolean;
  executablePacket?: boolean;
  finalWrongParent?: boolean;
  historicalEdgeAttack?: 'copy' | 'delete' | 'gitlink' | 'rename' | 'symlink';
  historicalIntermediate?: boolean;
  historicalModeNormalization?: boolean;
  historicalTamperRevert?: boolean;
  outsideChange?: boolean;
  residualFailure?: boolean;
  evidenceAttack?:
    | 'extra-path'
    | 'duplicate-key'
    | 'executable'
    | 'gitlink'
    | 'invalid-utf8'
    | 'missing-binding'
    | 'packet-mutation'
    | 'report-tamper'
    | 'self-pinned'
    | 'symlink'
    | 'unknown-key'
    | 'wrong-parent';
  semanticMutation?:
    | 'badCpeDepthDigest'
    | 'badLeakage'
    | 'blankProvenance'
    | 'leakageIncludesKe006'
    | 'missingAuthorizedKe006'
    | 'normalizedEquivalentRawChange'
    | 'unauthorizedSourceTransition'
    | 'undeclaredFingerprintChange'
    | 'unknownManifest'
    | 'unknownNested'
    | 'unknownSelfCheck';
}

function fixture(options: FixtureOptions = {}): {
  evidenceAnchor?: {
    blobSha: string;
    canonicalSha256: string;
    commitSha: string;
    finalCommitSha: string;
    finalTreeSha: string;
    freezeRefName: typeof S33_WAVE1_R12_FREEZE_REF;
    rawSha256: string;
    refName: typeof S33_WAVE1_R12_EVIDENCE_REF;
  };
  pins: S33Wave1DualDagPins;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 's33-dual-dag-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Lane 3 Test']);
  git(root, ['config', 'user.email', 'lane3-test@arkova.invalid']);
  write(root, WAVE1_TYPES_PATH, 'export const SUPPORT_VERSION = 1;\n');
  write(root, 'README.md', 'merge base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'dual DAG merge base']);
  const mergeBaseSha = git(root, ['rev-parse', 'HEAD']);

  git(root, ['checkout', '-qb', 'producer']);
  writePacket(
    root,
    10,
    'PRODUCER_REVISION_10_BASELINE',
    'NOT_RUN_PRODUCER_BOUNDARY',
    false,
    mergeBaseSha,
    mergeBaseSha,
    HISTORICAL_ADJUDICATIONS,
  );
  if (options.historicalModeNormalization) {
    chmodSync(join(root, WAVE1_SOURCE_BLOB_PATHS[1]), 0o755);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'revision 10 producer baseline']);
  const revision10HeadSha = git(root, ['rev-parse', 'HEAD']);

  if (options.historicalIntermediate) {
    write(root, 'historical-intermediate.txt', 'unauthorized intermediate history\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'unauthorized historical intermediate']);
  }
  if (options.historicalTamperRevert) {
    write(root, WAVE1_SOURCE_BLOB_PATHS[1], 'tampered producer packet\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'tamper historical packet']);
    git(root, ['checkout', revision10HeadSha, '--', WAVE1_SOURCE_BLOB_PATHS[1]]);
    git(root, ['commit', '-qm', 'revert historical packet tamper']);
  }

  writePacket(
    root,
    11,
    HISTORICAL_STATUS,
    HISTORICAL_ACCEPTANCE,
    true,
    revision10HeadSha,
    mergeBaseSha,
    HISTORICAL_ADJUDICATIONS,
  );
  if (options.historicalModeNormalization) {
    chmodSync(join(root, WAVE1_SOURCE_BLOB_PATHS[1]), 0o644);
  }
  const historicalAttackPath = WAVE1_SOURCE_BLOB_PATHS[1];
  if (options.historicalEdgeAttack === 'rename') {
    git(root, ['mv', historicalAttackPath, `${historicalAttackPath}.renamed`]);
  } else if (options.historicalEdgeAttack === 'copy') {
    copyFileSync(join(root, historicalAttackPath), join(root, `${historicalAttackPath}.copy`));
  } else if (options.historicalEdgeAttack === 'delete') {
    rmSync(join(root, historicalAttackPath));
  } else if (options.historicalEdgeAttack === 'symlink') {
    rmSync(join(root, historicalAttackPath));
    symlinkSync('golden-dataset-s33-licensing-heldout.ts', join(root, historicalAttackPath));
  }
  git(root, ['add', '.']);
  if (options.historicalEdgeAttack === 'gitlink') {
    rmSync(join(root, historicalAttackPath));
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${revision10HeadSha},${historicalAttackPath}`]);
  }
  git(root, ['commit', '-qm', 'revision 11 prime historical packet']);
  const historicalHeadSha = git(root, ['rev-parse', 'HEAD']);
  const historicalChangedPaths = git(root, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', revision10HeadSha, historicalHeadSha,
  ]).split('\n').filter(Boolean);

  const revision12Adjudications = options.badCpeAdjudicationPolicy
    ? {
        ...ADJUDICATIONS,
        cpeSubtypeRatification: {
          ...ADJUDICATIONS.cpeSubtypeRatification,
          modelMismatchDisposition: 'MODEL_SOFT',
        },
      }
    : ADJUDICATIONS;

  writePacket(
    root,
    12,
    REVISION12_STATUS,
    REVISION12_ACCEPTANCE,
    options.residualFailure ?? false,
    historicalHeadSha,
    mergeBaseSha,
    revision12Adjudications,
    options.semanticMutation,
  );
  if (options.outsideChange) write(root, 'outside-producer-packet.txt', 'forbidden\n');
  if (options.executablePacket) chmodSync(join(root, WAVE1_SOURCE_BLOB_PATHS[1]), 0o755);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'revision 12 producer repair']);
  const revision12HeadSha = git(root, ['rev-parse', 'HEAD']);
  const changedPaths = git(root, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', historicalHeadSha, revision12HeadSha,
  ]).split('\n').filter(Boolean).filter((path) => S33_WAVE1_PACKET_PATHS.includes(
    path as (typeof S33_WAVE1_PACKET_PATHS)[number],
  ));

  git(root, ['checkout', '-qb', 'support', mergeBaseSha]);
  write(root, WAVE1_TYPES_PATH, 'export const SUPPORT_VERSION = 12;\n');
  write(root, 'services/worker/src/ai/eval/lane3-support-marker.ts', 'export const DUAL_DAG = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Lane 3 support head']);
  const supportHeadSha = git(root, ['rev-parse', 'HEAD']);
  const supportTypesBlob = git(root, ['rev-parse', `${supportHeadSha}:${WAVE1_TYPES_PATH}`]);
  const supportBaselineTypesBlob = git(root, ['rev-parse', `${mergeBaseSha}:${WAVE1_TYPES_PATH}`]);
  const virtualTreeSha = git(root, ['merge-tree', '--write-tree', supportHeadSha, revision12HeadSha]);
  const finalParent = options.finalWrongParent ? mergeBaseSha : supportHeadSha;
  const finalHeadSha = git(root, ['commit-tree', virtualTreeSha, '-p', finalParent], 'materialized revision 12\n');

  const historicalInspection = inspectS33Wave1PacketRevision({
    repositoryRoot: root,
    producerHeadSha: historicalHeadSha,
    expectedRevision: 11,
    expectedStatus: HISTORICAL_STATUS,
    expectedLane3AcceptanceStatus: HISTORICAL_ACCEPTANCE,
    expectedAdjudications: HISTORICAL_ADJUDICATIONS,
  });
  const revision12Inspection = inspectS33Wave1PacketRevision({
    repositoryRoot: root,
    producerHeadSha: revision12HeadSha,
    expectedRevision: 12,
    expectedStatus: REVISION12_STATUS,
    expectedLane3AcceptanceStatus: REVISION12_ACCEPTANCE,
    expectedAdjudications: revision12Adjudications,
  });
  const historical = pinsForInspection(
    historicalInspection,
    ['GD-S33-BAR-001', 'GD-S33-KE-001'],
    HISTORICAL_ADJUDICATIONS,
  );
  const revision12 = {
    ...pinsForInspection(revision12Inspection, [], revision12Adjudications),
    revision: 12 as const,
    declaredImmediateParentChangedPaths: changedPaths,
  };
  const pins: S33Wave1DualDagPins = {
      schemaVersion: 1,
      supportBaseline: {
        commitSha: mergeBaseSha,
        typesBlobSha: supportBaselineTypesBlob,
      },
      support: {
        headSha: supportHeadSha,
        typesBlobSha: supportTypesBlob,
      },
      mergeBaseSha,
      revision10: {
        headSha: revision10HeadSha,
        declaredHistoricalChangedPaths: historicalChangedPaths,
      },
      historical,
      revision12,
      final: { headSha: finalHeadSha },
  };
  if (!options.includeEvidence) return { root, pins };
  const report = verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });
  const evidence: Record<string, unknown> = {
    artifactType: 'arkova-s33-wave1-r12-dual-dag-verification',
    schemaVersion: 1,
    selfPinned: options.evidenceAttack === 'self-pinned',
    bindingContext: {
      supportBaselineTreeSha: git(root, ['rev-parse', `${mergeBaseSha}^{tree}`]),
      evidenceCommitPolicy: 'A12C is a child of F12C and does not pin itself; it changes no packet path or verifier implementation path.',
    },
    pins,
    report: structuredClone(report),
  };
  if (options.evidenceAttack === 'unknown-key') evidence.unreviewed = true;
  if (options.evidenceAttack === 'missing-binding') delete evidence.bindingContext;
  if (options.evidenceAttack === 'report-tamper') {
    (evidence.report as Record<string, unknown>).reportDigestSha256 = '0'.repeat(64);
  }
  git(root, ['checkout', '--detach', options.evidenceAttack === 'wrong-parent' ? mergeBaseSha : finalHeadSha]);
  if (options.evidenceAttack === 'invalid-utf8') {
    const absolute = join(root, S33_WAVE1_R12_EVIDENCE_PATH);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, Buffer.from([0xff, 0xfe, 0xfd]));
  } else if (options.evidenceAttack === 'duplicate-key') {
    write(root, S33_WAVE1_R12_EVIDENCE_PATH, `{"schemaVersion":1,"schemaVersion":1}\n`);
  } else {
    write(root, S33_WAVE1_R12_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (options.evidenceAttack === 'executable') {
    chmodSync(join(root, S33_WAVE1_R12_EVIDENCE_PATH), 0o755);
  }
  if (options.evidenceAttack === 'symlink') {
    rmSync(join(root, S33_WAVE1_R12_EVIDENCE_PATH));
    symlinkSync('untrusted-target', join(root, S33_WAVE1_R12_EVIDENCE_PATH));
  }
  if (options.evidenceAttack === 'extra-path') write(root, 'docs/lane3/evidence/extra.json', '{}\n');
  if (options.evidenceAttack === 'packet-mutation') {
    write(root, WAVE1_MANIFEST_PATH, '{"tampered":true}\n');
  }
  git(root, ['add', '.']);
  if (options.evidenceAttack === 'gitlink') {
    git(root, [
      'update-index', '--add', '--cacheinfo',
      `160000,${finalHeadSha},${S33_WAVE1_R12_EVIDENCE_PATH}`,
    ]);
  }
  git(root, ['commit', '-qm', 'record Wave-1 dual-DAG evidence']);
  const evidenceCommitSha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_FREEZE_REF}`, finalHeadSha]);
  git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_EVIDENCE_REF}`, evidenceCommitSha]);
  const evidenceBytes = execFileSync('git', [
    'show', `${evidenceCommitSha}:${S33_WAVE1_R12_EVIDENCE_PATH}`,
  ], { cwd: root });
  return {
    root,
    pins,
    evidenceAnchor: {
      blobSha: git(root, ['rev-parse', `${evidenceCommitSha}:${S33_WAVE1_R12_EVIDENCE_PATH}`]),
      canonicalSha256: sha256(canonicaliseJson(evidence)),
      commitSha: evidenceCommitSha,
      finalCommitSha: finalHeadSha,
      finalTreeSha: git(root, ['rev-parse', `${finalHeadSha}^{tree}`]),
      freezeRefName: S33_WAVE1_R12_FREEZE_REF,
      rawSha256: sha256(evidenceBytes),
      refName: S33_WAVE1_R12_EVIDENCE_REF,
    },
  };
}

describe('S3.3 Wave-1 revision-12 dual-DAG contract', { timeout: 30_000 }, () => {
  it('separately pins the exact reviewed e8 Lane-3 support baseline', () => {
    expect(S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE).toEqual({
      commitSha: 'e8a9ba3d2ba8023fe59781b6a0499c8208cc59af',
      treeSha: '9c797db5716062d8cef5bd54db7f952dde3bb7f4',
      typesBlobSha: 'fbc05660e4575c3c527204658571246f9294ceb9',
    });
    expect(Object.isFrozen(S33_WAVE1_DUAL_DAG_SUPPORT_BASELINE)).toBe(true);
  });

  it('deep-freezes every nested binding CTO adjudication value', () => {
    const taxonomy = S33_WAVE1_R12_BINDING_ADJUDICATIONS.taxonomyAdjudicationSet;
    const issuedDates = S33_WAVE1_R12_BINDING_ADJUDICATIONS.issuedDateAdjudicationSet;
    expect(Object.isFrozen(S33_WAVE1_R12_BINDING_ADJUDICATIONS)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_R12_CPE_DEPTH_BINDING)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_R12_CPE_DEPTH_BINDING.acceptanceOnlyCpeEntryIds)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_R12_SOURCE_TRANSITION_BINDING)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.leakage32EntryIds)).toBe(true);
    expect(Object.isFrozen(
      S33_WAVE1_R12_SOURCE_TRANSITION_BINDING.exactSourceTransitionEntryIds,
    )).toBe(true);
    expect(Object.isFrozen(taxonomy)).toBe(true);
    expect(Object.isFrozen(taxonomy.entryIds)).toBe(true);
    expect(Object.isFrozen(taxonomy.resolvedValues)).toBe(true);
    expect(Object.isFrozen(issuedDates.resolvedValues)).toBe(true);
    expect(Reflect.set(taxonomy.resolvedValues, 'GD-S33-KE-006', 'LICENSE/general')).toBe(false);
    expect(taxonomy.resolvedValues['GD-S33-KE-006']).toBe('IDENTITY/government_id');
  });

  it('accepts a history-preserving producer repair and a conflict-free materialized support child', () => {
    const { root, pins } = fixture();
    const report = verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });

    expect(report).toMatchObject({
      algorithmVersion: 's33-wave1-dual-dag-v1',
      mergeBaseSha: pins.mergeBaseSha,
      historical: { disposition: 'HISTORICAL_BLOCKED', failureCount: 2 },
      revision12: { disposition: 'STRUCTURALLY_VALID_ZERO_FAILURES', failureCount: 0 },
      final: { headSha: pins.final.headSha },
    });
    expect(report.final.virtualMergeTreeSha).toBe(report.final.treeSha);
    expect(report.revision12.immediateParentChangedPaths).toEqual(
      S33_WAVE1_R12_IMMEDIATE_CHANGED_PATHS,
    );
    expect(report.revision12.immediateParentChangedPaths).toHaveLength(5);
    expect(report.revision12.packetBlobs).toEqual(
      Object.fromEntries(S33_WAVE1_PACKET_PATHS.map((path) => [
        path,
        git(root, ['rev-parse', `${pins.revision12.headSha}:${path}`]),
      ])),
    );
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('authenticates create-only A12C while keeping all four edge universes distinct', () => {
    const { evidenceAnchor, pins, root } = fixture({ includeEvidence: true });
    if (!evidenceAnchor) throw new Error('evidence fixture did not return its anchor');
    const verifyEvidence = createTestOnlyS33Wave1R12EvidenceVerifier(evidenceAnchor);
    const verified = verifyEvidence({
      expectedProducerHeadSha: pins.revision12.headSha,
      repositoryRoot: root,
    });

    expect(verified.report.reportDigestSha256).toBe(
      verifyS33Wave1DualDagContract({ repositoryRoot: root, pins }).reportDigestSha256,
    );
    expect(git(root, [
      'diff-tree', '--no-commit-id', '--name-status', '-r',
      pins.historical.headSha, pins.revision12.headSha,
    ]).split('\n')).toEqual(
      S33_WAVE1_R12_IMMEDIATE_CHANGED_PATHS.map((path) => `M\t${path}`),
    );
    expect(git(root, [
      'diff-tree', '--no-commit-id', '--name-status', '-r', pins.mergeBaseSha, pins.revision12.headSha,
    ]).split('\n')).toEqual(S33_WAVE1_PACKET_PATHS.map((path) => `A\t${path}`));
    expect(git(root, [
      'diff-tree', '--no-commit-id', '--name-status', '-r', pins.support.headSha, pins.final.headSha,
    ]).split('\n')).toEqual(S33_WAVE1_PACKET_PATHS.map((path) => `A\t${path}`));
    expect(git(root, [
      'diff-tree', '--no-commit-id', '--name-status', '-r', pins.final.headSha, evidenceAnchor.commitSha,
    ])).toBe(`A\t${S33_WAVE1_R12_EVIDENCE_PATH}`);
  }, 15_000);

  it.each([
    ['wrong A12C parent', 'wrong-parent'],
    ['extra A12C path', 'extra-path'],
    ['duplicate-key A12C', 'duplicate-key'],
    ['executable A12C evidence', 'executable'],
    ['gitlink A12C evidence', 'gitlink'],
    ['invalid UTF-8 A12C evidence', 'invalid-utf8'],
    ['missing A12C binding context', 'missing-binding'],
    ['symlink A12C evidence', 'symlink'],
    ['A12C packet mutation', 'packet-mutation'],
    ['tampered stored A12C report', 'report-tamper'],
    ['self-pinned A12C', 'self-pinned'],
    ['unknown A12C schema key', 'unknown-key'],
  ] as const)('rejects %s', (_label, evidenceAttack) => {
    const { evidenceAnchor, pins, root } = fixture({ evidenceAttack, includeEvidence: true });
    if (!evidenceAnchor) throw new Error('evidence fixture did not return its anchor');
    const verifyEvidence = createTestOnlyS33Wave1R12EvidenceVerifier(evidenceAnchor);
    expect(() => verifyEvidence({
      expectedProducerHeadSha: pins.revision12.headSha,
      repositoryRoot: root,
    })).toThrow(/A12C|evidence|single-parent|exactly one|packet|schema|selfPinned/i);
  });

  it('rejects moved refs and false compiled blob or digest pins', () => {
    const { evidenceAnchor, pins, root } = fixture({ includeEvidence: true });
    if (!evidenceAnchor) throw new Error('evidence fixture did not return its anchor');
    const verify = (anchor = evidenceAnchor) => createTestOnlyS33Wave1R12EvidenceVerifier(anchor)({
      expectedProducerHeadSha: pins.revision12.headSha,
      repositoryRoot: root,
    });
    git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_EVIDENCE_REF}`, pins.final.headSha]);
    expect(() => verify()).toThrow(/A12C.*ref/i);
    git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_EVIDENCE_REF}`, evidenceAnchor.commitSha]);
    git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_FREEZE_REF}`, pins.support.headSha]);
    expect(() => verify()).toThrow(/F12C.*ref/i);
    git(root, ['update-ref', `refs/heads/${S33_WAVE1_R12_FREEZE_REF}`, evidenceAnchor.finalCommitSha]);
    for (const mutation of [
      { ...evidenceAnchor, commitSha: '0'.repeat(40) },
      { ...evidenceAnchor, finalCommitSha: '0'.repeat(40) },
      { ...evidenceAnchor, finalTreeSha: '0'.repeat(40) },
      { ...evidenceAnchor, blobSha: '0'.repeat(40) },
      { ...evidenceAnchor, rawSha256: '0'.repeat(64) },
      { ...evidenceAnchor, canonicalSha256: '0'.repeat(64) },
      { ...evidenceAnchor, reportDigestSha256: '0'.repeat(64) },
    ]) {
      expect(() => verify(mutation)).toThrow(/ref|commit|tree|blob|digest/i);
    }
  });

  it('pins the exact production A12C/F12C authority and forbids synthetic anchors outside tests', () => {
    expect(S33_WAVE1_R12_PRODUCTION_EVIDENCE).toEqual({
      blobSha: 'c74b9d6e001355d7701640b2d062473c8bcbed76',
      canonicalSha256: '8a98c148bce14678a94e5ac0b8bac97b76147ca93a8b0058169544d32d439b72',
      commitSha: '3508e5e9c7e100e9c55c0cba129d8d7b9d123bec',
      finalCommitSha: '447326ddd2225524895f35cbafda58b15555ed30',
      finalTreeSha: '52b6a2dd7201783f93325c24c999bc3e6bb8ee25',
      freezeRefName: S33_WAVE1_R12_FREEZE_REF,
      rawSha256: '02d8026546b14c64af447e8e12544b9e40d6618d9d1020a7a21086b83e425cb7',
      refName: S33_WAVE1_R12_EVIDENCE_REF,
      reportDigestSha256: '049ac9c08f168fc335cd277796c52f5fcc53bfe32097f7510ea0c609b5279a5e',
    });
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createTestOnlyS33Wave1R12EvidenceVerifier(
        S33_WAVE1_R12_PRODUCTION_EVIDENCE,
      )).toThrow(/forbidden.*outside NODE_ENV=test/i);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('rejects a historical failure-set digest that is not the exact blocked packet result', () => {
    const { root, pins } = fixture();
    const mutated = structuredClone(pins);
    mutated.historical.expectedGroundTruthFailureDigestSha256 = '0'.repeat(64);
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins: mutated }))
      .toThrow(/historical.*failure digest/i);
  });

  it('rejects a revision-12 packet that retains any covered-row failure', () => {
    expect(() => {
      const { root, pins } = fixture({ residualFailure: true });
      verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });
    })
      .toThrow(/revision 12.*(?:zero|exact ground-truth).*failure/i);
  });

  it('rejects an unauthorized r12 adjudication even when caller pins repeat it', () => {
    expect(() => fixture({ badCpeAdjudicationPolicy: true }))
      .toThrow(/binding CTO adjudication/i);
  });

  it('rejects a caller-selected r10 that is not the authenticated parent of r11 prime', () => {
    const { root, pins } = fixture();
    const mutated = structuredClone(pins);
    mutated.revision10.headSha = pins.mergeBaseSha;
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins: mutated }))
      .toThrow(/revision 11 prime.*direct single-parent child.*revision 10/i);
  });

  it.each([
    ['intermediate commit', { historicalIntermediate: true }],
    ['tamper and revert commits', { historicalTamperRevert: true }],
  ] as const)('rejects hidden r10-to-r11 history: %s', (_label, options) => {
    const { root, pins } = fixture(options);
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins }))
      .toThrow(/revision 11 prime.*direct single-parent child.*revision 10/i);
  });

  it.each([
    ['copy', 'copy'],
    ['delete', 'delete'],
    ['gitlink', 'gitlink'],
    ['rename', 'rename'],
    ['symlink', 'symlink'],
  ] as const)('rejects a historical-edge %s attack', (_label, historicalEdgeAttack) => {
    expect(() => {
      const { root, pins } = fixture({ historicalEdgeAttack });
      verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });
    }).toThrow(/changed paths|deletion|rename|copy|submodule|100644|missing|unsupported status/i);
  });

  it('rejects old-executable to new-regular mode normalization on a producer edge', () => {
    const { root, pins } = fixture({ historicalModeNormalization: true });
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins }))
      .toThrow(/old endpoint.*100644|old endpoint.*regular non-executable/i);
  });

  it.each([
    ['unknown manifest key', 'unknownManifest', /manifest.*exact key set/i],
    ['unknown self-check key', 'unknownSelfCheck', /selfChecks.*exact key set/i],
    ['unknown dependency key', 'unknownNested', /dependency.*exact key set/i],
    ['blank provenance', 'blankProvenance', /sourceProvenance.*non-empty/i],
    ['false CPE20 depth digest', 'badCpeDepthDigest', /production-depth CPE universe/i],
    ['false GREEN0 leakage summary', 'badLeakage', /post-remediation leakage evidence.*GREEN0/i],
    ['KE-006 miscounted as leakage', 'leakageIncludesKe006', /RED341\/32|LEAKAGE32/i],
    ['missing separately authorized KE-006', 'missingAuthorizedKe006', /separately authorized.*exact/i],
    ['extra source transition', 'unauthorizedSourceTransition', /source-text changes.*LEAKAGE32.*KE-006/i],
  ] as const)(
    'rejects a recomputed-pin semantic mutation: %s',
    (_label, semanticMutation, error) => {
      expect(() => fixture({ semanticMutation })).toThrow(error);
    },
  );

  it('rejects an undeclared normalized-input change even when packet pins are recomputed', () => {
    const { root, pins } = fixture({ semanticMutation: 'undeclaredFingerprintChange' });
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins }))
      .toThrow(/unauthorized normalized-input change.*LEAKAGE32.*KE-006/i);
  });

  it('rejects a normalized-equivalent raw source edit outside the exact 33', () => {
    const { root, pins } = fixture({ semanticMutation: 'normalizedEquivalentRawChange' });
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins }))
      .toThrow(/raw strippedText changes.*LEAKAGE32.*KE-006/i);
  });

  it.each([
    ['outside producer path', { outsideChange: true }, /declared.*exact changed paths|outside.*six-path packet/i],
    ['executable producer packet blob', { executablePacket: true }, /100644|regular non-executable/i],
    ['wrong final parent', { finalWrongParent: true }, /final.*single-parent child.*support/i],
  ] as const)('rejects malicious topology: %s', (_label, options, error) => {
    expect(() => {
      const { root, pins } = fixture(options);
      verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });
    }).toThrow(error);
  });

  it('rejects caller-declared immediate-parent paths that omit a real producer change', () => {
    const { root, pins } = fixture();
    const mutated = structuredClone(pins);
    mutated.revision12.declaredImmediateParentChangedPaths = [WAVE1_MANIFEST_PATH];
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins: mutated }))
      .toThrow(/immediate-parent edge.*exact.*five-path set/i);
  });

  it('pins all six producer blobs independently of the support tree', () => {
    const { root, pins } = fixture();
    const report = verifyS33Wave1DualDagContract({ repositoryRoot: root, pins });
    expect(report.final.packetBlobs).toEqual(packetBlobs(root, pins.revision12.headSha));
    expect(report.final.typesBlobSha).toBe(pins.support.typesBlobSha);
    expect(canonicaliseJson(report.final.packetBlobs)).toBe(canonicaliseJson(report.revision12.packetBlobs));
  });

  it('ignores Git replacement refs while authenticating the pinned DAG', () => {
    const { root, pins } = fixture();
    git(root, [
      'update-ref', `refs/replace/${pins.historical.headSha}`, pins.revision10.headSha,
    ]);
    expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins })).not.toThrow();
  });

  it('ignores hostile inherited Git environment and config injection', () => {
    const { root, pins } = fixture();
    const hostile = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent/objects',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/nonexistent/hostile-fsmonitor',
      GIT_DIR: '/nonexistent/repository',
      GIT_OBJECT_DIRECTORY: '/nonexistent/objects',
      GIT_REPLACE_REF_BASE: 'refs/hostile-replacements/',
      GIT_WORK_TREE: '/nonexistent/worktree',
    } as const;
    const previous = Object.fromEntries(
      Object.keys(hostile).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, hostile);
      expect(() => verifyS33Wave1DualDagContract({ repositoryRoot: root, pins })).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
