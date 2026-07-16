import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const teardownSource = readFileSync(resolve(here, 'teardown-isolated-rig.sh'), 'utf8');
const roots: string[] = [];

describe('teardown-isolated-rig.sh — RIG-B1 verifier bootstrap trust', () => {
  it('pins the exact production verifier bytes so verifier drift fails closed', () => {
    const verifierSha = createHash('sha256')
      .update(readFileSync(resolve(here, 's33-b1-node-approval.mjs')))
      .digest('hex');
    const pinnedSha = teardownSource.match(
      /^RIG_B1_APPROVAL_VERIFIER_SHA256="([0-9a-f]{64})"$/mu,
    )?.[1];

    expect(pinnedSha).toBe(verifierSha);
  });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

const approvalId = 'b1-node-approval-teardown-fixture';
const projectRef = 'abcdefghijklmnopqrst';
const service = 'arkova-worker-s33-rig-b1-staging';
const runtimeSa = 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com';
const schedulerSa = 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com';
const envelopeSha = `sha256:${'1'.repeat(64)}`;
const payloadSha = `sha256:${'2'.repeat(64)}`;
const sourceHead = '3'.repeat(40);
const sourceTree = '4'.repeat(40);
const corpusDigest = `sha256:${'5'.repeat(64)}`;
const releaseCandidateId = 's33-w3-final-local-rc';
const soakId = 's33-b1-soak';
const leaseId = 's33-b1-lease';
const expiresAt = '2099-01-01T00:00:00Z';
const splitPlanDigest =
  'sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8';
const splitTransactionId =
  '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941';
const bitcoinCoreImage =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8';

const resources = {
  zone: 'us-central1-a',
  vm: 'arkova-s33-rig-b1-bitcoin-core-signet',
  bootDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-boot',
  dataDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-data',
  internalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip',
  externalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip',
  network: 'arkova-s33-rig-b1-bitcoin-core-signet-vpc',
  subnet: 'arkova-s33-rig-b1-bitcoin-core-signet-subnet',
  rpcFirewall: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc',
  vpcConnector: 'arkova-s33-rig-b1-bitcoin-core-signet-connector',
  nodeServiceAccount: 's33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
};

const schedulerJobNames = [
  'batch-anchors',
  'batch-anchors-forced-flush',
  'check-confirmations',
  'org-queue-scheduler',
  'populate-confirmation-proofs',
  'recover-broadcasts',
].map((suffix) => `${service}-${suffix}`);

const secretReferences = [
  ['SUPABASE_URL', 'supabase-url-s33-rig-b1-staging'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'supabase-service-role-key-s33-rig-b1-staging'],
  ['BITCOIN_RPC_URL', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-url'],
  ['BITCOIN_RPC_AUTH', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth'],
  ['BITCOIN_TREASURY_WIF', 'arkova-s33-rig-b1-treasury-wif-signet'],
  ['STRIPE_SECRET_KEY', 'arkova-s33-rig-b1-stripe-secret-key'],
  ['STRIPE_WEBHOOK_SECRET', 'arkova-s33-rig-b1-stripe-webhook-secret'],
  ['API_KEY_HMAC_SECRET', ['arkova-s33-rig-b1', 'api-key-hmac'].join('-')],
  ['CRON_SECRET', ['arkova-s33-rig-b1', 'cron-secret'].join('-')],
].map(([env, secretName]) => ({
  env,
  secretName,
  version: '1',
  resource: `projects/arkova1/secrets/${secretName}/versions/1`,
}));

const exactReadiness = {
  schemaVersion: 'arkova.s33.rig-b1.node-readiness/v1',
  bitcoinCoreVersion: '31.1',
  bitcoinCoreImage,
  sourceTarballSha256:
    'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e',
  chain: 'signet',
  initialBlockDownload: false,
  blocks: 100,
  headers: 100,
  genesisHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  txindexSynced: true,
  txindexBestBlockHeight: 100,
  treasurySplitPlanDigest: splitPlanDigest,
  splitTransactionId,
  confirmedOutputCount: 32,
  confirmedTotalSats: 169_639,
  splitBlockHash: 'a'.repeat(64),
  splitBlockHeader: 'b'.repeat(160),
  txOutProof: 'aa',
};

interface FixtureResult {
  code: number;
  out: string;
  gcloudCalls: string[];
}

function runFixture(
  mutate: (topology: Record<string, unknown>) => void = () => undefined,
): FixtureResult {
  const root = mkdtempSync(join(tmpdir(), 'b1-teardown-readiness-'));
  roots.push(root);
  const staging = join(root, 'scripts/staging');
  const bin = join(root, 'bin');
  mkdirSync(staging, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const teardown = join(staging, 'teardown-isolated-rig.sh');
  const verifier = join(staging, 's33-b1-node-approval.mjs');
  const claimPath = join(root, 'claim.json');
  const topologyPath = join(root, 'topology.json');
  const approvalArtifact = join(root, 'approval.json');
  const gcloudLog = join(root, 'gcloud.log');
  const claimUri =
    `gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/node-approval-claims/${approvalId}.json`;

  const approval = {
    status: 'VERIFIED',
    keyId: 'arkova.s33.b1-evidence.ed25519.v1',
    verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
    envelopeSha256: envelopeSha,
    signedPayloadSha256: payloadSha,
    payload: {
      approvalId,
      authority: {
        approverIdentity: 'arkova.s33.approver.founder-cto.v1',
        purpose: 'RIG_B1_BITCOIN_CORE_PROVISION',
      },
      candidate: {
        sourceHeadSha: sourceHead,
        sourceTreeSha: sourceTree,
        corpusDigest,
        releaseCandidateId,
        bitcoinCoreImage,
        teardownScriptSha256: '',
      },
      run: {
        rigId: 'RIG-B1',
        rigName: 's33-rig-b1',
        soakId,
        leaseId,
        workerService: service,
        workerRuntimeServiceAccount: runtimeSa,
        schedulerOidcServiceAccount: schedulerSa,
      },
      topology: {
        provider: {
          workerProvider: 'rpc',
          primary: 'bitcoin-core-signet-rpc',
          secondary: 'mempool-space-signet',
          secondaryApiUrl: 'https://mempool.space/signet/api',
        },
        resources,
        schedulerJobs: schedulerJobNames,
        secretReferences,
        nodeSecretEnvs: ['BITCOIN_RPC_AUTH'],
        forbiddenNodeSecretEnvs: ['BITCOIN_TREASURY_WIF'],
        treasuryWatchOnly: {
          preSplitPlanDigest: splitPlanDigest,
          splitTransactionId,
          expectedTotalSats: 169_639,
          wifOnNode: false,
        },
      },
      budget: { spendCapUsd: 50 },
      teardown: { projectedMonthlyRecurringUsd: 0 },
      expiresAt,
    },
  };
  writeFileSync(verifier, `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const approval = ${JSON.stringify(approval)};
const teardown = join(dirname(fileURLToPath(import.meta.url)), 'teardown-isolated-rig.sh');
approval.payload.candidate.teardownScriptSha256 =
  'sha256:' + createHash('sha256').update(readFileSync(teardown)).digest('hex');
process.stdout.write(JSON.stringify(approval));
`);
  const verifierSha = createHash('sha256').update(readFileSync(verifier)).digest('hex');
  const nodeSha = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const fixtureSource = teardownSource
    .replace(
      /RIG_B1_APPROVAL_VERIFIER_SHA256="[0-9a-f]+"/,
      `RIG_B1_APPROVAL_VERIFIER_SHA256="${verifierSha}"`,
    )
    .replace(/RIG_B1_TRUSTED_NODE_PATH="[^"]+"/, `RIG_B1_TRUSTED_NODE_PATH="${process.execPath}"`)
    .replace(/RIG_B1_TRUSTED_NODE_SHA256="[0-9a-f]+"/, `RIG_B1_TRUSTED_NODE_SHA256="${nodeSha}"`)
    .replace(/RIG_B1_TRUSTED_NODE_VERSION="[^"]+"/, `RIG_B1_TRUSTED_NODE_VERSION="${process.version}"`);
  writeFileSync(teardown, fixtureSource);
  chmodSync(teardown, 0o755);
  writeFileSync(approvalArtifact, '{}\n');
  writeFileSync(gcloudLog, '');

  const claim = {
    schemaVersion: 'arkova.s33.rig-b1.node-approval-claim/v1',
    approvalId,
    envelopeSha256: envelopeSha,
    signedPayloadSha256: payloadSha,
    sourceHeadSha: sourceHead,
    sourceTreeSha: sourceTree,
    corpusDigest,
    releaseCandidateId,
    soakId,
    leaseId,
    spendCapUsd: 50,
    claimedAt: '2026-07-16T12:00:00Z',
  };
  writeFileSync(claimPath, `${JSON.stringify(claim)}\n`);

  const topology: Record<string, unknown> = {
    schemaVersion: 'arkova.s33.rig-b1.topology-ownership/v1',
    approvalId,
    envelopeSha256: envelopeSha,
    signedPayloadSha256: payloadSha,
    sourceHeadSha: sourceHead,
    sourceTreeSha: sourceTree,
    corpusDigest,
    releaseCandidateId,
    rigId: 'RIG-B1',
    rigName: 's33-rig-b1',
    soakId,
    leaseId,
    gcpProjectId: 'arkova1',
    gcpRegion: 'us-central1',
    supabaseProjectRef: projectRef,
    supabaseProjectName: 'arkova-soak-s33-rig-b1',
    workerService: service,
    workerRuntimeServiceAccount: runtimeSa,
    schedulerOidcServiceAccount: schedulerSa,
    cloudRunServiceUrl: 'https://arkova-worker-s33-rig-b1-staging.example.test',
    resources,
    secretReferences,
    schedulerJobNames,
    generatedSecretNames: [
      'supabase-url-s33-rig-b1-staging',
      'supabase-service-role-key-s33-rig-b1-staging',
    ],
    nodeReadiness: structuredClone(exactReadiness),
    resourceIdentities: {
      cloudRunServiceUid: 'cloudrunuid123',
      vmId: '1000000000000000001',
      bootDiskName: resources.bootDisk,
      bootDiskId: '1000000000000000002',
      dataDiskId: '1000000000000000003',
      internalAddressId: '1000000000000000004',
      externalAddressId: '1000000000000000005',
      rpcFirewallId: '1000000000000000006',
      vpcConnectorName:
        'projects/arkova1/locations/us-central1/connectors/arkova-s33-rig-b1-bitcoin-core-signet-connector',
      subnetId: '1000000000000000007',
      networkId: '1000000000000000008',
      nodeServiceAccountUniqueId: '1000000000000000009',
      workerRuntimeServiceAccountUniqueId: '1000000000000000010',
      schedulerOidcServiceAccountUniqueId: '1000000000000000011',
    },
    approvalClaim: { objectUri: claimUri, generation: '1' },
    projectedMonthlyRecurringUsd: 0,
  };
  mutate(topology);
  writeFileSync(topologyPath, `${JSON.stringify(topology)}\n`);

  const gcloud = join(bin, 'gcloud');
  writeFileSync(gcloud, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${gcloudLog}'
if [[ "$1 $2 $3" == 'storage objects describe' ]]; then
  object_uri="$4"
  object_name="\${object_uri#gs://arkova1-s33-immutable-authority-ledger/}"
  printf '{"bucket":"arkova1-s33-immutable-authority-ledger","name":"%s","generation":"1","retention":{"mode":"Locked","retainUntilTime":"2099-01-02T00:00:00Z"}}\\n' "$object_name"
  exit 0
fi
if [[ "$1 $2" == 'storage cat' ]]; then
  if [[ "$3" == *'/node-approval-claims/'* ]]; then
    cat '${claimPath}'
  else
    cat '${topologyPath}'
  fi
  exit 0
fi
if [[ "$1 $2 $3" == 'run services describe' ]]; then
  echo 'injected post-ownership preflight stop' >&2
  exit 73
fi
echo "unexpected gcloud call: $*" >&2
exit 64
`);
  chmodSync(gcloud, 0o755);

  try {
    execFileSync('bash', [
      teardown,
      '--project-ref', projectRef,
      '--rig-name', 's33-rig-b1',
      '--rig-id', 'RIG-B1',
      '--service', service,
      '--b1-approval-artifact', approvalArtifact,
      '--apply',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CONFIRM_TEARDOWN: projectRef,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: '', gcloudCalls: [] };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: failure.status ?? 1,
      out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      gcloudCalls: readFileSync(gcloudLog, 'utf8').trim().split('\n').filter(Boolean),
    };
  }
}

describe('teardown-isolated-rig.sh — immutable RIG-B1 node readiness', () => {
  it('accepts the exact non-secret readiness object through the next ownership preflight gate', () => {
    const result = runFixture();
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('cannot observe RIG-B1 Cloud Run service before teardown');
    expect(result.out).not.toContain('Locked RIG-B1 topology does not exactly bind');
    expect(result.gcloudCalls.some((call) => call.startsWith('run services describe '))).toBe(true);
    expect(result.gcloudCalls.some((call) => / delete /.test(call))).toBe(false);
  });

  it.each([
    ['missing object', (topology: Record<string, unknown>) => { delete topology.nodeReadiness; }],
    ['unapproved key', (topology: Record<string, unknown>) => {
      topology.nodeReadiness = { ...(topology.nodeReadiness as object), rpcAuth: 'must-not-appear' };
    }],
    ['signed-value mismatch', (topology: Record<string, unknown>) => {
      topology.nodeReadiness = {
        ...(topology.nodeReadiness as object),
        confirmedTotalSats: 169_638,
      };
    }],
  ])('rejects %s before resource preflight or mutation', (_label, mutate) => {
    const result = runFixture(mutate);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain(
      'Locked RIG-B1 topology does not exactly bind the verified approval and teardown targets',
    );
    expect(result.gcloudCalls.some((call) => call.startsWith('run services describe '))).toBe(false);
    expect(result.gcloudCalls.some((call) => / delete /.test(call))).toBe(false);
  });
});
