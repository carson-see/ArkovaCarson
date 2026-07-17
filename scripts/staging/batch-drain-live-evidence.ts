#!/usr/bin/env -S npx tsx
/**
 * S3.3 RIG-B1 evidence consumer.
 *
 * The immutable run declaration and all six capture digests are authenticated
 * by one independently Ed25519-signed envelope. Filesystem permissions are
 * defense in depth only and are never treated as the authenticity boundary.
 * Scheduler, worker-log, DB, signet, Cloud Run, and supervisor captures are
 * six independent raw exports whose exact SHA-256 digests are named by that
 * declaration. Runtime facts are derived only after strict schema validation;
 * a combined caller-authored "evidence bundle" is intentionally unsupported.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, types as utilTypes } from 'node:util';

import { z } from 'zod';

import {
  DRAIN_WINDOW_KINDS,
  assertDrainPassObservation,
  assertDrainWindowSemantic,
  assertDrainWindowObservation,
  isPoisonDrainWindowKind,
  type DrainPassEvidenceSummary,
  type DrainPassObservation,
  type DrainWindowEvidenceSummary,
  type DrainWindowExpectation,
} from './batch-drain-observation';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { parseUtcTimestamp, strictUtcTimestampSchema } from './batch-drain-time';

export const LIVE_EVIDENCE_ENABLE_VALUE = 'ARKOVA_S33_COLLECT_LIVE_RAW_EVIDENCE';
export const SOAK_FLOOR_MINUTES = 2_880;
export const SOAK_REQUIRED_UPTIME_MINUTES = SOAK_FLOOR_MINUTES;
export const SOAK_WALL_FLOOR_MINUTES = SOAK_FLOOR_MINUTES + 30;
export const MAX_HEARTBEAT_GAP_MINUTES = 5;
export const DEFAULT_EVIDENCE_TRUST_ROOT = '/var/lib/arkova/s33-evidence/trust-roots';
export const DEFAULT_EVIDENCE_CAPTURE_ROOT = '/var/lib/arkova/s33-evidence/captures';

// Founder/CTO-confirmed public verification authority. Private material stays
// in external custody; CLI flags and environment variables are never consulted.
const B1_EVIDENCE_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';

export interface S33B1EvidenceVerificationAuthority {
  readonly keyId: 'arkova.s33.b1-evidence.ed25519.v1';
  readonly purpose: 'B1_EVIDENCE';
  readonly publicKeyFingerprintSha256: string;
  readonly authorizedOperator: 'arkova.s33.operator.key-custodian.v1';
  readonly activatedAtUtc: '2026-07-16T13:52:06Z';
  readonly genesisRosterRootSha256: string;
}

const B1_EVIDENCE_VERIFICATION_AUTHORITY: S33B1EvidenceVerificationAuthority = Object.freeze({
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  purpose: 'B1_EVIDENCE',
  publicKeyFingerprintSha256: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  authorizedOperator: 'arkova.s33.operator.key-custodian.v1',
  activatedAtUtc: '2026-07-16T13:52:06Z',
  genesisRosterRootSha256:
    'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
});

export function getS33B1EvidenceVerificationAuthority(): S33B1EvidenceVerificationAuthority {
  return B1_EVIDENCE_VERIFICATION_AUTHORITY;
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const projectRef = z.string().regex(/^[a-z]{20}$/);
const uuid = z.string().uuid();
const nonEmpty = z.string().min(1);
const isoTimestamp = strictUtcTimestampSchema;
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const rawCaptureDigestsSchema = z.object({
  scheduler: sha256Hex,
  workerLogs: sha256Hex,
  database: sha256Hex,
  signet: sha256Hex,
  cloudRun: sha256Hex,
  supervisor: sha256Hex,
}).strict();

const claimSchema = z.object({ fingerprint: sha256Hex, orgId: nonEmpty }).strict();
const faultWindowSchema = z.object({ id: nonEmpty, startsAt: isoTimestamp, endsAt: isoTimestamp }).strict();
const passBaseShape = {
  armedTrigger: z.enum(['org-scheduler', 'global-policy', 'global-flush']),
  schedulerExecutionId: nonEmpty,
  faultWindow: faultWindowSchema,
  claims: z.array(claimSchema).min(1),
} as const;
const broadcastPassExpectationSchema = z.object({
  outcome: z.literal('broadcast'),
  batchId: nonEmpty,
  ...passBaseShape,
}).strict();
const noBroadcastPassExpectationSchema = z.object({
  outcome: z.literal('no-broadcast'),
  outcomeId: nonEmpty,
  armedTrigger: z.literal('org-scheduler'),
  schedulerExecutionId: nonEmpty,
  faultWindow: faultWindowSchema,
  claims: z.array(claimSchema).length(1),
  deniedGate: z.object({
    fingerprint: sha256Hex,
    orgId: nonEmpty,
    decision: z.literal('denied'),
    reason: nonEmpty,
    referenceId: nonEmpty,
    requiredAmount: positiveInteger,
    balanceBefore: nonNegativeInteger,
    balanceAfter: nonNegativeInteger,
  }).strict(),
}).strict().superRefine((pass, context) => {
  const claim = pass.claims[0];
  if (claim?.fingerprint !== pass.deniedGate.fingerprint
    || claim.orgId !== pass.deniedGate.orgId
    || pass.deniedGate.balanceAfter !== pass.deniedGate.balanceBefore) {
    context.addIssue({
      code: 'custom',
      path: ['deniedGate'],
      message: 'No-broadcast denial gate must bind the sole claim and preserve its balance.',
    });
  }
});
const passExpectationSchema = z.discriminatedUnion('outcome', [
  broadcastPassExpectationSchema,
  noBroadcastPassExpectationSchema,
]);
const windowExpectationSchema = z.object({
  scenarioId: nonEmpty,
  kind: z.enum(DRAIN_WINDOW_KINDS),
  armedTrigger: z.enum(['org-scheduler', 'global-policy', 'global-flush']),
  expectedInitialPending: nonNegativeInteger,
  expectedFinalPending: nonNegativeInteger,
  passes: z.array(passExpectationSchema).min(1),
}).strict();
const recoveryExpectationSchema = z.object({
  schedulerExecutionId: nonEmpty,
  correlatedDrainExecutionId: nonEmpty,
  faultWindowId: nonEmpty,
}).strict();

export const RIG_B1_BITCOIN_CORE_VERSION = '31.1' as const;
export const RIG_B1_BITCOIN_CORE_SOURCE_URL =
  'https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz' as const;
export const RIG_B1_BITCOIN_CORE_SOURCE_SHA256 =
  'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e' as const;
export const RIG_B1_MEMPOOL_SIGNET_API_URL = 'https://mempool.space/signet/api' as const;
export const RIG_B1_SIGNET_GENESIS_HASH =
  '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6' as const;

const numericSecretVersion = z.string().regex(/^[1-9][0-9]*$/);
const secretResource = z.string().regex(
  /^projects\/arkova1\/secrets\/[A-Za-z][A-Za-z0-9_-]{0,254}\/versions\/[1-9][0-9]*$/,
);
export const RIG_B1_SECRET_REFERENCE_BINDINGS = [
  ['SUPABASE_URL', 'supabase-url-s33-rig-b1-staging'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'supabase-service-role-key-s33-rig-b1-staging'],
  ['STRIPE_SECRET_KEY', 'arkova-s33-rig-b1-stripe-secret-key'],
  ['STRIPE_WEBHOOK_SECRET', 'arkova-s33-rig-b1-stripe-webhook-secret'],
  ['API_KEY_HMAC_SECRET', 'arkova-s33-rig-b1-api-key-hmac'],
  ['CRON_SECRET', 'arkova-s33-rig-b1-cron-secret'],
  ['BITCOIN_RPC_URL', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-url'],
  ['BITCOIN_RPC_AUTH', 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth'],
  ['BITCOIN_TREASURY_WIF', 'arkova-s33-rig-b1-treasury-wif-signet'],
] as const;

function exactRigB1SecretReferenceSchema<
  Env extends typeof RIG_B1_SECRET_REFERENCE_BINDINGS[number][0],
  Name extends typeof RIG_B1_SECRET_REFERENCE_BINDINGS[number][1],
>(env: Env, secretName: Name) {
  return z.object({
    env: z.literal(env),
    secretName: z.literal(secretName),
    version: numericSecretVersion,
    resource: secretResource,
  }).strict().superRefine((reference, context) => {
    if (reference.resource
      !== `projects/arkova1/secrets/${secretName}/versions/${reference.version}`) {
      context.addIssue({
        code: 'custom',
        path: ['resource'],
        message: 'RIG-B1 secret resource must bind its exact name and numeric version.',
      });
    }
  });
}

export const rigB1SecretReferencesSchema = z.tuple([
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[0]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[1]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[2]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[3]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[4]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[5]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[6]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[7]),
  exactRigB1SecretReferenceSchema(...RIG_B1_SECRET_REFERENCE_BINDINGS[8]),
]);

const rigB1NodeReadinessSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.node-readiness/v1'),
  bitcoinCoreVersion: z.literal(RIG_B1_BITCOIN_CORE_VERSION),
  bitcoinCoreImage: z.literal(
    'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8',
  ),
  sourceTarballSha256: z.literal(RIG_B1_BITCOIN_CORE_SOURCE_SHA256),
  chain: z.literal('signet'),
  initialBlockDownload: z.literal(false),
  blocks: z.number().int().nonnegative().safe(),
  headers: z.number().int().nonnegative().safe(),
  genesisHash: z.literal(RIG_B1_SIGNET_GENESIS_HASH),
  txindexSynced: z.literal(true),
  txindexBestBlockHeight: z.number().int().nonnegative().safe(),
  treasurySplitPlanDigest: imageDigest,
  splitTransactionId: z.literal(
    '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941',
  ),
  confirmedOutputCount: z.literal(32),
  confirmedTotalSats: z.union([
    z.literal(169_639),
    z.literal(169_482),
    z.literal(169_168),
  ]),
  splitBlockHash: sha256Hex,
  splitBlockHeader: z.string().regex(/^[0-9a-f]{160}$/),
  txOutProof: z.string().regex(/^(?:[0-9a-f]{2})+$/),
}).strict().superRefine((value, context) => {
  if (value.headers !== value.blocks
    || value.txindexBestBlockHeight !== value.blocks) {
    context.addIssue({
      code: 'custom',
      path: ['txindexBestBlockHeight'],
      message: 'RIG-B1 readiness heights must agree exactly.',
    });
  }
});

export const rigB1InfrastructureSchema = z.object({
  provider: z.object({
    workerProvider: z.literal('rpc'),
    primary: z.literal('bitcoin-core-signet-rpc'),
    secondary: z.literal('mempool-space-signet'),
    secondaryApiUrl: z.literal(RIG_B1_MEMPOOL_SIGNET_API_URL),
  }).strict(),
  bitcoinCore: z.object({
    version: z.literal(RIG_B1_BITCOIN_CORE_VERSION),
    recipeCommit: z.literal('b9a54856c9bee87d958cc4b070776828b5c17b32'),
    sourceTarballUrl: z.literal(RIG_B1_BITCOIN_CORE_SOURCE_URL),
    sourceTarballSha256: z.literal(RIG_B1_BITCOIN_CORE_SOURCE_SHA256),
    containerImage: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
    amd64RuntimeDigest: z.literal(
      'sha256:684e80900f124890c45ad9b691d7f76456c1042385bce4ab92725b1979b55888',
    ),
    startupScriptPath: z.literal('scripts/staging/start-rig-b1-bitcoin-core.sh'),
    startupScriptSha256: sha256Hex,
  }).strict(),
  resources: z.object({
    zone: z.literal('us-central1-a'),
    vm: z.literal('arkova-s33-rig-b1-bitcoin-core-signet'),
    bootDisk: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-boot'),
    dataDisk: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-data'),
    internalAddress: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip'),
    externalAddress: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip'),
    network: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-vpc'),
    subnet: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-subnet'),
    rpcFirewall: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-rpc'),
    vpcConnector: z.literal('arkova-s33-b1-signet-vpc'),
    nodeServiceAccount: z.literal(
      's33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
    ),
  }).strict(),
  schedulerJobs: z.array(z.string().regex(
    /^arkova-worker-[a-z0-9-]+-staging-(batch-anchors|batch-anchors-forced-flush|check-confirmations|org-queue-scheduler|populate-confirmation-proofs|recover-broadcasts)$/,
  )).length(6),
  iam: z.object({
    artifactRegistryReader: z.object({
      repository: z.literal('projects/arkova1/locations/us-central1/repositories/arkova-worker-images'),
      member: z.literal(
        'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
      ),
      role: z.literal('roles/artifactregistry.reader'),
    }).strict(),
    rpcAuthSecretAccessor: z.object({
      secretName: z.literal('arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth'),
      member: z.literal(
        'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
      ),
      role: z.literal('roles/secretmanager.secretAccessor'),
    }).strict(),
  }).strict(),
  network: z.object({
    rpcEndpoint: z.literal('http://10.33.10.10:38332'),
    rpcBind: z.literal('10.33.10.10'),
    rpcAllowCidr: z.literal('10.33.11.0/28'),
    subnetCidr: z.literal('10.33.10.0/28'),
    rpcPort: z.literal(38_332),
    signetP2pPort: z.literal(38_333),
    publicRpc: z.literal(false),
  }).strict(),
  secretReferences: rigB1SecretReferencesSchema,
  nodeSecretEnvs: z.tuple([z.literal('BITCOIN_RPC_AUTH')]),
  forbiddenNodeSecretEnvs: z.tuple([z.literal('BITCOIN_TREASURY_WIF')]),
  treasuryWatchOnly: z.object({
    address: z.string().regex(/^tb1[a-z0-9]{20,87}$/),
    descriptor: z.string().regex(/^addr\(tb1[a-z0-9]{20,87}\)#[a-z0-9]{8}$/),
    splitTransactionId: z.literal(
      '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941',
    ),
    preSplitPlanDigest: imageDigest,
    expectedConfirmedOutputCount: z.literal(32),
    expectedTotalSats: z.number().int().positive().safe(),
    descriptorPolicy: z.literal('addr-checksummed-importdescriptors'),
    wifOnNode: z.literal(false),
  }).strict(),
  nodeReadiness: rigB1NodeReadinessSchema,
  authority: z.object({
    binding: z.literal('ed25519-signed-node-approval'),
    approvalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/),
    approvalEnvelopeSha256: imageDigest,
    signedPayloadSha256: imageDigest,
    spendCapUsd: z.number().int().min(1).max(200),
    claim: z.object({
      backend: z.literal('gcs-if-generation-match-0-locked-retention'),
      objectUri: z.string().regex(
        /^gs:\/\/arkova1-s33-immutable-authority-ledger\/s33\/rig-b1\/node-approval-claims\/[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}\.json$/,
      ),
      generation: numericSecretVersion,
    }).strict(),
  }).strict(),
  teardown: z.object({
    orderedResources: z.tuple([
      z.literal('scheduler-jobs'),
      z.literal('cloud-run-service'),
      z.literal('bitcoin-core-vm'),
      z.literal('boot-disk'),
      z.literal('data-disk'),
      z.literal('external-address'),
      z.literal('internal-address'),
      z.literal('rpc-firewall'),
      z.literal('vpc-connector'),
      z.literal('subnet'),
      z.literal('vpc-network'),
      z.literal('artifact-registry-iam'),
      z.literal('node-secret-iam'),
      z.literal('node-service-account'),
      z.literal('worker-secret-iam'),
      z.literal('worker-runtime-service-account'),
      z.literal('scheduler-oidc-service-account'),
      z.literal('supabase-project'),
    ]),
    projectedMonthlyRecurringUsd: z.literal(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (
    value.nodeReadiness.treasurySplitPlanDigest
      !== value.treasuryWatchOnly.preSplitPlanDigest
    || value.nodeReadiness.confirmedOutputCount
      !== value.treasuryWatchOnly.expectedConfirmedOutputCount
    || value.nodeReadiness.confirmedTotalSats
      !== value.treasuryWatchOnly.expectedTotalSats
  ) {
    context.addIssue({
      code: 'custom',
      path: ['nodeReadiness'],
      message: 'RIG-B1 node readiness treasury plan, output count, and total must exactly match treasuryWatchOnly.',
    });
  }
});

export type RigB1Infrastructure = z.infer<typeof rigB1InfrastructureSchema>;

export const runDeclarationSchema = z.object({
  schemaVersion: z.literal(1),
  declarationId: nonEmpty,
  gitBaseSha: headSha,
  gitHeadSha: headSha,
  imageDigest,
  rigId: z.literal('RIG-B1'),
  gcpProjectId: nonEmpty,
  projectRef,
  soakId: nonEmpty,
  leaseId: nonEmpty,
  cleanMirrorAttestationId: nonEmpty,
  workerService: nonEmpty,
  workerRevision: nonEmpty,
  region: nonEmpty,
  infrastructure: rigB1InfrastructureSchema,
  soakStartedAt: isoTimestamp,
  soakEndedAt: isoTimestamp,
  recoveries: z.array(recoveryExpectationSchema),
  windows: z.array(windowExpectationSchema).min(1),
}).strict();

export type RunDeclaration = z.infer<typeof runDeclarationSchema>;
type BroadcastPassExpectation = z.infer<typeof broadcastPassExpectationSchema>;
type NoBroadcastPassExpectation = z.infer<typeof noBroadcastPassExpectationSchema>;

export interface ImmutableRunDeclaration {
  readonly value: RunDeclaration;
  readonly contentSha256: string;
  readonly trustRootId: string;
  readonly trustRootSha256: string;
  readonly rawCaptureDigests: RawCaptureDigests;
}

const VERIFIED_DECLARATIONS = new WeakSet<ImmutableRunDeclaration>();

const evidenceTrustRootSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  keyId: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,127}$/),
  keyFingerprint: sha256Hex,
  signedPayloadRaw: nonEmpty,
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

const evidenceSignedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  declaration: runDeclarationSchema,
  rawCaptureDigests: rawCaptureDigestsSchema,
}).strict();

const commonRawFields = {
  schemaVersion: z.literal(1),
  exportId: nonEmpty,
  declarationSha256: sha256Hex,
  rigId: z.literal('RIG-B1'),
  soakId: nonEmpty,
  gitHeadSha: headSha,
  imageDigest,
  generatedAt: isoTimestamp,
};

const schedulerRecordSchema = z.object({
  recordId: nonEmpty,
  purpose: z.enum(['preclock', 'drain', 'recovery']),
  schedulerExecutionId: nonEmpty,
  correlatedDrainExecutionId: nonEmpty.nullable(),
  faultWindowId: nonEmpty.nullable(),
  gcpProjectId: nonEmpty,
  workerRevision: nonEmpty,
  workerId: nonEmpty,
  path: z.string().regex(/^\/jobs\/[a-z0-9-]+(?:\?[A-Za-z0-9_=&%-]+)?$/),
  trigger: z.enum(['org-scheduler', 'global-policy', 'global-flush']),
  statusCode: z.number().int(),
  firedAt: isoTimestamp,
  completedAt: isoTimestamp,
}).strict();
const schedulerCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-scheduler'),
  records: z.array(schedulerRecordSchema).min(1),
}).strict();

const workerLogRecordSchema = z.object({
  recordId: nonEmpty,
  insertId: nonEmpty,
  traceId: nonEmpty,
  workerId: nonEmpty,
  event: z.enum(['trigger-fired', 'credit-gate']),
  schedulerExecutionId: nonEmpty,
  batchId: nonEmpty.nullable(),
  trigger: z.enum(['org-scheduler', 'global-policy', 'global-flush']),
  fingerprint: sha256Hex.nullable(),
  orgId: nonEmpty.nullable(),
  decision: z.enum(['not-required', 'allowed', 'denied']).nullable(),
  reason: nonEmpty.nullable(),
  referenceId: nonEmpty.nullable(),
  requiredAmount: nonNegativeInteger.nullable(),
  balanceBefore: nonNegativeInteger.nullable(),
  balanceAfter: nonNegativeInteger.nullable(),
  occurredAt: isoTimestamp,
}).strict();
const workerLogsCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-logging'),
  records: z.array(workerLogRecordSchema).min(1),
}).strict();

const dbExecutionSchema = z.object({
  batchId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  armedTrigger: z.enum(['org-scheduler', 'global-policy', 'global-flush']),
  faultWindowId: nonEmpty,
  workerId: nonEmpty,
  startedAt: isoTimestamp,
  completedAt: isoTimestamp,
  pendingBefore: nonNegativeInteger,
  pendingAfter: nonNegativeInteger,
}).strict();
const dbDeniedOutcomeSchema = z.object({
  outcomeId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  faultWindowId: nonEmpty,
  workerId: nonEmpty,
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  batchId: z.null(),
  status: z.literal('PENDING'),
  chainTxId: z.null(),
  merkleRoot: z.null(),
  creditDenialReason: nonEmpty,
  queueCreditChargedAt: z.null(),
  queueCreditDeniedAt: isoTimestamp,
  pendingBefore: nonNegativeInteger,
  pendingAfter: nonNegativeInteger,
  startedAt: isoTimestamp,
  completedAt: isoTimestamp,
}).strict();
const dbPassRowSchema = z.object({
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  batchId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  claimOrder: positiveInteger,
  status: z.enum(['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'FAILED']),
  chainTxId: sha256Hex.nullable(),
  merkleRoot: sha256Hex.nullable(),
  creditDenialReason: nonEmpty.nullable(),
  queueCreditChargedAt: isoTimestamp.nullable(),
  queueCreditDeniedAt: isoTimestamp.nullable(),
}).strict();
const dbTransactionSchema = z.object({
  txId: sha256Hex,
  batchId: nonEmpty,
  merkleRoot: sha256Hex,
  signedBytesSha256: sha256Hex,
}).strict();
const dbJournalLeafSchema = z.object({
  anchorId: uuid,
  fingerprint: sha256Hex,
}).strict();
const dbJournalRowSchema = z.object({
  journalId: uuid,
  batchId: nonEmpty,
  txId: sha256Hex,
  fingerprintRoot: sha256Hex,
  anchorIds: z.array(uuid).min(1).max(10_000),
  leafOrder: z.array(dbJournalLeafSchema).min(1).max(10_000),
  signedAt: isoTimestamp,
  recoveryStatus: z.enum(['PENDING', 'HELD', 'ADOPTED', 'REVERTED', 'PERSISTED']),
  holdReason: nonEmpty.nullable(),
  heldAt: isoTimestamp.nullable(),
  resolvedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).strict();
const dbLeafSchema = z.object({
  txId: sha256Hex,
  batchId: nonEmpty,
  anchorId: uuid,
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  merkleIndex: nonNegativeInteger,
}).strict();
const proofSiblingSchema = z.object({ hash: sha256Hex, position: z.enum(['left', 'right']) }).strict();
const dbProofSchema = dbLeafSchema.extend({
  merkleRoot: sha256Hex,
  leafCount: positiveInteger,
  proofPath: z.array(proofSiblingSchema),
}).strict();
const dbLedgerEventSchema = z.object({
  eventId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  kind: z.enum(['debit', 'refund']),
  amount: positiveInteger,
  referenceId: nonEmpty,
  occurredAt: isoTimestamp,
}).strict();
const dbOrgBalanceSchema = z.object({
  schedulerExecutionId: nonEmpty,
  orgId: nonEmpty,
  before: nonNegativeInteger,
  after: nonNegativeInteger,
}).strict();
const dbLedgerDeltaSchema = z.object({
  schedulerExecutionId: nonEmpty,
  orgId: nonEmpty,
  delta: z.number().int(),
}).strict();
const databaseCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('db-query-export'),
  projectRef,
  queryId: nonEmpty,
  isolation: z.literal('repeatable-read'),
  executions: z.array(dbExecutionSchema).min(1),
  deniedOutcomes: z.array(dbDeniedOutcomeSchema),
  passRows: z.array(dbPassRowSchema).min(1),
  transactions: z.array(dbTransactionSchema).min(1),
  journalRows: z.array(dbJournalRowSchema).min(1),
  txLeaves: z.array(dbLeafSchema).min(1),
  proofs: z.array(dbProofSchema).min(1),
  creditLedgerEvents: z.array(dbLedgerEventSchema),
  orgBalances: z.array(dbOrgBalanceSchema).min(1),
  ledgerDeltas: z.array(dbLedgerDeltaSchema).min(1),
}).strict();

const signetRecordSchema = z.object({
  recordId: nonEmpty,
  rpcRequestId: nonEmpty,
  rpcMethod: z.enum(['getrawtransaction', 'getmempoolentry', 'gettransaction']),
  schedulerExecutionId: nonEmpty,
  workerId: nonEmpty,
  txId: sha256Hex,
  batchId: nonEmpty,
  merkleRoot: sha256Hex,
  rawTxSha256: sha256Hex,
  nodeId: nonEmpty,
  network: z.literal('signet'),
  state: z.enum(['mempool', 'confirmed']),
  observedAt: isoTimestamp,
}).strict();
const signetCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('signet-rpc'),
  records: z.array(signetRecordSchema).min(1),
}).strict();

const cloudRunLifecycleSchema = z.object({
  recordId: nonEmpty,
  workerId: nonEmpty,
  event: z.enum(['started', 'heartbeat', 'stopped', 'crash-loop', 'endpoint-eviction']),
  occurredAt: isoTimestamp,
}).strict();
const cloudRunCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-run-lifecycle'),
  gcpProjectId: nonEmpty,
  workerService: nonEmpty,
  workerRevision: nonEmpty,
  region: nonEmpty,
  records: z.array(cloudRunLifecycleSchema).min(2),
}).strict();

const supervisorEventSchema = z.object({
  recordId: nonEmpty,
  event: z.enum(['started', 'heartbeat', 'stopped', 'death']),
  occurredAt: isoTimestamp,
}).strict();
const supervisorCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('supervisor-records'),
  cleanMirror: z.object({
    attestationId: nonEmpty,
    result: z.literal('pass'),
    projectRef,
    gitBaseSha: headSha,
    gitHeadSha: headSha,
    observedAt: isoTimestamp,
  }).strict(),
  lease: z.object({
    leaseId: nonEmpty,
    state: z.literal('active'),
    holder: nonEmpty,
    acquiredAt: isoTimestamp,
    expiresAt: isoTimestamp,
  }).strict(),
  runnerId: nonEmpty,
  supervisor: nonEmpty,
  mode: z.literal('log-and-continue'),
  records: z.array(supervisorEventSchema).min(4),
}).strict();

export type SchedulerCapture = z.infer<typeof schedulerCaptureSchema>;
export type WorkerLogsCapture = z.infer<typeof workerLogsCaptureSchema>;
export type DatabaseCapture = z.infer<typeof databaseCaptureSchema>;
export type SignetCapture = z.infer<typeof signetCaptureSchema>;
export type CloudRunCapture = z.infer<typeof cloudRunCaptureSchema>;
export type SupervisorCapture = z.infer<typeof supervisorCaptureSchema>;

export interface RawCaptureTextSet {
  scheduler: string;
  workerLogs: string;
  database: string;
  signet: string;
  cloudRun: string;
  supervisor: string;
}

export interface ParsedRawCaptureSet {
  scheduler: SchedulerCapture;
  workerLogs: WorkerLogsCapture;
  database: DatabaseCapture;
  signet: SignetCapture;
  cloudRun: CloudRunCapture;
  supervisor: SupervisorCapture;
  contentDigests: RawCaptureDigests;
}

const VERIFIED_CAPTURE_PROVENANCE = new WeakMap<ParsedRawCaptureSet, ImmutableRunDeclaration>();

export interface RawCaptureDigests {
  scheduler: string;
  workerLogs: string;
  database: string;
  signet: string;
  cloudRun: string;
  supervisor: string;
}

export interface RawCaptureFileArguments {
  schedulerFile: string;
  workerLogsFile: string;
  databaseFile: string;
  signetFile: string;
  cloudRunFile: string;
  supervisorFile: string;
}

export interface LiveEvidenceExecutionEnv {
  ARKOVA_LIVE_EVIDENCE_EXECUTION?: string;
  ARKOVA_LIVE_EVIDENCE_SOAK_ID?: string;
}

export interface KnownLiveSourceCollectors {
  collectScheduler(declaration: ImmutableRunDeclaration): Promise<string>;
  collectWorkerLogs(declaration: ImmutableRunDeclaration): Promise<string>;
  collectDatabase(declaration: ImmutableRunDeclaration): Promise<string>;
  collectSignet(declaration: ImmutableRunDeclaration): Promise<string>;
  collectCloudRun(declaration: ImmutableRunDeclaration): Promise<string>;
  collectSupervisor(declaration: ImmutableRunDeclaration): Promise<string>;
}

export type KnownSourceKind = keyof RawCaptureTextSet;

export interface KnownSourceTransport {
  collect(request: {
    source: KnownSourceKind;
    declaration: RunDeclaration;
    declarationSha256: string;
  }): Promise<string>;
}

/** Concrete source-specific collector: source names and binding arguments are fixed. */
export class KnownSourceCollectorsAdapter implements KnownLiveSourceCollectors {
  constructor(
    private readonly transport: KnownSourceTransport,
    private readonly env: LiveEvidenceExecutionEnv,
  ) {}

