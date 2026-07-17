import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  projectAdmissionV2ToPreClockIdentity,
  requirePreClockAdmissionIdentity,
} from './batch-drain-admission-adapter';
import {
  buildWave3DrainDriverPlan,
  digestWave3TriggerObservation,
  type Wave3TriggerObservation,
} from './batch-drain-wave3-driver';
import {
  captureS33ReleaseAdmissionIdentity,
  composeS33ReleaseEvidenceChain,
  requireS33ReleaseEvidenceChainResult,
  type S33ReleaseEvidenceChainMetadata,
} from './s33-release-evidence-chain';
import {
  calculateS33TreasuryRunway,
  type S33TreasuryRunwayInput,
} from './s33-treasury-runway';
import {
  verifyS33TeardownZeroCost,
  type S33TeardownZeroCostInput,
} from './s33-teardown-zero-cost';
import {
  TEST_TEARDOWN_TREE_SHA,
  buildTestTeardownCapturedVerification,
} from './s33-teardown-inventory.test-fixture';

const ADMISSION_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
  'utf8',
);
const TREE_SHA = TEST_TEARDOWN_TREE_SHA;
const RUN_ID = 's33-w3-c-release-chain-fixture';
const SHA = (character: string) => `sha256:${character.repeat(64)}`;

function admission() {
  const raw = JSON.parse(ADMISSION_RAW) as { scheduler: { state: string } };
  raw.scheduler.state = 'paused_after_clean_mirror';
  return projectAdmissionV2ToPreClockIdentity(JSON.stringify(raw));
}

function fixture(options: {
  teardownBeforeAt?: string;
  teardownAfterAt?: string;
  composedAt?: string;
} = {}) {
  const admissionHandle = admission();
  const identity = requirePreClockAdmissionIdentity(admissionHandle);
  const drainPlan = buildWave3DrainDriverPlan({
    runId: RUN_ID,
    gitHeadSha: identity.gitHeadSha,
    imageDigest: identity.imageDigest,
    orgs: 30,
  });
  const triggerCaptures: Wave3TriggerObservation[] = drainPlan.triggerExecutionPlan.map(
    (execution, index) => {
      const capture = {
        ...structuredClone(execution),
        observedAt: `2026-07-16T12:${String(index * 5).padStart(2, '0')}:00.000Z`,
        evidenceArtifactSha256: SHA(String(index + 1)),
      };
      return {
        ...capture,
        observationDigestSha256: digestWave3TriggerObservation(capture),
      };
    },
  );
  const runwayInput: S33TreasuryRunwayInput = {
    schemaVersion: 'arkova.s33.l1.treasury-runway-input/v1',
    evidenceMode: 'OFFLINE_PAPER_UNSIGNED',
    modelId: 's33-w3-c-runway-fixture',
    generatedAt: '2026-07-16T11:00:00.000Z',
    exactHeadSha: identity.gitHeadSha,
    exactTreeSha: TREE_SHA,
    claimClass: 'ASSERTED_MAINNET_FEE_MODEL_NOT_MEASURED_ON_CHAIN',
    feeModel: {
      sourcePath: 'services/worker/src/chain/signet.ts',
      sourceBlobSha: 'e'.repeat(40),
      expression: 'estimateTxVsize(true, 36)',
      hasChange: true,
      opReturnPayloadBytes: 36,
      txVbytes: 157,
    },
    baseline: {
      transactionsPerDay: 1,
      claimClass: 'ASSERTED_CURRENT_TOPOLOGY_NOT_CHAIN_MEASURED',
    },
    fanout: {
      orgCounts: [5, 25, 50, 100],
      feeRatesSatPerVbyte: [2, 10, 50],
    },
    illustrativeTreasuryBalanceSats: 5_000_000,
    signetMechanism: {
      claimClass: 'MECHANISM_ONLY_NOT_MAINNET_COST',
      status: 'DEFERRED_POST_WAVE3',
      measuredVbytes: null,
      artifactSha256: null,
    },
    signature: {
      authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
      envelope: null,
    },
  };
  const teardownVerification = buildTestTeardownCapturedVerification({
    beforeCapturedAt: options.teardownBeforeAt,
    afterCapturedAt: options.teardownAfterAt,
  });
  const teardownInput: S33TeardownZeroCostInput = {
    metadata: {
      schemaVersion: 'arkova.s33.l1.teardown-zero-cost-input/v2',
      evidenceMode: 'CAPTURED_INVENTORY_SIGNATURE_BLOCKED',
      runId: RUN_ID,
      exactHeadSha: identity.gitHeadSha,
      exactTreeSha: TREE_SHA,
      signature: {
        authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
        status: 'BLOCKED_UNAVAILABLE',
        envelope: null,
      },
    },
    teardownVerification,
  };
  const teardownResult = verifyS33TeardownZeroCost(teardownInput);
  const metadata: S33ReleaseEvidenceChainMetadata = {
    schemaVersion: 'arkova.s33.l1.release-evidence-chain-input/v2',
    evidenceMode: 'OFFLINE_COMPOSITION_SIGNATURE_BLOCKED',
    runId: RUN_ID,
    composedAt: options.composedAt ?? '2026-07-16T13:15:00.000Z',
    exactHeadSha: identity.gitHeadSha,
    exactTreeSha: TREE_SHA,
    producerBoundary: {
      lane2TeardownSchemaVersion: 'arkova.s33.l2.teardown-captured-verification/v1',
      lane2TeardownIdentity: teardownResult.producerIdentity,
      lane3SignatureSchemaVersion: null,
      lane3SignatureAuthority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'LANE2_VERIFIED_SIGNATURE_BLOCKED',
    },
    signature: {
      authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
      envelope: null,
    },
  };
  return {
    admissionHandle,
    drainPlan,
    triggerCaptures,
    runwayResult: calculateS33TreasuryRunway(runwayInput),
    teardownResult,
    metadata,
  };
}

