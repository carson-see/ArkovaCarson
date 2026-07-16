import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalApprovalRecordSha256,
  createG1SpendApprovalVerifierForTest,
  createProductionG1SpendApprovalVerifier,
  getG1SpendApprovalAuthority,
  g1SpendApprovalRecordSchema,
} from './s33-g1-spend-approval.mjs';

const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyFingerprint = createHash('sha256')
  .update(keyPair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const rosterRoot = `sha256:${'a'.repeat(64)}`;
const sourceHeadSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const expectedScope = {
  rigClass: 'RIG-G1' as const,
  rigName: 's33-g1',
  rigProfile: 'gemini' as const,
  soakId: 'soak-s33-g1',
  rigId: 'RIG-G1' as const,
  leaseId: 'lease-s33-g1',
  corpusDigest: `sha256:${'d'.repeat(64)}`,
  endpointResource: 'projects/arkova1/locations/us-central1/endpoints/123456789',
};
const verifier = createG1SpendApprovalVerifierForTest({
  publicKeyPem,
  keyId: 'arkova.s33.g1-spend.ed25519.v1',
  keyFingerprint,
  authorityRosterRootSha256: rosterRoot,
  authorizedApproverIdentities: ['approved-founder'],
  verifierIdentity: 'release-verifier',
  activatedAtUtc: '2026-07-15T19:00:00Z',
});

function record(overrides: Record<string, unknown> = {}) {
  return g1SpendApprovalRecordSchema.parse({
    schemaVersion: 1,
    approvalId: 'approval-s33-g1-001',
    sourceReference: 'ari:cloud:confluence:tenant:page/123456',
    immutableRevisionId: 'revision-42',
    authority: {
      approverIdentity: 'approved-founder',
      approverRole: 'founder',
      authorizedRosterRootSha256: rosterRoot,
    },
    candidate: { sourceHeadSha, imageDigest },
    scope: expectedScope,
    budget: {
      isolatedSupabaseProjectCount: 3,
      isolatedSupabaseProjectMonthlyEachUsd: 10,
      isolatedSupabaseProjectsMonthlyTotalUsd: 30,
      g1VariableComputeModelCapUsd: 120,
      s33TotalCapUsd: 200,
    },
    execution: {
      ownerIdentity: 'lane-4-sm',
      expiresAt: '2026-07-20T00:00:00Z',
    },
    raci: {
      responsibleIdentity: 'lane-4-sm',
      accountableIdentity: 'approved-founder',
      consultedIdentities: ['cto'],
      informedIdentities: ['rte'],
    },
    verification: {
      verifiedAt: '2026-07-15T20:00:00Z',
      verifierIdentity: 'release-verifier',
      method: 'ed25519-pinned-authority-roster',
    },
    ...overrides,
  });
}

function envelope(value = record(), signatureOverride?: string): string {
  const signedPayloadRaw = JSON.stringify(value);
  return JSON.stringify({
    schemaVersion: 1,
    keyFingerprint,
    canonicalSha256: canonicalApprovalRecordSha256(value),
    signedPayloadRaw,
    signatureBase64: signatureOverride
      ?? sign(null, Buffer.from(signedPayloadRaw), keyPair.privateKey).toString('base64'),
  });
}

function envelopeFromRaw(signedPayloadRaw: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    keyFingerprint,
    canonicalSha256: canonicalApprovalRecordSha256(record()),
    signedPayloadRaw,
    signatureBase64: sign(null, Buffer.from(signedPayloadRaw), keyPair.privateKey).toString('base64'),
  });
}