  private async collect(source: KnownSourceKind, declaration: ImmutableRunDeclaration): Promise<string> {
    assertLiveCollectionGate(declaration, this.env);
    return this.transport.collect({
      source,
      declaration: declaration.value,
      declarationSha256: declaration.contentSha256,
    });
  }

  collectScheduler(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('scheduler', declaration); }
  collectWorkerLogs(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('workerLogs', declaration); }
  collectDatabase(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('database', declaration); }
  collectSignet(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('signet', declaration); }
  collectCloudRun(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('cloudRun', declaration); }
  collectSupervisor(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('supervisor', declaration); }
}

export class CapturedFileRawSourceCollector {
  constructor(private readonly files: RawCaptureFileArguments) {}

  async collect(): Promise<RawCaptureTextSet> {
    const [scheduler, workerLogs, database, signet, cloudRun, supervisor] = await Promise.all([
      readCaptureFile(this.files.schedulerFile),
      readCaptureFile(this.files.workerLogsFile),
      readCaptureFile(this.files.databaseFile),
      readCaptureFile(this.files.signetFile),
      readCaptureFile(this.files.cloudRunFile),
      readCaptureFile(this.files.supervisorFile),
    ]);
    return { scheduler, workerLogs, database, signet, cloudRun, supervisor };
  }
}

