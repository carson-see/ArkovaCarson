import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
  S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  transitionS33DetachedSigningTrustPolicySetV2,
  validateS33DetachedSigningTrustPolicySetV2,
  validateS33DetachedSigningTrustPolicyV2,
} from '../../services/worker/src/ai/eval/s33-wave3-detached-signing-v2.js';
import { runS33DetachedSigningCli } from './s33-wave3-detached-signing-v2.js';

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

function payloadInput(): object {
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
    acceptedEntries: [{
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
    }],
  };
}

function publicFingerprint(publicKeySpkiPem: string): string {
  return createHash('sha256')
    .update(createPublicKey(publicKeySpkiPem).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

describe('S3.3 Wave-3 detached-signing CLI', () => {
  it('emits one owner-only unsigned request and accepts no private-key flag', () => {
    const root = mkdtempSync(join(tmpdir(), 's33-v2-cli-'));
    const input = join(root, 'payload-input.json');
    const output = join(root, 'request.json');
    writeFileSync(input, JSON.stringify(payloadInput()));
    const result = runS33DetachedSigningCli([
      'emit-request', '--payload-input', input, '--output', output,
    ]);
    expect(result.artifactType).toBe('arkova-s33-detached-signing-request');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(result);
    expect(() => runS33DetachedSigningCli([
      'emit-request', '--payload-input', input, '--private-key', 'forbidden', '--output', join(root, 'bad.json'),
    ])).toThrow(/Usage/i);
  });

  it('keeps signature assembly fail-closed while production policy is UNCONFIGURED', () => {
    const root = mkdtempSync(join(tmpdir(), 's33-v2-cli-'));
    const input = join(root, 'payload-input.json');
    const request = join(root, 'request.json');
    const signature = join(root, 'signature.json');
    writeFileSync(input, JSON.stringify(payloadInput()));
    runS33DetachedSigningCli(['emit-request', '--payload-input', input, '--output', request]);
    writeFileSync(signature, JSON.stringify({ signatureBase64Url: 'A'.repeat(86) }));
    expect(() => runS33DetachedSigningCli([
      'assemble', '--signing-request', request, '--signature', signature,
      '--output', join(root, 'envelope.json'),
    ])).toThrow(/UNCONFIGURED/i);
  });

  it('regenerates an in-flight request for the sole active post-cutover key', () => {
    const root = mkdtempSync(join(tmpdir(), 's33-v2-cli-'));
    const input = join(root, 'payload-input.json');
    const requestA = join(root, 'request-a.json');
    const requestB = join(root, 'request-b.json');
    const trustPolicySet = join(root, 'trust-policy-set.json');
    writeFileSync(input, JSON.stringify(payloadInput()));
    runS33DetachedSigningCli(['emit-request', '--payload-input', input, '--output', requestA]);

    const pairA = generateKeyPairSync('ed25519');
    const publicKeyA = pairA.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const activeA = validateS33DetachedSigningTrustPolicyV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      state: 'ACTIVE',
      publicKeySpkiPem: publicKeyA,
      publicKeyFingerprintSha256: publicFingerprint(publicKeyA),
      authorizedOperator: 'cto-release-operator-a',
      fingerprintConfirmation: {
        method: 'cto-out-of-band',
        confirmedBy: 'cto',
        confirmedAtUtc: '2026-07-15T16:59:00.000Z',
      },
      activatedAtUtc: '2026-07-15T17:00:00.000Z',
    });
    const activeSetA = validateS33DetachedSigningTrustPolicySetV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
      activeSigningKeyId: activeA.signingKeyId,
      keys: [activeA],
    });
    const pairB = generateKeyPairSync('ed25519');
    const publicKeyB = pairB.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyIdB = 'arkova-s33-cto-release-2026q3-02';
    const cutoverAtUtc = '2026-07-15T19:00:00.000Z';
    const activeB = validateS33DetachedSigningTrustPolicyV2({
      ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
      signingKeyId: keyIdB,
      state: 'ACTIVE',
      publicKeySpkiPem: publicKeyB,
      publicKeyFingerprintSha256: publicFingerprint(publicKeyB),
      authorizedOperator: 'cto-release-operator-b',
      fingerprintConfirmation: {
        method: 'cto-out-of-band',
        confirmedBy: 'cto',
        confirmedAtUtc: '2026-07-15T18:59:00.000Z',
      },
      activatedAtUtc: cutoverAtUtc,
    });
    const rotated = transitionS33DetachedSigningTrustPolicySetV2(activeSetA, {
      ...activeSetA,
      activeSigningKeyId: keyIdB,
      keys: [{ ...activeA, state: 'RETIRED', retiredAtUtc: cutoverAtUtc }, activeB],
    });
    writeFileSync(trustPolicySet, JSON.stringify(rotated));

    const result = runS33DetachedSigningCli([
      'regenerate-request', '--signing-request', requestA,
      '--signed-at-utc', cutoverAtUtc, '--trust-policy-set', trustPolicySet,
      '--output', requestB,
    ]);
    expect(result).toMatchObject({
      signingKeyId: keyIdB,
      payload: { signingKeyId: keyIdB, signedAtUtc: cutoverAtUtc },
    });
    expect(JSON.parse(readFileSync(requestB, 'utf8'))).toEqual(result);
  });
});
