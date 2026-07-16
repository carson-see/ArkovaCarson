/**
 * SCRUM-2695 offline teardown inventory-diff and $0 recurring-cost consumer.
 *
 * This consumer accepts only Lane 2's branded immutable capture verification.
 * It cannot delete, pause, downgrade, query, or otherwise mutate a resource,
 * and descriptive signer metadata never satisfies release signature authority.
 */

import { z } from 'zod';

import {
  digestS33Evidence,
  freezeS33Evidence,
} from './s33-evidence-integrity';
import {
  requireS33TeardownCapturedVerification,
  type S33TeardownCapturedVerification,
} from './s33-teardown-inventory';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;

const capturedMetadataSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.teardown-zero-cost-input/v2'),
  evidenceMode: z.literal('CAPTURED_INVENTORY_SIGNATURE_BLOCKED'),
  runId: z.string().regex(SAFE_ID),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  signature: z.object({
    authority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
    status: z.literal('BLOCKED_UNAVAILABLE'),
    envelope: z.null(),
  }).strict(),
}).strict();

export interface S33TeardownZeroCostInput {
  readonly metadata: S33CapturedTeardownZeroCostMetadata;
  readonly teardownVerification: S33TeardownCapturedVerification;
}

export interface S33TeardownInventoryDiffRow {
  readonly provider: 'GCP' | 'SUPABASE';
  readonly kind: string;
  readonly scopeId: string;
  readonly resourceId: string;
  readonly billingClass: 'RECURRING_PAID' | 'NO_RECURRING_CHARGE';
  readonly targetProvenance: S33TeardownCapturedVerification['targetOutcomes'][number]['targetProvenance'];
  readonly terminalState: 'DELETED' | 'RELEASED_EXPIRED';
  readonly projectedMonthlyRecurringUsd: 0;
  readonly evidenceArtifactSha256: string;
}

export type S33CapturedTeardownZeroCostMetadata = z.input<
  typeof capturedMetadataSchema
>;

export interface S33TeardownZeroCostResult {
  readonly schemaVersion: 'arkova.s33.l1.teardown-zero-cost-result/v2';
  readonly status: 'CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED';
  readonly releaseAcceptance: false;
  readonly runId: string;
  readonly exactHeadSha: string;
  readonly exactTreeSha: string;
  readonly producerIdentity: string;
  readonly resourceBoundarySha256: string;
  readonly releaseBoundaryComplete: true;
  readonly boundaryStatus: 'COMPLETE';
  readonly beforeCapturedAt: string;
  readonly afterCapturedAt: string;
  readonly beforeArtifactSha256: string;
  readonly afterArtifactSha256: string;
  readonly resourceCount: number;
  readonly deletedCount: number;
  readonly releasedExpiredCount: number;
  readonly downgradedZeroRecurringCount: 0;
  readonly projectedMonthlyRecurringUsd: 0;
  readonly recurring_cost_zero: true;
  readonly zeroRecurringProjected: true;
  readonly inventoryDiff: readonly S33TeardownInventoryDiffRow[];
  readonly operator: S33TeardownCapturedVerification['operator'];
  readonly signer: S33TeardownCapturedVerification['signer'];
  readonly signature: Readonly<{
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY';
    status: 'BLOCKED_UNAVAILABLE';
    envelope: null;
  }>;
  readonly producerDependencies: readonly [
    'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
  ];
  readonly inputDigestSha256: string;
  readonly resultDigestSha256: string;
}

const TEARDOWN_RESULTS = new WeakSet<object>();

export function requireS33TeardownZeroCostResult(
  candidate: unknown,
): S33TeardownZeroCostResult {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Teardown evidence requires a provenance-bound result.');
  }
  const result = candidate as S33TeardownZeroCostResult;
  if (!TEARDOWN_RESULTS.has(result)) {
    throw new Error('Teardown evidence requires a provenance-bound result.');
  }
  return result;
}