export function resolveCaptureFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  if (
    dirname(resolved) !== DEFAULT_EVIDENCE_CAPTURE_ROOT
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}\.json$/.test(basename(resolved))
  ) throw new Error('Capture file path must be one allowlisted JSON file directly inside the fixed capture root.');
  return resolved;
}

async function readCaptureFile(filePath: string): Promise<string> {
  const safePath = resolveCaptureFilePath(filePath);
  const handle = await open(safePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Raw capture export must be a regular file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function parseJson(raw: string, label: string): unknown {
  return parseJsonRejectingDuplicateKeys(raw, label);
}

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const result = schema.safeParse(parseJson(raw, label));
  if (!result.success) throw new Error(`${label} schema rejected: ${z.prettifyError(result.error)}`);
  return result.data;
}

function time(value: string, label: string): number {
  return parseUtcTimestamp(value, label);
}

function unique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities.`);
}

export function assertRunDeclarationInvariants(value: RunDeclaration): void {
  if (value.gitBaseSha === value.gitHeadSha) throw new Error('Declaration git base and tested head must be distinct named commits.');
  const expectedSecrets = RIG_B1_SECRET_REFERENCE_BINDINGS;
  value.infrastructure.secretReferences.forEach((reference, index) => {
    const expected = expectedSecrets[index];
    if (
      !expected
      || reference.env !== expected[0]
      || reference.secretName !== expected[1]
      || reference.resource
        !== `projects/arkova1/secrets/${reference.secretName}/versions/${reference.version}`
    ) throw new Error('Signed RIG-B1 infrastructure secret references are not exact numeric-version bindings.');
  });
  const schedulerSuffixes = [
    'batch-anchors',
    'batch-anchors-forced-flush',
    'check-confirmations',
    'org-queue-scheduler',
    'populate-confirmation-proofs',
    'recover-broadcasts',
  ];
  const expectedSchedulerJobs = schedulerSuffixes.map((suffix) => `${value.workerService}-${suffix}`);
  if (
    value.infrastructure.schedulerJobs.length !== expectedSchedulerJobs.length
    || value.infrastructure.schedulerJobs.some((job, index) => job !== expectedSchedulerJobs[index])
  ) throw new Error('Signed RIG-B1 infrastructure must enumerate the exact six worker Scheduler identities.');
  if (
    !value.infrastructure.treasuryWatchOnly.descriptor.startsWith(
      `addr(${value.infrastructure.treasuryWatchOnly.address})#`,
    )
  ) throw new Error('Signed RIG-B1 watch-only descriptor does not bind the exact treasury address.');
  if (time(value.soakEndedAt, 'soakEndedAt') - time(value.soakStartedAt, 'soakStartedAt') < SOAK_WALL_FLOOR_MINUTES * 60_000) {
    throw new Error('Declared soak wall window cannot contain the fixed 48h floor plus 30-minute overshoot.');
  }
  unique(value.windows.map((window) => window.scenarioId), 'declaration windows');
  const passes = value.windows.flatMap((window) => window.passes);
  const broadcastPasses = passes.filter((pass) => pass.outcome === 'broadcast');
  const noBroadcastPasses = passes.filter((pass) => pass.outcome === 'no-broadcast');
  unique(broadcastPasses.map((pass) => pass.batchId), 'declaration broadcast batch IDs');
  unique(noBroadcastPasses.map((pass) => pass.outcomeId), 'declaration no-broadcast outcome IDs');
  unique(passes.flatMap((pass) => pass.claims.map((claim) => claim.fingerprint)), 'declaration claim fingerprints');
  for (const window of value.windows) {
    const executionIds = new Set(window.passes.map((pass) => pass.schedulerExecutionId));
    const faultWindowIds = new Set(window.passes.map((pass) => pass.faultWindow.id));
    const hasNoBroadcastPass = window.passes.some((pass) => pass.outcome === 'no-broadcast');
    if (isPoisonDrainWindowKind(window.kind) !== hasNoBroadcastPass) {
      throw new Error('Exactly poison-isolation semantic windows must declare a distinct no-broadcast denial pass.');
    }
    if (window.armedTrigger === 'org-scheduler') {
      if (executionIds.size !== 1 || faultWindowIds.size !== 1) {
        throw new Error('An org-scheduler window must preserve ordered per-org passes under one execution and fault window.');
      }
    } else if (executionIds.size !== window.passes.length
      || faultWindowIds.size !== window.passes.length
      || window.passes.some((pass) => pass.outcome !== 'broadcast')) {
      throw new Error('A global window requires distinct broadcast Scheduler executions and fault windows.');
    }
  }
  unique(value.recoveries.map((recovery) => recovery.schedulerExecutionId), 'declaration recovery executions');
  const drainExecutionIds = new Set(passes.map((pass) => pass.schedulerExecutionId));
  const faultWindowByDrainExecution = new Map<string, string>();
  for (const pass of passes) {
    const existing = faultWindowByDrainExecution.get(pass.schedulerExecutionId);
    if (existing !== undefined && existing !== pass.faultWindow.id) {
      throw new Error('One Scheduler execution cannot span multiple declared fault windows.');
    }
    faultWindowByDrainExecution.set(pass.schedulerExecutionId, pass.faultWindow.id);
  }
  if (value.recoveries.some((recovery) => (
    !drainExecutionIds.has(recovery.correlatedDrainExecutionId)
    || faultWindowByDrainExecution.get(recovery.correlatedDrainExecutionId) !== recovery.faultWindowId
    || drainExecutionIds.has(recovery.schedulerExecutionId)
  ))) throw new Error('Every recovery must be distinct and correlate to the exact same declared drain execution and fault window.');
  const soakStartMs = time(value.soakStartedAt, 'soakStartedAt');
  const soakEndMs = time(value.soakEndedAt, 'soakEndedAt');
  for (const pass of value.windows.flatMap((window) => window.passes)) {
    const faultStartMs = time(pass.faultWindow.startsAt, 'faultWindow.startsAt');
    const faultEndMs = time(pass.faultWindow.endsAt, 'faultWindow.endsAt');
    if (faultStartMs < soakStartMs || faultEndMs > soakEndMs || faultEndMs <= faultStartMs) {
      throw new Error('Every declared fault window must be ordered and contained by the named soak window.');
    }
    unique(pass.claims.map((claim) => claim.fingerprint), `claims for ${pass.schedulerExecutionId}`);
  }
  if (value.windows.some((window) => window.passes.some((pass) => pass.armedTrigger !== window.armedTrigger))) {
    throw new Error('Every declared pass must match its window armed trigger.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export interface EvidenceEnvelopeVerifier {
  verify(raw: unknown): ImmutableRunDeclaration;
}

interface EvidenceVerifierConfig {
  keyId: string;
  publicKeyPem: string;
  keyFingerprint: string;
}

function assertPlainVerifierConfig(config: unknown): asserts config is EvidenceVerifierConfig {
  if (!config || typeof config !== 'object' || utilTypes.isProxy(config) || Object.getPrototypeOf(config) !== Object.prototype) {
    throw new Error('Evidence verifier configuration must be a plain non-proxy data object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(config);
  if (
    Reflect.ownKeys(config).some((key) => typeof key !== 'string')
    || Object.keys(descriptors).sort(compareCodeUnits).join(',') !== 'keyFingerprint,keyId,publicKeyPem'
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || descriptor.get || descriptor.set)
    || typeof descriptors.publicKeyPem?.value !== 'string'
    || typeof descriptors.keyFingerprint?.value !== 'string'
    || typeof descriptors.keyId?.value !== 'string'
  ) throw new Error('Evidence verifier configuration rejects getters, unknown keys, and ambiguous values.');
}

class Ed25519EvidenceEnvelopeVerifier implements EvidenceEnvelopeVerifier {
  private readonly publicKey;
  private readonly keyId: string;
  private readonly keyFingerprint: string;

  constructor(config: EvidenceVerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Evidence verification key must be Ed25519.');
    const actualFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (actualFingerprint !== config.keyFingerprint) throw new Error('Evidence verification key fingerprint mismatch.');
    this.keyId = config.keyId;
    this.keyFingerprint = config.keyFingerprint;
  }

  verify(raw: unknown): ImmutableRunDeclaration {
    if (typeof raw !== 'string') throw new Error('Signed evidence envelope must be a primitive string.');
    const envelope = parseStrict(evidenceTrustRootSchema, raw, 'signed evidence envelope');
    if (envelope.keyId !== this.keyId) throw new Error('Signed evidence envelope names an untrusted key id.');
    if (envelope.keyFingerprint !== this.keyFingerprint) throw new Error('Signed evidence envelope names an untrusted key fingerprint.');
    const signature = Buffer.from(envelope.signatureBase64, 'base64');
    if (!verifySignature(null, Buffer.from(envelope.signedPayloadRaw), this.publicKey, signature)) {
      throw new Error('Signed evidence envelope Ed25519 signature is invalid.');
    }

    // Signature verification precedes the single semantic parse of signed bytes.
    const payload = parseStrict(evidenceSignedPayloadSchema, envelope.signedPayloadRaw, 'signed evidence payload');
    if (payload.envelopeId !== envelope.envelopeId) throw new Error('Signed envelope and payload identities differ.');
    assertRunDeclarationInvariants(payload.declaration);
    const contentSha256 = digest(JSON.stringify(payload.declaration));
    const declaration = deepFreeze({
      value: payload.declaration,
      contentSha256,
      trustRootId: envelope.envelopeId,
      trustRootSha256: digest(envelope.signedPayloadRaw),
      rawCaptureDigests: payload.rawCaptureDigests,
    });
    VERIFIED_DECLARATIONS.add(declaration);
    return declaration;
  }
}

export function createProductionEvidenceEnvelopeVerifier(): EvidenceEnvelopeVerifier {
  return new Ed25519EvidenceEnvelopeVerifier({
    keyId: B1_EVIDENCE_VERIFICATION_AUTHORITY.keyId,
    publicKeyPem: B1_EVIDENCE_PUBLIC_KEY_PEM,
    keyFingerprint: B1_EVIDENCE_VERIFICATION_AUTHORITY.publicKeyFingerprintSha256,
  });
}

export function createEvidenceEnvelopeVerifierForTest(config: unknown): EvidenceEnvelopeVerifier {
  if (process.env.NODE_ENV !== 'test') throw new Error('Evidence verification-key injection is available only in tests.');
  assertPlainVerifierConfig(config);
  return new Ed25519EvidenceEnvelopeVerifier(config);
}

export class TrustedRunDeclarationStore {
  async load(trustRootId: string): Promise<ImmutableRunDeclaration> {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(trustRootId)) throw new Error('Trust-root id is not allowlisted.');
    const path = join(DEFAULT_EVIDENCE_TRUST_ROOT, `${trustRootId}.json`);
    const verifier = createProductionEvidenceEnvelopeVerifier();
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Signed evidence envelope must be a regular file.');
      const raw = await handle.readFile('utf8');
      const declaration = verifier.verify(raw);
      if (declaration.trustRootId !== trustRootId) throw new Error('Evidence trust-root filename and content identity differ.');
      return declaration;
    } finally {
      await handle.close();
    }
  }
}

