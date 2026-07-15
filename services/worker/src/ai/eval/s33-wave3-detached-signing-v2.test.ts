import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  S33_DETACHED_SIGNING_V2_CONSTANTS,
  assembleS33DetachedAcceptanceEnvelopeV2,
  createS33DetachedSigningTestHarnessV2,
  emitS33DetachedSigningRequestV2,
  transitionS33DetachedSigningTrustPolicyV2,
  validateS33DetachedSigningTrustPolicyV2,
  verifyS33DetachedAcceptanceEnvelopeV2,
  type S33DetachedAcceptanceEnvelopeV2,
  type S33DetachedSigningTestHarnessV2,
  type S33DetachedSigningTrustPolicyV2,
} from './s33-wave3-detached-signing-v2.js';
import {
  computeS33Wave2AcceptedEntryOrderSha256,
  type S33Wave2AcceptanceBindings,
  type S33Wave2AcceptancePayloadInput,
} from './s33-wave2-acceptance-envelope.js';

const SHA1_A = 'a'.repeat(40);
const SHA1_B = 'b'.repeat(40);
const SHA1_C = 'c'.repeat(40);
const SHA1_D = 'd'.repeat(40);
const SHA1_E = 'e'.repeat(40);
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const SHA256_C = 'c'.repeat(64);
const SHA256_D = 'd'.repeat(64);
const SHA256_E = 'e'.repeat(64);
const SHA256_F = 'f'.repeat(64);

function payloadInput(): S33Wave2AcceptancePayloadInput {
  return {
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1701,
    candidateBaseSha: SHA1_C,
    candidateHeadSha: SHA1_A,
    candidateTreeSha: SHA1_B,
    batchId: 'S33-W2-TOP15-01-05',
    revision: 1,
    manifestPath: 'docs/lane4/s33-wave2-batches/top15-01-05/manifest.json',
    manifestRawSha256: SHA256_A,
    manifestCanonicalSha256: SHA256_B,
    sourceBlobSha: SHA1_D,
    datasheetBlobSha: SHA1_E,
    preflightArtifactDigestSha256: SHA256_C,
    baseRegistryDigestSha256: SHA256_D,
    resultingRegistryDigestSha256: SHA256_E,
    coverageRegistryPath: 'docs/lane4/s33-wave2-top15-registry.json',
    coverageRegistryRawSha256: SHA256_F,
    coverageRegistryCanonicalSha256: SHA256_A,
    signedAtUtc: '2026-07-15T18:00:00.000Z',
    reviewer: {
      lane: 'Lane 3',
      transport: 'github-issue-comment',
      evidence: {
        id: 456,
        nodeId: 'IC_kwDOExample456',
        url: 'https://github.com/carson-see/ArkovaCarson/pull/1701#issuecomment-456',
        submittedAtUtc: '2026-07-15T17:59:00.000Z',
        actor: { login: 'lane3-reviewer', databaseId: 456, nodeId: 'U_lane3' },
      },
    },
    proof: {
      machineValidationArtifactSha256: SHA256_B,
      machineValidationFailureCount: 0,
      humanCrossReviewArtifactSha256: SHA256_C,
      humanCrossReviewSampleSize: 1,
      materialLabelDefectCount: 0,
      prodModelDiffArtifactSha256: SHA256_D,
      exactLeakageArtifactSha256: SHA256_E,
      exactLeakageHitCount: 0,
    },
    acceptedEntries: [
      {
        id: 'GD-S33-W2-001',
        registryTypeId: 'w2-legal-01',
        batchId: 'S33-W2-TOP15-01-05',
        revision: 1,
        credentialType: 'LEGAL',
        subType: 'court-order',
        normalizedInputSha256: SHA256_A,
        groundTruthSha256: SHA256_C,
        authorshipMethod: 'independently-authored',
        generatorDerived: false,
        trainingExposed: false,
        intendedSplit: 'held-out',
        productionValidSubstantiveFieldCount: 6,
        edgeCase: true,
        sourceBlobSha: SHA1_D,
      },
    ],
  };
}

