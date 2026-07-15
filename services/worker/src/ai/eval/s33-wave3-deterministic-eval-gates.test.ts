import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  countS33SubstantiveGroundTruthFields,
  V6_SUBTYPE_TAXONOMY,
} from './golden-dataset-s33-types.js';
import {
  S33_WAVE3_FOUNDER_MAPPING_CONTRACT,
  S33_WAVE3_FROZEN_CREDENTIAL_TYPES,
  S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY,
  S33_WAVE3_GATE_IDS,
  S33_WAVE3_JURISDICTION_MANIFESTS,
  S33_WAVE3_SUBSTANTIVE_FIELDS,
  assessS33Wave3ReleaseCorpusFreeze,
  createS33Wave3ArmManifest,
  createS33Wave3InputPacketDigests,
  deriveS33Wave3ValidatedGoldFields,
  evaluateS33Wave3OfflineGates,
  scoreS33FieldComparisons,
  type S33Wave3EvaluationInput,
  type S33Wave3Observation,
} from './s33-wave3-deterministic-eval-gates.js';
import {
  buildS33Wave2BaseCorpusRegistry,
  extendS33Wave2CorpusRegistry,
  type S33Wave2CorpusRegistry,
  type S33Wave2RegistryBatch,
  type S33Wave2RegistryEntry,
} from './s33-wave2-corpus-registry.js';
import { S33_AU_KE_HELDOUT } from './golden-dataset-s33-au-ke-heldout.js';
import { S33_LICENSING_HELDOUT } from './golden-dataset-s33-licensing-heldout.js';
import { S33_OOD_NEGATIVES } from './golden-dataset-s33-ood-negatives.js';
import {
  buildAndSignS33Wave2AcceptanceForTest,
  type S33Wave2AcceptancePayloadInput,
  type S33Wave2AcceptanceTrustRoot,
  type S33Wave2AuthenticatedBatchAcceptance,
} from './s33-wave2-acceptance-envelope.js';

const FIXTURE_SOURCE_PATH = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-fixture-heldout.ts';
const FIXTURE_EXPORT_NAME = 'S33_WAVE2_FIXTURE_HELDOUT';
const WAVE1_BASE_REGISTRY_DIGEST = '412a08227608a58172569a4fcbf3cd1025dc67fc1beeaddd6c163d22c4cb80d6';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const GATE_REGISTRY_JSON = readFileSync(
  fileURLToPath(new URL('../../../../../docs/lane3/s33-wave3-v71-offline-gates.json', import.meta.url)),
  'utf8',
);
const WAVE1_BASE_REGISTRY = buildS33Wave2BaseCorpusRegistry({
  repositoryRoot: REPOSITORY_ROOT,
  verificationHeadSha: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
});
const WAVE1_ROWS = [
  ...S33_LICENSING_HELDOUT,
  ...S33_AU_KE_HELDOUT,
  ...S33_OOD_NEGATIVES,
];
const WAVE1_ROWS_BY_ID = new Map(WAVE1_ROWS.map((row) => [row.id, row]));
const WAVE1_TRUSTED_GOLD_SOURCES = [
  {
    sourcePath: 'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
    exportName: 'S33_LICENSING_HELDOUT',
  },
  {
    sourcePath: 'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
    exportName: 'S33_AU_KE_HELDOUT',
  },
  {
    sourcePath: 'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
    exportName: 'S33_OOD_NEGATIVES',
  },
].map(({ sourcePath, exportName }) => ({
  sourcePath,
  exportName,
  sourceBlobSha: WAVE1_BASE_REGISTRY.wave1Tuple.packetBlobs[sourcePath as keyof typeof WAVE1_BASE_REGISTRY.wave1Tuple.packetBlobs],
  sourceText: readFileSync(`${REPOSITORY_ROOT}${sourcePath}`, 'utf8'),
}));

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha1(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

const fixtureKeyPair = generateKeyPairSync('ed25519');
const fixturePrivateKeyPkcs8Pem = fixtureKeyPair.privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}).toString();
const fixturePublicKeySpkiPem = fixtureKeyPair.publicKey.export({
  type: 'spki',
  format: 'pem',
}).toString();
const fixtureTrustRoot: S33Wave2AcceptanceTrustRoot = {
  signerIdentity: 'arkova-s33-wave2-cto-release',
  signingKeyId: 'arkova-s33-wave2-cto-release',
  publicKeySpkiPem: fixturePublicKeySpkiPem,
  publicKeyFingerprintSha256: createHash('sha256').update(
    createPublicKey(fixturePublicKeySpkiPem).export({ type: 'spki', format: 'der' }),
  ).digest('hex'),
};

function normalizedInput(entry: FixtureEntry): string {
  return entry.strippedText ?? `Trusted fixture document ${entry.id}`;
}

function normalizedInputDigest(entry: FixtureEntry): string {
  return sha256(normalizedInput(entry).toLowerCase().replace(/\s+/gu, ' ').trim());
}

function fixtureGroundTruth(entry: FixtureEntry): Record<string, unknown> {
  if (entry.groundTruth) return entry.groundTruth;
  return {
    credentialType: entry.credentialType,
    subType: entry.subType,
    fraudSignals: [],
    issuerName: `Issuer ${entry.id}`,
    recipientIdentifier: `[RECIPIENT_${entry.id}_REDACTED]`,
    issuedDate: '2026-07-15',
    expiryDate: '2027-07-15',
    jurisdiction: `Jurisdiction ${entry.id}`,
  };
}

function fixtureSource(entries: readonly FixtureEntry[]): string {
  const rows = entries.map((entry) => ({
    id: entry.id,
    description: `${entry.id} fixture`,
    strippedText: normalizedInput(entry),
    credentialTypeHint: entry.credentialType,
    groundTruth: fixtureGroundTruth(entry),
    source: entry.source ?? (entry.founderTypeId
      ? `authored/s33-wave2/fixture/${entry.founderTypeId}/${entry.id}`
      : `authored/s33-wave2/fixture/non-founder/${entry.id}`),
    category: 'fixture',
    tags: ['held-out'],
    provenance: 'authored-s33-lane4',
    edgeCase: entry.edgeCase ?? false,
    jurisdictionSlice: 'US',
  }));
  return `export const ${FIXTURE_EXPORT_NAME} = ${JSON.stringify(rows)} as const;\n`;
}