describe('RIG-G1 immutable spend approval', () => {
  it('activates only the founder/CTO-confirmed public production authority', () => {
    expect(getG1SpendApprovalAuthority()).toEqual({
      keyId: 'arkova.s33.g1-spend.ed25519.v1',
      purpose: 'G1_SPEND',
      publicKeyFingerprintSha256:
        '6ece5cea2d35423aab35a23f6292fd769c6d839ac03ba7860a973d4febd5d987',
      authorizedApproverIdentities: ['arkova.s33.approver.founder-cto.v1'],
      verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
      activatedAtUtc: '2026-07-16T13:52:06Z',
      genesisRosterRootSha256:
        'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
    });
    expect(createProductionG1SpendApprovalVerifier()).toBeDefined();
  });

  it('verifies the immutable source, candidate, three-project budget, TTL, RACI, and verifier', () => {
    const result = verifier.verify(
      envelope(),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    );

    expect(result).toMatchObject({
      status: 'VERIFIED',
      approvalId: 'approval-s33-g1-001',
      sourceReference: 'ari:cloud:confluence:tenant:page/123456',
      immutableRevisionId: 'revision-42',
      approverIdentity: 'approved-founder',
      authorityRosterRootSha256: rosterRoot,
      candidateSourceHeadSha: sourceHeadSha,
      candidateImageDigest: imageDigest,
      scope: expectedScope,
      isolatedSupabaseProjectCount: 3,
      isolatedSupabaseProjectsMonthlyTotalUsd: 30,
      g1VariableComputeModelCapUsd: 120,
      s33TotalCapUsd: 200,
      ownerIdentity: 'lane-4-sm',
      verifierIdentity: 'release-verifier',
      trustRootKeyId: 'arkova.s33.g1-spend.ed25519.v1',
      authorityActivatedAtUtc: '2026-07-15T19:00:00Z',
    });
  });

  it('rejects forged signatures and candidate substitution', () => {
    expect(() => verifier.verify(
      envelope(record(), Buffer.alloc(64).toString('base64')),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/signature/i);
    expect(() => verifier.verify(
      envelope(),
      { sourceHeadSha: 'd'.repeat(40), imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/candidate/i);
  });

  it('rejects replay of the same envelope under another rig name or lease', () => {
    expect(() => verifier.verify(
      envelope(),
      { ...expectedScope, sourceHeadSha, imageDigest, rigName: 's33-g1-replay' },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/scope|rigName|name/i);
    expect(() => verifier.verify(
      envelope(),
      { ...expectedScope, sourceHeadSha, imageDigest, leaseId: 'lease-s33-g1-replay' },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/scope|lease/i);
  });

  it('rejects self-attested identities, roster drift, invalid RACI, and expired TTLs', () => {
    const selfAttested = record({
      authority: {
        approverIdentity: 'caller-self-attestation',
        approverRole: 'founder',
        authorizedRosterRootSha256: rosterRoot,
      },
    });
    expect(() => verifier.verify(
      envelope(selfAttested),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/authorized|roster/i);

    const badRaci = record({
      raci: {
        responsibleIdentity: 'different-owner',
        accountableIdentity: 'approved-founder',
        consultedIdentities: ['cto'],
        informedIdentities: ['rte'],
      },
    });
    expect(() => verifier.verify(
      envelope(badRaci),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/RACI/i);

    const expired = record({
      execution: { ownerIdentity: 'lane-4-sm', expiresAt: '2026-07-15T20:30:00Z' },
    });
    expect(() => verifier.verify(
      envelope(expired),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/TTL|time/i);
  });

  it('rejects malformed three-project accounting and unknown free-form fields', () => {
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      budget: { ...record().budget, isolatedSupabaseProjectCount: 1 },
    })).toThrow();
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      callerConfirmation: 'I approve myself',
    })).toThrow();
    expect(() => verifier.verify(
      envelope(record({
        budget: { ...record().budget, s33TotalCapUsd: 201 },
      })),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/200|cap/i);
    expect(() => verifier.verify(
      envelope(record({
        budget: { ...record().budget, g1VariableComputeModelCapUsd: 171 },
      })),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/170|cap/i);
  });

  it('rejects duplicate JSON keys even when the ambiguous bytes have a valid signature', () => {
    const signedPayloadRaw = JSON.stringify(record()).replace(
      '"approvalId":"approval-s33-g1-001"',
      '"approvalId":"shadow-approval","approvalId":"approval-s33-g1-001"',
    );
    expect(() => verifier.verify(
      envelopeFromRaw(signedPayloadRaw),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/duplicate JSON key approvalId/i);

    const duplicateEnvelopeKey = envelope().replace(
      `"keyFingerprint":"${keyFingerprint}"`,
      `"keyFingerprint":"${'0'.repeat(64)}","keyFingerprint":"${keyFingerprint}"`,
    );
    expect(() => verifier.verify(
      duplicateEnvelopeKey,
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/duplicate JSON key keyFingerprint/i);
  });

  it('rejects approval IDs that could escape or alias the ledger object namespace', () => {
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      approvalId: 'approval/s33-g1/replay',
    })).toThrow(/approvalId|schema/i);
  });

  it('production verifier rejects an envelope signed by an untrusted ephemeral key', () => {
    expect(() => createProductionG1SpendApprovalVerifier().verify(
      envelope(),
      { sourceHeadSha, imageDigest, ...expectedScope },
      new Date('2026-07-16T14:00:00Z'),
    )).toThrow(/fingerprint|key|signature/i);
  });
});