function bindings(input = payloadInput()): S33Wave2AcceptanceBindings {
  return {
    repositoryIdentity: input.repositoryIdentity,
    pullRequestNumber: input.pullRequestNumber,
    candidateBaseSha: input.candidateBaseSha,
    candidateHeadSha: input.candidateHeadSha,
    candidateTreeSha: input.candidateTreeSha,
    batchId: input.batchId,
    revision: input.revision,
    manifestPath: input.manifestPath,
    manifestRawSha256: input.manifestRawSha256,
    manifestCanonicalSha256: input.manifestCanonicalSha256,
    sourceBlobSha: input.sourceBlobSha,
    datasheetBlobSha: input.datasheetBlobSha,
    preflightArtifactDigestSha256: input.preflightArtifactDigestSha256,
    baseRegistryDigestSha256: input.baseRegistryDigestSha256,
    resultingRegistryDigestSha256: input.resultingRegistryDigestSha256,
    coverageRegistryPath: input.coverageRegistryPath,
    coverageRegistryRawSha256: input.coverageRegistryRawSha256,
    coverageRegistryCanonicalSha256: input.coverageRegistryCanonicalSha256,
    acceptedEntryOrderSha256: computeS33Wave2AcceptedEntryOrderSha256(
      input.acceptedEntries.map(({ id }) => id),
    ),
  };
}

