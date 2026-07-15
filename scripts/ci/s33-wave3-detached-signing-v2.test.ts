import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
