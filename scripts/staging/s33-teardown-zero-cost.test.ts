import { describe, expect, it } from 'vitest';

import {
  consumeS33TeardownInventoryVerification,
  requireS33TeardownZeroCostResult,
  verifyS33TeardownZeroCost,
  type S33TeardownZeroCostInput,
} from './s33-teardown-zero-cost';
import {
  TEST_TEARDOWN_HEAD_SHA,
  TEST_TEARDOWN_TREE_SHA,
  buildTestPreSoakCapturedVerification,
  buildTestTeardownCapturedVerification,
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
      signature: {
        authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
        status: 'BLOCKED_UNAVAILABLE',
        envelope: null,
      },
    });
    expect(result.inventoryDiff).toHaveLength(21);
    expect(result.inventoryDiff.every(
      ({ terminalState, projectedMonthlyRecurringUsd }) => (
        terminalState === 'DELETED' && projectedMonthlyRecurringUsd === 0
      ),
    )).toBe(true);
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
});
