import { describe, expect, it } from "vitest";

import {
  buildS33PtMemoTemplate,
  calculateS33PtSizing,
  type S33PtSizingInput,
} from "./s33-pt-sizing.js";

function sizingInput(
  overrides: Partial<S33PtSizingInput> = {},
): S33PtSizingInput {
  return {
    evidenceMode: "TEST_FIXTURE",
    memoId: "s33-pt-fixture-001",
    generatedAt: "2026-07-16T02:00:00.000Z",
    measurement: {
      claimClass: "synthetic-test-fixture",
      runId: "s33-w3-l2b-fixture-20260715",
      sourceArtifactSha256: `sha256:${"1".repeat(64)}`,
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

describe("S3.3 PT/GSU memo contract", () => {
  it("emits an honest empty template that cannot imply measured sizing", () => {
    const template = buildS33PtMemoTemplate("s33-pt-live-pending");
    expect(template.status).toBe("AWAITING_POST_WAVE3_MEASUREMENTS");
    expect(template.measurement).toBeNull();
    expect(template.recommendation).toBeNull();
    expect(template.requiredClaims).toEqual({
      windowInputs: "measured",
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
});
