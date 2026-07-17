/**
 * Offline RIG-B1 signet readiness contract layered on Team2 admission-v2.
 *
 * Building this plan creates no secrets, infrastructure, funded outputs,
 * schedules, or broadcasts. The validator accepts only later supervised facts
 * bound to the immutable admission identity.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  requirePreClockAdmissionIdentity,
  type PreClockAdmissionBoundIdentity,
} from './batch-drain-admission-adapter';
import { parseUtcTimestamp } from './batch-drain-time';
import {
  RIG_B1_MEMPOOL_SIGNET_API_URL,
  RIG_B1_SIGNET_GENESIS_HASH,
  type RigB1Infrastructure,
} from './batch-drain-live-evidence';
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
  bitcoinRpcUrl: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-url',
  bitcoinRpcAuth: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth',
  treasuryWif: 'arkova-s33-rig-b1-treasury-wif-signet',
});

export const RIG_B1_REQUIRED_RPC_CAPABILITIES = Object.freeze([
  'sendrawtransaction',
  'getrawtransaction',
  'getmempoolentry',
  'getblockheader',
  'gettxoutproof',
] as const);

export const RIG_B1_ACCELERATED_SCHEDULER_CADENCE = '*/5 * * * *' as const;

export type RigB1SecretEnv = 'BITCOIN_RPC_URL' | 'BITCOIN_RPC_AUTH' | 'BITCOIN_TREASURY_WIF';

export interface RigB1SecretReference {
  readonly env: RigB1SecretEnv;
  readonly secretName: string;
  readonly version: string;
  readonly resource: string;
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
  readonly infrastructure: Readonly<RigB1EffectiveInfrastructure>;
  readonly continuityCompositeIdentitySha256?: string;
  readonly secretReferences: readonly RigB1SecretReference[];
  readonly schedulerPolicy: Readonly<RigB1SchedulerPolicy>;
  readonly schedulerJobs: readonly RigB1SchedulerJob[];
  readonly drainTriggers: readonly Wave3DrainTriggerSpec[];
}

type RigB1EffectiveInfrastructure = Omit<
  RigB1Infrastructure,
  'treasuryWatchOnly' | 'nodeReadiness'
> & {
  readonly treasuryWatchOnly: Omit<
    RigB1Infrastructure['treasuryWatchOnly'],
    'preSplitPlanDigest' | 'expectedConfirmedOutputCount' | 'expectedTotalSats'
  > & {
    readonly preSplitPlanDigest: string;
    readonly expectedConfirmedOutputCount: number;
    readonly expectedTotalSats: number;
  };
  readonly nodeReadiness: Omit<
    RigB1Infrastructure['nodeReadiness'],
    'treasurySplitPlanDigest' | 'confirmedOutputCount' | 'confirmedTotalSats'
  > & {
    readonly treasurySplitPlanDigest: string;
    readonly confirmedOutputCount: number;
    readonly confirmedTotalSats: number;
  };
};