describe('S3.3 W3-C release evidence-chain consumer', () => {
  it('strictly captures the complete canonical pre-clock infrastructure identity', () => {
    const identity = structuredClone(requirePreClockAdmissionIdentity(admission()));
    const captured = captureS33ReleaseAdmissionIdentity(identity);

    expect(captured).toEqual(identity);
    expect(captured.infrastructure.treasuryWatchOnly.expectedTotalSats).toBe(169_639);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.infrastructure)).toBe(true);

    const missing = structuredClone(identity) as unknown as Record<string, unknown>;
    delete missing.infrastructure;
    expect(() => captureS33ReleaseAdmissionIdentity(missing)).toThrow(
      /infrastructure|release admission identity|strict/i,
    );

    const extra = structuredClone(identity) as unknown as {
      infrastructure: Record<string, unknown>;
    };
    extra.infrastructure.unrecognizedTopology = 'must-not-survive';
    expect(() => captureS33ReleaseAdmissionIdentity(extra)).toThrow(
      /unrecognizedTopology|unrecognized|strict/i,
    );

    const drifted = structuredClone(identity);
    drifted.infrastructure.treasuryWatchOnly.preSplitPlanDigest = SHA('f');
    expect(() => captureS33ReleaseAdmissionIdentity(drifted)).toThrow(
      /treasury plan|node readiness|preSplitPlanDigest|strict/i,
    );
  });

  it('binds admission, exact A/A/B/D/org evidence, runway, and teardown as a blocked draft', () => {
    const input = fixture();
    const result = composeS33ReleaseEvidenceChain(input);

    expect(result).toMatchObject({
      status: 'OFFLINE_CHAIN_DRAFT_SIGNATURE_BLOCKED',
      releaseAcceptance: false,
      runId: RUN_ID,
      exactHeadSha: input.metadata.exactHeadSha,
      exactTreeSha: TREE_SHA,
    });
    expect(result.drain.executionSignature).toEqual([
      'trigger-a-size:1',
      'trigger-a-size:2',
      'trigger-b-age:1',
      'trigger-d-force:1',
      'org-scheduler:1',
    ]);
    expect(result.drain.triggerEvidence).toHaveLength(5);
    expect(result.runway).toMatchObject({
      status: 'OFFLINE_PAPER_UNSIGNED',
      releaseAcceptance: false,
    });
    expect(result.teardown).toMatchObject({
      status: 'CAPTURED_INVENTORY_VERIFIED_SIGNATURE_BLOCKED',
      producerIdentity: input.teardownResult.producerIdentity,
      recurring_cost_zero: true,
      zeroRecurringProjected: true,
      projectedMonthlyRecurringUsd: 0,
      releaseAcceptance: false,
    });
    expect(result.signature.envelope).toBeNull();
    expect(result.producerDependencies).toEqual([
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ]);
    expect(new Set(result.sourceArtifactDigests).size)
      .toBe(result.sourceArtifactDigests.length);
    expect(result.resultDigestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('uses one immutable trigger snapshot when caller values change between reads', () => {
    const input = fixture();
    const firstCapture = input.triggerCaptures[0]!;
    const canonicalTrigger = firstCapture.trigger;
    const canonicalOrdinal = firstCapture.executionOrdinal;
    let triggerReads = 0;
    let ordinalReads = 0;

    Object.defineProperty(firstCapture, 'trigger', {
      configurable: true,
      enumerable: true,
      get() {
        triggerReads += 1;
        return triggerReads === 1 ? canonicalTrigger : 'org-scheduler';
      },
    });
    Object.defineProperty(firstCapture, 'executionOrdinal', {
      configurable: true,
      enumerable: true,
      get() {
        ordinalReads += 1;
        return ordinalReads === 1 ? canonicalOrdinal : 99;
      },
    });

    const result = composeS33ReleaseEvidenceChain(input);

    expect(triggerReads).toBe(1);
    expect(ordinalReads).toBe(1);
    expect(result.drain.exactIdentity).toBe(true);
    expect(result.drain.executionSignature).toEqual([
      'trigger-a-size:1',
      'trigger-a-size:2',
      'trigger-b-age:1',
      'trigger-d-force:1',
      'org-scheduler:1',
    ]);
    expect(result.drain.triggerEvidence[0]).toMatchObject({
      trigger: 'trigger-a-size',
      cause: 'SIZE_THRESHOLD',
      executionOrdinal: 1,
    });
  });

  it('uses the one provenance-validated drain plan captured at function ingress', () => {
    const input = fixture();
    const validatedPlan = input.drainPlan;
    const switchedPlan = buildWave3DrainDriverPlan({
      runId: validatedPlan.runId,
      gitHeadSha: validatedPlan.gitHeadSha,
      imageDigest: validatedPlan.imageDigest,
      orgs: 31,
    });
    expect(switchedPlan.planDigest).not.toBe(validatedPlan.planDigest);
    let reads = 0;
    Object.defineProperty(input, 'drainPlan', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? validatedPlan : switchedPlan;
      },
    });

    const result = composeS33ReleaseEvidenceChain(input);

    expect(reads).toBe(1);
    expect(result.drain.planDigest).toBe(validatedPlan.planDigest);
    expect(result.derivedManifestDigests[0]).toBe(validatedPlan.planDigest);
    expect(result.drain.triggerEvidence.every(
      ({ observationDigestSha256 }) => result.derivedManifestDigests.includes(
        observationDigestSha256,
      ),
    )).toBe(true);
  });

  it('uses the one authenticated admission handle captured at function ingress', () => {
    const input = fixture();
    const authenticatedHandle = input.admissionHandle;
    const unauthenticatedSwitch = { admissionSha256: 'a'.repeat(64) };
    let reads = 0;
    Object.defineProperty(input, 'admissionHandle', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? authenticatedHandle : unauthenticatedSwitch;
      },
    });

    const result = composeS33ReleaseEvidenceChain(input);
    const authenticatedDigest = `sha256:${authenticatedHandle.admissionSha256}`;

    expect(reads).toBe(1);
    expect(result.admission.artifactSha256).toBe(authenticatedDigest);
    expect(result.sourceArtifactDigests[0]).toBe(authenticatedDigest);
    expect(result.sourceArtifactDigests).not.toContain(`sha256:${'a'.repeat(64)}`);
  });

  it('reads every top-level composer dependency exactly once', () => {
    const values = fixture();
    const keys = [
      'metadata',
      'admissionHandle',
      'drainPlan',
      'triggerCaptures',
      'runwayResult',
      'teardownResult',
    ] as const;
    const reads = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
      (typeof keys)[number],
      number
    >;
    const input = {} as typeof values;
    for (const key of keys) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads[key] += 1;
          return values[key];
        },
      });
    }

    const result = composeS33ReleaseEvidenceChain(input);

    expect(result.drain.exactIdentity).toBe(true);
    expect(reads).toEqual({
      metadata: 1,
      admissionHandle: 1,
      drainPlan: 1,
      triggerCaptures: 1,
      runwayResult: 1,
      teardownResult: 1,
    });
  });

  it('fails closed on stale head/tree/image bindings or incomplete trigger multiplicity', () => {
    const staleHead = fixture();
    staleHead.metadata.exactHeadSha = 'd'.repeat(40);
    expect(() => composeS33ReleaseEvidenceChain(staleHead)).toThrow(
      /head|admission|identity|stale/i,
    );

    const staleTree = fixture();
    staleTree.metadata.exactTreeSha = 'd'.repeat(40);
    expect(() => composeS33ReleaseEvidenceChain(staleTree)).toThrow(
      /tree|runway|teardown|stale/i,
    );

    const staleImage = fixture();
    staleImage.drainPlan = buildWave3DrainDriverPlan({
      runId: RUN_ID,
      gitHeadSha: staleImage.metadata.exactHeadSha,
      imageDigest: SHA('a'),
      orgs: 30,
    });
    expect(() => composeS33ReleaseEvidenceChain(staleImage)).toThrow(
      /image|admission|identity|stale/i,
    );

    const incomplete = fixture();
    incomplete.triggerCaptures = incomplete.triggerCaptures.slice(0, 4);
    expect(() => composeS33ReleaseEvidenceChain(incomplete)).toThrow(
      /five|org.scheduler|exact|multiplicity/i,
    );

    const earlyTeardown = fixture({
      teardownBeforeAt: '2026-07-16T12:10:00.000Z',
      teardownAfterAt: '2026-07-16T12:15:00.000Z',
    });
    expect(() => composeS33ReleaseEvidenceChain(earlyTeardown)).toThrow(
      /teardown|chronology|trigger|precedes/i,
    );

    const earlyComposition = fixture({
      composedAt: '2026-07-16T13:05:00.000Z',
    });
    expect(() => composeS33ReleaseEvidenceChain(earlyComposition)).toThrow(
      /composition|chronology|teardown|precedes/i,
    );
  });

  it('requires provenance-branded inputs and rejects caller clones', () => {
    const inputs = fixture();
    expect(() => composeS33ReleaseEvidenceChain({
      ...inputs,
      admissionHandle: structuredClone(inputs.admissionHandle),
    })).toThrow(/admission|provenance|paused/i);
    expect(() => composeS33ReleaseEvidenceChain({
      ...fixture(),
      drainPlan: structuredClone(inputs.drainPlan),
    })).toThrow(/drain plan|provenance|validated/i);
    expect(() => composeS33ReleaseEvidenceChain({
      ...fixture(),
      runwayResult: structuredClone(inputs.runwayResult),
    })).toThrow(/runway|provenance/i);
    expect(() => composeS33ReleaseEvidenceChain({
      ...fixture(),
      teardownResult: structuredClone(inputs.teardownResult),
    })).toThrow(/teardown|provenance/i);
  });

  it('rejects invented producer/signature identities and clone promotion', () => {
    const invented = fixture() as unknown as {
      metadata: Record<string, unknown> & {
        producerBoundary: Record<string, unknown>;
      };
    };
    invented.metadata.producerBoundary.lane2TeardownIdentity = 'invented-id';
    expect(() => composeS33ReleaseEvidenceChain(invented as never)).toThrow(
      /producerBoundary|lane2TeardownIdentity|null|invalid/i,
    );

    const signed = fixture() as unknown as {
      metadata: Record<string, unknown> & { signature: Record<string, unknown> };
    };
    signed.metadata.signature.envelope = { signature: 'fabricated' };
    expect(() => composeS33ReleaseEvidenceChain(signed as never)).toThrow(
      /signature|envelope|null|invalid/i,
    );

    const extra = fixture() as unknown as {
      metadata: Record<string, unknown>;
    };
    extra.metadata.secret = 'must-not-survive';
    expect(() => composeS33ReleaseEvidenceChain(extra as never)).toThrow(
      /unrecognized|secret|strict/i,
    );

    const result = composeS33ReleaseEvidenceChain(fixture());
    expect(requireS33ReleaseEvidenceChainResult(result)).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => requireS33ReleaseEvidenceChainResult(structuredClone(result)))
      .toThrow(/release evidence|provenance/i);
  });
});