function snapshotRawCaptureTextSet(raw: RawCaptureTextSet): Readonly<RawCaptureTextSet> {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error('Raw capture set must be a plain non-proxy data object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const expectedKeys = ['cloudRun', 'database', 'scheduler', 'signet', 'supervisor', 'workerLogs'];
  if (
    Reflect.ownKeys(raw).some((key) => typeof key !== 'string')
    || Object.keys(descriptors).sort(compareCodeUnits).join(',') !== expectedKeys.join(',')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || descriptor.get || descriptor.set)
    || expectedKeys.some((key) => typeof descriptors[key]?.value !== 'string')
  ) throw new Error('Raw capture set rejects getters, unknown keys, and ambiguous values.');
  return Object.freeze({
    scheduler: descriptors.scheduler!.value as string,
    workerLogs: descriptors.workerLogs!.value as string,
    database: descriptors.database!.value as string,
    signet: descriptors.signet!.value as string,
    cloudRun: descriptors.cloudRun!.value as string,
    supervisor: descriptors.supervisor!.value as string,
  });
}

export function parseRawCaptureSet(
  raw: RawCaptureTextSet,
  declaration: ImmutableRunDeclaration,
): ParsedRawCaptureSet {
  if (!VERIFIED_DECLARATIONS.has(declaration)) {
    throw new Error('Raw captures require a declaration from the verified signed evidence envelope.');
  }
  const captured = snapshotRawCaptureTextSet(raw);
  const contentDigests = {
    scheduler: digest(captured.scheduler),
    workerLogs: digest(captured.workerLogs),
    database: digest(captured.database),
    signet: digest(captured.signet),
    cloudRun: digest(captured.cloudRun),
    supervisor: digest(captured.supervisor),
  };
  for (const source of Object.keys(contentDigests) as Array<keyof typeof contentDigests>) {
    if (contentDigests[source] !== declaration.rawCaptureDigests[source]) {
      throw new Error(`${source} raw export content digest does not match its trusted immutable declaration digest.`);
    }
  }
  const scheduler = parseStrict(schedulerCaptureSchema, captured.scheduler, 'cloud-scheduler raw export');
  const workerLogs = parseStrict(workerLogsCaptureSchema, captured.workerLogs, 'cloud-logging raw export');
  const database = parseStrict(databaseCaptureSchema, captured.database, 'database raw export');
  const signet = parseStrict(signetCaptureSchema, captured.signet, 'signet RPC raw export');
  const cloudRun = parseStrict(cloudRunCaptureSchema, captured.cloudRun, 'Cloud Run lifecycle raw export');
  const supervisor = parseStrict(supervisorCaptureSchema, captured.supervisor, 'supervisor raw export');
  const parsed = deepFreeze<ParsedRawCaptureSet>({
    scheduler, workerLogs, database, signet, cloudRun, supervisor, contentDigests,
  });
  VERIFIED_CAPTURE_PROVENANCE.set(parsed, declaration);
  return parsed;
}