function founderRegistryJson(): string {
  const domains = ['legal', 'financial', 'education'].map((domain, domainIndex) => ({
    id: domain,
    order: domainIndex + 1,
    types: S33_WAVE3_FOUNDER_MAPPING_CONTRACT
      .filter((entry) => entry.domain === domain)
      .map((entry, typeIndex) => ({
        id: entry.id,
        order: typeIndex + 1,
        documentType: entry.documentType,
        mappings: entry.mappings,
      })),
  }));
  return JSON.stringify({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-top15-registry',
    status: 'CTO_SIGNED_SCOPE',
    acceptedBaseline: {
      batchId: 'S33-W1',
      revision: 12,
      pullRequest: 1544,
      producerHeadCommit: '618e08d5a11cb73cb61394bc0343d33f4353ef39',
      mergeCommit: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
      entryCount: 81,
    },
    coveragePolicy: {
      minimumHeldoutPerType: 12,
      generatorDerivedAllowed: false,
      trainingExposedAllowed: false,
      acceptanceLane: 'lane3',
    },
    productionOrder: S33_WAVE3_FOUNDER_MAPPING_CONTRACT.map(({ id }) => id),
    domains,
  });
}

interface FixtureEntry {
  id: string;
  domain: string;
  credentialType: string;
  subType: string;
  founderTypeId?: string;
  strippedText?: string;
  groundTruth?: Record<string, unknown>;
  source?: string;
  edgeCase?: boolean;
}

function fixtureSubtype(credentialType: string): string {
  return S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[credentialType]?.[0] ?? 'other';
}

function fixtureEntries(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  let sequence = 0;
  for (const contract of S33_WAVE3_FOUNDER_MAPPING_CONTRACT) {
    const mapping = contract.mappings[0];
    for (let index = 0; index < 12; index += 1) {
      sequence += 1;
      entries.push({
        id: `GD-S33-W3-${String(sequence).padStart(4, '0')}`,
        domain: contract.domain,
        credentialType: mapping.credentialType,
        subType: mapping.subType,
        founderTypeId: contract.id,
      });
    }
  }

  const covered = new Set(entries.map(({ credentialType }) => credentialType));
  for (const credentialType of S33_WAVE3_FROZEN_CREDENTIAL_TYPES) {
    if (credentialType === 'OTHER') continue;
    if (covered.has(credentialType)) continue;
    for (let index = 0; index < 12; index += 1) {
      sequence += 1;
      entries.push({
        id: `GD-S33-W3-${String(sequence).padStart(4, '0')}`,
        domain: 'cross-domain',
        credentialType,
        subType: fixtureSubtype(credentialType),
      });
    }
  }

  return entries;
}

function wave1FixtureEntries(): FixtureEntry[] {
  return WAVE1_BASE_REGISTRY.entries.map((entry) => {
    const row = WAVE1_ROWS_BY_ID.get(entry.id);
    if (!row || typeof row.groundTruth.subType !== 'string') {
      throw new Error(`Wave-1 fixture row is missing: ${entry.id}`);
    }
    return {
      id: entry.id,
      domain: entry.domain,
      credentialType: entry.credentialType,
      subType: row.groundTruth.subType,
      strippedText: row.strippedText,
      groundTruth: { ...row.groundTruth },
      source: row.source,
    };
  });
}

function arm(
  entry: FixtureEntry,
  quality: 'candidate' | 'baseline',
): S33Wave3Observation['arms']['v71'] {
  const perfect = quality === 'candidate';
  const truth = fixtureGroundTruth(entry);
  const { fields: validatedTruth } = deriveS33Wave3ValidatedGoldFields(truth);
  const allExtracted = Object.fromEntries(Object.entries(validatedTruth).filter(([field]) => (
    field === 'fraudSignals' || S33_WAVE3_SUBSTANTIVE_FIELDS.includes(
      field as typeof S33_WAVE3_SUBSTANTIVE_FIELDS[number],
    )
  )));
  const predictedCredentialType = entry.credentialType === 'CPE' ? 'CLE' : entry.credentialType;
  const predictedSubType = entry.credentialType === 'CPE'
    ? entry.subType.replace(/_cpe$/u, '_cle')
    : entry.subType;
  const candidateAccuracy = entry.credentialType === 'CPE'
    ? 1 - (2 / (S33_WAVE3_SUBSTANTIVE_FIELDS.length + 3))
    : 1;
  return {
    parsed: true,
    predictedCredentialType,
    suggestedType: entry.credentialType === 'OTHER' ? 'non-credential document' : null,
    subType: perfect ? predictedSubType : null,
    description: `${entry.id} deterministic description`,
    extractedFields: perfect ? allExtracted : { fraudSignals: [] },
    calibratedConfidence: perfect ? candidateAccuracy : 0.65,
    latencyMs: perfect ? 100 : 120,
    tokensUsed: perfect ? 10 : 12,
  };
}

function corpusRegistry(entries: readonly FixtureEntry[], sourceBlobSha: string): S33Wave2CorpusRegistry {
  const registryEntries: S33Wave2RegistryEntry[] = entries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    credentialType: entry.credentialType,
    normalizedInputSha256: normalizedInputDigest(entry),
    batchId: 'S33-W3-FIXTURE',
    revision: 1,
    sourcePath: FIXTURE_SOURCE_PATH,
  }));
  const batch: S33Wave2RegistryBatch = {
    batchId: 'S33-W3-FIXTURE',
    revision: 1,
    manifestPath: 'test/manifest.json',
    manifestRawSha256: sha256('manifest'),
    sourcePath: FIXTURE_SOURCE_PATH,
    sourceBlobSha,
    datasheetPath: 'test/datasheet.json',
    datasheetBlobSha: '4'.repeat(40),
    entryCount: registryEntries.length,
  };
  return extendS33Wave2CorpusRegistry(WAVE1_BASE_REGISTRY, batch, registryEntries);
}

