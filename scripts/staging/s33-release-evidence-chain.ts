/**
 * SCRUM-2695 fail-closed S3.3 release-evidence chain composer.
 *
 * This module composes already validated, provenance-branded offline inputs.
 * It does not deploy, query a rig, tear resources down, sign a packet, or
 * promote descriptive signer metadata into release acceptance. Lane 2's
 * capture producer is bound; the independent release-signature gate remains
 * explicitly unavailable in every result.
 */

import { z } from 'zod';

import {
  requirePreClockAdmissionIdentity,
  type PreClockAdmissionBoundIdentity,
} from './batch-drain-admission-adapter';
import {
  assertTriggerIdentityCaptures,
  type Wave3DrainDriverPlan,
  type Wave3TriggerObservation,
} from './batch-drain-wave3-driver';
import {
  requireS33TreasuryRunwayResult,
  type S33TreasuryRunwayResult,
} from './s33-treasury-runway';
import {
  requireS33TeardownZeroCostResult,
  type S33TeardownZeroCostResult,
} from './s33-teardown-zero-cost';
import {
  digestS33Evidence,
  freezeS33Evidence,
} from './s33-evidence-integrity';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const metadataSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.release-evidence-chain-input/v2'),
  evidenceMode: z.literal('OFFLINE_COMPOSITION_SIGNATURE_BLOCKED'),
  runId: z.string().regex(SAFE_ID),
  composedAt: z.string().datetime({ offset: true }),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  producerBoundary: z.object({
    lane2TeardownSchemaVersion: z.literal(
      'arkova.s33.l2.teardown-captured-verification/v1',
    ),
    lane2TeardownIdentity: z.string().regex(SHA256),
    lane3SignatureSchemaVersion: z.null(),
    lane3SignatureAuthority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
    status: z.literal('LANE2_VERIFIED_SIGNATURE_BLOCKED'),
  }).strict(),
  signature: z.object({
    authority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
    status: z.literal('BLOCKED_UNAVAILABLE'),
    envelope: z.null(),
  }).strict(),
}).strict();

const admissionHandleSchema = z.object({
  admissionSha256: z.string().regex(SHA256_HEX),
}).strict();

const admissionIdentitySchema = z.object({
  gitHeadSha: z.string().regex(GIT_SHA),
  imageDigest: z.string().regex(SHA256),
  gcpProjectId: z.string().min(1),
  workerService: z.string().min(1),
  cleanMirrorAttestationId: z.string().min(1),
}).strict();

const drainPlanSnapshotSchema = z.object({
  mode: z.literal('OFFLINE_PLAN_ONLY'),
  liveEvidenceStatus: z.literal('DEFERRED_POST_WAVE3'),
  runId: z.string().regex(SAFE_ID),
  gitHeadSha: z.string().regex(GIT_SHA),
  imageDigest: z.string().regex(SHA256),
  planDigest: z.string().regex(SHA256),
  eligible10000: z.unknown(),
  eligible12500: z.unknown(),
  poisonIsolation: z.unknown(),
  orgScheduler: z.unknown(),
  backlog: z.unknown(),
  triggerSpecs: z.array(z.unknown()).min(1),
  triggerExecutionPlan: z.array(z.unknown()).length(5),
}).strict();

const signatureUnavailableSchema = z.object({
  authority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
  status: z.literal('BLOCKED_UNAVAILABLE'),
  envelope: z.null(),
}).strict();

const runwaySnapshotSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.treasury-runway-result/v1'),
  status: z.literal('OFFLINE_PAPER_UNSIGNED'),
  releaseAcceptance: z.literal(false),
  modelId: z.string().regex(SAFE_ID),
  generatedAt: z.string().datetime({ offset: true }),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  illustrativeTreasuryBalanceSats: z.number().int().positive().safe(),
  feeModel: z.unknown(),
  baselineRows: z.array(z.unknown()).min(1),
  fanoutRows: z.array(z.unknown()).min(1),
  signetMechanism: z.object({
    claimClass: z.literal('MECHANISM_ONLY_NOT_MAINNET_COST'),
    status: z.literal('DEFERRED_POST_WAVE3'),
    measuredVbytes: z.null(),
    artifactSha256: z.null(),
  }).strict(),
  signature: signatureUnavailableSchema,
  producerDependencies: z.tuple([
    z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE'),
  ]),
  claims: z.object({
    mainnetCost: z.literal('asserted-from-fee-model-not-measured-on-chain'),
    signetMechanism: z.literal('separate-and-deferred'),
    treasuryBalance: z.literal('illustrative-not-a-treasury-read'),
    fanout: z.literal('N-transactions-per-day-versus-one-asserted-baseline'),
  }).strict(),
  inputDigestSha256: z.string().regex(SHA256),
  resultDigestSha256: z.string().regex(SHA256),
}).strict();

