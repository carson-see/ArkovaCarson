import { describe, expect, it } from "vitest";

import {
  buildS33429AttributionEvidence,
  type S33429AttributionSourcePacket,
} from "./s33-429-attribution.js";
import {
  buildS33LoadEvidence,
  type S33LoadEvidence,
  type S33LoadEvidenceInput,
} from "./s33-load-evidence.js";
import {
  buildS33LoadPlan,
  digestS33LoadPlan,
  digestS33Value,
  iterateOpenArrivals,
  type S33LoadPlan,
  type S33LoadProfileId,
} from "./s33-load-plan.js";
import { loadPlanInput } from "./s33-load-plan.test.js";
import type { S33LoadRunnerOutput } from "./s33-load-runner.js";
import {
  buildS33PtMemoTemplate,
  calculateS33PtSizing,
  type S33PtSizingInput,
} from "./s33-pt-sizing.js";

const RUN_ID = "s33-w3-l2b-fixture-20260715";
const EXACT_HEAD_SHA = "a".repeat(40);
const EXACT_TREE_SHA = "b".repeat(40);
const MEASUREMENT_ARTIFACT = `sha256:${"1".repeat(64)}`;

function sizingInput(
  overrides: Partial<S33PtSizingInput> = {},
): S33PtSizingInput {
  return {
    evidenceMode: "TEST_FIXTURE",
    memoId: "s33-pt-fixture-001",
    generatedAt: "2026-07-16T02:00:00.000Z",
    measurement: {
      claimClass: "synthetic-test-fixture",
      runId: RUN_ID,
      exactHeadSha: EXACT_HEAD_SHA,
      exactTreeSha: EXACT_TREE_SHA,
      sourceArtifactSha256: MEASUREMENT_ARTIFACT,
      startedAt: "2026-07-16T00:00:00.000Z",
      endedAt: "2026-07-16T01:00:00.000Z",
      requestCount: 3_600,
      peakQueriesPerSecond: 10,
      meanInputTokensPerQuery: 1_000,
      meanOutputTokensPerQuery: 100,
      totalInputTokens: 3_600_000,
      totalOutputTokens: 360_000,
    },
    capacity: {
      claimClass: "synthetic-test-fixture",
      model: "gemini-2.5-flash",
      region: "us-central1",
      inputTokenBurndown: 1,
      outputTokenBurndown: 9,
      normalizedTokensPerSecondPerGsu: 2_690,
      minimumGsuIncrement: 1,
      sourceUrl: "https://example.test/capacity-fixture",
      sourceRetrievedAt: "2026-07-15T22:00:00.000Z",
      sourceArtifactSha256: `sha256:${"2".repeat(64)}`,
    },
    pricing: {
      claimClass: "synthetic-test-fixture",
      currency: "USD",
      onDemandInputUsdPerMillionTokens: 0.3,
      onDemandOutputUsdPerMillionTokens: 2.5,
      provisionedUsdPerGsuPeriod: 2_700,
      provisionedPeriodHours: 730,
      sourceUrl: "https://example.test/pricing-fixture",
      sourceRetrievedAt: "2026-07-15T22:05:00.000Z",
      sourceArtifactSha256: `sha256:${"3".repeat(64)}`,
    },
    assumptions: {
      claimClass: "asserted",
      headroomFactor: 1.2,
      queueingNote:
        "Fixture assumption only; replace with the measured post-Wave-3 burst profile.",
      multimodalCapInvalidationNoted: true,
    },
    ...overrides,
  };
}

function attributionSourcePacket(): S33429AttributionSourcePacket {
  return {
    run: {
      runId: RUN_ID,
      arm: "public",
      apiSurface: "Developer-API",
      model: "gemini-2.5-flash",
      tunedModel: null,
      region: "global",
      v6PromptActive: false,
      responseSchema: "unset",
      responseMimeType: "application/json",
    },
    client429s: [],
    limiterLogs: [],
    upstream429s: [],
  };
}

