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

const ADMISSION_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
  'utf8',
);
const TREE_SHA = 'f'.repeat(40);
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
  const teardownInput: S33TeardownZeroCostInput = {
    schemaVersion: 'arkova.s33.l1.teardown-zero-cost-input/v1',
    evidenceMode: 'OFFLINE_FIXTURE',
    runId: RUN_ID,
    exactHeadSha: identity.gitHeadSha,
    exactTreeSha: TREE_SHA,
    producerBoundary: {
      lane2TeardownSchemaVersion: null,
      lane2TeardownIdentity: null,
      status: 'BLOCKED_UNAVAILABLE',
    },
    before: {
      capturedAt: options.teardownBeforeAt ?? '2026-07-16T13:00:00.000Z',
      artifactSha256: SHA('6'),
      resources: [
        {
          provider: 'GCP',
          kind: 'cloud-run-service',
          scopeId: identity.gcpProjectId,
          resourceId: identity.workerService,
          billingClass: 'RECURRING_PAID',
        },
        {
          provider: 'SUPABASE',
          kind: 'isolated-project',
          scopeId: 'org-arkova',
          resourceId: 'project-rig-b1',
          billingClass: 'RECURRING_PAID',
        },
      ],
    },
    after: {
      capturedAt: options.teardownAfterAt ?? '2026-07-16T13:10:00.000Z',
      artifactSha256: SHA('7'),
      resources: [
        {
          provider: 'GCP',
          kind: 'cloud-run-service',
          scopeId: identity.gcpProjectId,
          resourceId: identity.workerService,
          state: 'DELETED',
          projectedMonthlyRecurringUsd: 0,
          evidenceArtifactSha256: SHA('8'),
        },
        {
          provider: 'SUPABASE',
          kind: 'isolated-project',
          scopeId: 'org-arkova',
          resourceId: 'project-rig-b1',
          state: 'DOWNGRADED_ZERO_RECURRING',
          projectedMonthlyRecurringUsd: 0,
          evidenceArtifactSha256: SHA('9'),
        },
      ],
    },
    signature: {
      authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
      envelope: null,
    },
  };
  const metadata: S33ReleaseEvidenceChainMetadata = {
    schemaVersion: 'arkova.s33.l1.release-evidence-chain-input/v1',
    evidenceMode: 'OFFLINE_COMPOSITION_PRODUCER_BLOCKED',
    runId: RUN_ID,
    composedAt: options.composedAt ?? '2026-07-16T13:15:00.000Z',
    exactHeadSha: identity.gitHeadSha,
    exactTreeSha: TREE_SHA,
    producerBoundary: {
      lane2TeardownSchemaVersion: null,
      lane2TeardownIdentity: null,
      lane3SignatureSchemaVersion: null,
      lane3SignatureAuthority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
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
    teardownResult: verifyS33TeardownZeroCost(teardownInput),
    metadata,
  };
}

describe('S3.3 W3-C release evidence-chain consumer', () => {
  it('binds admission, exact A/A/B/D/org evidence, runway, and teardown as a blocked draft', () => {
    const input = fixture();
    const result = composeS33ReleaseEvidenceChain(input);

    expect(result).toMatchObject({
      status: 'OFFLINE_CHAIN_DRAFT_PRODUCER_BLOCKED',
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
      status: 'OFFLINE_DIFF_VERIFIED_PRODUCER_BLOCKED',
      zeroRecurringProjected: true,
      projectedMonthlyRecurringUsd: 0,
      releaseAcceptance: false,
    });
    expect(result.signature.envelope).toBeNull();
    expect(result.producerDependencies).toEqual([
      'LANE2_TEARDOWN_INVENTORY_IDENTITY_UNAVAILABLE',
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