function authenticatedFixtureAcceptance(
  entries: readonly FixtureEntry[],
  sourceBlobSha: string,
  resultingRegistryDigestSha256: string,
  options: {
    batchId?: string;
    baseRegistryDigestSha256?: string;
    manifestPath?: string;
    manifestRawSha256?: string;
    fallbackRegistryTypeId?: string;
    signedEdgeCaseOverride?: (entry: FixtureEntry) => boolean;
  } = {},
): S33Wave2AuthenticatedBatchAcceptance {
  const batchId = options.batchId ?? 'S33-W3-FIXTURE';
  const manifestPath = options.manifestPath ?? 'test/manifest.json';
  const manifestRawSha256 = options.manifestRawSha256 ?? sha256('manifest');
  const input: S33Wave2AcceptancePayloadInput = {
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1601,
    candidateBaseSha: '5'.repeat(40),
    candidateHeadSha: '6'.repeat(40),
    candidateTreeSha: '7'.repeat(40),
    batchId,
    revision: 1,
    manifestPath,
    manifestRawSha256,
    manifestCanonicalSha256: '8'.repeat(64),
    sourceBlobSha,
    datasheetBlobSha: '4'.repeat(40),
    preflightArtifactDigestSha256: '9'.repeat(64),
    baseRegistryDigestSha256: options.baseRegistryDigestSha256 ?? WAVE1_BASE_REGISTRY_DIGEST,
    resultingRegistryDigestSha256,
    coverageRegistryPath: 'docs/lane4/s33-wave2-top15-registry.json',
    coverageRegistryRawSha256: 'a'.repeat(64),
    coverageRegistryCanonicalSha256: 'b'.repeat(64),
    signedAtUtc: '2026-07-15T14:00:00.000Z',
    reviewer: {
      lane: 'Lane 3',
      transport: 'github-issue-comment',
      evidence: {
        id: 123,
        nodeId: 'IC_kwDOExample123',
        url: 'https://github.com/carson-see/ArkovaCarson/pull/1601#issuecomment-123',
        submittedAtUtc: '2026-07-15T13:59:59.000Z',
        actor: {
          login: 'lane3-reviewer',
          databaseId: 456,
          nodeId: 'MDQ6VXNlcjQ1Ng==',
        },
      },
    },
    proof: {
      machineValidationArtifactSha256: 'c'.repeat(64),
      machineValidationFailureCount: 0,
      humanCrossReviewArtifactSha256: 'd'.repeat(64),
      humanCrossReviewSampleSize: entries.length,
      materialLabelDefectCount: 0,
      prodModelDiffArtifactSha256: 'e'.repeat(64),
      exactLeakageArtifactSha256: 'f'.repeat(64),
      exactLeakageHitCount: 0,
    },
    acceptedEntries: entries.map((entry) => ({
      id: entry.id,
      registryTypeId: entry.founderTypeId ?? options.fallbackRegistryTypeId ?? 'non-founder',
      batchId,
      revision: 1,
      credentialType: entry.credentialType,
      subType: entry.subType,
      normalizedInputSha256: normalizedInputDigest(entry),
      groundTruthSha256: sha256(canonicaliseJson(fixtureGroundTruth(entry))),
      authorshipMethod: 'independently-authored' as const,
      generatorDerived: false as const,
      trainingExposed: false as const,
      intendedSplit: 'held-out' as const,
      productionValidSubstantiveFieldCount: 5,
      edgeCase: options.signedEdgeCaseOverride?.(entry) ?? entry.edgeCase ?? false,
      sourceBlobSha,
    })),
  };
  return buildAndSignS33Wave2AcceptanceForTest(input, fixturePrivateKeyPkcs8Pem, fixtureTrustRoot);
}

const TOP15_BATCH_IDS = [
  'S33-W2-TOP15-01-05',
  'S33-W2-TOP15-06-10',
  'S33-W2-TOP15-11-15',
] as const;

function releaseCorpusFreezeVector(options: {
  missingBatchIndex?: number;
  underfilledFounderTypeId?: string;
  lowEdgeFounderTypeId?: string;
  finalRegistryDigestMismatch?: boolean;
} = {}): ReturnType<typeof assessS33Wave3ReleaseCorpusFreeze> {
  const founderEntries = fixtureEntries().filter(({ founderTypeId }) => founderTypeId !== undefined);
  const batches = TOP15_BATCH_IDS.map((batchId, batchIndex) => {
    const founderIds = ['legal', 'financial', 'education'].flatMap((domain) => (
      S33_WAVE3_FOUNDER_MAPPING_CONTRACT
        .filter((mapping) => mapping.domain === domain)
        .slice(batchIndex * 5, (batchIndex * 5) + 5)
        .map(({ id }) => id)
    ));
    const entries = founderIds.flatMap((founderTypeId) => {
      const count = founderTypeId === options.underfilledFounderTypeId ? 11 : 12;
      const edgeCount = founderTypeId === options.lowEdgeFounderTypeId ? 3 : 4;
      return founderEntries
        .filter((entry) => entry.founderTypeId === founderTypeId)
        .slice(0, count)
        .map((entry, index) => ({ ...entry, edgeCase: index < edgeCount }));
    });
    return { batchId, entries };
  }).filter((_batch, index) => index !== options.missingBatchIndex);

  let previousRegistryDigestSha256 = WAVE1_BASE_REGISTRY_DIGEST;
  const acceptances: S33Wave2AuthenticatedBatchAcceptance[] = [];
  for (const [index, { batchId, entries }] of batches.entries()) {
    const resultingRegistryDigestSha256 = sha256(`release-registry:${index}:${batchId}`);
    const sourceBlobSha = gitBlobSha1(fixtureSource(entries));
    acceptances.push(authenticatedFixtureAcceptance(
      entries,
      sourceBlobSha,
      resultingRegistryDigestSha256,
      {
        batchId,
        baseRegistryDigestSha256: previousRegistryDigestSha256,
        manifestPath: `test/${batchId}/manifest.json`,
        manifestRawSha256: sha256(`manifest:${batchId}`),
      },
    ));
    previousRegistryDigestSha256 = resultingRegistryDigestSha256;
  }

  return assessS33Wave3ReleaseCorpusFreeze({
    suppliedCorpusRegistryDigestSha256: options.finalRegistryDigestMismatch
      ? sha256('mismatched-final-registry')
      : previousRegistryDigestSha256,
    acceptedCorpusEntries: [
      ...Array.from({ length: 81 }, () => ({ batchId: 'S33-W1' })),
      ...batches.flatMap(({ batchId, entries }) => entries.map(() => ({ batchId }))),
    ],
    acceptedCorpusBatches: [
      { batchId: 'S33-W1', entryCount: 81 },
      ...batches.map(({ batchId, entries }) => ({ batchId, entryCount: entries.length })),
    ],
    authenticatedBatchAcceptances: acceptances,
  });
}