function parseCapturedMetadata(raw: unknown): z.output<typeof capturedMetadataSchema> {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Captured teardown consumer metadata must be an object.');
  }
  let snapshot: unknown;
  try {
    snapshot = structuredClone(raw);
  } catch (error) {
    throw new TypeError('Captured teardown consumer metadata must be immutable data.', {
      cause: error,
    });
  }
  const parsed = capturedMetadataSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(
      `Captured teardown consumer metadata schema rejected: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function consumeS33TeardownInventoryVerification(
  metadataRaw: unknown,
  verificationRaw: unknown,
): S33TeardownZeroCostResult {
  const metadata = parseCapturedMetadata(metadataRaw);
  const verification = requireS33TeardownCapturedVerification(verificationRaw);
  if (
    !verification.verified
    || !verification.protectedResourcesUntouched
    || !verification.releaseBoundaryComplete
    || verification.boundaryStatus !== 'COMPLETE'
    || verification.unboundRigIds.length !== 0
    || verification.recurringCostVerdict !== 'recurring_cost_zero'
    || !verification.recurring_cost_zero
    || verification.projectedMonthlyRecurringUsd !== 0
  ) {
    throw new Error(
      'Captured teardown verification is blocked; recurring_cost_zero requires complete targets and protected-resource no-drift.',
    );
  }
  if (
    verification.releaseAcceptance !== false
    || verification.signatureVerification !== 'UNVERIFIED_EXTERNAL_ARTIFACT'
    || verification.signer.verificationStatus !== 'UNVERIFIED_EXTERNAL_ARTIFACT'
  ) {
    throw new Error('Captured teardown signer metadata cannot satisfy release signature authority.');
  }
  if (
    metadata.exactHeadSha !== verification.gitHeadSha
    || metadata.exactTreeSha !== verification.gitTreeSha
  ) {
    throw new Error('Captured teardown exact head/tree identity is stale or contradictory.');
  }

  const identities = new Set<string>();
  const evidenceArtifacts = new Set<string>();
  const inventoryDiff = verification.targetOutcomes.map(
    (outcome): S33TeardownInventoryDiffRow => {
      if (
        (outcome.state !== 'REMOVED' && outcome.state !== 'RELEASED_EXPIRED')
        || outcome.projectedMonthlyRecurringUsd !== 0
      ) {
        throw new Error('Captured teardown target outcome is not deleted at zero recurring cost.');
      }
      const identity = [
        outcome.provider,
        outcome.kind,
        outcome.scopeId,
        outcome.resourceId,
      ].join('\u0000');
      if (identities.has(identity)) {
        throw new Error(`Captured teardown target identity is duplicated: ${identity}.`);
      }
      if (evidenceArtifacts.has(outcome.evidenceArtifactSha256)) {
        throw new Error('Captured teardown target evidence artifacts must be distinct.');
      }
      identities.add(identity);
      evidenceArtifacts.add(outcome.evidenceArtifactSha256);
      return {
        provider: outcome.provider,
        kind: outcome.kind,
        scopeId: outcome.scopeId,
        resourceId: outcome.resourceId,
        billingClass: outcome.billingClass,
        targetProvenance: { ...outcome.targetProvenance },
        terminalState: outcome.state === 'RELEASED_EXPIRED'
          ? 'RELEASED_EXPIRED'
          : 'DELETED',
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: outcome.evidenceArtifactSha256,
      };
    },
  );
  if (inventoryDiff.length === 0) {
    throw new Error('Captured teardown inventory must include at least one target resource.');
  }
  const deletedCount = inventoryDiff.filter(
    ({ terminalState }) => terminalState === 'DELETED',
  ).length;
  const releasedExpiredCount = inventoryDiff.filter(
    ({ terminalState }) => terminalState === 'RELEASED_EXPIRED',
  ).length;

  const inputDigestSha256 = digestS33Evidence({
    metadata,
    verificationDigestSha256: verification.verificationDigestSha256,
  }, 'captured teardown consumer input');
  const resultWithoutDigest = {
    schemaVersion: 'arkova.s33.l1.teardown-zero-cost-result/v2' as const,
    status: 'CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED' as const,
    releaseAcceptance: false as const,
    runId: metadata.runId,
    exactHeadSha: metadata.exactHeadSha,
    exactTreeSha: metadata.exactTreeSha,
    producerIdentity: verification.verificationDigestSha256,
    resourceBoundarySha256: verification.resourceBoundarySha256,
    releaseBoundaryComplete: true as const,
    boundaryStatus: 'COMPLETE' as const,
    beforeCapturedAt: verification.beforeCapturedAt,
    afterCapturedAt: verification.afterCapturedAt,
    beforeArtifactSha256: verification.beforeCaptureArtifactSha256,
    afterArtifactSha256: verification.afterCaptureArtifactSha256,
    resourceCount: inventoryDiff.length,
    deletedCount,
    releasedExpiredCount,
    downgradedZeroRecurringCount: 0 as const,
    projectedMonthlyRecurringUsd: 0 as const,
    recurring_cost_zero: true as const,
    zeroRecurringProjected: true as const,
    inventoryDiff,
    operator: { ...verification.operator },
    signer: { ...verification.signer },
    signature: { ...metadata.signature },
    producerDependencies: [
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ] as const,
    inputDigestSha256,
  };
  const result = freezeS33Evidence<S33TeardownZeroCostResult>({
    ...resultWithoutDigest,
    resultDigestSha256: digestS33Evidence(
      resultWithoutDigest,
      'captured teardown consumer result',
    ),
  });
  TEARDOWN_RESULTS.add(result);
  return result;
}

export function verifyS33TeardownZeroCost(
  rawInput: unknown,
): S33TeardownZeroCostResult {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new TypeError('Captured teardown consumer input must be an object.');
  }
  const keys = Object.keys(rawInput).sort((left, right) => left.localeCompare(right));
  if (
    keys.length !== 2
    || keys[0] !== 'metadata'
    || keys[1] !== 'teardownVerification'
  ) {
    throw new Error(
      'Captured teardown consumer input requires exact top-level metadata and teardownVerification fields.',
    );
  }
  const input = rawInput as Record<string, unknown>;
  const metadata = input.metadata;
  const teardownVerification = input.teardownVerification;
  return consumeS33TeardownInventoryVerification(metadata, teardownVerification);
}