function runnerOutput(
  plan: S33LoadPlan,
  profileId: Exclude<S33LoadProfileId, "prodShapeReplay">,
): S33LoadRunnerOutput {
  const startedAt = Date.parse(plan.plannedStartAt);
  const arrivals = Array.from(iterateOpenArrivals(plan, profileId)).map(
    (arrival) => ({
      ...arrival,
      observedAt: new Date(startedAt + arrival.scheduledOffsetMs).toISOString(),
      status: arrival.expectedStatus,
      correlationId: `${profileId}-request-${arrival.sequence}`,
      injectedFailure: false,
    }),
  );
  const observationPasses = Array.from(
    {
      length: Math.ceil(plan.durationMinutes / plan.observation.cadenceMinutes),
    },
    (_, index) => {
      const passId = `pass-${String(index).padStart(4, "0")}`;
      const scheduledOffsetMs =
        index * plan.observation.cadenceMinutes * 60_000;
      const observedAt = new Date(startedAt + scheduledOffsetMs).toISOString();
      return {
        passId,
        scheduledOffsetMs,
        opsSlo: {
          passId,
          observedAt,
          artifactSha256: digestS33Value({ profileId, passId, kind: "ops" }),
          overallBreach: false,
        },
        sentry: {
          passId,
          observedAt,
          issueRatePerMinute: 0,
          newCriticalIssueCount: 0,
          artifactSha256: digestS33Value({
            profileId,
            passId,
            kind: "sentry",
          }),
        },
        connector: {
          passId,
          observedAt,
          status: 200,
          correlationId: `${profileId}-connector-${passId}`,
          artifactSha256: digestS33Value({
            profileId,
            passId,
            kind: "connector",
          }),
        },
        heartbeat: {
          passId,
          observedAt,
          workerUp: true,
          artifactSha256: digestS33Value({
            profileId,
            passId,
            kind: "heartbeat",
          }),
        },
      };
    },
  );
  return {
    schemaVersion: "arkova.s33.l2.load-runner-output/v1",
    runId: plan.runId,
    evidenceMode: plan.evidenceMode,
    profileId,
    executionModel: "open-arrival-absolute-schedule",
    arrivals,
    observationPasses,
    termination: {
      state: "COMPLETED",
      trigger: null,
      reasons: [],
      lastDispatchedSequence: arrivals.at(-1)?.sequence ?? null,
    },
  };
}

function loadEvidencePacket(
  profileId: "fixture500" | "stress5000",
  evidenceMode: "OFFLINE_FIXTURE" | "LIVE_POST_WAVE3" = "LIVE_POST_WAVE3",
): { artifact: S33LoadEvidence; source: S33LoadEvidenceInput } {
  const planSourcePacket = loadPlanInput({
    evidenceMode,
    runId: RUN_ID,
    exactHeadSha: EXACT_HEAD_SHA,
    exactTreeSha: EXACT_TREE_SHA,
    ...(evidenceMode === "LIVE_POST_WAVE3"
      ? {
          prodShapeBaseline: {
            claimClass: "measured-in-window" as const,
            ratePerHour: 500,
            observedAt: "2026-07-15T23:59:00.000Z",
            sourceArtifactSha256: `sha256:${"7".repeat(64)}`,
          },
        }
      : {}),
  });
  const plan = buildS33LoadPlan(planSourcePacket);
  const runner = runnerOutput(plan, profileId);
  const attributionSource = attributionSourcePacket();
  const attribution = buildS33429AttributionEvidence(attributionSource);
  const runnerArtifactSha256 = digestS33Value(runner);
  const attributionArtifactSha256 = digestS33Value(attribution);
  const observationDigests = runner.observationPasses.flatMap((pass) => [
    pass.opsSlo.artifactSha256,
    pass.sentry.artifactSha256,
    pass.connector.artifactSha256,
    pass.heartbeat.artifactSha256,
  ]);
  const source: S33LoadEvidenceInput = {
    plan,
    planSourcePacket,
    planDigestSha256: digestS33LoadPlan(plan),
    runner,
    runnerArtifactSha256,
    attribution,
    attributionSourcePacket: attributionSource,
    attributionArtifactSha256,
    targetedLimiterTelemetry: {
      perOrgRateLimit: { observed429s: 0, headlineEligible: false },
      x402PayerRateLimit: { observed429s: 0, headlineEligible: false },
    },
    rawArtifactDigests: [
      ...new Set([
        runnerArtifactSha256,
        attributionArtifactSha256,
        ...observationDigests,
        ...(profileId === "stress5000" ? [MEASUREMENT_ARTIFACT] : []),
      ]),
    ],
  };
  const artifact = buildS33LoadEvidence(source);
  return {
    artifact: JSON.parse(JSON.stringify(artifact)) as S33LoadEvidence,
    source: JSON.parse(JSON.stringify(source)) as S33LoadEvidenceInput,
  };
}

