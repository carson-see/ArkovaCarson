import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyB1NodeApprovalEnvelope } from './s33-b1-node-approval.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createHash('sha256')
  .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const keyId = 'arkova.s33.b1-evidence.ed25519.v1';
const now = new Date('2026-07-16T15:00:00Z');
const workerImage = `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:${'a'.repeat(64)}`;
const bitcoinRecipeCommit = 'b9a54856c9bee87d958cc4b070776828b5c17b32';
const bitcoinImage =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8';
const bitcoinCoreAmd64RuntimeDigest =
  'sha256:684e80900f124890c45ad9b691d7f76456c1042385bce4ab92725b1979b55888';
const treasury = 'tb1qarkovas33rigb1treasuryfixture0000000000000';
const treasurySplitTxid =
  '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941';

function secret(env: string, secretName: string, version: string) {
  return {
    env,
    secretName,
    version,
    resource: `projects/arkova1/secrets/${secretName}/versions/${version}`,
  };
}

function payload() {
  return {
    schemaVersion: 1,
    approvalId: 'b1-node-approval-001',
    authority: {
      keyId,
      approverIdentity: 'arkova.s33.approver.founder-cto.v1',
      purpose: 'RIG_B1_BITCOIN_CORE_PROVISION',
    },
    candidate: {
      sourceHeadSha: '1'.repeat(40),
      sourceTreeSha: '2'.repeat(40),
      workerImage,
      workerImageDigest: `sha256:${'a'.repeat(64)}`,
      bitcoinCoreRecipeCommit: bitcoinRecipeCommit,
      bitcoinCoreImage: bitcoinImage,
      bitcoinCoreAmd64RuntimeDigest,
      startupScriptSha256: `sha256:${'3'.repeat(64)}`,
      teardownScriptSha256: `sha256:${'4'.repeat(64)}`,
      corpusDigest: `sha256:${'5'.repeat(64)}`,
      releaseCandidateId: 's33-w3-final-rc',
    },
    run: {
      rigId: 'RIG-B1',
      rigName: 's33-rig-b1',
      soakId: 'soak-s33-rig-b1',
      leaseId: 'lease-s33-rig-b1',
      workerService: 'arkova-worker-s33-rig-b1-staging',
      workerRuntimeServiceAccount: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
      schedulerOidcServiceAccount: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
    },
    topology: {
      provider: {
        workerProvider: 'rpc',
        primary: 'bitcoin-core-signet-rpc',
        secondary: 'mempool-space-signet',
        secondaryApiUrl: 'https://mempool.space/signet/api',
      },
      bitcoinCore: {
        version: '31.1',
        recipeCommit: bitcoinRecipeCommit,
        sourceTarballUrl: 'https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz',
        sourceTarballSha256: 'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e',
        containerImage: bitcoinImage,
        amd64RuntimeDigest: bitcoinCoreAmd64RuntimeDigest,
        startupScriptPath: 'scripts/staging/start-rig-b1-bitcoin-core.sh',
        startupScriptSha256: `sha256:${'3'.repeat(64)}`,
      },
      resources: {
        zone: 'us-central1-a',
        vm: 'arkova-s33-rig-b1-bitcoin-core-signet',
        bootDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-boot',
        dataDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-data',
        internalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip',
        externalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip',
        network: 'arkova-s33-rig-b1-bitcoin-core-signet-vpc',
        subnet: 'arkova-s33-rig-b1-bitcoin-core-signet-subnet',
        rpcFirewall: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc',
        vpcConnector: 'arkova-s33-b1-signet-vpc',
        nodeServiceAccount: 's33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
      },
      schedulerJobs: [
        'arkova-worker-s33-rig-b1-staging-batch-anchors',
        'arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush',
        'arkova-worker-s33-rig-b1-staging-check-confirmations',
        'arkova-worker-s33-rig-b1-staging-org-queue-scheduler',
        'arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs',
        'arkova-worker-s33-rig-b1-staging-recover-broadcasts',
      ],
      iam: {
        artifactRegistryReader: {
          repository: 'projects/arkova1/locations/us-central1/repositories/arkova-worker-images',
          member: 'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
          role: 'roles/artifactregistry.reader',
        },
        rpcAuthSecretAccessor: {
          secretName: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth',
          member: 'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
          role: 'roles/secretmanager.secretAccessor',
        },
      },
      network: {
        rpcEndpoint: 'http://10.33.10.10:38332',
        rpcBind: '10.33.10.10',
        rpcAllowCidr: '10.33.11.0/28',
        subnetCidr: '10.33.10.0/28',
        rpcPort: 38332,
        signetP2pPort: 38333,
        publicRpc: false,
      },
      secretReferences: [
        secret('SUPABASE_URL', 'supabase-url-s33-rig-b1-staging', '1'),
        secret('SUPABASE_SERVICE_ROLE_KEY', 'supabase-service-role-key-s33-rig-b1-staging', '1'),
        secret('STRIPE_SECRET_KEY', 'arkova-s33-rig-b1-stripe-secret-key', '4'),
        secret('STRIPE_WEBHOOK_SECRET', 'arkova-s33-rig-b1-stripe-webhook-secret', '5'),
        secret('API_KEY_HMAC_SECRET', 'arkova-s33-rig-b1-api-key-hmac', '6'), // gitleaks:allow — resource name only
        secret('CRON_SECRET', 'arkova-s33-rig-b1-cron-secret', '7'), // gitleaks:allow — resource name only
        secret('BITCOIN_RPC_URL', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-url', '1'),
        secret('BITCOIN_RPC_AUTH', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth', '2'),
        secret('BITCOIN_TREASURY_WIF', 'arkova-s33-rig-b1-treasury-wif-signet', '3'),
      ],
      nodeSecretEnvs: ['BITCOIN_RPC_AUTH'],
      forbiddenNodeSecretEnvs: ['BITCOIN_TREASURY_WIF'],
      treasuryWatchOnly: {
        address: treasury,
        descriptor: `addr(${treasury})#deadbeef`,
        splitTransactionId: treasurySplitTxid,
        preSplitPlanDigest: `sha256:${'8'.repeat(64)}`,
        expectedConfirmedOutputCount: 32,
        expectedTotalSats: 169_639,
        descriptorPolicy: 'addr-checksummed-importdescriptors',
        wifOnNode: false,
      },
    },
    budget: { spendCapUsd: 200 },
    teardown: {
      orderedResources: [
        'scheduler-jobs', 'cloud-run-service', 'bitcoin-core-vm', 'boot-disk', 'data-disk',
        'external-address', 'internal-address', 'rpc-firewall', 'vpc-connector',
        'subnet', 'vpc-network', 'artifact-registry-iam', 'node-secret-iam', 'node-service-account',
        'worker-secret-iam', 'worker-runtime-service-account', 'scheduler-oidc-service-account',
        'supabase-project',
      ],
      projectedMonthlyRecurringUsd: 0,
    },
    issuedAt: '2026-07-16T14:00:00Z',
    expiresAt: '2026-07-18T14:00:00Z',
  };
}

function envelope(value = payload()): string {
  const signedPayloadRaw = JSON.stringify(value);
  return JSON.stringify({
    schemaVersion: 1,
    envelopeId: 'b1-node-envelope-001',
    keyId,
    keyFingerprint: fingerprint,
    signedPayloadRaw,
    signatureBase64: sign(null, Buffer.from(signedPayloadRaw), keys.privateKey).toString('base64'),
  });
}

const options = { publicKeyPem, fingerprint, keyId, now } as const;

describe('RIG-B1 signed Bitcoin Core node/spend approval', () => {
  it('verifies and returns the exact signed topology, run, spend cap, and teardown inventory', () => {
    expect(verifyB1NodeApprovalEnvelope(envelope(), options)).toMatchObject({
      status: 'VERIFIED',
      keyId,
      payload: {
        candidate: {
          bitcoinCoreRecipeCommit: bitcoinRecipeCommit,
          bitcoinCoreImage: bitcoinImage,
          bitcoinCoreAmd64RuntimeDigest,
        },
        topology: {
          provider: { workerProvider: 'rpc', primary: 'bitcoin-core-signet-rpc' },
          treasuryWatchOnly: { address: treasury, wifOnNode: false },
        },
        budget: { spendCapUsd: 200 },
        teardown: { projectedMonthlyRecurringUsd: 0 },
      },
    });
  });

  it('rejects signature tampering and duplicate signed JSON keys', () => {
    const tampered = JSON.parse(envelope());
    tampered.signedPayloadRaw = tampered.signedPayloadRaw.replace('"spendCapUsd":200', '"spendCapUsd":199');
    expect(() => verifyB1NodeApprovalEnvelope(JSON.stringify(tampered), options)).toThrow(/signature/i);

    const duplicate = JSON.parse(envelope());
    duplicate.signedPayloadRaw = duplicate.signedPayloadRaw.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    duplicate.signatureBase64 = sign(null, Buffer.from(duplicate.signedPayloadRaw), keys.privateKey).toString('base64');
    expect(() => verifyB1NodeApprovalEnvelope(JSON.stringify(duplicate), options)).toThrow(/duplicate/i);
  });

  it.each([
    ['mutable Bitcoin image', (value: ReturnType<typeof payload>) => { value.candidate.bitcoinCoreImage = 'bitcoin:31.1'; }],
    ['unreviewed recipe commit', (value: ReturnType<typeof payload>) => { value.candidate.bitcoinCoreRecipeCommit = 'f'.repeat(40); }],
    ['substituted runtime digest', (value: ReturnType<typeof payload>) => { value.candidate.bitcoinCoreAmd64RuntimeDigest = `sha256:${'f'.repeat(64)}`; }],
    ['public RPC', (value: ReturnType<typeof payload>) => { value.topology.network.publicRpc = true; }],
    ['WIF granted to node', (value: ReturnType<typeof payload>) => { value.topology.nodeSecretEnvs = ['BITCOIN_RPC_AUTH', 'BITCOIN_TREASURY_WIF']; }],
    ['empty treasury watch', (value: ReturnType<typeof payload>) => { value.topology.treasuryWatchOnly.address = ''; }],
    ['substituted split transaction', (value: ReturnType<typeof payload>) => { value.topology.treasuryWatchOnly.splitTransactionId = 'f'.repeat(64); }],
    ['substituted treasury total', (value: ReturnType<typeof payload>) => { value.topology.treasuryWatchOnly.expectedTotalSats = 169_638; }],
    ['nonzero teardown', (value: ReturnType<typeof payload>) => { value.teardown.projectedMonthlyRecurringUsd = 1; }],
    ['overspend', (value: ReturnType<typeof payload>) => { value.budget.spendCapUsd = 201; }],
  ] as const)('rejects signed but unauthorized %s', (_label, mutate) => {
    const value = payload();
    mutate(value);
    expect(() => verifyB1NodeApprovalEnvelope(envelope(value), options)).toThrow();
  });

  it('rejects expired and overlong authority windows', () => {
    const expired = payload();
    expired.expiresAt = '2026-07-16T14:59:59Z';
    expect(() => verifyB1NodeApprovalEnvelope(envelope(expired), options)).toThrow(/valid|window/i);
    const overlong = payload();
    overlong.expiresAt = '2026-07-30T14:00:00Z';
    expect(() => verifyB1NodeApprovalEnvelope(envelope(overlong), options)).toThrow(/seven-day|window/i);
  });
});