const teardownInventoryDiffSchema = z.object({
  provider: z.enum(['GCP', 'SUPABASE']),
  kind: z.string().min(1),
  scopeId: z.string().min(1),
  resourceId: z.string().min(1),
  billingClass: z.enum(['RECURRING_PAID', 'NO_RECURRING_CHARGE']),
  targetProvenance: z.object({
    authority: z.literal('CTO'),
    origin: z.literal('S33_ISOLATED_RIG_RESOURCE'),
    decisionArtifactSha256: z.string().regex(SHA256),
    provisionArtifactSha256: z.string().regex(SHA256),
  }).strict(),
  terminalState: z.enum(['DELETED', 'DOWNGRADED_ZERO_RECURRING']),
  projectedMonthlyRecurringUsd: z.literal(0),
  evidenceArtifactSha256: z.string().regex(SHA256),
}).strict();

const teardownSnapshotSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.teardown-zero-cost-result/v2'),
  status: z.literal('CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED'),
  releaseAcceptance: z.literal(false),
  runId: z.string().regex(SAFE_ID),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  producerIdentity: z.string().regex(SHA256),
  resourceBoundarySha256: z.string().regex(SHA256),
  releaseBoundaryComplete: z.literal(true),
  boundaryStatus: z.literal('COMPLETE'),
  beforeCapturedAt: z.string().datetime({ offset: true }),
  afterCapturedAt: z.string().datetime({ offset: true }),
  beforeArtifactSha256: z.string().regex(SHA256),
  afterArtifactSha256: z.string().regex(SHA256),
  resourceCount: z.number().int().positive().safe(),
  deletedCount: z.number().int().nonnegative().safe(),
  downgradedZeroRecurringCount: z.literal(0),
  projectedMonthlyRecurringUsd: z.literal(0),
  recurring_cost_zero: z.literal(true),
  zeroRecurringProjected: z.literal(true),
  inventoryDiff: z.array(teardownInventoryDiffSchema).min(1),
  operator: z.object({
    operatorId: z.string().min(1),
    role: z.enum(['RTE', 'LANE2_TEARDOWN_OPERATOR']),
    organization: z.literal('ARKOVA'),
  }).strict(),
  signer: z.object({
    keyId: z.string().min(1),
    algorithm: z.literal('Ed25519'),
    publicKeyFingerprintSha256: z.string().regex(SHA256),
    verificationStatus: z.literal('UNVERIFIED_EXTERNAL_ARTIFACT'),
    beforeDetachedSignatureArtifactSha256: z.string().regex(SHA256),
    afterDetachedSignatureArtifactSha256: z.string().regex(SHA256),
  }).strict(),
  signature: signatureUnavailableSchema,
  producerDependencies: z.tuple([
    z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE'),
  ]),
  inputDigestSha256: z.string().regex(SHA256),
  resultDigestSha256: z.string().regex(SHA256),
}).strict();

const COMPOSER_INPUT_KEYS = Object.freeze([
  'admissionHandle',
  'drainPlan',
  'metadata',
  'runwayResult',
  'teardownResult',
  'triggerCaptures',
] as const);

export type S33ReleaseEvidenceChainMetadata = z.input<typeof metadataSchema>;

export interface S33ReleaseEvidenceChainInput {
  readonly metadata: unknown;
  readonly admissionHandle: PreClockAdmissionBoundIdentity;
  readonly drainPlan: Wave3DrainDriverPlan;
  readonly triggerCaptures: unknown;
  readonly runwayResult: S33TreasuryRunwayResult;
  readonly teardownResult: S33TeardownZeroCostResult;
}

export interface S33ReleaseTriggerEvidenceIdentity {
  readonly trigger:
    | 'trigger-a-size'
    | 'trigger-b-age'
    | 'trigger-d-force'
    | 'org-scheduler';
  readonly cause: 'SIZE_THRESHOLD' | 'AGE_THRESHOLD' | 'FORCE' | 'ORG_SCHEDULER';
  readonly executionOrdinal: number;
  readonly schedulerExecutionId: string;
  readonly observedAt: string;
  readonly evidenceArtifactSha256: string;
  readonly observationDigestSha256: string;
}