export async function collectLiveRawSources(
  declaration: ImmutableRunDeclaration,
  collectors: KnownLiveSourceCollectors,
  env: LiveEvidenceExecutionEnv,
): Promise<{ mode: 'disabled'; reason: string } | { mode: 'captured'; raw: RawCaptureTextSet }> {
  try {
    assertLiveCollectionGate(declaration, env);
  } catch {
    return { mode: 'disabled', reason: 'live evidence collection was not explicitly enabled' };
  }
  const [scheduler, workerLogs, database, signet, cloudRun, supervisor] = await Promise.all([
    collectors.collectScheduler(declaration),
    collectors.collectWorkerLogs(declaration),
    collectors.collectDatabase(declaration),
    collectors.collectSignet(declaration),
    collectors.collectCloudRun(declaration),
    collectors.collectSupervisor(declaration),
  ]);
  return { mode: 'captured', raw: { scheduler, workerLogs, database, signet, cloudRun, supervisor } };
}

function assertLiveCollectionGate(
  declaration: ImmutableRunDeclaration,
  env: LiveEvidenceExecutionEnv,
): void {
  if (
    env.ARKOVA_LIVE_EVIDENCE_EXECUTION !== LIVE_EVIDENCE_ENABLE_VALUE
    || env.ARKOVA_LIVE_EVIDENCE_SOAK_ID !== declaration.value.soakId
  ) throw new Error('Live evidence collection was not explicitly enabled for this exact soak.');
}

function assertCommonBindings(declaration: ImmutableRunDeclaration, captures: ParsedRawCaptureSet): void {
  const expected = declaration.value;
  const sources = [
    captures.scheduler, captures.workerLogs, captures.database,
    captures.signet, captures.cloudRun, captures.supervisor,
  ];
  unique(sources.map((source) => source.exportId), 'raw source export IDs');
  for (const source of sources) {
    if (
      source.declarationSha256 !== declaration.contentSha256
      || source.rigId !== expected.rigId
      || source.soakId !== expected.soakId
      || source.gitHeadSha !== expected.gitHeadSha
      || source.imageDigest !== expected.imageDigest
    ) {
      throw new Error(`${source.source} raw export is cross-run, cross-head, cross-image, or declaration-unbound.`);
    }
    if (time(source.generatedAt, `${source.source} generatedAt`) < time(expected.soakEndedAt, 'soakEndedAt')) {
      throw new Error(`${source.source} raw export was generated before the declared soak completed.`);
    }
  }
  if (
    captures.database.projectRef !== expected.projectRef
    || captures.cloudRun.gcpProjectId !== expected.gcpProjectId
    || captures.cloudRun.workerService !== expected.workerService
    || captures.cloudRun.workerRevision !== expected.workerRevision
    || captures.cloudRun.region !== expected.region
  ) {
    throw new Error('DB or Cloud Run raw export mismatches the named rig project/service/revision/region.');
  }
}

export interface UnsignedLiveEvidenceValidation {
  readonly declaration: RunDeclaration;
  readonly declarationSha256: string;
  readonly rawCaptureDigests: RawCaptureDigests;
}

/**
 * Producer-side pre-signing gate. This validates exact raw schemas and common
 * run bindings but deliberately does not create verified declaration/capture
 * provenance; only the independently signed evidence envelope can do that.
 */
export function validateUnsignedLiveEvidenceForSigning(
  declarationInput: unknown,
  rawInput: RawCaptureTextSet,
): UnsignedLiveEvidenceValidation {
  const declaration = runDeclarationSchema.parse(declarationInput);
  assertRunDeclarationInvariants(declaration);
  const raw = snapshotRawCaptureTextSet(rawInput);
  const rawCaptureDigests = Object.freeze({
    scheduler: digest(raw.scheduler),
    workerLogs: digest(raw.workerLogs),
    database: digest(raw.database),
    signet: digest(raw.signet),
    cloudRun: digest(raw.cloudRun),
    supervisor: digest(raw.supervisor),
  });
  const captures: ParsedRawCaptureSet = {
    scheduler: parseStrict(schedulerCaptureSchema, raw.scheduler, 'cloud-scheduler unsigned raw export'),
    workerLogs: parseStrict(workerLogsCaptureSchema, raw.workerLogs, 'cloud-logging unsigned raw export'),
    database: parseStrict(databaseCaptureSchema, raw.database, 'database unsigned raw export'),
    signet: parseStrict(signetCaptureSchema, raw.signet, 'signet RPC unsigned raw export'),
    cloudRun: parseStrict(cloudRunCaptureSchema, raw.cloudRun, 'Cloud Run lifecycle unsigned raw export'),
    supervisor: parseStrict(supervisorCaptureSchema, raw.supervisor, 'supervisor unsigned raw export'),
    contentDigests: rawCaptureDigests,
  };
  const declarationSha256 = digest(JSON.stringify(declaration));
  const unsignedDeclaration: ImmutableRunDeclaration = {
    value: declaration,
    contentSha256: declarationSha256,
    trustRootId: 'UNSIGNED-PRE-SIGNING-VALIDATION-ONLY',
    trustRootSha256: '',
    rawCaptureDigests,
  };
  assertCommonBindings(unsignedDeclaration, captures);
  deriveSemanticLiveEvidence(unsignedDeclaration, captures);
  return deepFreeze({ declaration, declarationSha256, rawCaptureDigests });
}

function assertPreflightAndSupervisor(declaration: RunDeclaration, capture: SupervisorCapture): void {
  const startMs = time(declaration.soakStartedAt, 'soakStartedAt');
  const endMs = time(declaration.soakEndedAt, 'soakEndedAt');
  const cleanMs = time(capture.cleanMirror.observedAt, 'clean_mirror observedAt');
  if (
    capture.cleanMirror.attestationId !== declaration.cleanMirrorAttestationId
    || capture.cleanMirror.projectRef !== declaration.projectRef
    || capture.cleanMirror.gitBaseSha !== declaration.gitBaseSha
    || capture.cleanMirror.gitHeadSha !== declaration.gitHeadSha
    || cleanMs > startMs
  ) throw new Error('clean_mirror raw record mismatches named base/head/project or postdates the soak clock.');
  if (
    capture.lease.leaseId !== declaration.leaseId
    || time(capture.lease.acquiredAt, 'lease acquiredAt') > cleanMs
    || time(capture.lease.expiresAt, 'lease expiresAt') < endMs
  ) throw new Error('Lease raw record does not cover clean_mirror through soak completion.');

  unique(capture.records.map((record) => record.recordId), 'supervisor record IDs');
  const started = capture.records.filter((record) => record.event === 'started');
  const stopped = capture.records.filter((record) => record.event === 'stopped');
  const heartbeats = capture.records.filter((record) => record.event === 'heartbeat');
  const deaths = capture.records.filter((record) => record.event === 'death');
  if (
    capture.mode !== 'log-and-continue'
    || started.length !== 1
    || stopped.length !== 1
    || heartbeats.length < 2
    || deaths.length !== 0
    || time(started[0]!.occurredAt, 'runner start') > startMs
    || time(stopped[0]!.occurredAt, 'runner stop') < endMs
    || heartbeats.some((record) => {
      const at = time(record.occurredAt, 'runner heartbeat');
      return at < startMs || at > endMs;
    })
  ) throw new Error('Soak v2 supervisor records do not prove a continuous log-and-continue runner.');
  assertHeartbeatCadence(
    heartbeats.map((record) => record.occurredAt),
    startMs,
    endMs,
    'Soak v2 supervisor',
  );
}

interface WorkerInterval {
  workerId: string;
  start: number;
  end: number;
  countedStart: number;
  countedEnd: number;
}

function assertHeartbeatCadence(values: string[], startMs: number, endMs: number, label: string): void {
  const times = values
    .map((value) => time(value, `${label} heartbeat`))
    .filter((value) => value >= startMs && value <= endMs)
    .sort((left, right) => left - right);
  unique(times, `${label} heartbeat timestamps`);
  const points = [startMs, ...times, endMs];
  const maximumGap = MAX_HEARTBEAT_GAP_MINUTES * 60_000;
  if (points.some((point, index) => index > 0 && point - points[index - 1]! > maximumGap)) {
    throw new Error(`${label} heartbeat gap exceeds the continuous ${MAX_HEARTBEAT_GAP_MINUTES}-minute cadence.`);
  }
}

