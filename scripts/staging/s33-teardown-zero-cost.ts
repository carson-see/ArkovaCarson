/**
 * SCRUM-2695 offline teardown inventory-diff and $0 recurring-cost consumer.
 *
 * Lane 2 has not yet published the authoritative teardown identity/schema.
 * This consumer therefore validates only normalized fixture inventories and
 * always leaves release acceptance blocked. It cannot delete, pause, downgrade,
 * query, or otherwise mutate a resource.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;

const resourceIdentitySchema = z.object({
  provider: z.enum(['GCP', 'SUPABASE']),
  kind: z.string().regex(SAFE_ID),
  scopeId: z.string().regex(SAFE_ID),
  resourceId: z.string().regex(SAFE_ID),
}).strict();

const beforeResourceSchema = resourceIdentitySchema.extend({
  billingClass: z.enum(['RECURRING_PAID', 'NO_RECURRING_CHARGE']),
}).strict();

const afterResourceSchema = resourceIdentitySchema.extend({
  state: z.enum([
    'DELETED',
    'DOWNGRADED_ZERO_RECURRING',
    'PAUSED',
    'ACTIVE',
  ]),
  projectedMonthlyRecurringUsd: z.number().nonnegative().finite(),
  evidenceArtifactSha256: z.string().regex(SHA256),
}).strict();

const inputSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.teardown-zero-cost-input/v1'),
  evidenceMode: z.literal('OFFLINE_FIXTURE'),
  runId: z.string().regex(SAFE_ID),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  producerBoundary: z.object({
    lane2TeardownSchemaVersion: z.null(),
    lane2TeardownIdentity: z.null(),
    status: z.literal('BLOCKED_UNAVAILABLE'),
  }).strict(),
  before: z.object({
    capturedAt: z.string().datetime({ offset: true }),
    artifactSha256: z.string().regex(SHA256),
    resources: z.array(beforeResourceSchema).min(1),
  }).strict(),
  after: z.object({
    capturedAt: z.string().datetime({ offset: true }),
    artifactSha256: z.string().regex(SHA256),
    resources: z.array(afterResourceSchema).min(1),
  }).strict(),
  signature: z.object({
    authority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
    status: z.literal('BLOCKED_UNAVAILABLE'),
    envelope: z.null(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.after.capturedAt) < Date.parse(value.before.capturedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['after', 'capturedAt'],
      message: 'after inventory must be captured at or after before inventory',
    });
  }
  if (value.before.artifactSha256 === value.after.artifactSha256) {
    context.addIssue({
      code: 'custom',
      path: ['after', 'artifactSha256'],
      message: 'before and after inventory artifacts must be distinct',
    });
  }
});

export type S33TeardownZeroCostInput = z.input<typeof inputSchema>;

export interface S33TeardownInventoryDiffRow {
  readonly provider: 'GCP' | 'SUPABASE';
  readonly kind: string;
  readonly scopeId: string;
  readonly resourceId: string;
  readonly billingClass: 'RECURRING_PAID' | 'NO_RECURRING_CHARGE';
  readonly terminalState: 'DELETED' | 'DOWNGRADED_ZERO_RECURRING';
  readonly projectedMonthlyRecurringUsd: 0;
  readonly evidenceArtifactSha256: string;
}

export interface S33TeardownZeroCostResult {
  readonly schemaVersion: 'arkova.s33.l1.teardown-zero-cost-result/v1';
  readonly status: 'OFFLINE_DIFF_VERIFIED_PRODUCER_BLOCKED';
  readonly releaseAcceptance: false;
  readonly runId: string;
  readonly exactHeadSha: string;
  readonly exactTreeSha: string;
  readonly beforeCapturedAt: string;
  readonly afterCapturedAt: string;
  readonly beforeArtifactSha256: string;
  readonly afterArtifactSha256: string;
  readonly resourceCount: number;
  readonly deletedCount: number;
  readonly downgradedZeroRecurringCount: number;
  readonly projectedMonthlyRecurringUsd: 0;
  readonly zeroRecurringProjected: true;
  readonly inventoryDiff: readonly S33TeardownInventoryDiffRow[];
  readonly signature: Readonly<{
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY';
    status: 'BLOCKED_UNAVAILABLE';
    envelope: null;
  }>;
  readonly producerDependencies: readonly [
    'LANE2_TEARDOWN_INVENTORY_IDENTITY_UNAVAILABLE',
    'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
  ];
  readonly inputDigestSha256: string;
  readonly resultDigestSha256: string;
}

const TEARDOWN_RESULTS = new WeakSet<S33TeardownZeroCostResult>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => (
      `${JSON.stringify(key)}:${stableJson(child)}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot digest undefined teardown data.');
  return encoded;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;

function resourceKey(resource: ResourceIdentity): string {
  return [
    resource.provider,
    resource.kind,
    resource.scopeId,
    resource.resourceId,
  ].join('\u0000');
}

function uniqueResourceMap<T extends ResourceIdentity>(
  resources: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const resource of resources) {
    const key = resourceKey(resource);
    if (result.has(key)) {
      throw new Error(`${label} inventory identities must be unique; duplicate ${key}.`);
    }
    result.set(key, resource);
  }
  return result;
}

export function verifyS33TeardownZeroCost(
  rawInput: unknown,
): S33TeardownZeroCostResult {
  const input = inputSchema.parse(rawInput);
  const before = uniqueResourceMap(input.before.resources, 'Before');
  const after = uniqueResourceMap(input.after.resources, 'After');
  const missing = [...before.keys()].filter((key) => !after.has(key));
  const extra = [...after.keys()].filter((key) => !before.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Teardown inventory must be an exact before/after bijection; missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}.`,
    );
  }

  const evidenceArtifacts = new Set<string>();
  const inventoryDiff = [...before.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, prior]): S33TeardownInventoryDiffRow => {
      const final = after.get(key)!;
      if (
        final.state !== 'DELETED'
        && final.state !== 'DOWNGRADED_ZERO_RECURRING'
      ) {
        throw new Error(
          `Teardown resource ${key} remains a ${final.state} survivor; DELETED or DOWNGRADED_ZERO_RECURRING is required.`,
        );
      }
      if (final.projectedMonthlyRecurringUsd !== 0) {
        throw new Error(
          `Teardown resource ${key} does not project zero recurring cost.`,
        );
      }
      if (evidenceArtifacts.has(final.evidenceArtifactSha256)) {
        throw new Error(
          'Each teardown inventory resource requires a unique evidence artifact.',
        );
      }
      evidenceArtifacts.add(final.evidenceArtifactSha256);
      return {
        provider: prior.provider,
        kind: prior.kind,
        scopeId: prior.scopeId,
        resourceId: prior.resourceId,
        billingClass: prior.billingClass,
        terminalState: final.state,
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: final.evidenceArtifactSha256,
      };
    });
  const deletedCount = inventoryDiff.filter(
    ({ terminalState }) => terminalState === 'DELETED',
  ).length;
  const downgradedZeroRecurringCount = inventoryDiff.length - deletedCount;
  const resultWithoutDigest = {
    schemaVersion: 'arkova.s33.l1.teardown-zero-cost-result/v1' as const,
    status: 'OFFLINE_DIFF_VERIFIED_PRODUCER_BLOCKED' as const,
    releaseAcceptance: false as const,
    runId: input.runId,
    exactHeadSha: input.exactHeadSha,
    exactTreeSha: input.exactTreeSha,
    beforeCapturedAt: input.before.capturedAt,
    afterCapturedAt: input.after.capturedAt,
    beforeArtifactSha256: input.before.artifactSha256,
    afterArtifactSha256: input.after.artifactSha256,
    resourceCount: inventoryDiff.length,
    deletedCount,
    downgradedZeroRecurringCount,
    projectedMonthlyRecurringUsd: 0 as const,
    zeroRecurringProjected: true as const,
    inventoryDiff,
    signature: { ...input.signature },
    producerDependencies: [
      'LANE2_TEARDOWN_INVENTORY_IDENTITY_UNAVAILABLE',
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ] as const,
    inputDigestSha256: digest(input),
  };
  const result = deepFreeze<S33TeardownZeroCostResult>({
    ...resultWithoutDigest,
    resultDigestSha256: digest(resultWithoutDigest),
  });
  TEARDOWN_RESULTS.add(result);
  return result;
}

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
