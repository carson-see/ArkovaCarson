/**
 * Offline RIG-B1 signet readiness contract layered on Team2 admission-v2.
 *
 * Building this plan creates no secrets, infrastructure, funded outputs,
 * schedules, or broadcasts. The validator accepts only later supervised facts
 * bound to the immutable admission identity.
 */

import { createHash } from 'node:crypto';

import {
  requirePreClockAdmissionIdentity,
  type PreClockAdmissionBoundIdentity,
} from './batch-drain-admission-adapter';
import { parseUtcTimestamp } from './batch-drain-time';
import {
  requireTreasuryPresplitPlan,
  type TreasuryPresplitPlan,
} from './batch-drain-utxo-fanout';
import {
  WAVE3_DRAIN_TRIGGER_SPECS,
  type Wave3DrainTriggerSpec,
} from './batch-drain-wave3-driver';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const TX_ID = /^[0-9a-f]{64}$/;

export const RIG_B1_SIGNET_SECRET_NAMES = Object.freeze({
  bitcoinRpcUrl: 'arkova-s33-rig-b1-getblock-rpc-url-signet',
  bitcoinRpcAuth: 'arkova-s33-rig-b1-getblock-rpc-auth-signet',
  treasuryWif: 'arkova-s33-rig-b1-treasury-wif-signet',
});

export const RIG_B1_ACCELERATED_SCHEDULER_CADENCE = '*/5 * * * *' as const;

export type RigB1SecretEnv = 'BITCOIN_RPC_URL' | 'BITCOIN_RPC_AUTH' | 'BITCOIN_TREASURY_WIF';

export interface RigB1SecretReference {
  readonly env: RigB1SecretEnv;
  readonly secretName: string;
}

export interface RigB1SchedulerJob {
  readonly name: string;
  readonly path: string;
  readonly cadence: typeof RIG_B1_ACCELERATED_SCHEDULER_CADENCE;
}

export interface RigB1SchedulerPolicy {
  readonly decision: 'FORCE_ACCELERATED_RIG_ONLY';
  readonly scope: 'ISOLATED_NON_PRODUCTION_S33_ONLY';
  readonly cadence: typeof RIG_B1_ACCELERATED_SCHEDULER_CADENCE;
  readonly requiredStateThroughCleanMirror: 'PAUSED';
  readonly enablePhase: 'AUTHORIZED_POST_WAVE3_EVIDENCE_ONLY';
  readonly productionCadenceMutation: 'FORBIDDEN';
  readonly productionTopologyMutation: 'FORBIDDEN';
}

export interface RigB1ReadinessPlan {
  readonly mode: 'OFFLINE_PLAN_ONLY';
  readonly liveEvidenceStatus: 'DEFERRED_POST_WAVE3';
  readonly admissionSha256: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly gcpProjectId: string;
  readonly workerService: string;
  readonly cleanMirrorAttestationId: string;
  readonly treasurySplitPlanDigest: string;
  readonly treasuryAddress: string;
  readonly signerChallengeSha256: string;
  readonly secretReferences: readonly RigB1SecretReference[];
  readonly schedulerPolicy: Readonly<RigB1SchedulerPolicy>;
  readonly schedulerJobs: readonly RigB1SchedulerJob[];
  readonly drainTriggers: readonly Wave3DrainTriggerSpec[];
}

export interface RigB1PreClockObservation {
  admissionSha256: string;
  gitHeadSha: string;
  imageDigest: string;
  cleanMirrorAttestationId: string;
  secretVersions: Array<{
    env: RigB1SecretEnv;
    secretName: string;
    resource: string;
  }>;
  schedulerPolicy: RigB1SchedulerPolicy & {
    productionCadenceMutationAttempted: boolean;
    productionTopologyMutationAttempted: boolean;
    cleanMirrorAdmissionComplete: boolean;
    evidencePhaseAuthorized: boolean;
    observedAt: string;
  };
  schedulerJobs: Array<RigB1SchedulerJob & {
    state: 'PAUSED' | 'ENABLED';
    createdPaused: boolean;
    pausedThroughCleanMirror: boolean;
    enabledAt: string | null;
  }>;
  getBlockchainInfo: {
    provider: string;
    rpcMethod: string;
    chain: string;
    observedAt: string;
  };
  signerReadiness: {
    algorithm: string;
    treasuryAddress: string;
    challengeSha256: string;
    signatureSha256: string;
    verified: boolean;
    observedAt: string;
  };
  treasurySplit: {
    planDigest: string;
    treasuryAddress: string;
    confirmedUtxos: number;
    minimumConfirmations: number;
    observedAt: string;
  };
  fundedBroadcast: {
    network: string;
    txId: string;
    spentFromTreasuryAddress: string;
    accepted: boolean;
    observedAt: string;
  };
  nodeCron: {
    mode: 'disabled' | 'attributed' | 'unattributed';
    schedulerExecutionIds?: string[];
    observedAt: string;
  };
}

