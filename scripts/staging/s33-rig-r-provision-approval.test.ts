import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  canonicalRigRProvisionApprovalRecordSha256,
  createProductionRigRProvisionApprovalVerifier,
  createRigRProvisionApprovalVerifierForTest,
  getRigRProvisionApprovalAuthority,
  RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN,
  rigRProvisionApprovalRecordSchema,
} from './s33-rig-r-provision-approval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const verifierPath = resolve(here, 's33-rig-r-provision-approval.mjs');
const provisionerPath = resolve(here, 'provision-isolated-rig.sh');
const verifierSource = readFileSync(verifierPath, 'utf8');
const provisionerSource = readFileSync(provisionerPath, 'utf8');

const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyFingerprint = createHash('sha256')
  .update(keyPair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const keyId = 'arkova.s33.release-corpus.ed25519.v1';
const rosterRoot = `sha256:${'1'.repeat(64)}`;
const approverIdentity = 'arkova.s33.approver.founder-cto.v1';
const verifierIdentity = 'arkova.s33.verifier.public-ed25519.v1';
const operatorIdentity = 'arkova.s33.operator.key-custodian.v1';
const activatedAtUtc = '2026-07-16T13:52:06Z';
const sourceHeadSha = 'a'.repeat(40);
const sourceTreeSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const sourceHeadImageRef =
  `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${sourceHeadSha}@${imageDigest}`;
const teardownSha256 = `sha256:${'d'.repeat(64)}`;
const placeholderProvisionArtifactSha256 = `sha256:${'e'.repeat(64)}`;
const vertexEndpoint = 'projects/arkova1/locations/us-central1/endpoints/9000000000000000001';
const protectedV6Endpoint = 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344';
const protectedV6Model = 'projects/arkova1/locations/us-central1/models/6611494259700793344';
const deployedModelId = '9000000000000000003';

const expectedBinding = () => ({
  sourceHeadSha,
  sourceTreeSha,
  sourceHeadImageRef,
  imageDigest,
  provisionArtifactSha256: canonicalRigRProvisionApprovalRecordSha256(record()),
  rigName: 's33-r',
  rigProfile: 'gemini-release',
  soakId: 'soak-s33-r-release',
  leaseId: 'lease-s33-r-release',
  requiredWallMin: 2910,
  vertexEndpoint,
  vertexModel: protectedV6Model,
  deployedModelId,
  provisionStartedAt: '2026-07-16T14:00:00Z',
  expiresAt: '2026-07-19T00:00:00Z',
  teardownScriptSha256: teardownSha256,
});

function record(overrides: Record<string, unknown> = {}) {
  return rigRProvisionApprovalRecordSchema.parse({
    schemaVersion: 1,
    approvalId: 'approval-s33-r-001',
    sourceReference: 'ari:cloud:confluence:tenant:page/s33-r-provision',
    immutableRevisionId: 'revision-2026-07-16-001',
    authority: {
      signingKeyId: keyId,
      approverIdentity,
      authorizedRosterRootSha256: rosterRoot,
    },
    candidate: {
      sourceHeadSha,
      sourceTreeSha,
      sourceHeadImageRef,
      imageDigest,
    },
    topology: {
      rigId: 'RIG-R',
      rigName: 's33-r',
      rigProfile: 'gemini-release',
      tier: 'T3',
      requiredWorkerUptimeMin: 2880,
      requiredWallMin: 2910,
      gcpProjectId: 'arkova1',
      gcpRegion: 'us-central1',
      supabaseOrgId: 'byhkazrpmivhcsuqjtva',
      supabaseProjectName: 'arkova-soak-s33-r',
      supabaseRegion: 'us-east-2',
      supabasePostgresMajor: 17,
      cloudRunService: 'arkova-worker-s33-r-staging',
      runtimeServiceAccount: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      generatedSecretNames: [
        'supabase-url-s33-r-staging',
        'supabase-service-role-key-s33-r-staging',
      ],
      vertexEndpoint,
      vertexModel: protectedV6Model,
      deployedModelId,
      temporaryVertexEndpoint: true,
      chainMode: 'mocked',
      inProcessJobs: 'disabled',
      containedDatabaseQueues: ['ai-rollback', 'chain-fault'],
      managedSchedulerJobs: [],
      managedQueues: [],
      oidcIdentities: [],
    },
    execution: {
      soakId: 'soak-s33-r-release',
      leaseId: 'lease-s33-r-release',
      ownerIdentity: operatorIdentity,
      provisionStartedAt: '2026-07-16T14:00:00Z',
      expiresAt: '2026-07-19T00:00:00Z',
      hardStopAuthorityIdentity: approverIdentity,
      teardownOnOrAfterExpiry: true,
      teardownOnDriverFailure: true,
    },
    budget: { s33TotalCapUsd: 200 },
    teardown: {
      scriptPath: 'scripts/staging/teardown-isolated-rig.sh',
      scriptSha256: teardownSha256,
      orderedBoundaries: [
        'deployed-model',
        'vertex-endpoint',
        'cloud-run-service',
        'supabase-secret-pair',
        'supabase-project',
        'runtime-iam-service-account',
        'exclusive-lease',
      ],
      protectedV6Endpoint,
      protectedV6Model,
      deleteProtectedV6Endpoint: false,
      deleteProtectedV6Model: false,
      projectedMonthlyRecurringUsd: 0,
    },
    verification: {
      verifiedAt: '2026-07-16T13:55:00Z',
      verifierIdentity,
      method: 'ed25519-pinned-authority-roster',
    },
    ...overrides,
  });
}

const verifier = createRigRProvisionApprovalVerifierForTest({
  publicKeyPem,
  keyId,
  keyFingerprint,
  authorityRosterRootSha256: rosterRoot,
  authorizedApproverIdentity: approverIdentity,
  verifierIdentity,
  operatorIdentity,
  activatedAtUtc,
});

function envelope(value = record(), overrides: Record<string, unknown> = {}): string {
  const signedPayloadRaw = JSON.stringify(value);
  const signedMessage = Buffer.from(
    `${RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN}${signedPayloadRaw}`,
  );
  return JSON.stringify({
    schemaVersion: 1,
    keyId,
    keyFingerprint,
    canonicalSha256: canonicalRigRProvisionApprovalRecordSha256(value),
    signedPayloadRaw,
    signatureBase64: sign(null, signedMessage, keyPair.privateKey).toString('base64'),
    ...overrides,
  });
}

describe('RIG-R immutable provision approval verifier', () => {
  it('activates only the founder/CTO-confirmed public production authority', () => {
    expect(getRigRProvisionApprovalAuthority()).toEqual({
      keyId: 'arkova.s33.release-corpus.ed25519.v1',
      purpose: 'RIG_R_PROVISION',
      publicKeyFingerprintSha256:
        'b5f6445ae954ac1f29b504fdc890dedefda23beb6300f35d99cd2c9d2eeb9e59',
      authorizedApproverIdentity: approverIdentity,
      verifierIdentity,
      authorizedOperator: operatorIdentity,
      activatedAtUtc,
      genesisRosterRootSha256:
        'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
    });
    expect(createProductionRigRProvisionApprovalVerifier()).toBeDefined();
  });

  it('verifies the exact candidate, frozen topology, execution, cap, and teardown boundary', () => {
    const result = verifier.verify(
      envelope(),
      expectedBinding(),
      new Date('2026-07-16T14:05:00Z'),
    );
    expect(result).toMatchObject({
      status: 'VERIFIED',
      approvalId: 'approval-s33-r-001',
      canonicalSha256: canonicalRigRProvisionApprovalRecordSha256(record()),
      trustRootKeyId: keyId,
      trustRootKeyFingerprint: keyFingerprint,
      approverIdentity,
      verifierIdentity,
      candidate: expectedBinding(),
      budget: { s33TotalCapUsd: 200 },
      execution: {
        ownerIdentity: operatorIdentity,
        hardStopAuthorityIdentity: approverIdentity,
      },
      teardown: {
        scriptSha256: teardownSha256,
        projectedMonthlyRecurringUsd: 0,
        deleteProtectedV6Endpoint: false,
        deleteProtectedV6Model: false,
      },
    });
  });

  it('rejects signature, key, candidate, topology, and runtime substitutions', () => {
    expect(() => verifier.verify(
      envelope(record(), { signatureBase64: Buffer.alloc(64).toString('base64') }),
      expectedBinding(),
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/signature/i);
    expect(() => verifier.verify(
      envelope(record(), { keyId: 'arkova.s33.release-corpus.ed25519.v2' }),
      expectedBinding(),
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/key/i);
    expect(() => verifier.verify(
      envelope(),
      { ...expectedBinding(), sourceTreeSha: 'f'.repeat(40) },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/candidate|tree/i);
    expect(() => verifier.verify(
      envelope(),
      { ...expectedBinding(), vertexEndpoint: `${vertexEndpoint}9` },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/topology|endpoint/i);
    expect(() => verifier.verify(
      envelope(),
      { ...expectedBinding(), leaseId: 'another-lease' },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/execution|lease/i);
  });

  it('rejects duplicate JSON keys and unknown fields before semantic acceptance', () => {
    const duplicatePayload = JSON.stringify(record()).replace(
      '"approvalId":"approval-s33-r-001"',
      '"approvalId":"shadow","approvalId":"approval-s33-r-001"',
    );
    const duplicateEnvelope = JSON.stringify({
      schemaVersion: 1,
      keyId,
      keyFingerprint,
      canonicalSha256: placeholderProvisionArtifactSha256,
      signedPayloadRaw: duplicatePayload,
      signatureBase64: sign(
        null,
        Buffer.from(`${RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN}${duplicatePayload}`),
        keyPair.privateKey,
      ).toString('base64'),
    });
    expect(() => verifier.verify(
      duplicateEnvelope,
      expectedBinding(),
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/duplicate JSON key approvalId/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      callerConfirmation: 'self-authorized',
    })).toThrow(/strict|schema|field/i);
  });

  it('enforces wall+360 through 72h, activation, current TTL, and exact $200 cap', () => {
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      execution: { ...record().execution, expiresAt: '2026-07-18T20:00:00Z' },
    })).toThrow(/expiry|wall|360/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      execution: { ...record().execution, expiresAt: '2026-07-19T15:00:01Z' },
    })).toThrow(/72/i);
    const preActivationRecord = record({
        verification: {
          ...record().verification,
          verifiedAt: '2026-07-16T13:50:00Z',
        },
      });
    expect(() => verifier.verify(
      envelope(preActivationRecord),
      {
        ...expectedBinding(),
        provisionArtifactSha256:
          canonicalRigRProvisionApprovalRecordSha256(preActivationRecord),
      },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/activation/i);
    expect(() => verifier.verify(
      envelope(),
      expectedBinding(),
      new Date('2026-07-19T00:00:00Z'),
    )).toThrow(/expired|TTL|time/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      budget: { s33TotalCapUsd: 201 },
    })).toThrow(/200|cap/i);
  });

  it('requires the protected v6 model, a temporary non-rollback endpoint, and empty managed topology', () => {
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, vertexEndpoint: protectedV6Endpoint },
    })).toThrow(/protected|endpoint/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: {
        ...record().topology,
        vertexModel: 'projects/arkova1/locations/us-central1/models/999',
      },
    })).toThrow(/protected|model|6611494259700793344/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, managedSchedulerJobs: ['shadow-job'] },
    })).toThrow(/Scheduler|empty|topology/i);
  });

  it('is built-ins-only and provisioner verifies tracked authority before cloud observation', () => {
    const imports = [...verifierSource.matchAll(/from ['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(provisionerSource).toContain('scripts/staging/s33-rig-r-provision-approval.mjs');
    expect(provisionerSource).toContain('STAGING_RIG_R_PROVISION_APPROVAL_ARTIFACT');
    expect(provisionerSource.indexOf('verify_rig_r_provision_approval_binding'))
      .toBeLessThan(provisionerSource.lastIndexOf('verify_source_head_image_digest'));
    expect(provisionerSource.indexOf('claim_rig_r_provision_approval_once'))
      .toBeLessThan(provisionerSource.lastIndexOf('claim_rig_r_lease_once'));
  });

  it('production verifier rejects unsigned public-key-only fixtures', () => {
    const production = createProductionRigRProvisionApprovalVerifier();
    expect(() => production.verify(
      envelope(),
      expectedBinding(),
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/fingerprint|key|signature/i);
  });

  it('CLI exposes no signing path or private-key option', () => {
    const helpOutput = (() => {
      try {
        return execFileSync(process.execPath, [verifierPath, '--help'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const failure = error as { stdout?: unknown; stderr?: unknown };
        return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      }
    })();
    expect(`${verifierSource}\n${helpOutput}`).not.toMatch(/private[-_ ]?key|--sign\b/iu);
  });
});
