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
  S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
  S33_DETACHED_SIGNING_V2_CONSTANTS,
  assembleS33DetachedAcceptanceEnvelopeV2,
  auditS33DetachedAcceptanceEnvelopeV2,
  createS33DetachedSigningTestHarnessV2,
  emitS33DetachedSigningRequestV2,
  regenerateS33DetachedSigningRequestForActiveKeyV2,
  transitionS33DetachedSigningTrustPolicySetV2,
  transitionS33DetachedSigningTrustPolicyV2,
  validateS33DetachedSigningTrustPolicySetV2,
  validateS33DetachedSigningTrustPolicyV2,
  verifyS33DetachedAcceptanceEnvelopeV2,
  type S33DetachedAcceptanceEnvelopeV2,
  type S33DetachedSigningTestHarnessV2,
  type S33DetachedSigningTrustPolicySetV2,
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
  let activePolicySet: S33DetachedSigningTrustPolicySetV2;
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
    activePolicySet = validateS33DetachedSigningTrustPolicySetV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
      activeSigningKeyId: activePolicy.signingKeyId,
      keys: [activePolicy],
    });
    testHarness = createS33DetachedSigningTestHarnessV2(activePolicySet);
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

  function signRequest(request: { signingBytesBase64Url: string }, key: KeyObject): string {
    return sign(null, Buffer.from(request.signingBytesBase64Url, 'base64url'), key)
      .toString('base64url');
  }

  function activePolicyForKey(
    signingKeyId: string,
    activatedAtUtc = '2026-07-15T17:00:00.000Z',
  ): S33DetachedSigningTrustPolicyV2 {
    return validateS33DetachedSigningTrustPolicyV2({
      ...activePolicy,
      signingKeyId,
      activatedAtUtc,
    });
  }

  function activePolicySetForKey(
    signingKeyId: string,
  ): S33DetachedSigningTrustPolicySetV2 {
    const policy = activePolicyForKey(signingKeyId);
    return validateS33DetachedSigningTrustPolicySetV2({
      ...activePolicySet,
      activeSigningKeyId: signingKeyId,
      keys: [policy],
    });
  }

  function hardCutover(
    current: S33DetachedSigningTrustPolicySetV2,
    nextSigningKeyId: string,
  ): S33DetachedSigningTrustPolicySetV2 {
    const cutoverAtUtc = '2026-07-15T19:00:00.000Z';
    const currentActive = current.keys.find(
      ({ signingKeyId }) => signingKeyId === current.activeSigningKeyId,
    )!;
    const nextActive = activePolicyForKey(nextSigningKeyId, cutoverAtUtc);
    const keys = [{
      ...currentActive,
      state: 'RETIRED' as const,
      retiredAtUtc: cutoverAtUtc,
    }, nextActive].sort((left, right) => left.signingKeyId.localeCompare(right.signingKeyId));
    return transitionS33DetachedSigningTrustPolicySetV2(current, {
      ...current,
      activeSigningKeyId: nextSigningKeyId,
      keys,
    });
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
    expect(S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2).toMatchObject({
      activeSigningKeyId: null,
      keys: [S33_DETACHED_SIGNING_TRUST_POLICY_V2],
    });
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
    expect(() => auditS33DetachedAcceptanceEnvelopeV2(signedEnvelope(), bindings(), {
      evidenceState: 'MERGED',
      mergedAtUtc: '2026-07-15T18:30:00.000Z',
      auditedAtUtc: '2026-07-15T18:31:00.000Z',
    })).toThrow(/configured public root/i);
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
    expect(transitionS33DetachedSigningTrustPolicySetV2(
      S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
      activePolicySet,
    ).activeSigningKeyId).toBe(activePolicy.signingKeyId);
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
    const revokedSet = transitionS33DetachedSigningTrustPolicySetV2(activePolicySet, {
      ...activePolicySet,
      activeSigningKeyId: null,
      keys: [revoked],
    });
    expect(() => createS33DetachedSigningTestHarnessV2(revokedSet)
      .assemble(emitS33DetachedSigningRequestV2(payloadInput()), 'A'.repeat(86))).toThrow(/ACTIVE/i);
  });

  it('performs a real A-to-B hard cutover and regenerates in-flight requests', () => {
    const pairB = generateKeyPairSync('ed25519');
    const publicKeySpkiPemB = pairB.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signingKeyIdB = 'arkova-s33-cto-release-2026q3-02';
    const cutoverAtUtc = '2026-07-15T19:00:00.000Z';
    const policyB = validateS33DetachedSigningTrustPolicyV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      signingKeyId: signingKeyIdB,
      state: 'ACTIVE',
      publicKeySpkiPem: publicKeySpkiPemB,
      publicKeyFingerprintSha256: publicFingerprint(publicKeySpkiPemB),
      authorizedOperator: 'cto-release-operator-b',
      fingerprintConfirmation: {
        method: 'cto-out-of-band',
        confirmedBy: 'cto',
        confirmedAtUtc: '2026-07-15T18:59:00.000Z',
      },
      activatedAtUtc: cutoverAtUtc,
    });
    const rotated = transitionS33DetachedSigningTrustPolicySetV2(activePolicySet, {
      ...activePolicySet,
      activeSigningKeyId: signingKeyIdB,
      keys: [{
        ...activePolicy,
        state: 'RETIRED',
        retiredAtUtc: cutoverAtUtc,
      }, policyB],
    });
    expect(rotated.activeSigningKeyId).toBe(signingKeyIdB);
    expect(rotated.keys.map(({ signingKeyId, state }) => ({ signingKeyId, state }))).toEqual([
      { signingKeyId: S33_DETACHED_SIGNING_V2_CONSTANTS.initialSigningKeyId, state: 'RETIRED' },
      { signingKeyId: signingKeyIdB, state: 'ACTIVE' },
    ]);

    const requestA = emitS33DetachedSigningRequestV2(payloadInput());
    const signatureA = signRequest(requestA, privateKey);
    const rotatedHarness = createS33DetachedSigningTestHarnessV2(rotated);
    expect(() => rotatedHarness.assemble(requestA, signatureA)).toThrow(/active.*key/i);

    const requestB = regenerateS33DetachedSigningRequestForActiveKeyV2(
      requestA,
      cutoverAtUtc,
      rotated,
    );
    expect(requestB.signingKeyId).toBe(signingKeyIdB);
    expect(requestB.payload.signingKeyId).toBe(signingKeyIdB);
    expect(requestB.payload.signedAtUtc).toBe(cutoverAtUtc);
    expect(requestB.requestDigestSha256).not.toBe(requestA.requestDigestSha256);
    const envelopeB = rotatedHarness.assemble(requestB, signRequest(requestB, pairB.privateKey));
    expect(rotatedHarness.verify(envelopeB, bindings())).toEqual(envelopeB);
    expect(() => testHarness.assemble(requestB, signRequest(requestB, pairB.privateKey)))
      .toThrow(/active.*key/i);
    expect(() => rotatedHarness.verify(signedEnvelope(), bindings())).toThrow(/active.*key/i);

    const retiredWithoutReplacement = transitionS33DetachedSigningTrustPolicySetV2(activePolicySet, {
      ...activePolicySet,
      activeSigningKeyId: null,
      keys: [{ ...activePolicy, state: 'RETIRED', retiredAtUtc: cutoverAtUtc }],
    });
    expect(() => transitionS33DetachedSigningTrustPolicySetV2(retiredWithoutReplacement, {
      ...retiredWithoutReplacement,
      activeSigningKeyId: signingKeyIdB,
      keys: [...retiredWithoutReplacement.keys, policyB],
    })).toThrow(/atomic A-to-B hard cutover/i);

    const revokedWithoutReplacement = transitionS33DetachedSigningTrustPolicySetV2(activePolicySet, {
      ...activePolicySet,
      activeSigningKeyId: null,
      keys: [{
        ...activePolicy,
        state: 'REVOKED',
        revokedAtUtc: cutoverAtUtc,
        revocationReason: 'CTO-declared compromise response',
      }],
    });
    expect(transitionS33DetachedSigningTrustPolicySetV2(revokedWithoutReplacement, {
      ...revokedWithoutReplacement,
      activeSigningKeyId: signingKeyIdB,
      keys: [...revokedWithoutReplacement.keys, policyB],
    }).activeSigningKeyId).toBe(signingKeyIdB);
  });

  it('requires strictly forward key versions for cutover and post-revocation recovery', () => {
    expect(() => validateS33DetachedSigningTrustPolicyV2({
      ...activePolicy,
      signingKeyId: 'arkova-s33-cto-release-2026q3-00',
    })).toThrow(/not versioned/i);

    expect(() => hardCutover(
      activePolicySetForKey('arkova-s33-cto-release-2026q3-02'),
      'arkova-s33-cto-release-2026q3-01',
    )).toThrow(/strictly forward/i);
    expect(() => hardCutover(
      activePolicySetForKey('arkova-s33-cto-release-2026q4-02'),
      'arkova-s33-cto-release-2026q3-99',
    )).toThrow(/strictly forward/i);

    expect(hardCutover(
      activePolicySetForKey('arkova-s33-cto-release-2026q3-01'),
      'arkova-s33-cto-release-2026q3-02',
    ).activeSigningKeyId).toBe('arkova-s33-cto-release-2026q3-02');
    expect(hardCutover(
      activePolicySetForKey('arkova-s33-cto-release-2026q3-99'),
      'arkova-s33-cto-release-2026q4-01',
    ).activeSigningKeyId).toBe('arkova-s33-cto-release-2026q4-01');

    const revokedKeyId = 'arkova-s33-cto-release-2026q4-02';
    const current = activePolicySetForKey(revokedKeyId);
    const revoked = transitionS33DetachedSigningTrustPolicySetV2(current, {
      ...current,
      activeSigningKeyId: null,
      keys: [{
        ...current.keys[0],
        state: 'REVOKED',
        revokedAtUtc: '2026-07-15T18:00:00.000Z',
        revocationReason: 'CTO-declared compromise response',
      }],
    });
    const backwardRecovery = activePolicyForKey(
      'arkova-s33-cto-release-2026q3-99',
      '2026-07-15T19:00:00.000Z',
    );
    expect(() => transitionS33DetachedSigningTrustPolicySetV2(revoked, {
      ...revoked,
      activeSigningKeyId: backwardRecovery.signingKeyId,
      keys: [backwardRecovery, ...revoked.keys],
    })).toThrow(/strictly forward/i);
    expect(() => validateS33DetachedSigningTrustPolicySetV2({
      ...revoked,
      activeSigningKeyId: revokedKeyId,
      keys: [revoked.keys[0], activePolicyForKey(revokedKeyId)],
    })).toThrow(/duplicate signing key id/i);
  });

  it('compares recovery against the maximum key version ever used in the ring', () => {
    const rotated = hardCutover(
      activePolicySetForKey('arkova-s33-cto-release-2026q3-01'),
      'arkova-s33-cto-release-2026q4-99',
    );
    const revokedB = transitionS33DetachedSigningTrustPolicySetV2(rotated, {
      ...rotated,
      activeSigningKeyId: null,
      keys: rotated.keys.map((policy) => policy.state === 'ACTIVE' ? {
        ...policy,
        state: 'REVOKED' as const,
        revokedAtUtc: '2026-07-15T20:00:00.000Z',
        revocationReason: 'CTO-declared B compromise response',
      } : policy),
    });
    const laterRevokedA = transitionS33DetachedSigningTrustPolicySetV2(revokedB, {
      ...revokedB,
      keys: revokedB.keys.map((policy) => policy.state === 'RETIRED' ? {
        ...policy,
        state: 'REVOKED' as const,
        revokedAtUtc: '2026-07-15T21:00:00.000Z',
        revocationReason: 'CTO-declared historical A compromise response',
      } : policy),
    });
    const recover = (signingKeyId: string, activatedAtUtc: string) => {
      const recovery = activePolicyForKey(signingKeyId, activatedAtUtc);
      return transitionS33DetachedSigningTrustPolicySetV2(laterRevokedA, {
        ...laterRevokedA,
        activeSigningKeyId: signingKeyId,
        keys: [...laterRevokedA.keys, recovery]
          .sort((left, right) => left.signingKeyId.localeCompare(right.signingKeyId)),
      });
    };

    expect(() => recover(
      'arkova-s33-cto-release-2026q4-01',
      '2026-07-15T22:00:00.000Z',
    )).toThrow(/strictly forward/i);
    expect(() => recover(
      'arkova-s33-cto-release-2027q1-01',
      '2026-07-15T20:30:00.000Z',
    )).toThrow(/latest revocation/i);
    expect(recover(
      'arkova-s33-cto-release-2027q1-01',
      '2026-07-15T22:00:00.000Z',
    ).activeSigningKeyId).toBe('arkova-s33-cto-release-2027q1-01');
  });

  it('separates historical audit, in-flight HOLD, and revoked merged-evidence HOLD', () => {
    const envelopeA = signedEnvelope();
    const retiredPolicy = transitionS33DetachedSigningTrustPolicyV2(activePolicy, {
      ...activePolicy,
      state: 'RETIRED',
      retiredAtUtc: '2026-07-15T19:00:00.000Z',
    });
    const retiredSet = validateS33DetachedSigningTrustPolicySetV2({
      ...activePolicySet,
      activeSigningKeyId: null,
      keys: [retiredPolicy],
    });
    const retiredHarness = createS33DetachedSigningTestHarnessV2(retiredSet);
    expect(() => retiredHarness.verify(envelopeA, bindings())).toThrow(/ACTIVE/i);
    expect(retiredHarness.audit(envelopeA, bindings(), {
      evidenceState: 'MERGED',
      mergedAtUtc: '2026-07-15T18:30:00.000Z',
      auditedAtUtc: '2026-07-15T19:01:00.000Z',
    })).toMatchObject({
      disposition: 'HISTORICAL_AUDIT_VERIFIED',
      acceptanceAuthority: false,
      cryptographicVerification: 'VERIFIED',
      keyState: 'RETIRED',
    });
    expect(retiredHarness.audit(envelopeA, bindings(), {
      evidenceState: 'UNMERGED',
      mergedAtUtc: null,
      auditedAtUtc: '2026-07-15T19:01:00.000Z',
    })).toMatchObject({
      disposition: 'REJECTED_NEW_ACCEPTANCE',
      acceptanceAuthority: false,
    });
    expect(retiredHarness.audit(envelopeA, bindings(), {
      evidenceState: 'MERGED',
      mergedAtUtc: '2026-07-15T19:00:00.000Z',
      auditedAtUtc: '2026-07-15T19:01:00.000Z',
    })).toMatchObject({
      disposition: 'CTO_HOLD',
      acceptanceAuthority: false,
      reason: expect.stringMatching(/cutover|regenerat/i),
    });

    const revokedPolicy = transitionS33DetachedSigningTrustPolicyV2(retiredPolicy, {
      ...retiredPolicy,
      state: 'REVOKED',
      revokedAtUtc: '2026-07-15T20:00:00.000Z',
      revocationReason: 'CTO-declared compromise response',
    });
    const revokedSet = transitionS33DetachedSigningTrustPolicySetV2(retiredSet, {
      ...retiredSet,
      keys: [revokedPolicy],
    });
    const revokedHarness = createS33DetachedSigningTestHarnessV2(revokedSet);
    expect(revokedHarness.audit(envelopeA, bindings(), {
      evidenceState: 'MERGED',
      mergedAtUtc: '2026-07-15T18:30:00.000Z',
      auditedAtUtc: '2026-07-15T20:00:00.000Z',
    })).toMatchObject({
      disposition: 'CTO_HOLD',
      acceptanceAuthority: false,
      keyState: 'REVOKED',
      reason: expect.stringMatching(/compromise response/i),
    });
    expect(revokedHarness.audit(envelopeA, bindings(), {
      evidenceState: 'UNMERGED',
      mergedAtUtc: null,
      auditedAtUtc: '2026-07-15T20:00:00.000Z',
    })).toMatchObject({ disposition: 'REJECTED_NEW_ACCEPTANCE' });
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

  it('rejects private PKCS#8 material before public-SPKI policy activation', () => {
    const privateKeyPkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => validateS33DetachedSigningTrustPolicyV2({
      ...activePolicy,
      publicKeySpkiPem: privateKeyPkcs8Pem,
    })).toThrow(/public SPKI PEM/i);
  });

  it('disables test-policy injection outside NODE_ENV=test', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createS33DetachedSigningTestHarnessV2(activePolicySet)).toThrow(/test-only/i);
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