function liveEvidencePackets(): NonNullable<
  S33PtSizingInput["liveEvidencePackets"]
> {
  return {
    fixture500: loadEvidencePacket("fixture500"),
    stress5000: loadEvidencePacket("stress5000"),
  };
}

function liveSizingInput(
  packets = liveEvidencePackets(),
): S33PtSizingInput {
  const fixture = sizingInput();
  return sizingInput({
    evidenceMode: "LIVE_POST_WAVE3",
    measurement: { ...fixture.measurement, claimClass: "measured" },
    liveEvidencePackets: packets,
    capacity: {
      ...fixture.capacity,
      claimClass: "asserted-from-dated-source",
    },
    pricing: {
      ...fixture.pricing,
      claimClass: "asserted-from-dated-source",
    },
  });
}

function rehashEvidenceArtifact(artifact: S33LoadEvidence): S33LoadEvidence {
  const clone = structuredClone(artifact) as S33LoadEvidence;
  const mutable = clone as unknown as Record<string, unknown>;
  delete mutable.evidenceDigestSha256;
  mutable.evidenceDigestSha256 = digestS33Value(mutable);
  return mutable as unknown as S33LoadEvidence;
}

describe("S3.3 PT/GSU memo contract", () => {
  it("emits an honest empty template that cannot imply measured sizing", () => {
    const template = buildS33PtMemoTemplate("s33-pt-live-pending");
    expect(template.status).toBe("AWAITING_POST_WAVE3_MEASUREMENTS");
    expect(template.measurement).toBeNull();
    expect(template.recommendation).toBeNull();
    expect(template.requiredClaims).toEqual({
      windowInputs: "measured",
      profileEvidence: "exact-head-bound-fixture500-and-stress5000",
      capacityAndPricing: "asserted-from-dated-source",
      projections: "derived-not-measured-spend",
    });
  });

  it("calculates normalized throughput, rounded GSU increment, and comparable window costs", () => {
    const result = calculateS33PtSizing(sizingInput());

    // (1,000 input * 1 + 100 output * 9) * 10 QPS * 1.2 headroom = 22,800 normalized TPS.
    expect(result.formula.normalizedTokensPerSecondWithHeadroom).toBe(22_800);
    expect(result.formula.rawGsu).toBeCloseTo(22_800 / 2_690, 10);
    expect(result.recommendation.recommendedGsu).toBe(9);
    expect(result.cost.onDemandEquivalentWindowUsd).toBeCloseTo(1.98, 10);
    expect(result.cost.provisionedEquivalentWindowUsd).toBeCloseTo(
      (9 * 2_700) / 730,
      10,
    );
  });

  it("labels measurements, sourced assertions, and derived projections separately", () => {
    const result = calculateS33PtSizing(sizingInput());
    expect(result.claims).toEqual({
      measurement: "synthetic-test-fixture",
      capacity: "synthetic-test-fixture",
      pricing: "synthetic-test-fixture",
      costProjection: "derived-not-measured-spend",
      recommendation: "derived-requires-cto-decision",
      profileEvidence: "test-fixture-no-live-binding",
    });
    expect(result.status).toBe("TEST_ONLY_NOT_RELEASE_EVIDENCE");
  });

  it("requires dated, digest-pinned HTTPS capacity and price sources", () => {
    const invalid = sizingInput() as unknown as Record<string, unknown>;
    invalid.pricing = {
      ...(invalid.pricing as object),
      sourceUrl: "http://example.test/pricing",
      sourceRetrievedAt: undefined,
    };
    expect(() => calculateS33PtSizing(invalid)).toThrow(
      /source|https|retrieved/i,
    );
  });

  it("prevents fixture arithmetic from claiming live measurements or dated-source assertions", () => {
    expect(() =>
      calculateS33PtSizing(
        sizingInput({
          measurement: { ...sizingInput().measurement, claimClass: "measured" },
          capacity: {
            ...sizingInput().capacity,
            claimClass: "asserted-from-dated-source",
          },
          pricing: {
            ...sizingInput().pricing,
            claimClass: "asserted-from-dated-source",
          },
        }),
      ),
    ).toThrow(/TEST_FIXTURE requires synthetic-test-fixture/i);
  });

  it("rejects inconsistent measured token totals instead of manufacturing a memo", () => {
    expect(() =>
      calculateS33PtSizing(
        sizingInput({
          measurement: {
            ...sizingInput().measurement,
            totalInputTokens: 1,
          },
        }),
      ),
    ).toThrow(/token total|inconsistent/i);
  });

  it("rejects live sizing without verifiable load-evidence packets for both profiles", () => {
    const fixture = sizingInput();
    const live = sizingInput({
      evidenceMode: "LIVE_POST_WAVE3",
      measurement: { ...fixture.measurement, claimClass: "measured" },
      capacity: {
        ...fixture.capacity,
        claimClass: "asserted-from-dated-source",
      },
      pricing: {
        ...fixture.pricing,
        claimClass: "asserted-from-dated-source",
      },
    });

    expect(() => calculateS33PtSizing(live)).toThrow(
      /fixture500|stress5000|load-evidence|packet/i,
    );
  });

  it("rebuilds two serialized live artifacts before deriving profile bindings", () => {
    const result = calculateS33PtSizing(liveSizingInput());

    expect(result.status).toBe("DRAFT_RECOMMENDATION_REQUIRES_CTO");
    expect(result.claims.profileEvidence).toBe(
      "exact-head-bound-fixture500-and-stress5000",
    );
    expect(result.liveEvidenceBindings?.stress5000.profileId).toBe(
      "stress5000",
    );
    expect(Object.isFrozen(result.liveEvidenceBindings?.fixture500)).toBe(true);
  });

  it("rejects swapped fixture500 and stress5000 artifacts", () => {
    const packets = liveEvidencePackets();
    const swapped = {
      fixture500: packets.stress5000,
      stress5000: packets.fixture500,
    };

    expect(() =>
      calculateS33PtSizing(liveSizingInput(swapped)),
    ).toThrow(/swapped profile|fixture500|stress5000/i);
  });

  it("rejects a forged exact head even when the serialized artifact is rehashed", () => {
    const packets = liveEvidencePackets();
    const forgedArtifact = structuredClone(packets.stress5000.artifact);
    (forgedArtifact as { exactHeadSha: string }).exactHeadSha = "c".repeat(40);
    packets.stress5000.artifact = rehashEvidenceArtifact(forgedArtifact);

    expect(() => calculateS33PtSizing(liveSizingInput(packets))).toThrow(
      /verified source packet|exact head/i,
    );
  });

  it("rejects fixture-mode evidence from a live sizing packet", () => {
    const packets = liveEvidencePackets();
    packets.fixture500 = loadEvidencePacket(
      "fixture500",
      "OFFLINE_FIXTURE",
    );

    expect(() => calculateS33PtSizing(liveSizingInput(packets))).toThrow(
      /measured live load evidence|LIVE_POST_WAVE3/i,
    );
  });

  it("rejects unknown top-level load-evidence source fields", () => {
    const packets = liveEvidencePackets();
    (packets.fixture500.source as unknown as Record<string, unknown>).secret =
      "must-not-be-ignored";

    expect(() => calculateS33PtSizing(liveSizingInput(packets))).toThrow(
      /source packet keys|unknown=secret/i,
    );
  });

  it("rejects secret-bearing nested runner telemetry", () => {
    const packets = liveEvidencePackets();
    const sentry = packets.stress5000.source.runner.observationPasses[0]!
      .sentry as unknown as Record<string, unknown>;
    sentry.secretTelemetry = "must-not-be-ignored";

    expect(() => calculateS33PtSizing(liveSizingInput(packets))).toThrow(
      /unrecognized|secretTelemetry|strict/i,
    );
  });

  it("rejects unknown serialized plan fields instead of ignoring them", () => {
    const packets = liveEvidencePackets();
    (packets.fixture500.source.plan as unknown as Record<string, unknown>)[
      "unknownPlanField"
    ] = true;

    expect(() => calculateS33PtSizing(liveSizingInput(packets))).toThrow(
      /load plan|strict source packet/i,
    );
  });
});