export interface RigB1PreClockObservation {
  admissionSha256: string;
  gitHeadSha: string;
  imageDigest: string;
  cleanMirrorAttestationId: string;
  secretVersions: Array<{
    env: RigB1SecretEnv;
    secretName: string;
    version: string;
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
    provider: 'bitcoin-core-signet-rpc';
    rpcMethod: 'getblockchaininfo';
    chain: 'signet';
    initialBlockDownload: boolean;
    headers: number;
    blocks: number;
    bestBlockHash: string;
    genesisHash: string;
    observedAt: string;
  };
  txindex: {
    rpcMethod: 'getindexinfo';
    synced: boolean;
    bestBlockHeight: number;
    observedAt: string;
  };
  watchOnlyWallet: {
    walletName: 'arkova-watch-only';
    privateKeysEnabled: boolean;
    descriptors: boolean;
    treasuryAddress: string;
    treasuryDescriptor: string;
    descriptorImported: boolean;
    rescanComplete: boolean;
    confirmedUtxos: number;
    confirmedTotalSats: number;
    minimumConfirmations: number;
    observedAt: string;
  };
  capabilityProbes: Array<{
    rpcMethod: typeof RIG_B1_REQUIRED_RPC_CAPABILITIES[number];
    available: boolean;
    nonBroadcastProbe: boolean;
    observedAt: string;
  }>;
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
  mempoolCorroboration: {
    provider: 'mempool-space-signet';
    baseUrl: typeof RIG_B1_MEMPOOL_SIGNET_API_URL;
    tipHeight: number;
    tipHash: string;
    txId: string;
    txOutcome: 'found';
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

const rigB1SecretVersionObservationSchema = z.object({
  env: z.enum(['BITCOIN_RPC_URL', 'BITCOIN_RPC_AUTH', 'BITCOIN_TREASURY_WIF']),
  secretName: z.string(),
  version: z.string().regex(/^[1-9][0-9]*$/),
  resource: z.string(),
}).strict();

const rigB1SchedulerPolicyObservationSchema = z.object({
  decision: z.literal('FORCE_ACCELERATED_RIG_ONLY'),
  scope: z.literal('ISOLATED_NON_PRODUCTION_S33_ONLY'),
  cadence: z.literal(RIG_B1_ACCELERATED_SCHEDULER_CADENCE),
  requiredStateThroughCleanMirror: z.literal('PAUSED'),
  enablePhase: z.literal('AUTHORIZED_POST_WAVE3_EVIDENCE_ONLY'),
  productionCadenceMutation: z.literal('FORBIDDEN'),
  productionTopologyMutation: z.literal('FORBIDDEN'),
  productionCadenceMutationAttempted: z.boolean(),
  productionTopologyMutationAttempted: z.boolean(),
  cleanMirrorAdmissionComplete: z.boolean(),
  evidencePhaseAuthorized: z.boolean(),
  observedAt: z.string(),
}).strict();

const rigB1SchedulerJobObservationSchema = z.object({
  name: z.string(),
  path: z.string(),
  cadence: z.literal(RIG_B1_ACCELERATED_SCHEDULER_CADENCE),
  state: z.enum(['PAUSED', 'ENABLED']),
  createdPaused: z.boolean(),
  pausedThroughCleanMirror: z.boolean(),
  enabledAt: z.string().nullable(),
}).strict();

const rigB1PreClockObservationSchema = z.object({
  admissionSha256: z.string(),
  gitHeadSha: z.string(),
  imageDigest: z.string(),
  cleanMirrorAttestationId: z.string(),
  secretVersions: z.array(rigB1SecretVersionObservationSchema),
  schedulerPolicy: rigB1SchedulerPolicyObservationSchema,
  schedulerJobs: z.array(rigB1SchedulerJobObservationSchema),
  getBlockchainInfo: z.object({
    provider: z.literal('bitcoin-core-signet-rpc'),
    rpcMethod: z.literal('getblockchaininfo'),
    chain: z.literal('signet'),
    initialBlockDownload: z.boolean(),
    headers: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    bestBlockHash: z.string(),
    genesisHash: z.string(),
    observedAt: z.string(),
  }).strict(),
  txindex: z.object({
    rpcMethod: z.literal('getindexinfo'),
    synced: z.boolean(),
    bestBlockHeight: z.number().int().nonnegative(),
    observedAt: z.string(),
  }).strict(),
  watchOnlyWallet: z.object({
    walletName: z.literal('arkova-watch-only'),
    privateKeysEnabled: z.boolean(),
    descriptors: z.boolean(),
    treasuryAddress: z.string(),
    treasuryDescriptor: z.string(),
    descriptorImported: z.boolean(),
    rescanComplete: z.boolean(),
    confirmedUtxos: z.number().int().nonnegative(),
    confirmedTotalSats: z.number().int().nonnegative().safe(),
    minimumConfirmations: z.number().int().nonnegative(),
    observedAt: z.string(),
  }).strict(),
  capabilityProbes: z.array(z.object({
    rpcMethod: z.enum(RIG_B1_REQUIRED_RPC_CAPABILITIES),
    available: z.boolean(),
    nonBroadcastProbe: z.boolean(),
    observedAt: z.string(),
  }).strict()),
  signerReadiness: z.object({
    algorithm: z.string(),
    treasuryAddress: z.string(),
    challengeSha256: z.string(),
    signatureSha256: z.string(),
    verified: z.boolean(),
    observedAt: z.string(),
  }).strict(),
  treasurySplit: z.object({
    planDigest: z.string(),
    treasuryAddress: z.string(),
    confirmedUtxos: z.number(),
    minimumConfirmations: z.number(),
    observedAt: z.string(),
  }).strict(),
  fundedBroadcast: z.object({
    network: z.string(),
    txId: z.string(),
    spentFromTreasuryAddress: z.string(),
    accepted: z.boolean(),
    observedAt: z.string(),
  }).strict(),
  mempoolCorroboration: z.object({
    provider: z.literal('mempool-space-signet'),
    baseUrl: z.literal(RIG_B1_MEMPOOL_SIGNET_API_URL),
    tipHeight: z.number().int().nonnegative(),
    tipHash: z.string(),
    txId: z.string(),
    txOutcome: z.literal('found'),
    observedAt: z.string(),
  }).strict(),
  nodeCron: z.object({
    mode: z.enum(['disabled', 'attributed', 'unattributed']),
    schedulerExecutionIds: z.array(z.string()).optional(),
    observedAt: z.string(),
  }).strict(),
}).strict();

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
  const continuity = admission.treasuryContinuity;
  const infrastructure: RigB1EffectiveInfrastructure = continuity === undefined
    ? structuredClone(admission.infrastructure)
    : {
      ...structuredClone(admission.infrastructure),
      treasuryWatchOnly: {
        ...structuredClone(admission.infrastructure.treasuryWatchOnly),
        preSplitPlanDigest: continuity.currentTreasury.planDigest,
        expectedConfirmedOutputCount: continuity.currentTreasury.confirmedOutputCount,
        expectedTotalSats: continuity.currentTreasury.confirmedTotalSats,
      },
      nodeReadiness: {
        ...structuredClone(admission.infrastructure.nodeReadiness),
        treasurySplitPlanDigest: continuity.currentTreasury.planDigest,
        confirmedOutputCount: continuity.currentTreasury.confirmedOutputCount,
        confirmedTotalSats: continuity.currentTreasury.confirmedTotalSats,
      },
    };
  requireSignetTreasuryAddress(treasurySplitPlan.treasuryAddress, 'RIG-B1 treasuryAddress');
  if (infrastructure.treasuryWatchOnly.address !== treasurySplitPlan.treasuryAddress) {
    throw new Error('RIG-B1 signed watch-only treasury address differs from the pre-split plan.');
  }
  const signedTreasury = infrastructure.treasuryWatchOnly;
  const plannedTotalSats = treasurySplitPlan.outputs.reduce((sum, output) => sum + output.valueSats, 0);
  if (
    signedTreasury.preSplitPlanDigest !== treasurySplitPlan.planDigest
    || signedTreasury.expectedConfirmedOutputCount !== treasurySplitPlan.outputCount
    || signedTreasury.expectedTotalSats !== plannedTotalSats
  ) {
    throw new Error('RIG-B1 signed treasury inventory differs from the exact pre-split plan.');
  }
  const readinessSecretEnvs: readonly RigB1SecretEnv[] = [
    'BITCOIN_RPC_URL', 'BITCOIN_RPC_AUTH', 'BITCOIN_TREASURY_WIF',
  ];
  const secretReferences: RigB1SecretReference[] = readinessSecretEnvs.map((env) => {
    const matches = admission.infrastructure.secretReferences.filter((reference) => reference.env === env);
    if (matches.length !== 1) {
      throw new Error(`RIG-B1 admission lacks one exact ${env} readiness reference.`);
    }
    return { ...matches[0], env };
  });
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
    infrastructure,
    ...(continuity === undefined
      ? {}
      : { continuityCompositeIdentitySha256: continuity.compositeIdentitySha256 }),
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
  rawObservation: unknown,
): RigB1PreClockReadinessSummary {
  if (!READINESS_PLANS.has(plan)) throw new Error('RIG-B1 readiness plan lacks admission provenance.');
  const observation = rigB1PreClockObservationSchema.parse(
    rawObservation,
  ) as RigB1PreClockObservation;
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
    if (
      !actual
      || actual.env !== expected.env
      || actual.secretName !== expected.secretName
      || actual.version !== expected.version
      || actual.resource !== expected.resource
    ) {
      throw new Error(`RIG-B1 signet secret reference ${expected.env} does not match the plan.`);
    }
    if (!actual.secretName.includes('signet') || actual.secretName.includes('bitcoin-rpc-url-staging')) {
      throw new Error(`RIG-B1 ${expected.env} must use its net-new signet secret.`);
    }
    const resourcePattern = new RegExp(
      `^projects/${escapeRegExp(plan.gcpProjectId)}/secrets/${escapeRegExp(expected.secretName)}/versions/${escapeRegExp(expected.version)}$`,
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
    observation.getBlockchainInfo.provider !== 'bitcoin-core-signet-rpc'
    || observation.getBlockchainInfo.rpcMethod !== 'getblockchaininfo'
    || observation.getBlockchainInfo.chain !== 'signet'
    || observation.getBlockchainInfo.initialBlockDownload
    || observation.getBlockchainInfo.headers !== observation.getBlockchainInfo.blocks
    || !TX_ID.test(observation.getBlockchainInfo.bestBlockHash)
    || observation.getBlockchainInfo.genesisHash !== RIG_B1_SIGNET_GENESIS_HASH
  ) throw new Error('Bitcoin Core readiness requires synced Signet headers/blocks and the exact genesis hash.');

  parseUtcTimestamp(observation.txindex.observedAt, 'txindex observedAt');
  if (
    observation.txindex.rpcMethod !== 'getindexinfo'
    || !observation.txindex.synced
    || observation.txindex.bestBlockHeight !== observation.getBlockchainInfo.blocks
  ) throw new Error('Bitcoin Core txindex must be synced to the exact ready Signet tip.');

  parseUtcTimestamp(observation.watchOnlyWallet.observedAt, 'watch-only wallet observedAt');
  if (
    observation.watchOnlyWallet.walletName !== 'arkova-watch-only'
    || observation.watchOnlyWallet.privateKeysEnabled
    || !observation.watchOnlyWallet.descriptors
    || observation.watchOnlyWallet.treasuryAddress !== plan.treasuryAddress
    || !observation.watchOnlyWallet.descriptorImported
    || !observation.watchOnlyWallet.rescanComplete
    || observation.watchOnlyWallet.treasuryDescriptor
      !== plan.infrastructure.treasuryWatchOnly.descriptor
    || observation.watchOnlyWallet.confirmedUtxos
      !== plan.infrastructure.treasuryWatchOnly.expectedConfirmedOutputCount
    || observation.watchOnlyWallet.confirmedTotalSats
      !== plan.infrastructure.treasuryWatchOnly.expectedTotalSats
    || observation.watchOnlyWallet.minimumConfirmations < 1
  ) throw new Error('Bitcoin Core readiness requires the descriptor watch-only wallet with private keys disabled.');

  if (
    observation.capabilityProbes.length !== RIG_B1_REQUIRED_RPC_CAPABILITIES.length
    || observation.capabilityProbes.some((probe, index) => (
      probe.rpcMethod !== RIG_B1_REQUIRED_RPC_CAPABILITIES[index]
      || !probe.available
      || !probe.nonBroadcastProbe
    ))
  ) throw new Error('Bitcoin Core readiness requires every exact non-broadcast RPC capability probe.');
  observation.capabilityProbes.forEach((probe) => {
    parseUtcTimestamp(probe.observedAt, `${probe.rpcMethod} capability observedAt`);
  });

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
  if (
    observation.treasurySplit.confirmedUtxos
      !== plan.infrastructure.treasuryWatchOnly.expectedConfirmedOutputCount
    || observation.treasurySplit.confirmedUtxos !== observation.watchOnlyWallet.confirmedUtxos
    || observation.treasurySplit.minimumConfirmations !== observation.watchOnlyWallet.minimumConfirmations
  ) throw new Error('RIG-B1 treasury split observation differs from the signed watch-only inventory.');

  parseUtcTimestamp(observation.fundedBroadcast.observedAt, 'funded broadcast observedAt');
  if (
    observation.fundedBroadcast.network !== 'signet'
    || !TX_ID.test(observation.fundedBroadcast.txId)
    || observation.fundedBroadcast.spentFromTreasuryAddress !== plan.treasuryAddress
    || !observation.fundedBroadcast.accepted
  ) throw new Error('RIG-B1 funded signet broadcast was not accepted from the planned treasury address.');

  parseUtcTimestamp(observation.mempoolCorroboration.observedAt, 'mempool.space corroboration observedAt');
  if (
    observation.mempoolCorroboration.provider !== 'mempool-space-signet'
    || observation.mempoolCorroboration.baseUrl !== RIG_B1_MEMPOOL_SIGNET_API_URL
    || observation.mempoolCorroboration.tipHeight !== observation.getBlockchainInfo.blocks
    || observation.mempoolCorroboration.tipHash !== observation.getBlockchainInfo.bestBlockHash
    || observation.mempoolCorroboration.txId !== observation.fundedBroadcast.txId
    || observation.mempoolCorroboration.txOutcome !== 'found'
    || parseUtcTimestamp(observation.mempoolCorroboration.observedAt, 'mempool.space corroboration observedAt')
      < parseUtcTimestamp(observation.fundedBroadcast.observedAt, 'funded broadcast observedAt')
  ) throw new Error('mempool.space Signet must exactly corroborate the Bitcoin Core tip and funded transaction.');

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