function publicFingerprint(publicKeySpkiPem: string): string {
  return createHash('sha256')
    .update(createPublicKey(publicKeySpkiPem).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

describe('S3.3 Wave-3 detached signing v2', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let privateKey: KeyObject;
  let activePolicy: S33DetachedSigningTrustPolicyV2;
  let testHarness: S33DetachedSigningTestHarnessV2;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const publicKeySpkiPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    activePolicy = validateS33DetachedSigningTrustPolicyV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      state: 'ACTIVE',
      publicKeySpkiPem,
      publicKeyFingerprintSha256: publicFingerprint(publicKeySpkiPem),
      authorizedOperator: 'cto-release-operator',
      fingerprintConfirmation: {
        method: 'cto-out-of-band',
        confirmedBy: 'cto',
        confirmedAtUtc: '2026-07-15T16:59:00.000Z',
      },
      activatedAtUtc: '2026-07-15T17:00:00.000Z',
    });
    testHarness = createS33DetachedSigningTestHarnessV2(activePolicy);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  function signedEnvelope(): S33DetachedAcceptanceEnvelopeV2 {
    const request = emitS33DetachedSigningRequestV2(payloadInput());
    const signature = sign(
      null,
      Buffer.from(request.signingBytesBase64Url, 'base64url'),
      privateKey,
    ).toString('base64url');
    return testHarness.assemble(request, signature);
  }

  it('keeps production unconfigured with no fabricated public material', () => {
    expect(S33_DETACHED_SIGNING_TRUST_POLICY_V2).toMatchObject({
      state: 'UNCONFIGURED',
      publicKeySpkiPem: null,
      publicKeyFingerprintSha256: null,
      authorizedOperator: null,
      fingerprintConfirmation: null,
      activatedAtUtc: null,
    });
    expect(Object.isFrozen(S33_DETACHED_SIGNING_TRUST_POLICY_V2)).toBe(true);
  });

  it('emits deterministic canonical domain-separated bytes without private material', () => {
    const first = emitS33DetachedSigningRequestV2(payloadInput());
    const second = emitS33DetachedSigningRequestV2(payloadInput());
    expect(first).toEqual(second);
    expect(Buffer.from(first.signingBytesBase64Url, 'base64url').toString('utf8')).toBe(
      `${S33_DETACHED_SIGNING_V2_CONSTANTS.domainSeparator}${first.payloadCanonicalJson}`,
    );
    expect(first).not.toHaveProperty('privateKey');
    expect(first.requestDigestSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('requires the deterministic whole-batch human-review floor of 10 percent', () => {
    const input = payloadInput();
    input.acceptedEntries = Array.from({ length: 180 }, (_, index) => ({
      ...input.acceptedEntries[0],
      id: `GD-S33-W2-${String(index + 1).padStart(3, '0')}`,
      normalizedInputSha256: createHash('sha256').update(`input-${index}`).digest('hex'),
      groundTruthSha256: createHash('sha256').update(`truth-${index}`).digest('hex'),
    }));
    input.proof.humanCrossReviewSampleSize = 17;
    expect(() => emitS33DetachedSigningRequestV2(input)).toThrow(/18-180 rows/i);
    input.proof.humanCrossReviewSampleSize = 18;
    expect(emitS33DetachedSigningRequestV2(input).payload.acceptedEntryCount).toBe(180);
  });

  it('assembles from only a detached signature and verifies every caller binding', () => {
    const envelope = signedEnvelope();
    expect(testHarness.verify(envelope, bindings())).toEqual(envelope);
  });

  it('fails closed under the production UNCONFIGURED policy', () => {
    const request = emitS33DetachedSigningRequestV2(payloadInput());
    const signature = sign(null, Buffer.from(request.signingBytesBase64Url, 'base64url'), privateKey)
      .toString('base64url');
    expect(() => assembleS33DetachedAcceptanceEnvelopeV2(request, signature)).toThrow(/UNCONFIGURED/i);
    expect(() => verifyS33DetachedAcceptanceEnvelopeV2(signedEnvelope(), bindings())).toThrow(/UNCONFIGURED/i);
  });

  it('rejects tampering, a wrong signature, and stale caller bindings', () => {
    const envelope = signedEnvelope();
    const tampered = structuredClone(envelope);
    tampered.request.payload.candidateHeadSha = SHA1_B;
    expect(() => testHarness.verify(tampered, bindings())).toThrow();

    const request = emitS33DetachedSigningRequestV2(payloadInput());
    expect(() => testHarness.assemble(request, 'A'.repeat(86))).toThrow(/signature/i);

    expect(() => testHarness.verify(envelope, {
      ...bindings(), candidateTreeSha: SHA1_C,
    })).toThrow(/binding mismatch.*candidateTreeSha/i);
  });

  it('enforces activation, retirement, and revocation transitions', () => {
    expect(transitionS33DetachedSigningTrustPolicyV2(
      S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      activePolicy,
    ).state).toBe('ACTIVE');
    const retired = transitionS33DetachedSigningTrustPolicyV2(activePolicy, {
      ...activePolicy,
      state: 'RETIRED',
      retiredAtUtc: '2026-07-16T00:00:00.000Z',
    });
    expect(retired.state).toBe('RETIRED');
    expect(() => transitionS33DetachedSigningTrustPolicyV2(retired, activePolicy)).toThrow(/transition/i);
    const revoked = transitionS33DetachedSigningTrustPolicyV2(activePolicy, {
      ...activePolicy,
      state: 'REVOKED',
      revokedAtUtc: '2026-07-15T20:00:00.000Z',
      revocationReason: 'CTO-declared compromise response',
    });
    expect(() => createS33DetachedSigningTestHarnessV2(revoked)).toThrow(/REVOKED/i);
  });

  it('requires and freezes CTO out-of-band fingerprint confirmation before activation', () => {
    expect(() => validateS33DetachedSigningTrustPolicyV2({
      ...activePolicy,
      fingerprintConfirmation: null,
    })).toThrow(/confirmation/i);
    expect(() => validateS33DetachedSigningTrustPolicyV2({
      ...activePolicy,
      fingerprintConfirmation: {
        ...activePolicy.fingerprintConfirmation!,
        confirmedAtUtc: '2026-07-15T17:00:00.001Z',
      },
    })).toThrow(/confirmed before policy activation/i);
    expect(() => transitionS33DetachedSigningTrustPolicyV2(activePolicy, {
      ...activePolicy,
      state: 'RETIRED',
      fingerprintConfirmation: {
        ...activePolicy.fingerprintConfirmation!,
        confirmedBy: 'different-confirmer',
      },
      retiredAtUtc: '2026-07-16T00:00:00.000Z',
    })).toThrow(/changed fingerprintConfirmation/i);
    expect(Object.isFrozen(activePolicy.fingerprintConfirmation)).toBe(true);
  });

  it('disables test-policy injection outside NODE_ENV=test', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createS33DetachedSigningTestHarnessV2(activePolicy)).toThrow(/test-only/i);
  });

  it('contains no production private-key or environment trust-root path', () => {
    const source = readFileSync(resolve(__dirname, 's33-wave3-detached-signing-v2.ts'), 'utf8');
    expect(source).not.toMatch(/createPrivateKey|privateKeyPkcs8|process\.env\.(?!NODE_ENV)/u);
    expect(source).not.toMatch(/\bsign\s*\(/u);
  });

  it('publishes exactly the CTO-recommended 16 offline gates', () => {
    const registry = JSON.parse(readFileSync(
      resolve(__dirname, '../../../../../docs/lane3/s33-wave3-v71-offline-gates.json'),
      'utf8',
    )) as {
      schemaVersion: string;
      allMustPass: boolean;
      pairedBootstrap: object;
      gates: Array<{ id: string; [key: string]: unknown }>;
    };
    expect(registry.schemaVersion).toBe('arkova.s33.v71.offline-gates/v1');
    expect(registry.allMustPass).toBe(true);
    expect(registry.gates).toHaveLength(16);
    expect(new Set(registry.gates.map(({ id }) => id)).size).toBe(16);
    expect(registry.gates.map(({ id }) => id)).toEqual([
      'G01_CORPUS_INTEGRITY', 'G02_SURGERY_CONFIG', 'G03_JSON_PARSE',
      'G04_MACRO_F1', 'G05_WEIGHTED_F1', 'G06_ALL_TYPE_FLOOR',
      'G07_CRITICAL_TYPE_FLOORS', 'G08_TYPE_REGRESSION', 'G09_LEGAL_UPLIFT',
      'G10_FINANCIAL_UPLIFT', 'G11_EDUCATION_UPLIFT', 'G12_SUBTYPE_EMISSION',
      'G13_DESCRIPTION_EMISSION', 'G14_EFFICIENCY', 'G15_CALIBRATION_GAP',
      'G16_CALIBRATION_ECE',
    ]);
    expect(registry.pairedBootstrap).toEqual({
      replicates: 2000,
      seedPolicy: 'sha256-frozen-corpus-and-arm-manifests',
      confidenceLevel: 0.95,
      domainsPooled: false,
    });
    const gates = Object.fromEntries(registry.gates.map((gate) => [gate.id, gate]));
    expect(gates.G02_SURGERY_CONFIG).toMatchObject({
      assertions: {
        droppedTrainingIds: {
          op: 'set_eq',
          value: Array.from({ length: 15 }, (_, index) => `GD-${3030 + index}`),
        },
        goodStandingStatusTrainingType: { op: 'eq', value: 'string' },
        concreteSubtypeRate: { op: 'eq', value: 1 },
        fraudStream: { op: 'eq', value: 'split' },
        exportLastCheckpointOnly: { op: 'eq', value: true },
      },
    });
    expect(gates.G07_CRITICAL_TYPE_FLOORS).toMatchObject({
      value: {
        RESUME: 0.75,
        FINANCIAL: 0.8,
        LEGAL: 0.8,
        MEDICAL: 0.8,
        CHARITY: 0.8,
        BUSINESS_ENTITY: 0.75,
      },
    });
    for (const id of ['G09_LEGAL_UPLIFT', 'G10_FINANCIAL_UPLIFT', 'G11_EDUCATION_UPLIFT']) {
      expect(gates[id]).toMatchObject({
        assertions: {
          meanPairedDelta: { op: 'gte', value: 0.05 },
          ci95Lower: { op: 'gt', value: 0 },
          bootstrapReplicates: { op: 'gte', value: 2000 },
        },
      });
    }
    expect(gates.G14_EFFICIENCY).toMatchObject({
      assertions: {
        meanLatencyDeltaVsV6Ms: { op: 'lte', value: 0 },
        p50LatencyMs: { op: 'lte', value: 3500 },
        p95LatencyMs: { op: 'lte', value: 5500 },
        meanTokensDeltaVsV6: { op: 'lte', value: 0 },
      },
    });
    expect(gates.G15_CALIBRATION_GAP).toMatchObject({ op: 'lte', value: 0.05 });
    expect(gates.G16_CALIBRATION_ECE).toMatchObject({ op: 'lte', value: 0.1 });
  });
});