function makeFixture(options: {
  includeNonFounderRows?: boolean;
  fallbackRegistryTypeId?: string;
  signedEdgeMismatchFounderTypeId?: string;
} = {}): S33Wave3EvaluationInput {
  const futureEntries = fixtureEntries().filter(
    ({ founderTypeId }) => options.includeNonFounderRows === true || founderTypeId !== undefined,
  );
  const entries = [...wave1FixtureEntries(), ...futureEntries];
  const sourceText = fixtureSource(futureEntries);
  const sourceBlobSha = gitBlobSha1(sourceText);
  const trustedGoldSources = [
    ...WAVE1_TRUSTED_GOLD_SOURCES,
    {
      sourcePath: FIXTURE_SOURCE_PATH,
      sourceBlobSha,
      exportName: FIXTURE_EXPORT_NAME,
      sourceText,
    },
  ];
  const registry = corpusRegistry(futureEntries, sourceBlobSha);
  const authenticatedBatchAcceptances = [authenticatedFixtureAcceptance(
    futureEntries,
    sourceBlobSha,
    String(registry.registryDigestSha256),
    {
      fallbackRegistryTypeId: options.fallbackRegistryTypeId,
      signedEdgeCaseOverride: options.signedEdgeMismatchFounderTypeId === undefined
        ? undefined
        : (entry) => entry.founderTypeId === options.signedEdgeMismatchFounderTypeId
          ? !(entry.edgeCase ?? false)
          : (entry.edgeCase ?? false),
    },
  )];
  const registryDigestSha256 = String(registry.registryDigestSha256);
  const entryIds = entries.map(({ id }) => id);
  const manifests = {
    public: createS33Wave3ArmManifest('public', registryDigestSha256, entryIds),
    v6: createS33Wave3ArmManifest('v6', registryDigestSha256, entryIds),
    v71: createS33Wave3ArmManifest('v71', registryDigestSha256, entryIds),
  };
  const observations = entries.map((entry): S33Wave3Observation => ({
    entryId: entry.id,
    domain: entry.domain,
    actualCredentialType: entry.credentialType,
    actualSubType: entry.subType,
    normalizedInputSha256: normalizedInputDigest(entry),
    founderTypeId: entry.founderTypeId ?? null,
    arms: {
      public: arm(entry, 'baseline'),
      v6: arm(entry, 'baseline'),
      v71: arm(entry, 'candidate'),
    },
  }));

  const integrityEvidence: S33Wave3EvaluationInput['integrityEvidence'] = {
    validationErrors: [],
    heldoutLeakageNgram6To13Findings: [],
    trainingOrGeneratorDerivedRowIds: [],
    productionCustomerDocumentIds: [],
  };
  const surgeryEvidence: S33Wave3EvaluationInput['surgeryEvidence'] = {
    sourceTrainingRowIds: [
      ...Array.from({ length: 15 }, (_, index) => `GD-${3030 + index}`),
      'GD-KEEP-0001',
    ],
    exportedTrainingRows: [{
      id: 'GD-KEEP-0001',
      credentialType: 'ATTESTATION',
      subType: 'good_standing',
      goodStandingStatus: 'active',
    }],
    fraudStream: { mode: 'split', rowIds: ['GD-FRAUD-0001'] },
    exportLastCheckpointOnly: true,
  };
  const jurisdictionManifests = S33_WAVE3_JURISDICTION_MANIFESTS;
  const inputPacketDigests = createS33Wave3InputPacketDigests({
    observations,
    integrityEvidence,
    surgeryEvidence,
    jurisdictionManifests,
    trustedGoldSources,
    authenticatedBatchAcceptances,
  });

  return {
    gateRegistryJson: GATE_REGISTRY_JSON,
    founderCoverageRegistryJson: founderRegistryJson(),
    acceptedCorpusRegistry: registry,
    trustedGoldSources,
    authenticatedBatchAcceptances,
    testOnlyAcceptanceTrustRoot: fixtureTrustRoot,
    armManifests: manifests,
    observations,
    integrityEvidence,
    surgeryEvidence,
    jurisdictionManifests,
    inputPacketDigests,
  };
}

function cloneFixture(): S33Wave3EvaluationInput {
  return structuredClone(makeFixture());
}

function rebindInputPackets(input: S33Wave3EvaluationInput): void {
  input.inputPacketDigests = createS33Wave3InputPacketDigests({
    observations: input.observations,
    integrityEvidence: input.integrityEvidence,
    surgeryEvidence: input.surgeryEvidence,
    jurisdictionManifests: input.jurisdictionManifests,
    trustedGoldSources: input.trustedGoldSources,
    authenticatedBatchAcceptances: input.authenticatedBatchAcceptances,
  });
}

function failCandidateObservation(observation: S33Wave3Observation): void {
  observation.arms.v71.predictedCredentialType = observation.actualCredentialType === 'LEGAL'
    ? 'LICENSE'
    : 'LEGAL';
  observation.arms.v71.subType = null;
  observation.arms.v71.extractedFields = {
    fraudSignals: ['FORGED_SIGNAL'],
    ...Object.fromEntries(S33_WAVE3_SUBSTANTIVE_FIELDS.map((field) => [field, `wrong:${field}`])),
  };
}

