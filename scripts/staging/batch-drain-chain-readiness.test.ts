import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  projectAdmissionV2ToPreClockIdentity,
  projectAdmissionV2ToRunDeclaration,
} from './batch-drain-admission-adapter';
import { planTreasuryPresplit, type TreasuryPresplitPlan } from './batch-drain-utxo-fanout';
import {
  RIG_B1_ACCELERATED_SCHEDULER_CADENCE,
  RIG_B1_SIGNET_SECRET_NAMES,
  assertRigB1PreClockReadiness,
  buildRigB1ReadinessPlan,
  type RigB1PreClockObservation,
} from './batch-drain-chain-readiness';

const ADMISSION_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
  'utf8',
);
const TREASURY_ADDRESS = 'tb1qarkovas33rigb1treasuryfixture0000000000000';
const OTHER_TREASURY_ADDRESS = 'tb1qdifferenttreasuryaddress0000000000000000000';

function preClockAdmissionRaw(): string {
  const admission = JSON.parse(ADMISSION_RAW) as { scheduler: { state: string } };
  admission.scheduler.state = 'paused_after_clean_mirror';
  return JSON.stringify(admission);
}

function completedCeremonyRaw(): string {
  return JSON.stringify({
    declarationId: 'decl-rig-b1-completed-only',
    soakStartedAt: '2026-07-13T12:00:00.000Z',
    soakEndedAt: '2026-07-15T12:31:00.000Z',
    recoveries: [],
    windows: [{
      scenarioId: 'completed-only-window',
      kind: 'eligible-10000',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 1,
      expectedFinalPending: 0,
      passes: [{
        batchId: 'batch-completed-only',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-completed-only',
        faultWindow: {
          id: 'fault-completed-only',
          startsAt: '2026-07-13T12:00:00.000Z',
          endsAt: '2026-07-13T12:05:00.000Z',
        },
        claims: [{ fingerprint: '1'.repeat(64), orgId: 'org-completed-only' }],
      }],
    }],
  });
}

function admission() {
  return projectAdmissionV2ToPreClockIdentity(preClockAdmissionRaw());
}

function splitPlan(): TreasuryPresplitPlan {
  return planTreasuryPresplit({
    planId: 's33-w3-b-rig-b1-readiness-split',
    network: 'signet',
    treasuryAddress: TREASURY_ADDRESS,
    inputs: [{
      txId: '7'.repeat(64), vout: 0, valueSats: 3_200_000,
      confirmations: 6,
    }],
    outputCount: 32,
    feeSats: 3_200,
    minOutputSats: 1_000,
  });
}

function plan() {
  return buildRigB1ReadinessPlan(admission(), { treasurySplitPlan: splitPlan() });
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
    schedulerPolicy: {
      ...readiness.schedulerPolicy,
      productionCadenceMutationAttempted: false,
      productionTopologyMutationAttempted: false,
      cleanMirrorAdmissionComplete: true,
      evidencePhaseAuthorized: false,
      observedAt,
    },
    schedulerJobs: readiness.schedulerJobs.map((job) => ({
      ...job,
      state: 'PAUSED' as const,
      createdPaused: true,
      pausedThroughCleanMirror: true,
      enabledAt: null,
    })),
    getBlockchainInfo: {
      provider: 'getblock',
      rpcMethod: 'getblockchaininfo',
      chain: 'signet',
      observedAt,
    },
    signerReadiness: {
      algorithm: 'secp256k1',
      treasuryAddress: TREASURY_ADDRESS,
      challengeSha256: readiness.signerChallengeSha256,
      signatureSha256: '5'.repeat(64),
      verified: true,
      observedAt,
    },
    treasurySplit: {
      planDigest: readiness.treasurySplitPlanDigest,
      treasuryAddress: TREASURY_ADDRESS,
      confirmedUtxos: 32,
      minimumConfirmations: 1,
      observedAt,
    },
    fundedBroadcast: {
      network: 'signet',
      txId: '6'.repeat(64),
      spentFromTreasuryAddress: TREASURY_ADDRESS,
      accepted: true,
      observedAt,
    },
    nodeCron: { mode: 'disabled', observedAt },
  };
}

