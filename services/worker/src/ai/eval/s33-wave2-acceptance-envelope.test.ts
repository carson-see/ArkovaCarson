import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAndSignS33Wave2AcceptanceForTest,
  computeS33Wave2AcceptedEntryOrderSha256,
  verifyS33Wave2AuthenticatedBatchAcceptance,
  type S33Wave2AcceptanceBindings,
  type S33Wave2AcceptancePayloadInput,
  type S33Wave2AcceptanceTrustRoot,
  type S33Wave2AuthenticatedBatchAcceptance,
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
const originalNodeEnv = {
  present: Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV'),
  value: process.env.NODE_ENV,
};

function fingerprint(publicKeySpkiPem: string): string {
  const key = createPublicKey(publicKeySpkiPem);
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function input(): S33Wave2AcceptancePayloadInput {
  return {
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1601,
    candidateBaseSha: SHA1_C,
    candidateHeadSha: SHA1_A,
    candidateTreeSha: SHA1_B,
    batchId: 'S33-W2-CREDENTIALS-01',
    revision: 1,
    manifestPath: 'docs/lane4/s33-wave2-batches/credentials-01/manifest.json',
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
          login: 'carson-see',
          databaseId: 456,
          nodeId: 'MDQ6VXNlcjQ1Ng==',
        },
      },
    },
    proof: {
      machineValidationArtifactSha256: SHA256_B,
      machineValidationFailureCount: 0,
      humanCrossReviewArtifactSha256: SHA256_C,
      humanCrossReviewSampleSize: 2,
      materialLabelDefectCount: 0,
      prodModelDiffArtifactSha256: SHA256_D,
      exactLeakageArtifactSha256: SHA256_E,
      exactLeakageHitCount: 0,
    },
    acceptedEntries: [
      {
        id: 'GD-S33-W2-001',
        registryTypeId: 'w2-professional-license-accountant',
        batchId: 'S33-W2-CREDENTIALS-01',
        revision: 1,
        credentialType: 'PROFESSIONAL_LICENSE',
        subType: 'accountant-license',
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
      {
        id: 'GD-S33-W2-002',
        registryTypeId: 'w2-professional-license-accountant',
        batchId: 'S33-W2-CREDENTIALS-01',
        revision: 1,
        credentialType: 'PROFESSIONAL_LICENSE',
        subType: 'accountant-license',
        normalizedInputSha256: SHA256_B,
        groundTruthSha256: SHA256_D,
        authorshipMethod: 'real-source',
        generatorDerived: false,
        trainingExposed: false,
        intendedSplit: 'held-out',
        productionValidSubstantiveFieldCount: 5,
        edgeCase: false,
        sourceBlobSha: SHA1_D,
      },
    ],
  };
}

function bindings(value = input()): S33Wave2AcceptanceBindings {
  return {
    repositoryIdentity: value.repositoryIdentity,
    pullRequestNumber: value.pullRequestNumber,
    candidateBaseSha: value.candidateBaseSha,
    candidateHeadSha: value.candidateHeadSha,
    candidateTreeSha: value.candidateTreeSha,
    batchId: value.batchId,
    revision: value.revision,
    manifestPath: value.manifestPath,
    manifestRawSha256: value.manifestRawSha256,
    manifestCanonicalSha256: value.manifestCanonicalSha256,
    sourceBlobSha: value.sourceBlobSha,
    datasheetBlobSha: value.datasheetBlobSha,
    preflightArtifactDigestSha256: value.preflightArtifactDigestSha256,
    baseRegistryDigestSha256: value.baseRegistryDigestSha256,
    resultingRegistryDigestSha256: value.resultingRegistryDigestSha256,
    coverageRegistryPath: value.coverageRegistryPath,
    coverageRegistryRawSha256: value.coverageRegistryRawSha256,
    coverageRegistryCanonicalSha256: value.coverageRegistryCanonicalSha256,
    acceptedEntryOrderSha256: computeS33Wave2AcceptedEntryOrderSha256(
      value.acceptedEntries.map(({ id }) => id),
    ),
  };
}