export interface S33ReleaseEvidenceChainResult {
  readonly schemaVersion: 'arkova.s33.l1.release-evidence-chain-result/v2';
  readonly status: 'OFFLINE_CHAIN_DRAFT_SIGNATURE_BLOCKED';
  readonly releaseAcceptance: false;
  readonly runId: string;
  readonly composedAt: string;
  readonly exactHeadSha: string;
  readonly exactTreeSha: string;
  readonly admission: Readonly<{
    sourceSchemaVersion: 2;
    artifactSha256: string;
    gitHeadSha: string;
    imageDigest: string;
    gcpProjectId: string;
    workerService: string;
    cleanMirrorAttestationId: string;
  }>;
  readonly drain: Readonly<{
    planDigest: string;
    executionSignature: readonly [
      'trigger-a-size:1',
      'trigger-a-size:2',
      'trigger-b-age:1',
      'trigger-d-force:1',
      'org-scheduler:1',
    ];
    triggerEvidence: readonly S33ReleaseTriggerEvidenceIdentity[];
    exactIdentity: true;
    evidenceClass: 'CONSUMER_VALIDATED_INPUT_NOT_PRODUCER_ACCEPTANCE';
  }>;
  readonly runway: Readonly<{
    status: 'OFFLINE_PAPER_UNSIGNED';
    releaseAcceptance: false;
    modelId: string;
    inputDigestSha256: string;
    resultDigestSha256: string;
    mainnetCostClaim: 'asserted-from-fee-model-not-measured-on-chain';
    signetMechanismClaim: 'separate-and-deferred';
  }>;
  readonly teardown: Readonly<{
    status: 'CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED';
    releaseAcceptance: false;
    producerIdentity: string;
    resourceBoundarySha256: string;
    releaseBoundaryComplete: true;
    boundaryStatus: 'COMPLETE';
    beforeCapturedAt: string;
    afterCapturedAt: string;
    beforeArtifactSha256: string;
    afterArtifactSha256: string;
    inputDigestSha256: string;
    resultDigestSha256: string;
    resourceCount: number;
    projectedMonthlyRecurringUsd: 0;
    recurring_cost_zero: true;
    zeroRecurringProjected: true;
  }>;
  readonly signature: Readonly<{
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY';
    status: 'BLOCKED_UNAVAILABLE';
    envelope: null;
  }>;
  readonly producerDependencies: readonly [
    'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
  ];
  readonly sourceArtifactDigests: readonly string[];
  readonly derivedManifestDigests: readonly string[];
  readonly claims: Readonly<{
    producerAcceptance: 'lane2-verified-signature-blocked';
    signature: 'unavailable-not-invented';
    teardownMutation: 'not-performed-by-this-composer';
    mainnetMeasurement: 'not-claimed';
  }>;
  readonly resultDigestSha256: string;
}

const CHAIN_RESULTS = new WeakSet<S33ReleaseEvidenceChainResult>();

function captureComposerInputs(input: S33ReleaseEvidenceChainInput): {
  readonly metadata: unknown;
  readonly admissionHandle: PreClockAdmissionBoundIdentity;
  readonly drainPlan: Wave3DrainDriverPlan;
  readonly triggerCaptures: unknown;
  readonly runwayResult: S33TreasuryRunwayResult;
  readonly teardownResult: S33TeardownZeroCostResult;
} {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Release evidence composer input must be an object.');
  }
  const keys = Object.keys(input).sort((left, right) => left.localeCompare(right));
  if (
    keys.length !== COMPOSER_INPUT_KEYS.length
    || keys.some((key, index) => key !== COMPOSER_INPUT_KEYS[index])
  ) {
    throw new Error('Release evidence composer input has missing or unrecognized top-level fields.');
  }
  const {
    metadata,
    admissionHandle,
    drainPlan,
    triggerCaptures,
    runwayResult,
    teardownResult,
  } = input;
  return {
    metadata,
    admissionHandle,
    drainPlan,
    triggerCaptures,
    runwayResult,
    teardownResult,
  };
}

function strictFrozenSnapshot<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  let clone: unknown;
  try {
    clone = structuredClone(value);
  } catch (error) {
    throw new TypeError(`${label} cannot be captured as immutable data.`, { cause: error });
  }
  const parsed = schema.safeParse(clone);
  if (!parsed.success) {
    throw new Error(`${label} strict snapshot rejected: ${z.prettifyError(parsed.error)}`);
  }
  return freezeS33Evidence(parsed.data);
}