function deriveWorkerUptime(
  declaration: RunDeclaration,
  capture: CloudRunCapture,
): { uptimeMs: number; intervals: WorkerInterval[] } {
  unique(capture.records.map((record) => record.recordId), 'Cloud Run lifecycle record IDs');
  if (capture.records.some((record) => record.event === 'crash-loop' || record.event === 'endpoint-eviction')) {
    throw new Error('Crash-loop or endpoint eviction voids the worker-uptime clock.');
  }
  const startMs = time(declaration.soakStartedAt, 'soakStartedAt');
  const endMs = time(declaration.soakEndedAt, 'soakEndedAt');
  const byWorker = new Map<string, CloudRunCapture['records']>();
  for (const record of capture.records) {
    const records = byWorker.get(record.workerId) ?? [];
    records.push(record);
    byWorker.set(record.workerId, records);
  }
  let uptimeMs = 0;
  const intervals: WorkerInterval[] = [];
  for (const [workerId, records] of byWorker) {
    const starts = records.filter((record) => record.event === 'started');
    const stops = records.filter((record) => record.event === 'stopped');
    const heartbeats = records.filter((record) => record.event === 'heartbeat');
    if (starts.length !== 1 || stops.length !== 1) throw new Error(`Worker ${workerId} lacks one start/stop lifecycle pair.`);
    const start = time(starts[0]!.occurredAt, 'worker start');
    const end = time(stops[0]!.occurredAt, 'worker stop');
    if (end <= start) throw new Error('Worker lifecycle interval is not chronological.');
    const countedStart = Math.max(start, startMs);
    const countedEnd = Math.min(end, endMs);
    if (countedEnd <= countedStart) throw new Error('Worker lifecycle interval does not overlap the declared soak clock.');
    assertHeartbeatCadence(
      heartbeats.map((record) => record.occurredAt),
      countedStart,
      countedEnd,
      `Cloud Run worker ${workerId}`,
    );
    intervals.push({ workerId, start, end, countedStart, countedEnd });
    uptimeMs += countedEnd - countedStart;
  }
  intervals.sort((left, right) => left.start - right.start);
  if (intervals.some((interval, index) => index > 0 && interval.start < intervals[index - 1]!.end)) {
    throw new Error('Cloud Run worker uptime intervals overlap and would double-count the soak clock.');
  }
  if (uptimeMs < SOAK_REQUIRED_UPTIME_MINUTES * 60_000) {
    throw new Error('Cloud Run worker uptime is below the fixed 48h worker-uptime floor.');
  }
  return { uptimeMs, intervals };
}

function assertWorkerCovers(
  intervals: WorkerInterval[],
  workerId: string,
  startedAt: string,
  completedAt: string,
  label: string,
): void {
  const start = time(startedAt, `${label} start`);
  const end = time(completedAt, `${label} completion`);
  if (!intervals.some((interval) => interval.workerId === workerId && interval.start <= start && interval.end >= end)) {
    throw new Error(`${label} is not bound to the declared active Cloud Run worker identity.`);
  }
}

function expectedDrainPath(trigger: 'org-scheduler' | 'global-policy' | 'global-flush'): string {
  if (trigger === 'org-scheduler') return '/jobs/org-queue-scheduler';
  return trigger === 'global-policy' ? '/jobs/batch-anchors' : '/jobs/batch-anchors?force=true';
}

function derivePassObservation(
  captures: ParsedRawCaptureSet,
  pass: BroadcastPassExpectation,
): DrainPassObservation {
  const executionRows = captures.database.executions.filter((row) => (
    row.schedulerExecutionId === pass.schedulerExecutionId && row.batchId === pass.batchId
  ));
  if (executionRows.length !== 1) throw new Error(`DB export must contain exactly one execution ${pass.schedulerExecutionId}.`);
  const execution = executionRows[0]!;
  const triggerLogs = captures.workerLogs.records.filter((record) => (
    record.event === 'trigger-fired'
    && record.schedulerExecutionId === pass.schedulerExecutionId
    && record.batchId === pass.batchId
  ));
  if (triggerLogs.length !== 1) throw new Error(`Worker logs must contain one trigger firing ${pass.schedulerExecutionId}.`);
  const triggerLog = triggerLogs[0]!;
  if (
    triggerLog.batchId !== pass.batchId
    || triggerLog.trigger !== pass.armedTrigger
    || triggerLog.workerId !== execution.workerId
    || triggerLog.fingerprint !== null
    || triggerLog.orgId !== null
    || triggerLog.decision !== null
    || triggerLog.reason !== null
    || triggerLog.referenceId !== null
    || triggerLog.requiredAmount !== null
    || triggerLog.balanceBefore !== null
    || triggerLog.balanceAfter !== null
  ) throw new Error('Trigger-fired raw log carries contradictory gate fields or wrong batch/trigger.');

  const passRows = captures.database.passRows.filter((row) => (
    row.schedulerExecutionId === pass.schedulerExecutionId && row.batchId === pass.batchId
  ));
  const transactionIds = new Set(passRows.map((row) => row.chainTxId).filter((value): value is string => value !== null));
  const transactions = captures.database.transactions.filter((row) => transactionIds.has(row.txId)).map((row) => {
    const chain = captures.signet.records.filter((record) => record.txId === row.txId);
    if (chain.length !== 1) throw new Error(`Signet export must contain one RPC result for ${row.txId}.`);
    const result = chain[0]!;
    if (
      result.batchId !== row.batchId
      || result.merkleRoot !== row.merkleRoot
      || result.rawTxSha256 !== row.signedBytesSha256
      || result.schedulerExecutionId !== pass.schedulerExecutionId
      || result.workerId !== execution.workerId
    ) throw new Error('Signet RPC result mismatches the DB transaction/root/signed bytes.');
    return {
      ...row,
      schedulerExecutionId: result.schedulerExecutionId,
      network: result.network,
      nodeId: result.nodeId,
      chainState: result.state,
      acceptedAt: result.observedAt,
    };
  });
  const gateLogs = captures.workerLogs.records.filter((record) => (
    record.event === 'credit-gate'
    && record.schedulerExecutionId === pass.schedulerExecutionId
    && record.batchId === pass.batchId
  ));
  const claimFingerprints = new Set(pass.claims.map((claim) => claim.fingerprint));
  const claimOrgIds = new Set(pass.claims.map((claim) => claim.orgId));
  const creditGateEvents = gateLogs.map((record) => {
    if (
      record.fingerprint === null
      || record.orgId === null
      || record.decision === null
      || record.requiredAmount === null
      || record.batchId !== pass.batchId
      || record.trigger !== pass.armedTrigger
      || record.traceId !== triggerLog.traceId
      || record.workerId !== execution.workerId
    ) throw new Error('Credit-gate raw log is missing typed gate fields.');
    return {
      eventId: record.recordId,
      schedulerExecutionId: record.schedulerExecutionId,
      fingerprint: record.fingerprint,
      orgId: record.orgId,
      decision: record.decision,
      reason: record.reason,
      referenceId: record.referenceId,
      requiredAmount: record.requiredAmount,
      balanceBefore: record.balanceBefore,
      balanceAfter: record.balanceAfter,
      occurredAt: record.occurredAt,
    };
  });
  return {
    execution: {
      schedulerExecutionId: execution.schedulerExecutionId,
      armedTrigger: execution.armedTrigger,
      faultWindowId: execution.faultWindowId,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    },
    triggerFirings: [{
      trigger: triggerLog.trigger,
      schedulerExecutionId: triggerLog.schedulerExecutionId,
      batchId: pass.batchId,
      firedAt: triggerLog.occurredAt,
    }],
    pendingBefore: execution.pendingBefore,
    pendingAfter: execution.pendingAfter,
    passRows,
    transactions,
    txLeaves: captures.database.txLeaves.filter((row) => transactionIds.has(row.txId)),
    proofs: captures.database.proofs.filter((row) => transactionIds.has(row.txId)),
    creditGateEvents,
    creditLedgerEvents: captures.database.creditLedgerEvents.filter((row) => (
      row.schedulerExecutionId === pass.schedulerExecutionId
      && claimFingerprints.has(row.fingerprint)
    )),
    orgBalances: captures.database.orgBalances.filter((row) => (
      row.schedulerExecutionId === pass.schedulerExecutionId && claimOrgIds.has(row.orgId)
    )),
    ledgerDeltas: captures.database.ledgerDeltas.filter((row) => (
      row.schedulerExecutionId === pass.schedulerExecutionId && claimOrgIds.has(row.orgId)
    )),
  };
}

interface OrderedWindowPassSummary {
  readonly schedulerExecutionId: string;
  readonly pendingBefore: number;
  readonly pendingAfter: number;
  readonly drainedLeaves: number;
  readonly poisonLeaves: number;
  readonly transactionIds: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
}

