import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  auditS33Wave2Coverage,
  createS33Wave2CoverageAuditTestHarnessV2,
  parseS33Wave2Top15Registry,
  s33Wave2CoverageReportSha256,
  type S33Wave2Top15Registry,
} from './s33-wave2-coverage-audit.js';
import {
  S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
  S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  createS33DetachedSigningTestHarnessV2,
  emitS33DetachedSigningRequestV2,
  validateS33DetachedSigningTrustPolicySetV2,
  validateS33DetachedSigningTrustPolicyV2,
  type S33DetachedAcceptedEntryInputV2,
  type S33DetachedAcceptanceEnvelopeV2,
  type S33DetachedSigningTestHarnessV2,
} from './s33-wave3-detached-signing-v2.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '../../../../..');
const registryPath = resolve(repositoryRoot, 'docs/lane4/s33-wave2-top15-registry.json');
const baselineEvidencePath = resolve(
  repositoryRoot,
  'docs/lane4/evidence/s33-wave2-coverage-baseline.json',
);
const WAVE1_BASE_REGISTRY_DIGEST = '412a08227608a58172569a4fcbf3cd1025dc67fc1beeaddd6c163d22c4cb80d6';

interface BaselineEvidence {
  registryRawSha256: string;
  reportCanonicalSha256: string;
  summary: Record<string, number>;
  productionOrder: string[];
}

function readRegistry(): unknown {
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

function readRegistryBytes(): Buffer {
  return readFileSync(registryPath);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitBlobSha1(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function acceptedEntryInput(
  id: string,
  batchId: string,
  revision: number,
  overrides: Partial<S33DetachedAcceptedEntryInputV2> = {},
): S33DetachedAcceptedEntryInputV2 {
  return {
    id,
    registryTypeId: 'legal-01-contract',
    batchId,
    revision,
    credentialType: 'LEGAL',
    subType: 'contract',
    normalizedInputSha256: digest(`${batchId}:${id}:input`),
    groundTruthSha256: digest(`${batchId}:${id}:ground-truth`),
    authorshipMethod: 'independently-authored',
    generatorDerived: false,
    trainingExposed: false,
    intendedSplit: 'held-out',
    productionValidSubstantiveFieldCount: 5,
    edgeCase: false,
    sourceBlobSha: sha1(`${batchId}:source`),
    ...overrides,
  };
}

interface AcceptanceOptions {
  batchId?: string;
  revision?: number;
  pullRequestNumber?: number;
  baseRegistryDigestSha256?: string;
  resultingRegistryDigestSha256?: string;
  coverageRegistryRawSha256?: string;
  coverageRegistryCanonicalSha256?: string;
  acceptedEntries?: S33DetachedAcceptedEntryInputV2[];
  privateKey?: KeyObject;
  signingHarness?: S33DetachedSigningTestHarnessV2;
}

let testPrivateKey: KeyObject;
let testSigningHarness: S33DetachedSigningTestHarnessV2;
let coverageAuditTestHarness: ReturnType<typeof createS33Wave2CoverageAuditTestHarnessV2>;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  testPrivateKey = privateKey;
  const policy = validateS33DetachedSigningTrustPolicyV2({
    ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
    state: 'ACTIVE',
    publicKeySpkiPem,
    publicKeyFingerprintSha256: createHash('sha256')
      .update(createPublicKey(publicKeySpkiPem).export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    authorizedOperator: 'lane3-coverage-fixture',
    fingerprintConfirmation: {
      method: 'cto-out-of-band',
      confirmedBy: 'lane3-coverage-cto',
      confirmedAtUtc: '2026-07-15T13:58:00.000Z',
    },
    activatedAtUtc: '2026-07-15T13:59:00.000Z',
  });
  testSigningHarness = createS33DetachedSigningTestHarnessV2(
    validateS33DetachedSigningTrustPolicySetV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
      activeSigningKeyId: policy.signingKeyId,
      keys: [policy],
    }),
  );
  coverageAuditTestHarness = createS33Wave2CoverageAuditTestHarnessV2(testSigningHarness);
});