describe('RIG-B1 signet admission and pre-clock readiness contract', () => {
  it('builds before any clock only from paused admission and rejects resumed/completed-soak input', () => {
    expect(plan()).toMatchObject({ mode: 'OFFLINE_PLAN_ONLY' });
    expect(() => projectAdmissionV2ToPreClockIdentity(ADMISSION_RAW))
      .toThrow(/paused_after_clean_mirror|Pre-clock admission/i);

    const completed = JSON.parse(preClockAdmissionRaw()) as Record<string, unknown>;
    Object.assign(completed, {
      soakStartedAt: '2026-07-13T12:00:00.000Z',
      soakEndedAt: '2026-07-15T12:31:00.000Z',
      windows: [],
      recoveries: [],
    });
    expect(() => projectAdmissionV2ToPreClockIdentity(JSON.stringify(completed)))
      .toThrow(/unrecognized|unknown|Pre-clock admission/i);

    const completedRun = projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, completedCeremonyRaw());
    expect(() => buildRigB1ReadinessPlan(
      completedRun as never,
      { treasurySplitPlan: splitPlan() },
    )).toThrow(/paused admission provenance|pre-clock readiness/i);
  });

  it('freezes net-new signet secret names, the rig-only five-minute cadence, and exact A/B/D causes', () => {
    const readiness = plan();

    expect(readiness.mode).toBe('OFFLINE_PLAN_ONLY');
    expect(readiness.liveEvidenceStatus).toBe('DEFERRED_POST_WAVE3');
    expect(readiness.treasuryAddress).toBe(TREASURY_ADDRESS);
    expect(readiness.signerChallengeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readiness.secretReferences).toEqual([
      { env: 'BITCOIN_RPC_URL', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcUrl },
      { env: 'BITCOIN_RPC_AUTH', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcAuth },
      { env: 'BITCOIN_TREASURY_WIF', secretName: RIG_B1_SIGNET_SECRET_NAMES.treasuryWif },
    ]);
    expect(readiness.secretReferences.every(({ secretName }) => secretName.includes('signet'))).toBe(true);
    expect(readiness.secretReferences.map(({ secretName }) => secretName)).not.toContain('bitcoin-rpc-url-staging');
    expect(readiness.schedulerPolicy).toEqual({
      decision: 'FORCE_ACCELERATED_RIG_ONLY',
      scope: 'ISOLATED_NON_PRODUCTION_S33_ONLY',
      cadence: RIG_B1_ACCELERATED_SCHEDULER_CADENCE,
      requiredStateThroughCleanMirror: 'PAUSED',
      enablePhase: 'AUTHORIZED_POST_WAVE3_EVIDENCE_ONLY',
      productionCadenceMutation: 'FORBIDDEN',
      productionTopologyMutation: 'FORBIDDEN',
    });
    expect(readiness.schedulerJobs.every(({ cadence }) => cadence === '*/5 * * * *')).toBe(true);
    expect(readiness.schedulerJobs.map(({ path }) => path)).toEqual([
      '/jobs/batch-anchors',
      '/jobs/batch-anchors?force=true',
      '/jobs/check-confirmations',
      '/jobs/org-queue-scheduler',
      '/jobs/populate-confirmation-proofs',
      '/jobs/recover-broadcasts',
    ]);
    expect(readiness.drainTriggers).toEqual([
      expect.objectContaining({
        trigger: 'trigger-a-size', cause: 'SIZE_THRESHOLD',
        path: '/jobs/batch-anchors',
      }),
      expect.objectContaining({
        trigger: 'trigger-b-age', cause: 'AGE_THRESHOLD',
        path: '/jobs/batch-anchors',
      }),
      expect.objectContaining({
        trigger: 'trigger-d-force', cause: 'FORCE',
        path: '/jobs/batch-anchors?force=true',
      }),
      expect.objectContaining({
        trigger: 'org-scheduler', cause: 'ORG_SCHEDULER',
        path: '/jobs/org-queue-scheduler',
      }),
    ]);
  });

  it('rejects a caller-spliced digest/address pair without pre-split plan provenance', () => {
    const split = splitPlan();
    const spliced = {
      ...split,
      treasuryAddress: OTHER_TREASURY_ADDRESS,
    } as TreasuryPresplitPlan;
    expect(() => buildRigB1ReadinessPlan(admission(), { treasurySplitPlan: spliced }))
      .toThrow(/validated|provenance|pre-split plan/i);
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

  it('rejects secret material at the reference-only pre-clock ingress', () => {
    const readiness = plan();
    const withSecretValues = observation(readiness) as unknown as {
      secretVersions: Array<Record<string, unknown>>;
    };
    const simulatedValues = [
      'https://rpc-user:rpc-password@getblock.example',
      'rpc-user:rpc-password',
      'cSimulatedSignetWifMustNeverCrossThisBoundary',
    ];
    withSecretValues.secretVersions.forEach((secret, index) => {
      secret.secretValue = simulatedValues[index];
    });

    expect(() => assertRigB1PreClockReadiness(readiness, withSecretValues))
      .toThrow(/unrecognized|secretValue|strict|secret material/i);
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
    enabled.schedulerJobs[2] = {
      ...enabled.schedulerJobs[2]!,
      state: 'ENABLED',
      pausedThroughCleanMirror: false,
      enabledAt: '2026-07-16T11:59:00.000Z',
    };
    expect(() => assertRigB1PreClockReadiness(readiness, enabled))
      .toThrow(/PAUSED|admission|enabled|Scheduler/i);

    const productionCadence = observation(readiness);
    productionCadence.schedulerPolicy.productionCadenceMutationAttempted = true;
    expect(() => assertRigB1PreClockReadiness(readiness, productionCadence))
      .toThrow(/production|cadence|forbidden/i);

    const productionTopology = observation(readiness);
    productionTopology.schedulerPolicy.productionTopologyMutationAttempted = true;
    expect(() => assertRigB1PreClockReadiness(readiness, productionTopology))
      .toThrow(/production|topology|forbidden/i);
  });

  it('rejects live-adapter reachability gaps, unverified signer readiness, and silent node-cron', () => {
    const readiness = plan();
    const unfunded = observation(readiness);
    unfunded.fundedBroadcast.accepted = false;
    expect(() => assertRigB1PreClockReadiness(readiness, unfunded)).toThrow(/broadcast|accepted/i);

    const signer = observation(readiness);
    signer.signerReadiness.verified = false;
    expect(() => assertRigB1PreClockReadiness(readiness, signer)).toThrow(/signer|verified/i);

    const wrongSignerAddress = observation(readiness);
    wrongSignerAddress.signerReadiness.treasuryAddress = OTHER_TREASURY_ADDRESS;
    expect(() => assertRigB1PreClockReadiness(readiness, wrongSignerAddress))
      .toThrow(/signer|treasury|address/i);

    const wrongBroadcastAddress = observation(readiness);
    wrongBroadcastAddress.fundedBroadcast.spentFromTreasuryAddress = OTHER_TREASURY_ADDRESS;
    expect(() => assertRigB1PreClockReadiness(readiness, wrongBroadcastAddress))
      .toThrow(/broadcast|treasury|address/i);

    const cron = observation(readiness);
    cron.nodeCron = { mode: 'unattributed', observedAt: '2026-07-16T12:00:00.000Z' };
    expect(() => assertRigB1PreClockReadiness(readiness, cron)).toThrow(/node.cron|attributed|disabled/i);
  });
});