describe('S3.3 Wave-2 authenticated whole-batch acceptance', () => {
  let privateKeyPkcs8Pem: string;
  let trustRoot: S33Wave2AcceptanceTrustRoot;

  afterEach(() => {
    if (originalNodeEnv.present) {
      process.env.NODE_ENV = originalNodeEnv.value;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  afterAll(() => {
    expect(Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV')).toBe(
      originalNodeEnv.present,
    );
    expect(process.env.NODE_ENV).toBe(originalNodeEnv.value);
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    const keys = generateKeyPairSync('ed25519');
    privateKeyPkcs8Pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeySpkiPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    trustRoot = {
      signerIdentity: 'arkova-s33-wave2-cto-release',
      signingKeyId: 'arkova-s33-wave2-cto-release',
      publicKeySpkiPem,
      publicKeyFingerprintSha256: fingerprint(publicKeySpkiPem),
    };
  });

  function signed(value = input()): S33Wave2AuthenticatedBatchAcceptance {
    return buildAndSignS33Wave2AcceptanceForTest(value, privateKeyPkcs8Pem, trustRoot);
  }

  function verify(
    artifact: unknown = signed(),
    expected: S33Wave2AcceptanceBindings = bindings(),
  ): S33Wave2AuthenticatedBatchAcceptance {
    return verifyS33Wave2AuthenticatedBatchAcceptance(artifact, expected, {
      testOnlyTrustRoot: trustRoot,
    });
  }

  it('verifies the dedicated CTO identity and every exact candidate/registry/policy binding', () => {
    const artifact = verify();
    expect(artifact.payload.acceptedEntryCount).toBe(2);
    expect(artifact.payload.acceptedEntries).toHaveLength(2);
    expect(artifact.payload.coverageRegistryPath).toBe('docs/lane4/s33-wave2-top15-registry.json');
    expect(artifact.payload.acceptedEntries[0].entryCanonicalSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact.payload.acceptedEntryOrderSha256).toBe(bindings().acceptedEntryOrderSha256);
  });

  it('fails closed while the production SPKI/fingerprint has not been committed', () => {
    expect(() => verifyS33Wave2AuthenticatedBatchAcceptance(signed(), bindings())).toThrow(/trust root.*not configured/i);
  });

  it.each([
    ['candidateHeadSha', SHA1_C],
    ['candidateTreeSha', SHA1_C],
    ['candidateBaseSha', SHA1_A],
    ['sourceBlobSha', SHA1_A],
    ['datasheetBlobSha', SHA1_A],
    ['manifestRawSha256', SHA256_F],
    ['manifestCanonicalSha256', SHA256_F],
    ['preflightArtifactDigestSha256', SHA256_F],
    ['baseRegistryDigestSha256', SHA256_F],
    ['resultingRegistryDigestSha256', SHA256_F],
    ['coverageRegistryRawSha256', SHA256_B],
    ['coverageRegistryCanonicalSha256', SHA256_B],
    ['acceptedEntryOrderSha256', SHA256_F],
  ] as const)('rejects a mismatched %s binding', (key, value) => {
    expect(() => verify(signed(), { ...bindings(), [key]: value })).toThrow(/binding/i);
  });

  it('rejects payload tampering, envelope digest tampering, and a wrong signing key', () => {
    const artifact = signed();
    const payloadTamper = structuredClone(artifact);
    payloadTamper.payload.acceptedEntries[0].edgeCase = false;
    expect(() => verify(payloadTamper)).toThrow(/digest|signature/i);
    expect(() => verify({ ...artifact, artifactDigestSha256: SHA256_F })).toThrow(/artifact.*digest/i);

    const attacker = generateKeyPairSync('ed25519');
    const attackerTrustRoot: S33Wave2AcceptanceTrustRoot = {
      ...trustRoot,
      publicKeySpkiPem: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publicKeyFingerprintSha256: fingerprint(attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    };
    expect(() => verifyS33Wave2AuthenticatedBatchAcceptance(artifact, bindings(), {
      testOnlyTrustRoot: attackerTrustRoot,
    })).toThrow(/fingerprint|signature/i);
  });

  it('rejects duplicate ids/fingerprints, partial counts, and per-entry digest substitution', () => {
    const value = input();
    const duplicate = structuredClone(value);
    duplicate.acceptedEntries[1].id = duplicate.acceptedEntries[0].id;
    expect(() => signed(duplicate)).toThrow(/duplicate.*id/i);

    const duplicateInput = input();
    duplicateInput.acceptedEntries[1].normalizedInputSha256 = duplicateInput.acceptedEntries[0].normalizedInputSha256;
    expect(() => signed(duplicateInput)).toThrow(/duplicate normalized/i);

    const artifact = signed();
    const partial = structuredClone(artifact);
    partial.payload.acceptedEntryCount = 1;
    expect(() => verify(partial)).toThrow(/count|digest/i);

    const entryTamper = structuredClone(artifact);
    entryTamper.payload.acceptedEntries[0].entryCanonicalSha256 = SHA256_F;
    expect(() => verify(entryTamper)).toThrow(/entry.*digest|payload.*digest/i);
  });

  it('rejects a transport from another PR and an acceptance signed before submission', () => {
    const wrongPr = input();
    wrongPr.reviewer.evidence.url = 'https://github.com/carson-see/ArkovaCarson/pull/1602#issuecomment-123';
    expect(() => signed(wrongPr)).toThrow(/transport URL/i);

    const early = input();
    early.signedAtUtc = '2026-07-15T13:00:00.000Z';
    expect(() => signed(early)).toThrow(/signed before/i);
  });

  it('rejects an entry source blob differing from the signed payload source blob', () => {
    const value = input();
    value.acceptedEntries[0].sourceBlobSha = SHA1_A;
    expect(() => signed(value)).toThrow(/sourceBlobSha.*signed source blob/i);
  });

  it('rejects unknown envelope, payload, and entry keys', () => {
    const artifact = signed();
    expect(() => verify({ ...artifact, unexpected: true })).toThrow(/envelope keys must be exactly/i);

    const payload = structuredClone(artifact) as S33Wave2AuthenticatedBatchAcceptance & {
      payload: S33Wave2AuthenticatedBatchAcceptance['payload'] & { unexpected?: boolean };
    };
    payload.payload.unexpected = true;
    expect(() => verify(payload)).toThrow(/payload keys must be exactly/i);

    const entry = structuredClone(artifact) as S33Wave2AuthenticatedBatchAcceptance & {
      payload: S33Wave2AuthenticatedBatchAcceptance['payload'] & {
        acceptedEntries: Array<S33Wave2AuthenticatedBatchAcceptance['payload']['acceptedEntries'][number] & {
          unexpected?: boolean;
        }>;
      };
    };
    entry.payload.acceptedEntries[0].unexpected = true;
    expect(() => verify(entry)).toThrow(/acceptedEntries\[0\] keys must be exactly/i);
  });

  it.each(['generated', 'independent', 'synthetic'])(
    'rejects the unauthorized authorship label %s',
    (authorshipMethod) => {
      const value = input();
      value.acceptedEntries[0].authorshipMethod = authorshipMethod as 'independently-authored';
      expect(() => signed(value)).toThrow(/authorship/i);
    },
  );

  it('rejects generator/training exposure, shallow ground truth, and wrong batch binding', () => {
    for (const mutate of [
      (value: S33Wave2AcceptancePayloadInput) => { value.acceptedEntries[0].generatorDerived = true as false; },
      (value: S33Wave2AcceptancePayloadInput) => { value.acceptedEntries[0].trainingExposed = true as false; },
      (value: S33Wave2AcceptancePayloadInput) => { value.acceptedEntries[0].productionValidSubstantiveFieldCount = 4; },
      (value: S33Wave2AcceptancePayloadInput) => { value.acceptedEntries[0].batchId = 'S33-W2-WRONG'; },
    ]) {
      const value = input();
      mutate(value);
      expect(() => signed(value)).toThrow();
    }
  });

  it('accepts either GitHub transport without treating the login as authority', () => {
    const formal = input();
    formal.reviewer = {
      lane: 'Lane 3',
      transport: 'github-formal-review',
      evidence: {
        id: 456,
        nodeId: null,
        url: 'https://github.com/carson-see/ArkovaCarson/pull/1601#pullrequestreview-456',
        submittedAtUtc: '2026-07-15T13:59:59.000Z',
        actor: {
          login: 'same-login-as-producer-is-allowed',
          databaseId: 456,
          nodeId: 'MDQ6VXNlcjQ1Ng==',
        },
      },
    };
    expect(verify(signed(formal), bindings(formal)).payload.reviewer.transport).toBe('github-formal-review');
  });

  it('rejects unverifiable proof outcomes even when signed', () => {
    for (const mutate of [
      (value: S33Wave2AcceptancePayloadInput) => { value.proof.machineValidationFailureCount = 1 as 0; },
      (value: S33Wave2AcceptancePayloadInput) => { value.proof.materialLabelDefectCount = 1 as 0; },
      (value: S33Wave2AcceptancePayloadInput) => { value.proof.exactLeakageHitCount = 1 as 0; },
      (value: S33Wave2AcceptancePayloadInput) => { value.proof.humanCrossReviewSampleSize = 0; },
    ]) {
      const value = input();
      mutate(value);
      expect(() => signed(value)).toThrow(/proof|sample|failure|defect|leakage/i);
    }
  });

  it('rejects test-key injection outside the test environment', () => {
    const artifact = signed();
    process.env.NODE_ENV = 'production';
    expect(() => verifyS33Wave2AuthenticatedBatchAcceptance(artifact, bindings(), {
      testOnlyTrustRoot: trustRoot,
    })).toThrow(/test-only/i);
  });
});