function buildAcceptance(options: AcceptanceOptions = {}): S33DetachedAcceptanceEnvelopeV2 {
  const batchId = options.batchId ?? 'S33-W2-L01-05';
  const revision = options.revision ?? 1;
  const pullRequestNumber = options.pullRequestNumber ?? 1601;
  const sourceBlobSha = sha1(`${batchId}:source`);
  const registryBytes = readRegistryBytes();
  const entries = options.acceptedEntries ?? [
    acceptedEntryInput(`GD-${batchId}-001`, batchId, revision, { sourceBlobSha }),
  ];
  const request = emitS33DetachedSigningRequestV2({
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber,
    candidateBaseSha: sha1(`${batchId}:candidate-base`),
    candidateHeadSha: sha1(`${batchId}:candidate-head`),
    candidateTreeSha: sha1(`${batchId}:candidate-tree`),
    batchId,
    revision,
    manifestPath: `docs/lane4/s33-wave2-batches/${batchId}/manifest.json`,
    manifestRawSha256: digest(`${batchId}:manifest-raw`),
    manifestCanonicalSha256: digest(`${batchId}:manifest-canonical`),
    sourceBlobSha,
    datasheetBlobSha: sha1(`${batchId}:datasheet`),
    preflightArtifactDigestSha256: digest(`${batchId}:preflight`),
    baseRegistryDigestSha256: options.baseRegistryDigestSha256 ?? WAVE1_BASE_REGISTRY_DIGEST,
    resultingRegistryDigestSha256: options.resultingRegistryDigestSha256 ?? digest(`${batchId}:registry-result`),
    coverageRegistryPath: 'docs/lane4/s33-wave2-top15-registry.json',
    coverageRegistryRawSha256: options.coverageRegistryRawSha256
      ?? createHash('sha256').update(registryBytes).digest('hex'),
    coverageRegistryCanonicalSha256: options.coverageRegistryCanonicalSha256
      ?? digest(canonicaliseJson(readRegistry())),
    signedAtUtc: '2026-07-15T14:00:00.000Z',
    reviewer: {
      lane: 'Lane 3',
      transport: 'github-issue-comment',
      evidence: {
        id: pullRequestNumber + 10_000,
        nodeId: `IC_${pullRequestNumber}`,
        url: `https://github.com/carson-see/ArkovaCarson/pull/${pullRequestNumber}#issuecomment-${pullRequestNumber + 10_000}`,
        submittedAtUtc: '2026-07-15T13:59:59.000Z',
        actor: {
          login: 'carson-see',
          databaseId: 456,
          nodeId: 'MDQ6VXNlcjQ1Ng==',
        },
      },
    },
    proof: {
      machineValidationArtifactSha256: digest(`${batchId}:machine-validation`),
      machineValidationFailureCount: 0,
      humanCrossReviewArtifactSha256: digest(`${batchId}:human-review`),
      humanCrossReviewSampleSize: Math.max(
        Math.min(entries.length, 5),
        Math.ceil(entries.length * 0.1),
      ),
      materialLabelDefectCount: 0,
      prodModelDiffArtifactSha256: digest(`${batchId}:prod-model-diff`),
      exactLeakageArtifactSha256: digest(`${batchId}:leakage`),
      exactLeakageHitCount: 0,
    },
    acceptedEntries: entries,
  });
  const signature = sign(
    null,
    Buffer.from(request.signingBytesBase64Url, 'base64url'),
    options.privateKey ?? testPrivateKey,
  ).toString('base64url');
  return (options.signingHarness ?? testSigningHarness).assemble(request, signature, {
    verifiedAtUtc: '2026-07-15T14:01:00.000Z',
  });
}

function withRefreshedArtifactDigest(
  envelope: S33DetachedAcceptanceEnvelopeV2,
): S33DetachedAcceptanceEnvelopeV2 {
  const digestInput = { ...envelope } as Record<string, unknown>;
  delete digestInput.artifactDigestSha256;
  return {
    ...envelope,
    artifactDigestSha256: digest(canonicaliseJson(digestInput)),
  };
}