describe('S3.3 Wave-3 deterministic offline gates', () => {
  it('freezes the exact v6 subtype block and corpus substantive-depth contract', () => {
    expect(S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY).toEqual(V6_SUBTYPE_TAXONOMY);
    const allPinnedFields = Object.fromEntries(S33_WAVE3_SUBSTANTIVE_FIELDS.map((field) => [
      field,
      field === 'creditHours' || field === 'ethicsHours'
        ? 1
        : ['parties', 'signatories', 'deliverables', 'riskFlags', 'recommendationUrls'].includes(field)
          ? ['present']
          : 'present',
    ]));
    const truth = { credentialType: 'OTHER', subType: 'other', ...allPinnedFields };
    expect(deriveS33Wave3ValidatedGoldFields(truth).substantiveDepth)
      .toBe(S33_WAVE3_SUBSTANTIVE_FIELDS.length);
    expect(countS33SubstantiveGroundTruthFields(truth))
      .toBe(S33_WAVE3_SUBSTANTIVE_FIELDS.length);
  });

  it('scores only non-empty fields that survive the production per-type validator', () => {
    const emptyArray = deriveS33Wave3ValidatedGoldFields({
      credentialType: 'OTHER',
      subType: 'other',
      parties: [],
    });
    expect(emptyArray.substantiveDepth).toBe(0);

    const stripped = deriveS33Wave3ValidatedGoldFields({
      credentialType: 'DEGREE',
      subType: 'bachelor',
      issuerName: 'University',
      contractType: 'asset_purchase',
    });
    expect(stripped.fields.contractType).toBeUndefined();
    expect(stripped.substantiveDepth).toBe(1);
  });

  it('machine-evaluates all 16 ratified gates with frozen deterministic bindings', () => {
    const first = evaluateS33Wave3OfflineGates(makeFixture());
    const second = evaluateS33Wave3OfflineGates(makeFixture());

    expect(first).toEqual(second);
    expect(first.gates.map(({ id }) => id)).toEqual(S33_WAVE3_GATE_IDS);
    expect(first.gates).toHaveLength(16);
    expect(first.gates.filter(({ passed }) => !passed).map(({ id }) => id)).toEqual([
      'G06_ALL_TYPE_FLOOR',
      'G07_CRITICAL_TYPE_FLOORS',
    ]);
    expect(first.evidenceClass).toBe('fixture-only');
    expect(first.verdict).toBe('NO-GO');
    expect(first.bindings.acceptanceAuthority).toEqual({
      verificationMode: 'test-injected',
      publicKeyFingerprintSha256: fixtureTrustRoot.publicKeyFingerprintSha256,
      authenticatedBatchCount: 1,
      releaseAuthority: false,
    });
    expect(first.releaseGuards.releaseAuthorityVerified).toBe(false);
    expect(first.bootstrap.replicates).toBe(2000);
    expect(first.bootstrap.domainsPooled).toBe(false);
    expect(first.bootstrap.knownDeltaControls.positive.ci95Lower).toBeGreaterThan(0);
    expect(first.bootstrap.knownDeltaControls.negative.ci95Upper).toBeLessThan(0);
    expect(first.regression.minimumPerTypeDeltaVsV6).toBeGreaterThanOrEqual(-0.05);
    expect(first.regression.publicBaselineGuardPassed).toBe(true);
    expect(Object.values(first.bindings.inputPacketDigests).every(
      (digest) => /^[0-9a-f]{64}$/u.test(digest),
    )).toBe(true);
    expect(first.artifactDigestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('never turns a test-injected acceptance chain into a release GO', () => {
    const report = evaluateS33Wave3OfflineGates(makeFixture());
    expect(report.gates).toHaveLength(16);
    expect(report.bindings.acceptanceAuthority.verificationMode).toBe('test-injected');
    expect(report.bindings.acceptanceAuthority.releaseAuthority).toBe(false);
    expect(report.releaseGuards.releaseAuthorityVerified).toBe(false);
    expect(report.evidenceClass).toBe('fixture-only');
    expect(report.verdict).toBe('NO-GO');

    const noInjectedAuthority = makeFixture();
    delete noInjectedAuthority.testOnlyAcceptanceTrustRoot;
    expect(() => evaluateS33Wave3OfflineGates(noInjectedAuthority)).toThrow(
      /CTO release trust root is not configured/u,
    );
  });

  it('requires the exact 81+3x180 signed release-corpus freeze', () => {
    const complete = releaseCorpusFreezeVector();
    expect(complete.passed).toBe(true);
    expect(complete.actualTotalEntryCount).toBe(621);
    expect(complete.immutableWave1EntryCount).toBe(81);
    expect(complete.actualPostWave1BatchIds).toEqual(TOP15_BATCH_IDS);
    expect(complete.authenticatedBatchCount).toBe(3);
    expect(complete.minimumFounderTypeCount).toBe(12);
    expect(complete.minimumFounderTypeEdgeCaseCount).toBe(4);
    expect(complete.finalRegistryDigestMatches).toBe(true);

    const missingBatch = releaseCorpusFreezeVector({ missingBatchIndex: 1 });
    expect(missingBatch.orderedBatchContractPassed).toBe(false);
    expect(missingBatch.authenticatedBatchCount).toBe(2);
    expect(missingBatch.passed).toBe(false);

    const elevenRows = releaseCorpusFreezeVector({
      underfilledFounderTypeId: 'legal-01-contract',
    });
    expect(elevenRows.founderTypeCounts['legal-01-contract']).toBe(11);
    expect(elevenRows.founderCountContractPassed).toBe(false);
    expect(elevenRows.passed).toBe(false);

    const threeEdges = releaseCorpusFreezeVector({
      lowEdgeFounderTypeId: 'legal-01-contract',
    });
    expect(threeEdges.founderTypeEdgeCaseCounts['legal-01-contract']).toBe(3);
    expect(threeEdges.edgeCaseContractPassed).toBe(false);
    expect(threeEdges.passed).toBe(false);

    const finalDigestMismatch = releaseCorpusFreezeVector({ finalRegistryDigestMismatch: true });
    expect(finalDigestMismatch.finalRegistryDigestMatches).toBe(false);
    expect(finalDigestMismatch.passed).toBe(false);
  });

  it('validates a malformed injected root even when no acceptance is supplied', () => {
    const input = makeFixture();
    input.authenticatedBatchAcceptances = [];
    input.testOnlyAcceptanceTrustRoot = {
      ...fixtureTrustRoot,
      publicKeySpkiPem: 'not an Ed25519 SPKI',
    };
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/trust-root SPKI PEM is invalid/u);
  });

  it('reports per-domain confusion, abstention, calibration, and a deterministic coverage curve', () => {
    const report = evaluateS33Wave3OfflineGates(makeFixture());

    expect(report.diagnostics.confusionByDomain.legal.total).toBeGreaterThan(0);
    expect(report.diagnostics.top20ConfusedPairs).toContainEqual({
      actual: 'CPE',
      predicted: 'CLE',
      count: 31,
    });
    expect(report.diagnostics.crossDomainConfusions).toBe(0);
    expect(report.diagnostics.abstention.count).toBeGreaterThan(0);
    expect(report.diagnostics.abstention.precisionAtAbstention).toBe(1);
    expect(report.diagnostics.coverageAccuracyCurve.at(-1)?.coverage).toBe(1);
    expect(report.calibration.meanGap).toBe(0);
    expect(report.calibration.ece).toBe(0);
  });

  it('keeps missing-both credit visible but out of coverage-adjusted F1', () => {
    const score = scoreS33FieldComparisons([
      { field: 'issuerName', expectedPresent: true, actualPresent: true, matched: true },
      { field: 'issuedDate', expectedPresent: true, actualPresent: false, matched: false },
      ...Array.from({ length: 8 }, (_, index) => ({
        field: `empty-${index}`,
        expectedPresent: false,
        actualPresent: false,
        matched: true,
      })),
    ]);

    expect(score.missingBothCount).toBe(8);
    expect(score.standardF1).toBeGreaterThan(0.9);
    expect(score.coverageAdjustedF1).toBeCloseTo(2 / 3, 10);
  });

  it('freezes the exact founder 3x15 mapping and emits the deterministic three-way scorer contract', () => {
    const report = evaluateS33Wave3OfflineGates(makeFixture());

    expect(report.founderCoverage.mappingCount).toBe(45);
    expect(report.founderCoverage.frozenCredentialTypes).toEqual(S33_WAVE3_FROZEN_CREDENTIAL_TYPES);
    expect(Object.values(report.founderCoverage.frozenSubtypeTaxonomy).flat()).toHaveLength(105);
    expect(report.founderCoverage.results).toHaveLength(45);
    expect(report.founderCoverage.results.every(
      ({ disposition }) => disposition === 'covered-by-prompt+base',
    )).toBe(true);

    const changed = cloneFixture();
    const registry = JSON.parse(changed.founderCoverageRegistryJson) as {
      domains: Array<{ types: Array<{ mappings: Array<{ subType: string }> }> }>;
    };
    registry.domains[0].types[0].mappings[0].subType = 'invented';
    changed.founderCoverageRegistryJson = JSON.stringify(registry);
    expect(() => evaluateS33Wave3OfflineGates(changed)).toThrow(/founder.*mapping/i);
  });

  it('rejects caller reassignment of a founder row bound by the trusted source', () => {
    const input = cloneFixture();
    input.observations.forEach((observation) => {
      if (observation.founderTypeId === 'legal-01-contract') {
        observation.founderTypeId = 'legal-02-service-agreement';
      }
    });
    rebindInputPackets(input);
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/founder mapping contradicts trusted gold source/u);
  });

  it('rejects a non-founder row signed under a founder registry id', () => {
    const input = makeFixture({
      includeNonFounderRows: true,
      fallbackRegistryTypeId: 'legal-01-contract',
    });
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/outside the founder corpus/u);
  });

  it('rejects signed edgeCase flags that disagree with the trusted literal source', () => {
    const input = makeFixture({ signedEdgeMismatchFounderTypeId: 'legal-01-contract' });
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/edgeCase binding mismatch/u);
  });

  it('scores exact AU>=10 and KE>=10 manifests separately with small-n/no-marketing wording', () => {
    const report = evaluateS33Wave3OfflineGates(makeFixture());

    expect(report.jurisdictions.AU.sampleSize).toBe(11);
    expect(report.jurisdictions.KE.sampleSize).toBe(11);
    expect(report.jurisdictions.AU.baselineF1).toBe(0.663);
    expect(report.jurisdictions.KE.baselineF1).toBe(0.663);
    expect(report.jurisdictions.AU.wording).toBe('measured, small-n — directional');
    expect(report.jurisdictions.KE.marketingAllowed).toBe(false);
  });

  it('returns an honest NO-GO for leakage and for a >=5pp per-type regression', () => {
    const leakage = cloneFixture();
    leakage.integrityEvidence.heldoutLeakageNgram6To13Findings.push('heldout/corpus overlap');
    rebindInputPackets(leakage);
    const leakageReport = evaluateS33Wave3OfflineGates(leakage);
    expect(leakageReport.verdict).toBe('NO-GO');
    expect(leakageReport.gates.find(({ id }) => id === 'G01_CORPUS_INTEGRITY')?.passed).toBe(false);

    const regression = cloneFixture();
    const targetType = S33_WAVE3_FROZEN_CREDENTIAL_TYPES[0];
    for (const observation of regression.observations) {
      if (observation.actualCredentialType !== targetType) continue;
      failCandidateObservation(observation);
    }
    rebindInputPackets(regression);
    const regressionReport = evaluateS33Wave3OfflineGates(regression);
    expect(regressionReport.verdict).toBe('NO-GO');
    expect(regressionReport.gates.find(({ id }) => id === 'G08_TYPE_REGRESSION')?.passed).toBe(false);
  });

  it.each([
    ['G02_SURGERY_CONFIG', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.exportLastCheckpointOnly = false;
    }],
    ['G03_JSON_PARSE', (input: S33Wave3EvaluationInput) => {
      const candidate = input.observations[0].arms.v71;
      candidate.parsed = false;
      candidate.predictedCredentialType = null;
      candidate.suggestedType = null;
      candidate.subType = null;
      candidate.description = null;
      candidate.extractedFields = {};
    }],
    ['G04_MACRO_F1', (input: S33Wave3EvaluationInput) => {
      const failedTypes: ReadonlySet<string> = new Set(S33_WAVE3_FROZEN_CREDENTIAL_TYPES.slice(0, 8));
      input.observations.filter(({ actualCredentialType }) => failedTypes.has(actualCredentialType))
        .forEach(failCandidateObservation);
    }],
    ['G05_WEIGHTED_F1', (input: S33Wave3EvaluationInput) => {
      const failedTypes = new Set(['LEGAL', 'FINANCIAL', 'DEGREE']);
      input.observations.filter(({ actualCredentialType }) => failedTypes.has(actualCredentialType))
        .forEach(failCandidateObservation);
    }],
    ['G06_ALL_TYPE_FLOOR', (input: S33Wave3EvaluationInput) => {
      input.observations.filter(({ actualCredentialType }) => actualCredentialType === 'ACCREDITATION')
        .forEach(failCandidateObservation);
    }],
    ['G07_CRITICAL_TYPE_FLOORS', (input: S33Wave3EvaluationInput) => {
      input.observations.filter(({ actualCredentialType }) => actualCredentialType === 'RESUME')
        .forEach(failCandidateObservation);
    }],
    ['G09_LEGAL_UPLIFT', (input: S33Wave3EvaluationInput) => {
      input.observations.filter(({ domain }) => domain === 'legal').forEach((observation) => {
        observation.arms.v71 = structuredClone(observation.arms.v6);
      });
    }],
    ['G10_FINANCIAL_UPLIFT', (input: S33Wave3EvaluationInput) => {
      input.observations.filter(({ domain }) => domain === 'financial').forEach((observation) => {
        observation.arms.v71 = structuredClone(observation.arms.v6);
      });
    }],
    ['G11_EDUCATION_UPLIFT', (input: S33Wave3EvaluationInput) => {
      input.observations.filter(({ domain }) => domain === 'education').forEach((observation) => {
        observation.arms.v71 = structuredClone(observation.arms.v6);
      });
    }],
    ['G12_SUBTYPE_EMISSION', (input: S33Wave3EvaluationInput) => {
      input.observations.forEach((observation) => {
        if (observation.actualCredentialType === 'OTHER') return;
        observation.arms.v71.subType = null;
      });
    }],
    ['G13_DESCRIPTION_EMISSION', (input: S33Wave3EvaluationInput) => {
      input.observations[0].arms.v71.description = null;
    }],
    ['G14_EFFICIENCY', (input: S33Wave3EvaluationInput) => {
      input.observations.forEach((observation) => {
        observation.arms.v71.latencyMs = 6000;
      });
    }],
    ['G14_EFFICIENCY', (input: S33Wave3EvaluationInput) => {
      input.observations.forEach((observation) => {
        observation.arms.v71.tokensUsed = 20;
      });
    }],
    ['G15_CALIBRATION_GAP', (input: S33Wave3EvaluationInput) => {
      input.observations.forEach((observation) => {
        observation.arms.v71.calibratedConfidence = 0.5;
      });
    }],
    ['G16_CALIBRATION_ECE', (input: S33Wave3EvaluationInput) => {
      input.observations.forEach((observation, index) => {
        if (index % 2 === 0) observation.arms.v71.calibratedConfidence = 0;
        else {
          failCandidateObservation(observation);
          observation.arms.v71.calibratedConfidence = 1;
        }
      });
    }],
  ])('makes %s executable rather than documentary', (gateId, mutate) => {
    const input = cloneFixture();
    mutate(input);
    rebindInputPackets(input);
    const report = evaluateS33Wave3OfflineGates(input);
    expect(report.gates.find(({ id }) => id === gateId)?.passed).toBe(false);
    expect(report.verdict).toBe('NO-GO');
  });

  it.each([
    ['dropped-id set', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.sourceTrainingRowIds.shift();
    }],
    ['goodStandingStatus type', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.exportedTrainingRows[0].goodStandingStatus = 1;
    }],
    ['concrete subtype rate', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.exportedTrainingRows[0].subType = 'other';
    }],
    ['fraud-stream split', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.fraudStream.mode = 'joined';
    }],
    ['credentialType/subType taxonomy pair', (input: S33Wave3EvaluationInput) => {
      input.surgeryEvidence.exportedTrainingRows[0].credentialType = 'LICENSE';
    }],
  ])('executes the G02 %s assertion', (_label, mutate) => {
    const input = cloneFixture();
    mutate(input);
    rebindInputPackets(input);
    const report = evaluateS33Wave3OfflineGates(input);
    expect(report.gates.find(({ id }) => id === 'G02_SURGERY_CONFIG')?.passed).toBe(false);
    expect(report.verdict).toBe('NO-GO');
  });

  it('fails the supplemental public-baseline guard when missing-both credit hides lost coverage', () => {
    const input = cloneFixture();
    input.observations.filter(({ actualCredentialType }) => actualCredentialType === 'ACCREDITATION')
      .forEach((observation) => {
        failCandidateObservation(observation);
        observation.arms.v71.predictedCredentialType = 'LEGAL';
      });

    rebindInputPackets(input);
    const report = evaluateS33Wave3OfflineGates(input);
    expect(report.gates.find(({ id }) => id === 'G08_TYPE_REGRESSION')?.passed).toBe(false);
    expect(report.regression.minimumCoverageAdjustedDeltaVsPublic).toBeLessThan(-0.05);
    expect(report.regression.publicBaselineGuardPassed).toBe(false);
    expect(report.verdict).toBe('NO-GO');
  });

  it('derives type correctness from the raw prediction instead of accepting claimed booleans', () => {
    const input = cloneFixture();
    const targetType = 'ACCREDITATION';
    input.observations.filter(({ actualCredentialType }) => actualCredentialType === targetType)
      .forEach(failCandidateObservation);
    rebindInputPackets(input);
    const report = evaluateS33Wave3OfflineGates(input);
    expect(report.scoring.coverageAdjustedF1).toBeLessThan(1);
    expect(report.verdict).toBe('NO-GO');
  });

  it('scores honestly-declared wrong predictions and cannot GO below the frozen type floor', () => {
    const input = cloneFixture();
    input.observations.filter(({ actualCredentialType }) => actualCredentialType === 'ACCREDITATION')
      .forEach(failCandidateObservation);
    rebindInputPackets(input);
    const report = evaluateS33Wave3OfflineGates(input);
    expect(report.gates.find(({ id }) => id === 'G06_ALL_TYPE_FLOOR')?.passed).toBe(false);
    expect(report.verdict).toBe('NO-GO');
  });

  it('does not let an arm redefine the corpus truth with arbitrary expected fields', () => {
    const input = cloneFixture();
    Object.assign(input.observations[0].arms.v71, {
      fieldComparisons: Array.from({ length: 5 }, (_, index) => ({
        field: `claimed-${index}`,
        expectedPresent: true,
        actualPresent: true,
        matched: true,
      })),
    });
    rebindInputPackets(input);
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/arm keys.*frozen ordered contract/u);
  });

  it('accepts exactly the public/v6/v71 arms and rejects an injected arm', () => {
    const input = cloneFixture();
    Object.assign(input.observations[0].arms, {
      attacker: structuredClone(input.observations[0].arms.public),
    });
    rebindInputPackets(input);
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/observation .* arms keys.*frozen ordered contract/u);
  });

  it('fails closed on stale input-packet bindings and distinguishes metric-equivalent raw packets', () => {
    const stale = cloneFixture();
    stale.observations[0].arms.v71.description = 'metric-equivalent but distinct raw description';
    expect(() => evaluateS33Wave3OfflineGates(stale)).toThrow(/observationsCanonicalSha256 mismatch/u);

    const originalReport = evaluateS33Wave3OfflineGates(makeFixture());
    const changed = cloneFixture();
    changed.observations[0].arms.v71.description = 'metric-equivalent but distinctly bound description';
    rebindInputPackets(changed);
    const changedReport = evaluateS33Wave3OfflineGates(changed);
    expect(changedReport.gates).toEqual(originalReport.gates);
    expect(changedReport.bindings.inputPacketDigests.observationsCanonicalSha256)
      .not.toBe(originalReport.bindings.inputPacketDigests.observationsCanonicalSha256);
    expect(changedReport.artifactDigestSha256).not.toBe(originalReport.artifactDigestSha256);
  });

  it('rejects a self-consistent forged registry and matching forged source without a new CTO acceptance', () => {
    const input = cloneFixture();
    const source = input.trustedGoldSources[input.trustedGoldSources.length - 1];
    source.sourceText = source.sourceText.replace('Issuer GD-S33-W3-0001', 'Forged Issuer GD-S33-W3-0001');
    source.sourceBlobSha = gitBlobSha1(source.sourceText);
    const registry = input.acceptedCorpusRegistry as {
      verificationHeadSha: string;
      verificationTreeSha: string;
      registryDigestSha256: string;
      acceptedBatches: Array<{ sourceBlobSha: string }>;
      entries: Array<{ id: string }>;
      [key: string]: unknown;
    };
    registry.acceptedBatches[registry.acceptedBatches.length - 1].sourceBlobSha = source.sourceBlobSha;
    const {
      verificationHeadSha: _head,
      verificationTreeSha: _tree,
      registryDigestSha256: _digest,
      ...corpusIdentity
    } = registry;
    registry.registryDigestSha256 = sha256(canonicaliseJson(corpusIdentity));
    const entryIds = registry.entries.map(({ id }) => id);
    input.armManifests = {
      public: createS33Wave3ArmManifest('public', registry.registryDigestSha256, entryIds),
      v6: createS33Wave3ArmManifest('v6', registry.registryDigestSha256, entryIds),
      v71: createS33Wave3ArmManifest('v71', registry.registryDigestSha256, entryIds),
    };
    rebindInputPackets(input);
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(/authenticated registry digest|acceptance.*binding/u);
  });

  it.each([
    ['non-finite metric', (input: S33Wave3EvaluationInput) => {
      input.observations[0].arms.v71.calibratedConfidence = Number.NaN;
    }, /finite/i],
    ['corpus digest mismatch', (input: S33Wave3EvaluationInput) => {
      input.armManifests.v71.corpusRegistryDigestSha256 = 'f'.repeat(64);
    }, /corpus.*digest/i],
    ['accepted-id mismatch', (input: S33Wave3EvaluationInput) => {
      input.observations.pop();
    }, /accepted.*id|observation.*id/i],
    ['jurisdiction manifest mismatch', (input: S33Wave3EvaluationInput) => {
      input.jurisdictionManifests.AU = input.jurisdictionManifests.AU.slice(1);
    }, /AU.*manifest/i],
    ['gate registry mismatch', (input: S33Wave3EvaluationInput) => {
      input.gateRegistryJson = input.gateRegistryJson.replace('2000', '1999');
    }, /gate registry.*digest/i],
    ['subtype taxonomy mismatch', (input: S33Wave3EvaluationInput) => {
      const observation = input.observations.find(
        ({ actualCredentialType }) => actualCredentialType === 'ACCREDITATION',
      );
      if (!observation) throw new Error('ACCREDITATION fixture is missing');
      observation.actualSubType = 'invented';
    }, /corpus subtype binding/i],
    ['unknown observation field', (input: S33Wave3EvaluationInput) => {
      Object.assign(input.observations[0], { unboundClaim: 'not permitted' });
    }, /observation.*keys/i],
  ])('fails closed on %s', (_label, mutate, expected) => {
    const input = cloneFixture();
    mutate(input);
    expect(() => evaluateS33Wave3OfflineGates(input)).toThrow(expected);
  });
});