function requireAllEqual(label: string, values: readonly string[]): void {
  if (new Set(values).size !== 1) {
    throw new Error(`${label} identity is stale or contradictory across release evidence.`);
  }
}

function requireUniqueDigests(label: string, values: readonly string[]): void {
  for (const value of values) {
    if (!SHA256.test(value)) throw new Error(`${label} contains an invalid SHA-256 identity.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain distinct immutable artifact identities.`);
  }
}

export function composeS33ReleaseEvidenceChain(
  input: S33ReleaseEvidenceChainInput,
): S33ReleaseEvidenceChainResult {
  const captured = captureComposerInputs(input);
  const metadata = strictFrozenSnapshot(
    metadataSchema,
    captured.metadata,
    'Release metadata',
  );
  const admissionHandle = strictFrozenSnapshot(
    admissionHandleSchema,
    captured.admissionHandle,
    'Admission handle',
  );
  const admission = freezeS33Evidence(admissionIdentitySchema.parse(
    requirePreClockAdmissionIdentity(captured.admissionHandle),
  ));
  const drainPlan = strictFrozenSnapshot(
    drainPlanSnapshotSchema,
    captured.drainPlan,
    'Drain plan',
  );
  const captures = freezeS33Evidence(structuredClone(
    captured.triggerCaptures,
  )) as readonly Wave3TriggerObservation[];
  const triggerSummary = assertTriggerIdentityCaptures(
    captured.drainPlan,
    captures,
  );
  const runway = strictFrozenSnapshot(
    runwaySnapshotSchema,
    requireS33TreasuryRunwayResult(captured.runwayResult),
    'Runway result',
  );
  const teardown = strictFrozenSnapshot(
    teardownSnapshotSchema,
    requireS33TeardownZeroCostResult(captured.teardownResult),
    'Teardown result',
  );

  requireAllEqual('Exact head', [
    metadata.exactHeadSha,
    admission.gitHeadSha,
    drainPlan.gitHeadSha,
    runway.exactHeadSha,
    teardown.exactHeadSha,
  ]);
  requireAllEqual('Exact tree', [
    metadata.exactTreeSha,
    runway.exactTreeSha,
    teardown.exactTreeSha,
  ]);
  requireAllEqual('Run', [
    metadata.runId,
    drainPlan.runId,
    teardown.runId,
  ]);
  requireAllEqual('Deployed image', [
    admission.imageDigest,
    drainPlan.imageDigest,
  ]);
  if (
    metadata.producerBoundary.lane2TeardownIdentity
    !== teardown.producerIdentity
  ) {
    throw new Error('Lane 2 teardown producer identity is stale or contradictory.');
  }

  const bindsWorker = teardown.inventoryDiff.some((resource) => (
    resource.provider === 'GCP'
    && resource.kind === 'cloud-run-service'
    && resource.scopeId === admission.gcpProjectId
    && resource.resourceId === admission.workerService
  ));
  if (!bindsWorker) {
    throw new Error(
      'Teardown evidence does not bind the admitted GCP project and worker service identity.',
    );
  }

  const latestTriggerAt = Math.max(...captures.map(({ observedAt }) => Date.parse(observedAt)));
  const teardownBeforeAt = Date.parse(teardown.beforeCapturedAt);
  const teardownAfterAt = Date.parse(teardown.afterCapturedAt);
  const composedAt = Date.parse(metadata.composedAt);
  if (teardownBeforeAt < latestTriggerAt) {
    throw new Error('Teardown chronology precedes the final bound trigger observation.');
  }
  if (
    composedAt < teardownAfterAt
    || composedAt < latestTriggerAt
    || composedAt < Date.parse(runway.generatedAt)
  ) {
    throw new Error('Release evidence composition time precedes a bound source artifact.');
  }

  const triggerEvidence = captures.map((capture): S33ReleaseTriggerEvidenceIdentity => ({
    trigger: capture.trigger,
    cause: capture.cause,
    executionOrdinal: capture.executionOrdinal,
    schedulerExecutionId: capture.schedulerExecutionId,
    observedAt: capture.observedAt,
    evidenceArtifactSha256: capture.evidenceArtifactSha256,
    observationDigestSha256: capture.observationDigestSha256,
  }));
  const executionSignature = triggerEvidence.map(
    ({ trigger, executionOrdinal }) => `${trigger}:${executionOrdinal}`,
  ) as unknown as S33ReleaseEvidenceChainResult['drain']['executionSignature'];

  const sourceArtifactDigests = [
    `sha256:${admissionHandle.admissionSha256}`,
    ...triggerEvidence.map(({ evidenceArtifactSha256 }) => evidenceArtifactSha256),
    teardown.beforeArtifactSha256,
    teardown.afterArtifactSha256,
    ...teardown.inventoryDiff.map(({ evidenceArtifactSha256 }) => evidenceArtifactSha256),
  ];
  const derivedManifestDigests = [
    drainPlan.planDigest,
    ...triggerEvidence.map(({ observationDigestSha256 }) => observationDigestSha256),
    runway.inputDigestSha256,
    runway.resultDigestSha256,
    teardown.producerIdentity,
    teardown.resourceBoundarySha256,
    teardown.inputDigestSha256,
    teardown.resultDigestSha256,
  ];
  requireUniqueDigests('Release source artifact chain', sourceArtifactDigests);
  requireUniqueDigests('Release derived manifest chain', derivedManifestDigests);

  const resultWithoutDigest = {
    schemaVersion: 'arkova.s33.l1.release-evidence-chain-result/v2' as const,
    status: 'OFFLINE_CHAIN_DRAFT_SIGNATURE_BLOCKED' as const,
    releaseAcceptance: false as const,
    runId: metadata.runId,
    composedAt: metadata.composedAt,
    exactHeadSha: metadata.exactHeadSha,
    exactTreeSha: metadata.exactTreeSha,
    admission: {
      sourceSchemaVersion: 2 as const,
      artifactSha256: `sha256:${admissionHandle.admissionSha256}`,
      gitHeadSha: admission.gitHeadSha,
      imageDigest: admission.imageDigest,
      gcpProjectId: admission.gcpProjectId,
      workerService: admission.workerService,
      cleanMirrorAttestationId: admission.cleanMirrorAttestationId,
    },
    drain: {
      planDigest: drainPlan.planDigest,
      executionSignature,
      triggerEvidence,
      exactIdentity: triggerSummary.exactIdentity,
      evidenceClass: 'CONSUMER_VALIDATED_INPUT_NOT_PRODUCER_ACCEPTANCE' as const,
    },
    runway: {
      status: runway.status,
      releaseAcceptance: runway.releaseAcceptance,
      modelId: runway.modelId,
      inputDigestSha256: runway.inputDigestSha256,
      resultDigestSha256: runway.resultDigestSha256,
      mainnetCostClaim: runway.claims.mainnetCost,
      signetMechanismClaim: runway.claims.signetMechanism,
    },
    teardown: {
      status: teardown.status,
      releaseAcceptance: teardown.releaseAcceptance,
      producerIdentity: teardown.producerIdentity,
      resourceBoundarySha256: teardown.resourceBoundarySha256,
      releaseBoundaryComplete: teardown.releaseBoundaryComplete,
      boundaryStatus: teardown.boundaryStatus,
      beforeCapturedAt: teardown.beforeCapturedAt,
      afterCapturedAt: teardown.afterCapturedAt,
      beforeArtifactSha256: teardown.beforeArtifactSha256,
      afterArtifactSha256: teardown.afterArtifactSha256,
      inputDigestSha256: teardown.inputDigestSha256,
      resultDigestSha256: teardown.resultDigestSha256,
      resourceCount: teardown.resourceCount,
      projectedMonthlyRecurringUsd: teardown.projectedMonthlyRecurringUsd,
      recurring_cost_zero: teardown.recurring_cost_zero,
      zeroRecurringProjected: teardown.zeroRecurringProjected,
    },
    signature: { ...metadata.signature },
    producerDependencies: [
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ] as const,
    sourceArtifactDigests,
    derivedManifestDigests,
    claims: {
      producerAcceptance: 'lane2-verified-signature-blocked' as const,
      signature: 'unavailable-not-invented' as const,
      teardownMutation: 'not-performed-by-this-composer' as const,
      mainnetMeasurement: 'not-claimed' as const,
    },
  };
  const result = freezeS33Evidence<S33ReleaseEvidenceChainResult>({
    ...resultWithoutDigest,
    resultDigestSha256: digestS33Evidence(
      resultWithoutDigest,
      'release-chain data',
    ),
  });
  CHAIN_RESULTS.add(result);
  return result;
}

export function requireS33ReleaseEvidenceChainResult(
  candidate: unknown,
): S33ReleaseEvidenceChainResult {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Release evidence requires a provenance-bound chain result.');
  }
  const result = candidate as S33ReleaseEvidenceChainResult;
  if (!CHAIN_RESULTS.has(result)) {
    throw new Error('Release evidence requires a provenance-bound chain result.');
  }
  return result;
}