describe('S3.3 Wave 2 top-15 registry', () => {
  it('pins exactly three ordered domains and 45 unique types', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.domains.map((domain) => domain.id)).toEqual(['legal', 'financial', 'education']);
    expect(registry.domains.map((domain) => domain.types.length)).toEqual([15, 15, 15]);
    expect(new Set(registry.domains.flatMap((domain) => domain.types.map((type) => type.id))).size).toBe(45);
    expect(registry.productionOrder).toHaveLength(45);
    expect(new Set(registry.productionOrder).size).toBe(45);
  });

  it('uses the CTO-ratified domain-interleaved tranche order', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.productionOrder.slice(0, 15)).toEqual([
      'legal-01-contract',
      'legal-02-service-agreement',
      'legal-03-nondisclosure-agreement',
      'legal-04-settlement-agreement',
      'legal-05-court-opinion',
      'financial-01-pay-stub',
      'financial-02-w2',
      'financial-03-1099',
      'financial-04-bank-statement',
      'financial-05-income-verification',
      'education-01-associate',
      'education-02-bachelor',
      'education-03-master',
      'education-04-doctorate',
      'education-05-professional-degree',
    ]);
    expect(registry.productionOrder.slice(-5)).toEqual([
      'education-11-trade-certification',
      'education-12-training-certificate',
      'education-13-completion-certificate',
      'education-14-accreditation',
      'education-15-microcredential',
    ]);
  });

  it('pins the merged Wave 1 baseline without claiming top-15 coverage', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.acceptedBaseline).toMatchObject({
      batchId: 'S33-W1',
      revision: 12,
      pullRequest: 1544,
      producerHeadCommit: '618e08d5a11cb73cb61394bc0343d33f4353ef39',
      mergeCommit: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
      entryCount: 81,
      top15CoverageDisposition: 'NOT_PROVIDED_IN_WAVE_1',
      countedTop15EntryIds: [],
    });
  });

  it('recomputes the Wave 1 document and source-blob pins from repository bytes', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());
    const baseline = registry.acceptedBaseline;

    expect(sha256File(resolve(repositoryRoot, 'docs/lane4/s33-wave1-batch-manifest.json')))
      .toBe(baseline.manifestRawSha256);
    expect(sha256File(resolve(repositoryRoot, 'docs/lane4/s33-wave1-entry-datasheet.json')))
      .toBe(baseline.entryDatasheetRawSha256);
    expect(sha256File(resolve(repositoryRoot, 'docs/lane4/s33-corpus-datasheet.md')))
      .toBe(baseline.corpusDatasheetRawSha256);
    expect(gitBlobSha1(resolve(repositoryRoot, 'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts')))
      .toBe(baseline.sourceBlobs.licensing);
    expect(gitBlobSha1(resolve(repositoryRoot, 'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts')))
      .toBe(baseline.sourceBlobs.auKe);
    expect(gitBlobSha1(resolve(repositoryRoot, 'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts')))
      .toBe(baseline.sourceBlobs.ood);
  });

  it('rejects a production-order change', () => {
    const registry = structuredClone(readRegistry()) as S33Wave2Top15Registry;
    [registry.productionOrder[0], registry.productionOrder[1]] = [
      registry.productionOrder[1]!,
      registry.productionOrder[0]!,
    ];

    expect(() => parseS33Wave2Top15Registry(registry)).toThrow(/production order/i);
  });

  it('rejects an unratified production taxonomy mapping', () => {
    const registry = structuredClone(readRegistry()) as S33Wave2Top15Registry;
    registry.domains[0]!.types[0]!.mappings[0]!.subType = 'invented_contract_type';

    expect(() => parseS33Wave2Top15Registry(registry)).toThrow(/unratified mapping/i);
  });
});