export interface RigB1PreClockReadinessSummary {
  readonly status: 'PRE_CLOCK_READY';
  readonly schedulerJobsPaused: 6;
  readonly schedulerCadence: typeof RIG_B1_ACCELERATED_SCHEDULER_CADENCE;
  readonly schedulerScope: 'ISOLATED_NON_PRODUCTION_S33_ONLY';
  readonly confirmedUtxos: number;
  readonly fundedBroadcastAccepted: true;
}

const READINESS_PLANS = new WeakSet<RigB1ReadinessPlan>();

const JOB_SUFFIXES = [
  ['batch-anchors', '/jobs/batch-anchors'],
  ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true'],
  ['check-confirmations', '/jobs/check-confirmations'],
  ['org-queue-scheduler', '/jobs/org-queue-scheduler'],
  ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs'],
  ['recover-broadcasts', '/jobs/recover-broadcasts'],
] as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireSafeInteger(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
  }
}

function requireSignetTreasuryAddress(value: string, label: string): void {
  if (!/^tb1[a-z0-9]{20,87}$/.test(value)) {
    throw new Error(`${label} must be a bounded lowercase tb1 signet treasury address.`);
  }
}

function signerChallengeSha256(input: {
  gitHeadSha: string;
  treasurySplitPlanDigest: string;
  treasuryAddress: string;
}): string {
  return createHash('sha256').update([
    'ARKOVA_RIG_B1_SIGNER_READINESS_V1',
    input.gitHeadSha,
    input.treasurySplitPlanDigest,
    input.treasuryAddress,
  ].join('\u0000')).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRigB1ReadinessPlan(
  admissionHandle: PreClockAdmissionBoundIdentity,
  input: { readonly treasurySplitPlan: TreasuryPresplitPlan },
): RigB1ReadinessPlan {
  const admission = requirePreClockAdmissionIdentity(admissionHandle);
  const treasurySplitPlan = requireTreasuryPresplitPlan(input.treasurySplitPlan);
  requireSignetTreasuryAddress(treasurySplitPlan.treasuryAddress, 'RIG-B1 treasuryAddress');
  const secretReferences: RigB1SecretReference[] = [
    { env: 'BITCOIN_RPC_URL', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcUrl },
    { env: 'BITCOIN_RPC_AUTH', secretName: RIG_B1_SIGNET_SECRET_NAMES.bitcoinRpcAuth },
    { env: 'BITCOIN_TREASURY_WIF', secretName: RIG_B1_SIGNET_SECRET_NAMES.treasuryWif },
  ];
  const schedulerJobs: RigB1SchedulerJob[] = JOB_SUFFIXES.map(([suffix, path]) => ({
    name: `${admission.workerService}-${suffix}`,
    path,
    cadence: RIG_B1_ACCELERATED_SCHEDULER_CADENCE,
  }));
  const schedulerPolicy: RigB1SchedulerPolicy = {
    decision: 'FORCE_ACCELERATED_RIG_ONLY',
    scope: 'ISOLATED_NON_PRODUCTION_S33_ONLY',
    cadence: RIG_B1_ACCELERATED_SCHEDULER_CADENCE,
    requiredStateThroughCleanMirror: 'PAUSED',
    enablePhase: 'AUTHORIZED_POST_WAVE3_EVIDENCE_ONLY',
    productionCadenceMutation: 'FORBIDDEN',
    productionTopologyMutation: 'FORBIDDEN',
  };
  const plan = deepFreeze<RigB1ReadinessPlan>({
    mode: 'OFFLINE_PLAN_ONLY',
    liveEvidenceStatus: 'DEFERRED_POST_WAVE3',
    admissionSha256: admissionHandle.admissionSha256,
    gitHeadSha: admission.gitHeadSha,
    imageDigest: admission.imageDigest,
    gcpProjectId: admission.gcpProjectId,
    workerService: admission.workerService,
    cleanMirrorAttestationId: admission.cleanMirrorAttestationId,
    treasurySplitPlanDigest: treasurySplitPlan.planDigest,
    treasuryAddress: treasurySplitPlan.treasuryAddress,
    signerChallengeSha256: signerChallengeSha256({
      gitHeadSha: admission.gitHeadSha,
      treasurySplitPlanDigest: treasurySplitPlan.planDigest,
      treasuryAddress: treasurySplitPlan.treasuryAddress,
    }),
    secretReferences,
    schedulerPolicy,
    schedulerJobs,
    drainTriggers: WAVE3_DRAIN_TRIGGER_SPECS.map((trigger) => ({ ...trigger })),
  });
  READINESS_PLANS.add(plan);
  return plan;
}

export function assertRigB1PreClockReadiness(
  plan: RigB1ReadinessPlan,
  observation: RigB1PreClockObservation,
): RigB1PreClockReadinessSummary {
  if (!READINESS_PLANS.has(plan)) throw new Error('RIG-B1 readiness plan lacks admission provenance.');
  if (
    observation.admissionSha256 !== plan.admissionSha256
    || observation.gitHeadSha !== plan.gitHeadSha
    || observation.imageDigest !== plan.imageDigest
  ) throw new Error('RIG-B1 observation does not match admission head/image identity.');
  if (observation.cleanMirrorAttestationId !== plan.cleanMirrorAttestationId) {
    throw new Error('RIG-B1 observation does not match the clean-mirror attestation.');
  }
  if (!HEAD_SHA.test(observation.gitHeadSha) || !SHA256.test(observation.imageDigest)) {
    throw new Error('RIG-B1 observation has malformed immutable head or image identity.');
  }

  if (observation.secretVersions.length !== plan.secretReferences.length) {
    throw new Error('RIG-B1 observation is missing a required signet secret version reference.');
  }
  plan.secretReferences.forEach((expected, index) => {
    const actual = observation.secretVersions[index];
    if (!actual || actual.env !== expected.env || actual.secretName !== expected.secretName) {
      throw new Error(`RIG-B1 signet secret reference ${expected.env} does not match the plan.`);
    }
    if (!actual.secretName.includes('signet') || actual.secretName.includes('bitcoin-rpc-url-staging')) {
      throw new Error(`RIG-B1 ${expected.env} must use its net-new signet secret.`);
    }
    const resourcePattern = new RegExp(
      `^projects/${escapeRegExp(plan.gcpProjectId)}/secrets/${escapeRegExp(expected.secretName)}/versions/[1-9][0-9]*$`,
    );
    if (!resourcePattern.test(actual.resource)) {
      throw new Error(`RIG-B1 ${expected.env} secret reference must resolve an exact numeric version.`);
    }
  });

  parseUtcTimestamp(observation.schedulerPolicy.observedAt, 'Scheduler policy observedAt');
  if (
    observation.schedulerPolicy.decision !== plan.schedulerPolicy.decision
    || observation.schedulerPolicy.scope !== plan.schedulerPolicy.scope
    || observation.schedulerPolicy.cadence !== plan.schedulerPolicy.cadence
    || observation.schedulerPolicy.requiredStateThroughCleanMirror
      !== plan.schedulerPolicy.requiredStateThroughCleanMirror
    || observation.schedulerPolicy.enablePhase !== plan.schedulerPolicy.enablePhase
    || observation.schedulerPolicy.productionCadenceMutation
      !== plan.schedulerPolicy.productionCadenceMutation
    || observation.schedulerPolicy.productionTopologyMutation
      !== plan.schedulerPolicy.productionTopologyMutation
  ) throw new Error('RIG-B1 Scheduler policy does not match FORCE_ACCELERATED_RIG_ONLY.');
  if (
    observation.schedulerPolicy.productionCadenceMutationAttempted
    || observation.schedulerPolicy.productionTopologyMutationAttempted
  ) throw new Error('Production Scheduler cadence/topology mutation is forbidden.');
  if (
    !observation.schedulerPolicy.cleanMirrorAdmissionComplete
    || observation.schedulerPolicy.evidencePhaseAuthorized
  ) throw new Error('RIG-B1 pre-clock Scheduler policy requires completed clean-mirror admission and no evidence-phase enable authority.');

  if (observation.schedulerJobs.length !== plan.schedulerJobs.length) {
    throw new Error('RIG-B1 Scheduler observation must include all six jobs PAUSED.');
  }
  plan.schedulerJobs.forEach((expected, index) => {
    const actual = observation.schedulerJobs[index];
    if (
      !actual
      || actual.name !== expected.name
      || actual.path !== expected.path
      || actual.cadence !== RIG_B1_ACCELERATED_SCHEDULER_CADENCE
      || actual.state !== 'PAUSED'
      || !actual.createdPaused
      || !actual.pausedThroughCleanMirror
      || actual.enabledAt !== null
    ) throw new Error(
      `RIG-B1 Scheduler job ${expected.path} must use the isolated-rig cadence and remain PAUSED through clean-mirror admission without an enable timestamp.`,
    );
  });

  parseUtcTimestamp(observation.getBlockchainInfo.observedAt, 'getblockchaininfo observedAt');
  if (
    observation.getBlockchainInfo.provider !== 'getblock'
    || observation.getBlockchainInfo.rpcMethod !== 'getblockchaininfo'
    || observation.getBlockchainInfo.chain !== 'signet'
  ) throw new Error('GetBlock getblockchaininfo chain must report signet.');

  parseUtcTimestamp(observation.signerReadiness.observedAt, 'signer readiness observedAt');
  if (
    observation.signerReadiness.algorithm !== 'secp256k1'
    || observation.signerReadiness.treasuryAddress !== plan.treasuryAddress
    || observation.signerReadiness.challengeSha256 !== plan.signerChallengeSha256
    || !SHA256_HEX.test(observation.signerReadiness.signatureSha256)
    || !observation.signerReadiness.verified
  ) throw new Error('RIG-B1 secp256k1 signer readiness challenge is not verified for signet.');

  parseUtcTimestamp(observation.treasurySplit.observedAt, 'treasury split observedAt');
  requireSafeInteger(observation.treasurySplit.confirmedUtxos, 'confirmed treasury UTXOs', 32);
  requireSafeInteger(observation.treasurySplit.minimumConfirmations, 'treasury minimum confirmations', 1);
  if (observation.treasurySplit.planDigest !== plan.treasurySplitPlanDigest) {
    throw new Error('RIG-B1 confirmed treasury UTXOs do not match the split plan digest.');
  }
  if (observation.treasurySplit.treasuryAddress !== plan.treasuryAddress) {
    throw new Error('RIG-B1 confirmed treasury UTXOs do not match the planned treasury address.');
  }

  parseUtcTimestamp(observation.fundedBroadcast.observedAt, 'funded broadcast observedAt');
  if (
    observation.fundedBroadcast.network !== 'signet'
    || !TX_ID.test(observation.fundedBroadcast.txId)
    || observation.fundedBroadcast.spentFromTreasuryAddress !== plan.treasuryAddress
    || !observation.fundedBroadcast.accepted
  ) throw new Error('RIG-B1 funded signet broadcast was not accepted from the planned treasury address.');

  parseUtcTimestamp(observation.nodeCron.observedAt, 'node-cron observedAt');
  if (
    observation.nodeCron.mode !== 'disabled'
    && (
      observation.nodeCron.mode !== 'attributed'
      || !observation.nodeCron.schedulerExecutionIds?.length
      || observation.nodeCron.schedulerExecutionIds.some((value) => !value?.trim())
    )
  ) throw new Error('RIG-B1 node-cron must be disabled or explicitly attributed to Scheduler executions.');

  return deepFreeze({
    status: 'PRE_CLOCK_READY' as const,
    schedulerJobsPaused: 6 as const,
    schedulerCadence: RIG_B1_ACCELERATED_SCHEDULER_CADENCE,
    schedulerScope: 'ISOLATED_NON_PRODUCTION_S33_ONLY' as const,
    confirmedUtxos: observation.treasurySplit.confirmedUtxos,
    fundedBroadcastAccepted: true as const,
  });
}