function assertNoBroadcastPass(
  captures: ParsedRawCaptureSet,
  pass: NoBroadcastPassExpectation,
): OrderedWindowPassSummary {
  const outcomes = captures.database.deniedOutcomes.filter((row) => row.outcomeId === pass.outcomeId);
  if (outcomes.length !== 1) {
    throw new Error(`DB export must contain one durable no-broadcast outcome ${pass.outcomeId}.`);
  }
  const outcome = outcomes[0]!;
  const gateLogs = captures.workerLogs.records.filter((record) => (
    record.event === 'credit-gate'
    && record.schedulerExecutionId === pass.schedulerExecutionId
    && record.batchId === null
    && record.fingerprint === pass.deniedGate.fingerprint
  ));
  if (gateLogs.length !== 1) {
    throw new Error('No-broadcast denial requires one exact batchless worker credit-gate record.');
  }
  const gate = gateLogs[0]!;
  const claim = pass.claims[0]!;
  if (outcome.schedulerExecutionId !== pass.schedulerExecutionId
    || outcome.faultWindowId !== pass.faultWindow.id
    || outcome.fingerprint !== claim.fingerprint
    || outcome.orgId !== claim.orgId
    || outcome.workerId !== gate.workerId
    || outcome.creditDenialReason !== pass.deniedGate.reason
    || outcome.pendingAfter !== outcome.pendingBefore
    || gate.orgId !== pass.deniedGate.orgId
    || gate.decision !== pass.deniedGate.decision
    || gate.reason !== pass.deniedGate.reason
    || gate.referenceId !== pass.deniedGate.referenceId
    || gate.requiredAmount !== pass.deniedGate.requiredAmount
    || gate.balanceBefore !== pass.deniedGate.balanceBefore
    || gate.balanceAfter !== pass.deniedGate.balanceAfter) {
    throw new Error('No-broadcast DB denial and worker gate differ from the declared exact denied facts.');
  }
  const start = time(outcome.startedAt, 'no-broadcast outcome start');
  const end = time(outcome.completedAt, 'no-broadcast outcome completion');
  const deniedAt = time(outcome.queueCreditDeniedAt, 'no-broadcast denial time');
  const gateAt = time(gate.occurredAt, 'no-broadcast gate time');
  const windowStart = time(pass.faultWindow.startsAt, 'no-broadcast fault start');
  const windowEnd = time(pass.faultWindow.endsAt, 'no-broadcast fault end');
  if (start < windowStart || end > windowEnd || end < start
    || gateAt < start || deniedAt < gateAt || deniedAt > end) {
    throw new Error('No-broadcast denial chronology is outside its exact execution/fault window.');
  }
  const matchingPassRows = captures.database.passRows.filter((row) => row.fingerprint === claim.fingerprint);
  const matchingLeaves = captures.database.txLeaves.filter((row) => row.fingerprint === claim.fingerprint);
  const matchingProofs = captures.database.proofs.filter((row) => row.fingerprint === claim.fingerprint);
  const matchingLedger = captures.database.creditLedgerEvents.filter((row) => row.fingerprint === claim.fingerprint);
  const fabricatedTrigger = captures.workerLogs.records.some((record) => (
    record.event === 'trigger-fired'
    && record.schedulerExecutionId === pass.schedulerExecutionId
    && record.batchId === null
  ));
  if (matchingPassRows.length !== 0
    || matchingLeaves.length !== 0
    || matchingProofs.length !== 0
    || matchingLedger.length !== 0
    || fabricatedTrigger) {
    throw new Error('No-broadcast denial cannot carry a fabricated batch, tx, proof, ledger, or trigger result.');
  }
  const balances = captures.database.orgBalances.filter((row) => (
    row.schedulerExecutionId === pass.schedulerExecutionId && row.orgId === claim.orgId
  ));
  const deltas = captures.database.ledgerDeltas.filter((row) => (
    row.schedulerExecutionId === pass.schedulerExecutionId && row.orgId === claim.orgId
  ));
  if (balances.length !== 1 || deltas.length !== 1
    || balances[0]!.before !== pass.deniedGate.balanceBefore
    || balances[0]!.after !== pass.deniedGate.balanceAfter
    || deltas[0]!.delta !== 0) {
    throw new Error('No-broadcast denial must prove one unchanged org balance and zero ledger delta.');
  }
  return {
    schedulerExecutionId: pass.schedulerExecutionId,
    pendingBefore: outcome.pendingBefore,
    pendingAfter: outcome.pendingAfter,
    drainedLeaves: 0,
    poisonLeaves: 1,
    transactionIds: [],
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt,
  };
}

function summarizeWindowWithNoBroadcast(
  window: RunDeclaration['windows'][number],
  captures: ParsedRawCaptureSet,
): DrainWindowEvidenceSummary {
  if (!isPoisonDrainWindowKind(window.kind) || window.armedTrigger !== 'org-scheduler') {
    throw new Error('No-broadcast denial is permitted only in an org-scheduler poison-isolation window.');
  }
  const summaries: OrderedWindowPassSummary[] = window.passes.map((pass) => {
    if (pass.outcome === 'no-broadcast') return assertNoBroadcastPass(captures, pass);
    const summary: DrainPassEvidenceSummary = assertDrainPassObservation(
      pass,
      derivePassObservation(captures, pass),
    );
    if (summary.poisonLeaves !== 0) {
      throw new Error('Poison-isolation broadcast neighbors cannot include the distinct denied poison claim.');
    }
    return summary;
  });
  const executionIds = [...new Set(summaries.map((summary) => summary.schedulerExecutionId))];
  const transactionIds = summaries.flatMap((summary) => [...summary.transactionIds]);
  if (executionIds.length !== 1
    || new Set(transactionIds).size !== transactionIds.length
    || summaries[0]?.pendingBefore !== window.expectedInitialPending
    || summaries.at(-1)?.pendingAfter !== window.expectedFinalPending) {
    throw new Error('Ordered no-broadcast window does not preserve one execution and exact pending boundaries.');
  }
  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1]!;
    const current = summaries[index]!;
    if (current.pendingBefore !== previous.pendingAfter
      || time(current.startedAt, 'ordered pass start') <= time(previous.completedAt, 'ordered pass completion')) {
      throw new Error('Ordered per-org passes do not preserve durable pending/chronology order.');
    }
  }
  const drainedLeaves = summaries.reduce((sum, summary) => sum + summary.drainedLeaves, 0);
  const poisonLeaves = summaries.reduce((sum, summary) => sum + summary.poisonLeaves, 0);
  if (drainedLeaves === 0 || poisonLeaves === 0 || window.expectedFinalPending === 0) {
    throw new Error('Poison-isolation requires real broadcast neighbors and a distinct pending no-broadcast denial.');
  }
  assertDrainWindowSemantic(window, summaries);
  return {
    scenarioId: window.scenarioId,
    kind: window.kind,
    armedTrigger: window.armedTrigger,
    schedulerTicks: 1,
    drainedLeaves,
    poisonLeaves,
    initialPending: window.expectedInitialPending,
    finalPending: window.expectedFinalPending,
    schedulerExecutionIds: executionIds,
    transactionIds,
  };
}

export interface LiveEvidenceSummary {
  declarationId: string;
  declarationSha256: string;
  trustRootId: string;
  trustRootSha256: string;
  rigId: 'RIG-B1';
  soakId: string;
  gitBaseSha: string;
  gitHeadSha: string;
  imageDigest: string;
  workerUptimeMs: number;
  requiredWorkerUptimeMs: number;
  windows: DrainWindowEvidenceSummary[];
  sourceDigests: RawCaptureDigests;
  sourceExportIds: string[];
}

/**
 * Bind each accepted transaction to the immutable pre-broadcast journal row
 * from the same independently signed repeatable-read export. The successful
 * drain evidence path is intentionally fail-closed: unresolved recovery rows
 * belong in the crash/fault evidence contracts, never in a happy-path verdict.
 */
function assertSuccessfulTransactionJournals(captures: ParsedRawCaptureSet): void {
  const journals = captures.database.journalRows;
  const transactions = captures.database.transactions;
  unique(journals.map((row) => row.journalId), 'DB journal IDs');
  unique(journals.map((row) => row.txId), 'DB journal txids');
  if (journals.length !== transactions.length) {
    throw new Error('DB journal rows must cover every accepted transaction exactly once.');
  }

  const transactionIds = new Set(transactions.map((row) => row.txId));
  if (journals.some((row) => !transactionIds.has(row.txId))) {
    throw new Error('DB journal rows contain a transaction outside the exact accepted transaction set.');
  }

  for (const transaction of transactions) {
    const matching = journals.filter((row) => row.txId === transaction.txId);
    if (matching.length !== 1) {
      throw new Error(`DB journal must identify accepted transaction ${transaction.txId} exactly once.`);
    }
    const journal = matching[0]!;
    if (
      journal.batchId !== transaction.batchId
      || journal.fingerprintRoot !== transaction.merkleRoot
      || journal.recoveryStatus !== 'PERSISTED'
      || journal.holdReason !== null
      || journal.heldAt !== null
      || journal.resolvedAt === null
    ) {
      throw new Error('Successful transaction journal must be exact, PERSISTED, resolved, and free of hold state.');
    }

    const leaves = captures.database.txLeaves
      .filter((row) => row.txId === transaction.txId)
      .sort((left, right) => left.merkleIndex - right.merkleIndex);
    unique(journal.anchorIds, `journal anchor IDs for ${transaction.txId}`);
    if (
      journal.anchorIds.length !== leaves.length
      || journal.leafOrder.length !== leaves.length
      || journal.anchorIds.some((anchorId, index) => anchorId !== journal.leafOrder[index]?.anchorId)
      || journal.leafOrder.some((leaf, index) => (
        leaf.anchorId !== leaves[index]?.anchorId || leaf.fingerprint !== leaves[index]?.fingerprint
      ))
    ) {
      throw new Error('DB journal cohort and ordered leaves must exactly match the accepted transaction leaves.');
    }

    const signetRows = captures.signet.records.filter((row) => row.txId === transaction.txId);
    const transactionPassRows = captures.database.passRows.filter((row) => row.chainTxId === transaction.txId);
    const executionIds = [...new Set(transactionPassRows.map((row) => row.schedulerExecutionId))];
    const executions = captures.database.executions.filter((row) => (
      executionIds.includes(row.schedulerExecutionId) && row.batchId === transaction.batchId
    ));
    if (signetRows.length !== 1 || executionIds.length !== 1 || executions.length !== 1) {
      throw new Error('DB journal chronology requires one exact signet acceptance and Scheduler execution.');
    }
    const signetObservedMs = time(signetRows[0]!.observedAt, 'journal signet observedAt');
    const executionCompletedMs = time(executions[0]!.completedAt, 'journal execution completedAt');
    const signedMs = time(journal.signedAt, 'journal signedAt');
    const createdMs = time(journal.createdAt, 'journal createdAt');
    const resolvedMs = time(journal.resolvedAt, 'journal resolvedAt');
    const updatedMs = time(journal.updatedAt, 'journal updatedAt');
    if (
      signedMs > createdMs
      || createdMs > signetObservedMs
      || resolvedMs < signetObservedMs
      || resolvedMs > executionCompletedMs
      || updatedMs < resolvedMs
      || updatedMs > executionCompletedMs
    ) {
      throw new Error('DB journal acceptance chronology must prove signing before acceptance and PERSISTED resolution before execution completion.');
    }
  }
}

