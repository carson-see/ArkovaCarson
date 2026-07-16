import { describe, expect, it } from 'vitest';

import {
  consumeS33TeardownInventoryVerification,
  requireS33TeardownZeroCostResult,
  verifyS33TeardownZeroCost,
  type S33TeardownZeroCostInput,
} from './s33-teardown-zero-cost';
import {
  captureS33TeardownInventory,
  verifyS33TeardownCapturedInventories,
} from './s33-teardown-inventory';
import {
  TEST_TEARDOWN_DECLARATION,
  TEST_TEARDOWN_HEAD_SHA,
  TEST_TEARDOWN_TREE_SHA,
  buildTestPreSoakCapturedVerification,
  buildTestTeardownCapturedVerification,
  testTeardownAfterInventory,
  testTeardownBeforeInventory,
  testTeardownCaptureMetadata,
} from './s33-teardown-inventory.test-fixture';

describe('S3.3 captured teardown provenance adapter', () => {
  const metadata = () => ({
    schemaVersion: 'arkova.s33.l1.teardown-zero-cost-input/v2',
    evidenceMode: 'CAPTURED_INVENTORY_SIGNATURE_BLOCKED',
    runId: 's33-w3-c-captured-teardown',
    exactHeadSha: TEST_TEARDOWN_HEAD_SHA,
    exactTreeSha: TEST_TEARDOWN_TREE_SHA,
    signature: {
      authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
      envelope: null,
    },
  } as const);

  function verificationWithLeaseReleasedAt(releasedAt: string) {
    const afterInventory = testTeardownAfterInventory();
    return verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      captureS33TeardownInventory(
        TEST_TEARDOWN_DECLARATION,
        testTeardownBeforeInventory(),
        testTeardownCaptureMetadata('before'),
      ),
      captureS33TeardownInventory(
        TEST_TEARDOWN_DECLARATION,
        {
          ...afterInventory,
          resources: {
            ...afterInventory.resources,
            leases: afterInventory.resources.leases.map((lease) => ({
              ...lease,
              releasedAt,
            })),
          },
        },
        testTeardownCaptureMetadata('after'),
      ),
    );
  }

  it('consumes only the branded Lane2 capture verification and closes its producer gap', () => {
    const verification = buildTestTeardownCapturedVerification();
    const result = consumeS33TeardownInventoryVerification(metadata(), verification);

    expect(result).toMatchObject({
      schemaVersion: 'arkova.s33.l1.teardown-zero-cost-result/v2',
      status: 'CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED',
      releaseAcceptance: false,
      producerIdentity: verification.verificationDigestSha256,
      resourceBoundarySha256: verification.resourceBoundarySha256,
      recurring_cost_zero: true,
      zeroRecurringProjected: true,
      projectedMonthlyRecurringUsd: 0,
      resourceCount: 24,
      deletedCount: 23,
      releasedExpiredCount: 1,
      signature: {
        authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
        status: 'BLOCKED_UNAVAILABLE',
        envelope: null,
      },
    });
    expect(result.inventoryDiff).toHaveLength(24);
    expect(result.inventoryDiff.every(
      ({ terminalState, projectedMonthlyRecurringUsd }) => (
        (terminalState === 'DELETED' || terminalState === 'RELEASED_EXPIRED')
        && projectedMonthlyRecurringUsd === 0
      ),
    )).toBe(true);
    expect(result.inventoryDiff).toContainEqual(expect.objectContaining({
      kind: 'logical-lease',
      terminalState: 'RELEASED_EXPIRED',
    }));
    expect(result.producerDependencies).toEqual([
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ]);
    expect(result.operator.operatorId).toBe('rte-s33-closeout');
    expect(result.signer.verificationStatus).toBe('UNVERIFIED_EXTERNAL_ARTIFACT');
    expect(requireS33TeardownZeroCostResult(result)).toBe(result);
  });

  it('makes branded captured verification the only existing zero-cost consumer path', () => {
    const teardownVerification = buildTestTeardownCapturedVerification();
    const capturedInput: S33TeardownZeroCostInput = {
      metadata: metadata(),
      teardownVerification,
    };
    const result = verifyS33TeardownZeroCost(capturedInput);

    expect(result.producerIdentity).toBe(teardownVerification.verificationDigestSha256);
    expect(() => verifyS33TeardownZeroCost({
      schemaVersion: 'arkova.s33.l1.teardown-zero-cost-input/v1',
      evidenceMode: 'OFFLINE_FIXTURE',
    })).toThrow(/captured|top-level|metadata|verification|schema/i);
  });

  it('rejects raw/cloned producer objects and a stale exact candidate identity', () => {
    const verification = buildTestTeardownCapturedVerification();
    expect(() => consumeS33TeardownInventoryVerification(
      metadata(),
      structuredClone(verification),
    )).toThrow(/provenance|captured|verification/i);

    expect(() => consumeS33TeardownInventoryVerification({
      ...metadata(),
      exactTreeSha: 'f'.repeat(40),
    }, verification)).toThrow(/tree|identity|stale|contradict/i);
  });

  it('rejects a valid G1/B1 pre-soak verification until RIG-R has a CTO-bound boundary', () => {
    const partial = buildTestPreSoakCapturedVerification();
    expect(partial).toMatchObject({
      verified: true,
      releaseBoundaryComplete: false,
      boundaryStatus: 'PARTIAL_RIG_R_CTO_BINDING_REQUIRED',
      recurring_cost_zero: false,
    });
    expect(() => consumeS33TeardownInventoryVerification(
      metadata(),
      partial,
    )).toThrow(/blocked|complete|RIG-R|boundary|recurring_cost_zero/i);
  });

  it('cannot turn descriptive test signer metadata into release acceptance', () => {
    const result = consumeS33TeardownInventoryVerification(
      metadata(),
      buildTestTeardownCapturedVerification(),
    );

    expect(result.signer.keyId).toContain('test-only');
    expect(result.signer.verificationStatus).toBe('UNVERIFIED_EXTERNAL_ARTIFACT');
    expect(result.signature.status).toBe('BLOCKED_UNAVAILABLE');
    expect(result.releaseAcceptance).toBe(false);
  });

  it('blocks captured verification and its $0 consumer when lease release is not after before capture', () => {
    const verification = verificationWithLeaseReleasedAt(
      testTeardownBeforeInventory().capturedAt,
    );

    expect(verification).toMatchObject({
      verified: false,
      recurringCostVerdict: 'blocked',
      recurring_cost_zero: false,
      projectedMonthlyRecurringUsd: null,
    });
    expect(verification.failures.join('\n')).toMatch(/lease|release|expiry|chronolog/i);
    expect(() => consumeS33TeardownInventoryVerification(
      metadata(),
      verification,
    )).toThrow(/blocked|complete|lease|recurring_cost_zero/i);
  });

  it('blocks captured verification and its $0 consumer when lease release follows expiry', () => {
    const expiresAt = testTeardownAfterInventory().resources.leases[0].expiresAt;
    const verification = verificationWithLeaseReleasedAt(
      new Date(Date.parse(expiresAt) + 60_000).toISOString(),
    );

    expect(verification).toMatchObject({
      verified: false,
      recurringCostVerdict: 'blocked',
      recurring_cost_zero: false,
      projectedMonthlyRecurringUsd: null,
    });
    expect(verification.failures.join('\n')).toMatch(/lease|release|expiry|chronolog/i);
    expect(() => consumeS33TeardownInventoryVerification(
      metadata(),
      verification,
    )).toThrow(/blocked|complete|lease|recurring_cost_zero/i);
  });
});