describe('S3.3 Wave 2 authenticated held-out coverage audit', () => {
  const auditWithTestRoot = (envelopes: readonly unknown[]) => (
    coverageAuditTestHarness.audit(
      readRegistryBytes(),
      envelopes,
      '2026-07-15T14:01:00.000Z',
    )
  );

  it('reports the honest Wave 1 baseline as 45 gaps and 540 missing rows without requiring a trust root', () => {
    const report = auditS33Wave2Coverage(readRegistryBytes(), []);

    expect(report).toMatchObject({
      planningBaseCommit: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
      registryTypeCount: 45,
      acceptedBatchCount: 0,
      acceptedEntryCount: 0,
      acceptanceArtifactDigests: [],
      acceptedRegistryRootSha256: null,
      acceptedRegistryHeadSha256: null,
      completeTypeCount: 0,
      incompleteTypeCount: 45,
      minimumRequiredEntryCount: 540,
      missingEntryCount: 540,
    });
    expect(report.types).toHaveLength(45);
    expect(report.types.every((type) => type.qualifyingCount === 0 && type.missingCount === 12)).toBe(true);
  });

  it('reproduces the committed pre-corpus evidence from exact registry bytes', () => {
    const evidence = JSON.parse(readFileSync(baselineEvidencePath, 'utf8')) as BaselineEvidence;
    const report = auditS33Wave2Coverage(readRegistryBytes(), []);

    expect(evidence.registryRawSha256).toBe(sha256File(registryPath));
    expect(evidence.reportCanonicalSha256).toBe(s33Wave2CoverageReportSha256(report));
    expect(evidence.summary).toEqual({
      registryTypeCount: report.registryTypeCount,
      acceptedBatchCount: report.acceptedBatchCount,
      acceptedEntryCount: report.acceptedEntryCount,
      completeTypeCount: report.completeTypeCount,
      incompleteTypeCount: report.incompleteTypeCount,
      minimumRequiredEntryCount: report.minimumRequiredEntryCount,
      missingEntryCount: report.missingEntryCount,
      missingPerType: 12,
    });
    expect(evidence.productionOrder).toEqual(report.productionOrder);
  });

  it('counts only entries inside a valid Lane-3-signed whole-batch envelope', () => {
    const batchId = 'S33-W2-L01-05';
    const entries = Array.from({ length: 12 }, (_, index) => acceptedEntryInput(
      `GD-S33-W2-L-C-${index + 1}`,
      batchId,
      1,
      { edgeCase: index < 4 },
    ));
    const envelope = buildAcceptance({ batchId, acceptedEntries: entries });
    const report = auditWithTestRoot([envelope]);
    const first = report.types[0];

    expect(first).toMatchObject({
      registryTypeId: 'legal-01-contract',
      qualifyingCount: 12,
      edgeCaseCount: 4,
      minimumEdgeCaseRequired: 4,
      missingCount: 0,
      complete: true,
    });
    expect(report).toMatchObject({
      acceptedBatchCount: 1,
      acceptedEntryCount: 12,
      acceptanceArtifactDigests: [envelope.artifactDigestSha256],
      acceptedRegistryRootSha256: envelope.request.payload.baseRegistryDigestSha256,
      acceptedRegistryHeadSha256: envelope.request.payload.resultingRegistryDigestSha256,
      completeTypeCount: 1,
      missingEntryCount: 528,
    });
  });

  it('cryptographically verifies the complete three-by-180 chain before reporting all 540 rows', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());
    const typeById = new Map(registry.domains.flatMap((domain) => (
      domain.types.map((type) => [type.id, type] as const)
    )));
    const batchIds = [
      'S33-W2-TOP15-01-05',
      'S33-W2-TOP15-06-10',
      'S33-W2-TOP15-11-15',
    ];
    const heads = batchIds.map((batchId) => digest(`${batchId}:complete-registry`));
    const envelopes = batchIds.map((batchId, batchIndex) => {
      const entries = registry.productionOrder
        .slice(batchIndex * 15, (batchIndex + 1) * 15)
        .flatMap((registryTypeId) => {
          const mapping = typeById.get(registryTypeId)!.mappings[0]!;
          return Array.from({ length: 12 }, (_, entryIndex) => acceptedEntryInput(
            `GD-${batchIndex + 1}-${registryTypeId}-${String(entryIndex + 1).padStart(2, '0')}`,
            batchId,
            1,
            {
              registryTypeId,
              credentialType: mapping.credentialType,
              subType: mapping.subType,
              edgeCase: entryIndex < 4,
            },
          ));
        });
      expect(entries).toHaveLength(180);
      return buildAcceptance({
        batchId,
        pullRequestNumber: 1620 + batchIndex,
        baseRegistryDigestSha256: batchIndex === 0
          ? WAVE1_BASE_REGISTRY_DIGEST
          : heads[batchIndex - 1],
        resultingRegistryDigestSha256: heads[batchIndex],
        acceptedEntries: entries,
      });
    });

    const report = auditWithTestRoot([envelopes[2], envelopes[0], envelopes[1]]);
    expect(report).toMatchObject({
      acceptedBatchCount: 3,
      acceptedEntryCount: 540,
      completeTypeCount: 45,
      incompleteTypeCount: 0,
      missingEntryCount: 0,
      acceptedRegistryRootSha256: WAVE1_BASE_REGISTRY_DIGEST,
      acceptedRegistryHeadSha256: heads[2],
    });
    expect(report.acceptanceArtifactDigests).toEqual(
      envelopes.map(({ artifactDigestSha256 }) => artifactDigestSha256),
    );
  });

  it('keeps a type incomplete when its signed 30% edge-case threshold is short', () => {
    const batchId = 'S33-W2-L01-05-SHORT-EDGE';
    const entries = Array.from({ length: 12 }, (_, index) => acceptedEntryInput(
      `GD-S33-W2-L-C-SHORT-${index + 1}`,
      batchId,
      1,
      { edgeCase: index < 3 },
    ));
    const report = auditWithTestRoot([buildAcceptance({ batchId, acceptedEntries: entries })]);

    expect(report.types[0]).toMatchObject({
      qualifyingCount: 12,
      edgeCaseCount: 3,
      minimumEdgeCaseRequired: 4,
      missingCount: 1,
      complete: false,
    });
    expect(report.completeTypeCount).toBe(0);
    expect(report.missingEntryCount).toBe(529);
  });

  it('rejects producer-fabricated Lane-3 labels instead of granting full coverage', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());
    const typeById = new Map(registry.domains.flatMap((domain) => (
      domain.types.map((type) => [type.id, type] as const)
    )));
    const fabricated = registry.productionOrder.flatMap((registryTypeId) => {
      const mapping = typeById.get(registryTypeId)!.mappings[0]!;
      return Array.from({ length: 12 }, (_, index) => ({
        id: `FABRICATED-${registryTypeId}-${String(index + 1).padStart(2, '0')}`,
        registryTypeId,
        batchId: 'FABRICATED-BATCH',
        credentialType: mapping.credentialType,
        subType: mapping.subType,
        edgeCase: index < 4,
        acceptance: { lane: 'lane3', artifactSha256: '0'.repeat(64) },
      }));
    });

    expect(fabricated).toHaveLength(540);
    expect(() => auditWithTestRoot(fabricated)).toThrow(/authenticated Lane-3 acceptance/iu);
  });

  it('fails closed for a valid envelope until the production v2 policy is activated', () => {
    const envelope = buildAcceptance();
    expect(() => auditS33Wave2Coverage(
      readRegistryBytes(),
      [envelope],
      '2026-07-15T14:01:00.000Z',
    ))
      .toThrow(/UNCONFIGURED|no configured ACTIVE key/iu);
  });

  it('binds acceptance to the exact raw and canonical coverage-registry bytes', () => {
    const envelope = buildAcceptance();
    expect(() => coverageAuditTestHarness.audit(
      Buffer.concat([readRegistryBytes(), Buffer.from(' ')]),
      [envelope],
      '2026-07-15T14:01:00.000Z',
    )).toThrow(/coverageRegistryRawSha256/iu);

    const wrongRegistry = buildAcceptance({ coverageRegistryCanonicalSha256: '0'.repeat(64) });
    expect(() => auditWithTestRoot([wrongRegistry])).toThrow(/coverageRegistryCanonicalSha256/iu);
  });

  it('rejects payload tampering and an invalid Ed25519 signature', () => {
    const envelope = buildAcceptance();
    const tampered = structuredClone(envelope);
    tampered.request.payload.acceptedEntries[0]!.edgeCase = !tampered.request.payload.acceptedEntries[0]!.edgeCase;
    expect(() => auditWithTestRoot([withRefreshedArtifactDigest(tampered)]))
      .toThrow(/entry digest mismatch/iu);

    const invalidSignature = structuredClone(envelope);
    const first = invalidSignature.signatureBase64Url[0] === 'A' ? 'B' : 'A';
    invalidSignature.signatureBase64Url = `${first}${invalidSignature.signatureBase64Url.slice(1)}`;
    expect(() => auditWithTestRoot([withRefreshedArtifactDigest(invalidSignature)]))
      .toThrow(/signature verification failed/iu);
  });

  it('rejects a signer outside the CTO release trust root', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const foreignPolicy = validateS33DetachedSigningTrustPolicyV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      state: 'ACTIVE',
      publicKeySpkiPem,
      publicKeyFingerprintSha256: createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
      authorizedOperator: 'foreign-fixture-operator',
      fingerprintConfirmation: {
        method: 'cto-out-of-band',
        confirmedBy: 'foreign-fixture-cto',
        confirmedAtUtc: '2026-07-15T13:58:00.000Z',
      },
      activatedAtUtc: '2026-07-15T13:59:00.000Z',
    });
    const foreignHarness = createS33DetachedSigningTestHarnessV2(
      validateS33DetachedSigningTrustPolicySetV2({
        ...S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
        activeSigningKeyId: foreignPolicy.signingKeyId,
        keys: [foreignPolicy],
      }),
    );
    const envelope = buildAcceptance({
      privateKey,
      signingHarness: foreignHarness,
    });
    expect(() => auditWithTestRoot([envelope])).toThrow(/fingerprint does not match/iu);
  });

  it('orders one unbroken registry chain before flattening accepted entries', () => {
    const root = WAVE1_BASE_REGISTRY_DIGEST;
    const middle = digest('chain-middle');
    const head = digest('chain-head');
    const first = buildAcceptance({
      batchId: 'S33-W2-CHAIN-01',
      pullRequestNumber: 1602,
      baseRegistryDigestSha256: root,
      resultingRegistryDigestSha256: middle,
    });
    const second = buildAcceptance({
      batchId: 'S33-W2-CHAIN-02',
      pullRequestNumber: 1603,
      baseRegistryDigestSha256: middle,
      resultingRegistryDigestSha256: head,
    });
    const report = auditWithTestRoot([second, first]);

    expect(report.acceptanceArtifactDigests).toEqual([
      first.artifactDigestSha256,
      second.artifactDigestSha256,
    ]);
    expect(report.acceptedRegistryRootSha256).toBe(root);
    expect(report.acceptedRegistryHeadSha256).toBe(head);
  });

  it('rejects a validly signed chain rooted anywhere except the immutable Wave-1 digest', () => {
    const wrongRoot = buildAcceptance({
      batchId: 'S33-W2-WRONG-ROOT',
      baseRegistryDigestSha256: digest('attacker-selected-root'),
      resultingRegistryDigestSha256: digest('attacker-selected-head'),
    });
    expect(() => auditWithTestRoot([wrongRoot]))
      .toThrow(/not rooted at the immutable Wave-1 registry/iu);
  });

  it('rejects duplicate artifacts and a repeated batch id at another revision', () => {
    const envelope = buildAcceptance();
    expect(() => auditWithTestRoot([envelope, envelope])).toThrow(/duplicate.+artifact/iu);

    const batchId = 'S33-W2-REPEATED-BATCH';
    const middle = digest('repeated-middle');
    const revisionOne = buildAcceptance({
      batchId,
      revision: 1,
      pullRequestNumber: 1604,
      baseRegistryDigestSha256: WAVE1_BASE_REGISTRY_DIGEST,
      resultingRegistryDigestSha256: middle,
    });
    const revisionTwoEntries = [acceptedEntryInput('GD-REPEATED-REVISION-2', batchId, 2)];
    const revisionTwo = buildAcceptance({
      batchId,
      revision: 2,
      pullRequestNumber: 1605,
      baseRegistryDigestSha256: middle,
      resultingRegistryDigestSha256: digest('repeated-head'),
      acceptedEntries: revisionTwoEntries,
    });
    expect(() => auditWithTestRoot([revisionOne, revisionTwo])).toThrow(/batch id across revisions/iu);
  });

  it('rejects duplicate entry ids and normalized-input fingerprints across batches', () => {
    const root = WAVE1_BASE_REGISTRY_DIGEST;
    const middle = digest('duplicate-entry-middle');
    const duplicateId = 'GD-S33-W2-DUPLICATE';
    const firstBatch = 'S33-W2-DUPLICATE-01';
    const secondBatch = 'S33-W2-DUPLICATE-02';
    const first = buildAcceptance({
      batchId: firstBatch,
      pullRequestNumber: 1606,
      baseRegistryDigestSha256: root,
      resultingRegistryDigestSha256: middle,
      acceptedEntries: [acceptedEntryInput(duplicateId, firstBatch, 1)],
    });
    const second = buildAcceptance({
      batchId: secondBatch,
      pullRequestNumber: 1607,
      baseRegistryDigestSha256: middle,
      resultingRegistryDigestSha256: digest('duplicate-entry-head'),
      acceptedEntries: [acceptedEntryInput(duplicateId, secondBatch, 1)],
    });
    expect(() => auditWithTestRoot([first, second])).toThrow(/duplicate accepted held-out entry id/iu);

    const sharedInput = digest('shared-normalized-input');
    const inputFirstBatch = 'S33-W2-DUPLICATE-INPUT-01';
    const inputSecondBatch = 'S33-W2-DUPLICATE-INPUT-02';
    const inputFirst = buildAcceptance({
      batchId: inputFirstBatch,
      pullRequestNumber: 1608,
      baseRegistryDigestSha256: root,
      resultingRegistryDigestSha256: middle,
      acceptedEntries: [acceptedEntryInput('GD-INPUT-01', inputFirstBatch, 1, {
        normalizedInputSha256: sharedInput,
      })],
    });
    const inputSecond = buildAcceptance({
      batchId: inputSecondBatch,
      pullRequestNumber: 1609,
      baseRegistryDigestSha256: middle,
      resultingRegistryDigestSha256: digest('duplicate-input-head'),
      acceptedEntries: [acceptedEntryInput('GD-INPUT-02', inputSecondBatch, 1, {
        normalizedInputSha256: sharedInput,
      })],
    });
    expect(() => auditWithTestRoot([inputFirst, inputSecond]))
      .toThrow(/duplicate accepted normalized-input fingerprint/iu);
  });

  it('rejects registry-chain forks, disconnected roots, and cycles', () => {
    const root = WAVE1_BASE_REGISTRY_DIGEST;
    const forkOne = buildAcceptance({
      batchId: 'S33-W2-FORK-01',
      pullRequestNumber: 1610,
      baseRegistryDigestSha256: root,
      resultingRegistryDigestSha256: digest('fork-one'),
    });
    const forkTwo = buildAcceptance({
      batchId: 'S33-W2-FORK-02',
      pullRequestNumber: 1611,
      baseRegistryDigestSha256: root,
      resultingRegistryDigestSha256: digest('fork-two'),
    });
    expect(() => auditWithTestRoot([forkOne, forkTwo])).toThrow(/chain forks/iu);

    const disconnected = buildAcceptance({
      batchId: 'S33-W2-DISCONNECTED',
      pullRequestNumber: 1612,
      baseRegistryDigestSha256: digest('other-root'),
      resultingRegistryDigestSha256: digest('other-head'),
    });
    expect(() => auditWithTestRoot([forkOne, disconnected])).toThrow(/exactly one root/iu);

    const cycleA = digest('cycle-a');
    const cycleB = digest('cycle-b');
    const cycleOne = buildAcceptance({
      batchId: 'S33-W2-CYCLE-01',
      pullRequestNumber: 1613,
      baseRegistryDigestSha256: cycleA,
      resultingRegistryDigestSha256: cycleB,
    });
    const cycleTwo = buildAcceptance({
      batchId: 'S33-W2-CYCLE-02',
      pullRequestNumber: 1614,
      baseRegistryDigestSha256: cycleB,
      resultingRegistryDigestSha256: cycleA,
    });
    expect(() => auditWithTestRoot([cycleOne, cycleTwo])).toThrow(/exactly one root/iu);
  });

  it('rejects unknown registry types and signed taxonomy mismatches', () => {
    const unknownBatch = 'S33-W2-UNKNOWN-TYPE';
    const unknown = buildAcceptance({
      batchId: unknownBatch,
      acceptedEntries: [acceptedEntryInput('GD-UNKNOWN', unknownBatch, 1, {
        registryTypeId: 'legal-99-unknown',
      })],
    });
    expect(() => auditWithTestRoot([unknown])).toThrow(/unknown registry type/iu);

    const mismatchBatch = 'S33-W2-MAPPING-MISMATCH';
    const mismatch = buildAcceptance({
      batchId: mismatchBatch,
      acceptedEntries: [acceptedEntryInput('GD-MISMATCH', mismatchBatch, 1, {
        subType: 'court_order',
      })],
    });
    expect(() => auditWithTestRoot([mismatch]))
      .toThrow(/does not match.+ratified taxonomy mapping/iu);
  });

  it('produces a deterministic canonical report digest', () => {
    const envelope = buildAcceptance({ batchId: 'S33-W2-DETERMINISTIC' });
    const reportA = auditWithTestRoot([envelope]);
    const reportB = auditWithTestRoot([envelope]);

    expect(s33Wave2CoverageReportSha256(reportA)).toMatch(/^[a-f0-9]{64}$/u);
    expect(s33Wave2CoverageReportSha256(reportA)).toBe(s33Wave2CoverageReportSha256(reportB));
  });
});
