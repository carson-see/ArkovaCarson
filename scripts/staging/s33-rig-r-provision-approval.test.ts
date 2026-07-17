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
const vertexEndpointId = '733016';
const vertexEndpoint = `projects/arkova1/locations/us-central1/endpoints/${vertexEndpointId}`;
const vertexEndpointDisplayName = 'arkova-s33-rig-r-release-v6';
const protectedV6Model =
  'projects/270018525501/locations/us-central1/models/6611494259700793344';
const protectedV6ModelVersion = `${protectedV6Model}@1`;
const checkpointId = '6';
const deployedModelId = '7330161';
const deployedModelDisplayName = vertexEndpointDisplayName;
const deploymentResourcesMode = 'TUNED_GEMINI_AUTOMATIC_RESOURCES';
const endpointIamRole = 'roles/aiplatform.endpointUser';
const endpointIamMember =
  'serviceAccount:s33-rig-r-runtime@arkova1.iam.gserviceaccount.com';
const runtimeImpersonatorServiceAccount =
  '270018525501-compute@developer.gserviceaccount.com';
const runtimeImpersonationRole = 'roles/iam.serviceAccountTokenCreator';
const runtimeImpersonationMember = `serviceAccount:${runtimeImpersonatorServiceAccount}`;
const rigRSecretReferences = {
  supabaseUrl: 'supabase-url-s33-r-staging@1',
  supabaseServiceRoleKey: 'supabase-service-role-key-s33-r-staging@1',
  stripeSecretKey: 'stripe-secret-key-staging@1',
  stripeWebhookSecret: 'stripe-webhook-secret-staging@1',
  apiKeyHmacSecret: 'api-key-hmac-secret-staging@1',
  cronSecret: 'cron-secret@1',
  geminiApiKey: 'gemini-api-key@2',
};
const immutableLedger = {
  backend: 'gcs-if-generation-match-0-locked-retention',
  bucket: 'arkova1-s33-immutable-authority-ledger',
  projectId: 'arkova1',
  requiresPerObjectRetention: true,
};

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
  vertexEndpointId,
  vertexEndpoint,
  vertexEndpointDisplayName,
  vertexModel: protectedV6Model,
  vertexModelVersion: protectedV6ModelVersion,
  checkpointId,
  deployedModelId,
  deployedModelDisplayName,
  deploymentResourcesMode,
  minReplicaCount: 1,
  maxReplicaCount: 1,
  endpointIamRole,
  endpointIamMember,
  runtimeImpersonatorServiceAccount,
  runtimeImpersonationRole,
  runtimeImpersonationMember,
  provisionStartedAt: '2026-07-16T14:00:00Z',
  expiresAt: '2026-07-19T00:00:00Z',
  teardownScriptSha256: teardownSha256,
  secretReferences: rigRSecretReferences,
  immutableLedger,
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
      runtimeImpersonatorServiceAccount,
      runtimeImpersonationRole,
      runtimeImpersonationMember,
      generatedSecretNames: [
        'supabase-url-s33-r-staging',
        'supabase-service-role-key-s33-r-staging',
      ],
      secretReferences: rigRSecretReferences,
      immutableLedger,
      vertexEndpointId,
      vertexEndpoint,
      vertexEndpointDisplayName,
      vertexModel: protectedV6Model,
      vertexModelVersion: protectedV6ModelVersion,
      checkpointId,
      deployedModelId,
      deployedModelDisplayName,
      deploymentResourcesMode,
      minReplicaCount: 1,
      maxReplicaCount: 1,
      endpointIamRole,
      endpointIamMember,
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
      protectedV6Model,
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
    expect(() => verifier.verify(
      envelope(),
      {
        ...expectedBinding(),
        runtimeImpersonationMember: 'serviceAccount:shadow@arkova1.iam.gserviceaccount.com',
      },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/topology|impersonation|operator/i);
    expect(() => verifier.verify(
      envelope(),
      {
        ...expectedBinding(),
        secretReferences: { ...rigRSecretReferences, geminiApiKey: 'shadow-gemini-key' },
      },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/topology|secret/i);
    expect(() => verifier.verify(
      envelope(),
      {
        ...expectedBinding(),
        immutableLedger: { ...immutableLedger, bucket: 'arkova-training-data' },
      },
      new Date('2026-07-16T14:05:00Z'),
    )).toThrow(/topology|ledger|bucket/i);
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
    expect(() => verifier.verify(
      envelope(),
      expectedBinding(),
      new Date('2026-07-16T13:59:59Z'),
    )).toThrow(/provision|start|time/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      budget: { s33TotalCapUsd: 201 },
    })).toThrow(/200|cap/i);
  });

  it('requires the exact temporary endpoint, protected v6 model@1/checkpoint 6, automatic 1x1, endpoint IAM, and empty managed topology', () => {
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, vertexEndpoint: `${vertexEndpoint}9` },
    })).toThrow(/endpoint/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: {
        ...record().topology,
        vertexModel: 'projects/arkova1/locations/us-central1/models/999',
      },
    })).toThrow(/protected|model|6611494259700793344/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, checkpointId: '5' },
    })).toThrow(/checkpoint/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, deploymentResourcesMode: 'DEDICATED_MACHINE_SPEC' },
    })).toThrow(/resources|mode/i);
    expect(() => rigRProvisionApprovalRecordSchema.parse({
      ...record(),
      topology: { ...record().topology, endpointIamRole: 'roles/aiplatform.user' },
    })).toThrow(/IAM|role/i);
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
    const runtimeRoleBlock = provisionerSource.slice(
      provisionerSource.indexOf('RIG_R_RUNTIME_ROLES=('),
      provisionerSource.indexOf('TRUSTED_GIT_PATH='),
    );
    expect(runtimeRoleBlock).not.toContain('roles/secretmanager.secretAccessor');
    expect(provisionerSource).toContain('gcloud secrets add-iam-policy-binding');
    expect(provisionerSource.indexOf('verify_rig_r_provision_approval_binding'))
      .toBeLessThan(provisionerSource.indexOf('grant_rig_r_runtime_secret_access'));
    expect(provisionerSource).toContain('--expected-immutable-ledger-bucket');
    expect(provisionerSource).toContain('verify_immutable_authority_ledger_capability');
    const leaseClaimBlock = provisionerSource.slice(
      provisionerSource.indexOf('claim_rig_r_lease_once()'),
      provisionerSource.indexOf('for denied in "${DENIED_CLOUD_RUN_SERVICES[@]}"'),
    );
    expect(leaseClaimBlock).not.toContain('--retention-mode=Locked');
    expect(leaseClaimBlock).not.toContain('.retention.mode == "Locked"');
    expect(leaseClaimBlock).toContain('RIG_R_LEASE_GENERATION');
    expect(leaseClaimBlock).toContain('--if-generation-match="$RIG_R_LEASE_GENERATION"');
    expect(provisionerSource.lastIndexOf('  verify_immutable_authority_ledger_capability'))
      .toBeLessThan(provisionerSource.indexOf('CREATE_CMD=('));
    expect(provisionerSource).not.toContain('RIG_R_LEASE_BUCKET="arkova-training-data"');
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
