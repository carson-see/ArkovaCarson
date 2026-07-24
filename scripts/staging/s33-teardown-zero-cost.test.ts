import { describe, expect, it } from 'vitest';

import {
  requireS33TeardownZeroCostResult,
  verifyS33TeardownZeroCost,
  type S33TeardownZeroCostInput,
} from './s33-teardown-zero-cost';

const SHA = (character: string) => `sha256:${character.repeat(64)}`;

const input = (
  overrides: Partial<S33TeardownZeroCostInput> = {},
): S33TeardownZeroCostInput => ({
  schemaVersion: 'arkova.s33.l1.teardown-zero-cost-input/v1',
  evidenceMode: 'OFFLINE_FIXTURE',
  runId: 's33-w3-c-teardown-fixture',
  exactHeadSha: 'a'.repeat(40),
  exactTreeSha: 'b'.repeat(40),
  producerBoundary: {
    lane2TeardownSchemaVersion: null,
    lane2TeardownIdentity: null,
    status: 'BLOCKED_UNAVAILABLE',
  },
  before: {
    capturedAt: '2026-07-16T12:00:00.000Z',
    artifactSha256: SHA('1'),
    resources: [
      {
        provider: 'GCP',
        kind: 'cloud-run-service',
        scopeId: 'project-rig-b1',
        resourceId: 'worker-rig-b1',
        billingClass: 'RECURRING_PAID',
      },
      {
        provider: 'GCP',
        kind: 'cloud-scheduler-job-set',
        scopeId: 'project-rig-b1',
        resourceId: 'scheduler-rig-b1',
        billingClass: 'RECURRING_PAID',
      },
      {
        provider: 'SUPABASE',
        kind: 'isolated-project',
        scopeId: 'org-arkova',
        resourceId: 'project-rig-b1',
        billingClass: 'RECURRING_PAID',
      },
      {
        provider: 'GCP',
        kind: 'secret-set',
        scopeId: 'project-rig-b1',
        resourceId: 'signet-secret-set',
        billingClass: 'NO_RECURRING_CHARGE',
      },
    ],
  },
  after: {
    capturedAt: '2026-07-16T12:10:00.000Z',
    artifactSha256: SHA('2'),
    resources: [
      {
        provider: 'GCP',
        kind: 'cloud-run-service',
        scopeId: 'project-rig-b1',
        resourceId: 'worker-rig-b1',
        state: 'DELETED',
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: SHA('3'),
      },
      {
        provider: 'GCP',
        kind: 'cloud-scheduler-job-set',
        scopeId: 'project-rig-b1',
        resourceId: 'scheduler-rig-b1',
        state: 'DELETED',
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: SHA('4'),
      },
      {
        provider: 'SUPABASE',
        kind: 'isolated-project',
        scopeId: 'org-arkova',
        resourceId: 'project-rig-b1',
        state: 'DOWNGRADED_ZERO_RECURRING',
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: SHA('5'),
      },
      {
        provider: 'GCP',
        kind: 'secret-set',
        scopeId: 'project-rig-b1',
        resourceId: 'signet-secret-set',
        state: 'DELETED',
        projectedMonthlyRecurringUsd: 0,
        evidenceArtifactSha256: SHA('6'),
      },
    ],
  },
  signature: {
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
    status: 'BLOCKED_UNAVAILABLE',
    envelope: null,
  },
  ...overrides,
});

describe('S3.3 W3-C teardown and zero-recurring-cost consumer', () => {
  it('verifies an exact before/after bijection and keeps producer acceptance blocked', () => {
    const result = verifyS33TeardownZeroCost(input());

    expect(result).toMatchObject({
      status: 'OFFLINE_DIFF_VERIFIED_PRODUCER_BLOCKED',
      releaseAcceptance: false,
      resourceCount: 4,
      deletedCount: 3,
      downgradedZeroRecurringCount: 1,
      projectedMonthlyRecurringUsd: 0,
      zeroRecurringProjected: true,
    });
    expect(result.producerDependencies).toEqual([
      'LANE2_TEARDOWN_INVENTORY_IDENTITY_UNAVAILABLE',
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ]);
    expect(result.inventoryDiff).toHaveLength(4);
    expect(result.resultDigestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects omitted, extra, or duplicate inventory identities', () => {
    const omitted = input();
    omitted.after.resources = omitted.after.resources.slice(0, 3);
    expect(() => verifyS33TeardownZeroCost(omitted)).toThrow(
      /exact|missing|bijection|inventory/i,
    );

    const extra = input();
    extra.after.resources.push({
      ...extra.after.resources[0]!,
      resourceId: 'unscoped-extra-resource',
      evidenceArtifactSha256: SHA('7'),
    });
    expect(() => verifyS33TeardownZeroCost(extra)).toThrow(
      /exact|extra|bijection|inventory/i,
    );

    const duplicate = input();
    duplicate.before.resources[1] = { ...duplicate.before.resources[0]! };
    expect(() => verifyS33TeardownZeroCost(duplicate)).toThrow(
      /duplicate|unique|inventory/i,
    );
  });

  it('rejects PAUSED/ACTIVE survivors and every non-zero recurring projection', () => {
    for (const state of ['PAUSED', 'ACTIVE'] as const) {
      const surviving = input();
      surviving.after.resources[0] = {
        ...surviving.after.resources[0]!,
        state,
      };
      expect(() => verifyS33TeardownZeroCost(surviving)).toThrow(
        /deleted|downgraded|PAUSED|ACTIVE|survivor/i,
      );
    }

    const billed = input();
    billed.after.resources[2] = {
      ...billed.after.resources[2]!,
      projectedMonthlyRecurringUsd: 0.01,
    };
    expect(() => verifyS33TeardownZeroCost(billed)).toThrow(
      /zero|recurring|cost/i,
    );
  });

  it('strictly rejects invented producer identities, secret material, and cloned results', () => {
    const inventedProducer = {
      ...input(),
      producerBoundary: {
        lane2TeardownSchemaVersion: 'invented/v1',
        lane2TeardownIdentity: 'invented-id',
        status: 'AVAILABLE',
      },
    } as unknown;
    expect(() => verifyS33TeardownZeroCost(inventedProducer)).toThrow(
      /producerBoundary|BLOCKED_UNAVAILABLE|null|invalid/i,
    );

    const secretBearing = input() as unknown as {
      before: { resources: Array<Record<string, unknown>> };
    };
    secretBearing.before.resources[0]!.credential = 'must-not-survive';
    expect(() => verifyS33TeardownZeroCost(secretBearing)).toThrow(
      /unrecognized|credential|strict/i,
    );

    const result = verifyS33TeardownZeroCost(input());
    expect(requireS33TeardownZeroCostResult(result)).toBe(result);
    expect(() => requireS33TeardownZeroCostResult(structuredClone(result)))
      .toThrow(/provenance|teardown/i);
  });
});