function deriveSemanticLiveEvidence(
  declaration: ImmutableRunDeclaration,
  captures: ParsedRawCaptureSet,
): LiveEvidenceSummary {
  assertCommonBindings(declaration, captures);
  assertPreflightAndSupervisor(declaration.value, captures.supervisor);
  const workerClock = deriveWorkerUptime(declaration.value, captures.cloudRun);
  const workerUptimeMs = workerClock.uptimeMs;
  const soakStartMs = time(declaration.value.soakStartedAt, 'soakStartedAt');
  unique(captures.scheduler.records.map((record) => record.recordId), 'Scheduler record IDs');
  unique(captures.scheduler.records.map((record) => record.schedulerExecutionId), 'Scheduler execution IDs');
  const preclock = captures.scheduler.records.filter((record) => record.purpose === 'preclock');
  if (
    preclock.length !== 1
    || preclock[0]!.statusCode !== 200
    || preclock[0]!.correlatedDrainExecutionId !== null
    || preclock[0]!.faultWindowId !== null
    || time(preclock[0]!.completedAt, 'preclock completedAt') > soakStartMs
  ) throw new Error('Raw Scheduler export must prove one /jobs/* HTTP 200 before the soak clock.');
  assertWorkerCovers(
    workerClock.intervals,
    preclock[0]!.workerId,
    preclock[0]!.firedAt,
    preclock[0]!.completedAt,
    'preclock Scheduler execution',
  );

  const passDeclarations = declaration.value.windows.flatMap((window) => window.passes);
  const broadcastDeclarations = passDeclarations.filter((pass) => pass.outcome === 'broadcast');
  const noBroadcastDeclarations = passDeclarations.filter((pass) => pass.outcome === 'no-broadcast');
  const declaredExecutionIds = new Set(passDeclarations.map((pass) => pass.schedulerExecutionId));
  const declaredBroadcasts = new Set(broadcastDeclarations.map((pass) => (
    `${pass.schedulerExecutionId}\0${pass.batchId}`
  )));
  const declaredDenials = new Set(noBroadcastDeclarations.map((pass) => pass.outcomeId));
  if (
    captures.database.executions.length !== broadcastDeclarations.length
    || captures.database.deniedOutcomes.length !== noBroadcastDeclarations.length
    || captures.database.executions.some((record) => !declaredBroadcasts.has(
      `${record.schedulerExecutionId}\0${record.batchId}`,
    ))
    || captures.database.deniedOutcomes.some((record) => !declaredDenials.has(record.outcomeId))
    || captures.database.passRows.some((record) => !declaredBroadcasts.has(
      `${record.schedulerExecutionId}\0${record.batchId}`,
    ))
    || captures.database.creditLedgerEvents.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.orgBalances.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.ledgerDeltas.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.workerLogs.records.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
  ) throw new Error('Raw worker/DB records contain an undeclared or missing drain execution.');
  const drainSchedulerRows = captures.scheduler.records.filter((record) => record.purpose === 'drain');
  if (
    drainSchedulerRows.length !== declaredExecutionIds.size
    || drainSchedulerRows.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
  ) throw new Error('Scheduler raw export must cover exactly every declared drain execution.');
  const declaredRecoveryIds = new Set(declaration.value.recoveries.map((recovery) => recovery.schedulerExecutionId));
  const recoverySchedulerRows = captures.scheduler.records.filter((record) => record.purpose === 'recovery');
  if (
    recoverySchedulerRows.length !== declaration.value.recoveries.length
    || recoverySchedulerRows.some((record) => !declaredRecoveryIds.has(record.schedulerExecutionId))
  ) throw new Error('Scheduler raw export contains an undeclared recovery or omits a declared recovery execution.');
  if (captures.scheduler.records.some((record) => (
    record.gcpProjectId !== declaration.value.gcpProjectId
    || record.workerRevision !== declaration.value.workerRevision
    || time(record.completedAt, 'Scheduler completedAt') < time(record.firedAt, 'Scheduler firedAt')
  ))) throw new Error('Scheduler raw record mismatches project/revision or has invalid chronology.');
  for (const schedulerExecutionId of declaredExecutionIds) {
    const declaredPasses = passDeclarations.filter((pass) => pass.schedulerExecutionId === schedulerExecutionId);
    const pass = declaredPasses[0]!;
    const records = drainSchedulerRows.filter((record) => record.schedulerExecutionId === schedulerExecutionId);
    const dbExecutions = [
      ...captures.database.executions.filter((record) => record.schedulerExecutionId === schedulerExecutionId),
      ...captures.database.deniedOutcomes.filter((record) => record.schedulerExecutionId === schedulerExecutionId),
    ];
    if (records.length !== 1 || dbExecutions.length !== declaredPasses.length) {
      throw new Error('One Scheduler execution must join every exact ordered DB pass/outcome.');
    }
    const record = records[0]!;
    const workerIds = new Set(dbExecutions.map((execution) => execution.workerId));
    const startedAt = Math.min(...dbExecutions.map((execution) => time(execution.startedAt, 'DB pass start')));
    const completedAt = Math.max(...dbExecutions.map((execution) => time(execution.completedAt, 'DB pass completion')));
    if (
      workerIds.size !== 1
      || record.gcpProjectId !== declaration.value.gcpProjectId
      || record.workerRevision !== declaration.value.workerRevision
      || record.statusCode !== 200
      || record.trigger !== pass.armedTrigger
      || record.path !== expectedDrainPath(pass.armedTrigger)
      || record.correlatedDrainExecutionId !== null
      || record.faultWindowId !== pass.faultWindow.id
      || record.workerId !== [...workerIds][0]
      || time(record.firedAt, 'Scheduler firedAt') > startedAt
      || time(record.completedAt, 'Scheduler completedAt') < completedAt
    ) throw new Error('Scheduler raw record mismatches project/revision/path/trigger/200 or DB chronology.');
    assertWorkerCovers(
      workerClock.intervals,
      record.workerId,
      record.firedAt,
      record.completedAt,
      `drain Scheduler execution ${schedulerExecutionId}`,
    );
  }
  for (const recovery of declaration.value.recoveries) {
    const records = recoverySchedulerRows.filter((record) => record.schedulerExecutionId === recovery.schedulerExecutionId);
    if (records.length !== 1) throw new Error('Scheduler recovery execution IDs must join one-to-one.');
    const record = records[0]!;
    const correlatedDrain = drainSchedulerRows.find((candidate) => (
      candidate.schedulerExecutionId === recovery.correlatedDrainExecutionId
    ));
    const correlatedPass = passDeclarations.find((candidate) => (
      candidate.schedulerExecutionId === recovery.correlatedDrainExecutionId
    ));
    if (
      !correlatedDrain
      || !correlatedPass
      || record.statusCode !== 200
      || record.path !== '/jobs/recover-broadcasts'
      || record.correlatedDrainExecutionId !== recovery.correlatedDrainExecutionId
      || record.faultWindowId !== recovery.faultWindowId
      || record.trigger !== correlatedPass.armedTrigger
      || time(record.firedAt, 'recovery firedAt') <= time(correlatedDrain.completedAt, 'correlated drain completedAt')
      || time(record.firedAt, 'recovery firedAt') < time(correlatedPass.faultWindow.startsAt, 'fault window startsAt')
      || time(record.completedAt, 'recovery completedAt') > time(correlatedPass.faultWindow.endsAt, 'fault window endsAt')
    ) throw new Error('Scheduler recovery raw record must be an HTTP 200 bound to its declared drain and fault window.');
    assertWorkerCovers(
      workerClock.intervals,
      record.workerId,
      record.firedAt,
      record.completedAt,
      `recovery Scheduler execution ${recovery.schedulerExecutionId}`,
    );
  }

  unique(captures.workerLogs.records.map((record) => record.recordId), 'worker log record IDs');
  unique(captures.workerLogs.records.map((record) => record.insertId), 'worker log insert IDs');
  unique(captures.signet.records.map((record) => record.recordId), 'signet record IDs');
  unique(captures.signet.records.map((record) => record.rpcRequestId), 'signet RPC request IDs');
  unique(captures.database.creditLedgerEvents.map((record) => record.eventId), 'DB ledger event IDs');
  unique(captures.database.transactions.map((record) => record.txId), 'DB transaction IDs');
  const referencedTxIds = new Set(captures.database.passRows
    .map((record) => record.chainTxId)
    .filter((value): value is string => value !== null));
  const dbTxIds = new Set(captures.database.transactions.map((record) => record.txId));
  const signetTxIds = new Set(captures.signet.records.map((record) => record.txId));
  if (
    referencedTxIds.size !== dbTxIds.size
    || [...referencedTxIds].some((txId) => !dbTxIds.has(txId))
    || signetTxIds.size !== dbTxIds.size
    || captures.signet.records.length !== dbTxIds.size
    || [...dbTxIds].some((txId) => !signetTxIds.has(txId))
    || captures.database.txLeaves.some((record) => !dbTxIds.has(record.txId))
    || captures.database.proofs.some((record) => !dbTxIds.has(record.txId))
  ) throw new Error('DB transaction, row, proof, leaf, and signet raw identities are not an exact closed set.');
  assertSuccessfulTransactionJournals(captures);

  const windows = declaration.value.windows.map((window) => {
    if (window.passes.some((pass) => pass.outcome === 'no-broadcast')) {
      return summarizeWindowWithNoBroadcast(window, captures);
    }
    const broadcastPasses = window.passes as BroadcastPassExpectation[];
    const observations = broadcastPasses.map((pass) => derivePassObservation(captures, pass));
    return assertDrainWindowObservation(window as DrainWindowExpectation, observations);
  });
  const transactionIds = windows.flatMap((window) => window.transactionIds);
  if (new Set(transactionIds).size !== transactionIds.length) {
    throw new Error('A transaction identity was reused across declared drain windows or Scheduler passes.');
  }
  return {
    declarationId: declaration.value.declarationId,
    declarationSha256: declaration.contentSha256,
    trustRootId: declaration.trustRootId,
    trustRootSha256: declaration.trustRootSha256,
    rigId: 'RIG-B1',
    soakId: declaration.value.soakId,
    gitBaseSha: declaration.value.gitBaseSha,
    gitHeadSha: declaration.value.gitHeadSha,
    imageDigest: declaration.value.imageDigest,
    workerUptimeMs,
    requiredWorkerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
    windows,
    sourceDigests: captures.contentDigests,
    sourceExportIds: [
      captures.scheduler.exportId,
      captures.workerLogs.exportId,
      captures.database.exportId,
      captures.signet.exportId,
      captures.cloudRun.exportId,
      captures.supervisor.exportId,
    ],
  };
}

export function deriveAndAssertLiveEvidence(
  declaration: ImmutableRunDeclaration,
  captures: ParsedRawCaptureSet,
): LiveEvidenceSummary {
  if (!VERIFIED_DECLARATIONS.has(declaration)) {
    throw new Error('Live evidence derivation requires a declaration from the verified signed evidence envelope.');
  }
  if (VERIFIED_CAPTURE_PROVENANCE.get(captures) !== declaration) {
    throw new Error('Live evidence derivation requires a verified capture set bound to this declaration provenance.');
  }
  return deriveSemanticLiveEvidence(declaration, captures);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'trust-root-id': { type: 'string' },
      'scheduler-export': { type: 'string' },
      'worker-logs-export': { type: 'string' },
      'database-export': { type: 'string' },
      'signet-export': { type: 'string' },
      'cloud-run-export': { type: 'string' },
      'supervisor-export': { type: 'string' },
    },
  });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
    return value;
  };
  const declaration = await new TrustedRunDeclarationStore().load(required('trust-root-id'));
  const raw = await new CapturedFileRawSourceCollector({
    schedulerFile: required('scheduler-export'),
    workerLogsFile: required('worker-logs-export'),
    databaseFile: required('database-export'),
    signetFile: required('signet-export'),
    cloudRunFile: required('cloud-run-export'),
    supervisorFile: required('supervisor-export'),
  }).collect();
  const summary = deriveAndAssertLiveEvidence(declaration, parseRawCaptureSet(raw, declaration));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`batch-drain-live-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
