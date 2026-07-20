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
const g1SecretReferences = {
  stripeSecretKey: 'stripe-secret-key-staging@1',
  stripeWebhookSecret: 'stripe-webhook-secret-staging@1',
  apiKeyHmacSecret: 'api-key-hmac-secret-staging@1',
  cronSecret: 'cron-secret@1',
  geminiApiKey: 'gemini-api-key@2',
} as const;
const immutableLedger = {
  backend: 'gcs-if-generation-match-0-locked-retention',
  bucket: 'arkova1-s33-immutable-authority-ledger',
  projectId: 'arkova1',
  requiresPerObjectRetention: true,
};
const expectedScope = {
  rigClass: 'RIG-G1' as const,
  rigName: 's33-g1',
  rigProfile: 'gemini' as const,
  soakId: 'soak-s33-g1',
  rigId: 'RIG-G1' as const,
  leaseId: 'lease-s33-g1',
  corpusDigest: `sha256:${'d'.repeat(64)}`,
  endpointId: '733002' as const,
  endpointResource: 'projects/arkova1/locations/us-central1/endpoints/733002' as const,
  endpointDisplayName: 'arkova-s33-rig-g1-b-tuned-v6' as const,
  vertexModelResource:
    'projects/270018525501/locations/us-central1/models/6611494259700793344@1' as const,
  checkpointId: '6' as const,
  deployedModelId: '7330021' as const,
  deployedModelDisplayName: 'arkova-s33-rig-g1-b-tuned-v6' as const,
  deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES' as const,
  minReplicaCount: 1 as const,
  maxReplicaCount: 1 as const,
  controlRuntimeServiceAccount:
    's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com' as const,
  tunedRuntimeServiceAccount:
    's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com' as const,
  controlService: 'arkova-worker-s33-g1-a-staging',
  tunedService: 'arkova-worker-s33-g1-b-staging',
  controlProjectName: 'arkova-soak-s33-g1-a',
  tunedProjectName: 'arkova-soak-s33-g1-b',
  controlSupabaseUrlSecret: 'supabase-url-s33-g1-a-staging@1' as const,
  controlSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-a-staging@1' as const,
  tunedSupabaseUrlSecret: 'supabase-url-s33-g1-b-staging@1' as const,
  tunedSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-b-staging@1' as const,
  controlRunId: 's33-g1-control-v6',
  tunedRunId: 's33-g1-tuned-v6',
  controlQueue: 's33-g1-control-queue',
  tunedQueue: 's33-g1-tuned-queue',
  pairedCadenceMaxMin: 30,
  secretReferences: g1SecretReferences,
  immutableLedger,
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
      isolatedSupabaseProjectCount: 4,
      isolatedSupabaseProjectMonthlyEachUsd: 10,
      isolatedSupabaseProjectsMonthlyTotalUsd: 40,
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

  it('verifies the immutable source, four-project budget, TTL, RACI, and verifier', () => {
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
      isolatedSupabaseProjectCount: 4,
      isolatedSupabaseProjectsMonthlyTotalUsd: 40,
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

  it.each([
    ['control runtime identity', { controlRuntimeServiceAccount: 'shadow@arkova1.iam.gserviceaccount.com' }],
    ['endpoint ID', { endpointId: '733099' }],
    ['endpoint resource', { endpointResource: 'projects/arkova1/locations/us-central1/endpoints/733099' }],
    ['endpoint display name', { endpointDisplayName: 'arkova-s33-rig-g1-shadow' }],
    ['deployed model ID', { deployedModelId: '7330022' }],
    ['deployed model display name', { deployedModelDisplayName: 'arkova-s33-rig-g1-shadow' }],
    ['model resource', { vertexModelResource: 'projects/270018525501/locations/us-central1/models/6611494259700793344' }],
    ['checkpoint', { checkpointId: '5' }],
    ['deployment resources mode', { deploymentResourcesMode: 'DEDICATED_MACHINE_SPEC' }],
    ['minimum replicas', { minReplicaCount: 2 }],
    ['maximum replicas', { maxReplicaCount: 2 }],
    ['control service', { controlService: 'arkova-worker-shadow-staging' }],
    ['control project', { controlProjectName: 'arkova-soak-shadow-a' }],
    ['tuned project secret', { tunedSupabaseUrlSecret: 'supabase-url-shadow-b-staging' }],
    ['control run', { controlRunId: 'shadow-control-run' }],
    ['tuned queue', { tunedQueue: 'shadow-tuned-queue' }],
    ['paired cadence', { pairedCadenceMaxMin: 29 }],
    [
      'secret reference',
      { secretReferences: { ...g1SecretReferences, geminiApiKey: 'gemini-api-key@1' } },
    ],
    [
      'immutable ledger',
      { immutableLedger: { ...immutableLedger, bucket: 'arkova-training-data' } },
    ],
  ])('rejects replay under substituted %s', (_label, scopeOverride) => {
    expect(() => verifier.verify(
      envelope(),
      { sourceHeadSha, imageDigest, ...expectedScope, ...scopeOverride } as never,
      new Date('2026-07-15T21:00:00Z'),
    )).toThrow(/scope|runtime|endpoint|model|deployment|resource|service|run|queue|cadence|secret|ledger|bucket/i);
  });

  it('rejects swapped or shared control/tuned runtime service accounts', () => {
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        controlRuntimeServiceAccount: expectedScope.tunedRuntimeServiceAccount,
        tunedRuntimeServiceAccount: expectedScope.controlRuntimeServiceAccount,
      },
    })).toThrow(/controlRuntimeServiceAccount|schema/i);

    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        tunedRuntimeServiceAccount: expectedScope.controlRuntimeServiceAccount,
      },
    })).toThrow(/tunedRuntimeServiceAccount|distinct|schema/i);

    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        tunedProjectName: expectedScope.controlProjectName,
      },
    })).toThrow(/distinct|project/i);
  });

  it('rejects stale or mutable-latest secret references and swapped generated arm secrets', () => {
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        secretReferences: { ...g1SecretReferences, geminiApiKey: 'gemini-api-key@1' },
      },
    })).toThrow(/geminiApiKey|schema/i);
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        secretReferences: { ...g1SecretReferences, geminiApiKey: 'gemini-api-key-staging@2' },
      },
    })).toThrow(/geminiApiKey|schema/i);
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        secretReferences: { ...g1SecretReferences, geminiApiKey: 'gemini-api-key@latest' },
      },
    })).toThrow(/geminiApiKey|schema/i);
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      scope: {
        ...expectedScope,
        controlSupabaseUrlSecret: expectedScope.tunedSupabaseUrlSecret,
        tunedSupabaseUrlSecret: expectedScope.controlSupabaseUrlSecret,
      },
    })).toThrow(/controlSupabaseUrlSecret|schema/i);
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

  it('rejects malformed four-project accounting and unknown free-form fields', () => {
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      budget: { ...record().budget, isolatedSupabaseProjectCount: 3 },
    })).toThrow();
    expect(() => g1SpendApprovalRecordSchema.parse({
      ...record(),
      budget: { ...record().budget, isolatedSupabaseProjectsMonthlyTotalUsd: 30 },
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
