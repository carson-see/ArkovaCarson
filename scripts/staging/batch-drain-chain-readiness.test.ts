import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectAdmissionV2ToRunDeclaration } from './batch-drain-admission-adapter';
import {
  RIG_B1_SIGNET_SECRET_NAMES,
  assertRigB1PreClockReadiness,
  buildRigB1ReadinessPlan,
  type RigB1PreClockObservation,
} from './batch-drain-chain-readiness';

const ADMISSION_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
  'utf8',
);
const SPLIT_PLAN_DIGEST = `sha256:${'9'.repeat(64)}`;

function ceremonyRaw(): string {
  return JSON.stringify({
    declarationId: 'decl-rig-b1-readiness',
    soakStartedAt: '2026-07-13T12:00:00.000Z',
    soakEndedAt: '2026-07-15T12:31:00.000Z',
    recoveries: [],
    windows: [{
      scenarioId: 'readiness-fixture-window',
      kind: 'eligible-10000',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 1,
      expectedFinalPending: 0,
      passes: [{
        batchId: 'batch-readiness-fixture',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-readiness-fixture',
        faultWindow: {
          id: 'fault-readiness-fixture',
          startsAt: '2026-07-13T12:00:00.000Z',
          endsAt: '2026-07-13T12:05:00.000Z',
        },
        claims: [{ fingerprint: '1'.repeat(64), orgId: 'org-readiness-fixture' }],
      }],
    }],
  });
}

function plan() {
  const admission = projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw());
  return buildRigB1ReadinessPlan(admission, { treasurySplitPlanDigest: SPLIT_PLAN_DIGEST });
}

function observation(
  readiness = plan(),
): RigB1PreClockObservation {
  const observedAt = '2026-07-16T12:00:00.000Z';
  return {
    admissionSha256: readiness.admissionSha256,
    gitHeadSha: readiness.gitHeadSha,
    imageDigest: readiness.imageDigest,
    cleanMirrorAttestationId: readiness.cleanMirrorAttestationId,
    secretVersions: readiness.secretReferences.map((reference, index) => ({
      env: reference.env,
      secretName: reference.secretName,
      resource: `projects/${readiness.gcpProjectId}/secrets/${reference.secretName}/versions/${index + 1}`,
    })),
    schedulerJobs: readiness.schedulerJobs.map((job) => ({ ...job, state: 'PAUSED' as const })),
    getBlockchainInfo: {
      provider: 'getblock',
      rpcMethod: 'getblockchaininfo',
      chain: 'signet',
      observedAt,
    },
    signerReadiness: {
      algorithm: 'secp256k1',
      treasuryAddress: 'tb1qarkovas33rigb1treasuryfixture0000000000000',
      challengeSha256: '4'.repeat(64),
      signatureSha256: '5'.repeat(64),
      verified: true,
      observedAt,
    },
    treasurySplit: {
      planDigest: readiness.treasurySplitPlanDigest,
      confirmedUtxos: 32,
      minimumConfirmations: 1,
      observedAt,
    },
    fundedBroadcast: {
      network: 'signet',
      txId: '6'.repeat(64),
      accepted: true,
      observedAt,
    },
    nodeCron: { mode: 'disabled', observedAt },
  };
}

describe('RIG-B1 signet admission and pre-clock readiness contract', () => {
  it('freezes net-new signet secret names, all six paused jobs, and exact trigger paths', () => {
    const readiness = plan();

    expect(readiness.mode).toBe('OFFLINE_PLAN_ONLY');
    expect(readiness.liveEvidenceStatus).toBe('DEFERRED_POST_WAVE3');
    expect(readiness.secretReferences).toEqual([
      { env: 'BITCOIN_RPC_URL', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcUrl },
      { env: 'BITCOIN_RPC_AUTH', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcAuth },
      { env: 'BITCOIN_TREASURY_WIF', secretName: RIG_B1_SIGNET_SECRET_NAMES.treasuryWif },
    ]);
    expect(readiness.secretReferences.every(({ secretName }) => secretName.includes('signet'))).toBe(true);
    expect(readiness.secretReferences.map(({ secretName }) => secretName)).not.toContain('bitcoin-rpc-url-staging');
    expect(readiness.schedulerJobs.map(({ path }) => path)).toEqual([
      '/jobs/batch-anchors',
      '/jobs/batch-anchors?force=true',
      '/jobs/check-confirmations',
      '/jobs/org-queue-scheduler',
      '/jobs/populate-confirmation-proofs',
      '/jobs/recover-broadcasts',
    ]);
    expect(readiness.drainTriggers).toEqual([
      { trigger: 'global-policy', method: 'POST', path: '/jobs/batch-anchors', body: null },
      { trigger: 'global-flush', method: 'POST', path: '/jobs/batch-anchors?force=true', body: null },
      { trigger: 'org-scheduler', method: 'POST', path: '/jobs/org-queue-scheduler', body: null },
    ]);
  });

  it('accepts only a clean-mirror-bound signet observation with resolved secrets and paused jobs', () => {
    const readiness = plan();
    expect(assertRigB1PreClockReadiness(readiness, observation(readiness))).toMatchObject({
      status: 'PRE_CLOCK_READY',
      schedulerJobsPaused: 6,
      confirmedUtxos: 32,
      fundedBroadcastAccepted: true,
    });
  });

  it('rejects a shared/missing signer secret, wrong chain, stale clean mirror, or an enabled Scheduler', () => {
    const readiness = plan();

    const shared = observation(readiness);
    shared.secretVersions[0] = {
      ...shared.secretVersions[0]!,
      secretName: 'bitcoin-rpc-url-staging',
      resource: `projects/${readiness.gcpProjectId}/secrets/bitcoin-rpc-url-staging/versions/1`,
    };
    expect(() => assertRigB1PreClockReadiness(readiness, shared)).toThrow(/secret|signet|reference/i);

    const missingSigner = observation(readiness);
    missingSigner.secretVersions = missingSigner.secretVersions.filter(({ env }) => env !== 'BITCOIN_TREASURY_WIF');
    expect(() => assertRigB1PreClockReadiness(readiness, missingSigner)).toThrow(/secret|signer|WIF/i);

    const mainnet = observation(readiness);
    mainnet.getBlockchainInfo.chain = 'mainnet';
    expect(() => assertRigB1PreClockReadiness(readiness, mainnet)).toThrow(/signet|chain/i);

    const staleMirror = observation(readiness);
    staleMirror.cleanMirrorAttestationId = `sha256:${'0'.repeat(64)}`;
    expect(() => assertRigB1PreClockReadiness(readiness, staleMirror)).toThrow(/clean.mirror|attestation/i);

    const enabled = observation(readiness);
    enabled.schedulerJobs[2] = { ...enabled.schedulerJobs[2]!, state: 'ENABLED' };
    expect(() => assertRigB1PreClockReadiness(readiness, enabled)).toThrow(/PAUSED|Scheduler/i);
  });

  it('rejects live-adapter reachability gaps, unverified signer readiness, and silent node-cron', () => {
    const readiness = plan();
    const unfunded = observation(readiness);
    unfunded.fundedBroadcast.accepted = false;
    expect(() => assertRigB1PreClockReadiness(readiness, unfunded)).toThrow(/broadcast|accepted/i);

    const signer = observation(readiness);
    signer.signerReadiness.verified = false;
    expect(() => assertRigB1PreClockReadiness(readiness, signer)).toThrow(/signer|verified/i);

    const cron = observation(readiness);
    cron.nodeCron = { mode: 'unattributed', observedAt: '2026-07-16T12:00:00.000Z' };
    expect(() => assertRigB1PreClockReadiness(readiness, cron)).toThrow(/node.cron|attributed|disabled/i);
  });
});
