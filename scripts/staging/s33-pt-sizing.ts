/**
 * SCRUM-2708 PT/GSU memo schema, template, and arithmetic.
 *
 * No price, throughput, or measurement is hardcoded. The operator must supply
 * digest-pinned, dated Google capacity/pricing inputs and a measured window.
 * Cost outputs are projections from asserted prices, never measured spend.
 */

import { z } from "zod";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Source URL must use HTTPS",
  });

const measurementSchema = z
  .object({
    claimClass: z.enum(["measured", "synthetic-test-fixture"]),
    runId: z.string().regex(SAFE_ID),
    sourceArtifactSha256: z.string().regex(SHA256),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    requestCount: z.number().int().positive(),
    peakQueriesPerSecond: z.number().positive().finite(),
    meanInputTokensPerQuery: z.number().nonnegative().finite(),
    meanOutputTokensPerQuery: z.number().nonnegative().finite(),
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
  })
  .strict();

const capacitySchema = z
  .object({
    claimClass: z.enum([
      "asserted-from-dated-source",
      "synthetic-test-fixture",
    ]),
    model: z.literal("gemini-2.5-flash"),
    region: z.string().regex(/^[a-z]+-[a-z]+\d$/),
    inputTokenBurndown: z.number().positive().finite(),
    outputTokenBurndown: z.number().positive().finite(),
    normalizedTokensPerSecondPerGsu: z.number().positive().finite(),
    minimumGsuIncrement: z.number().positive().finite(),
    sourceUrl: httpsUrl,
    sourceRetrievedAt: z.string().datetime({ offset: true }),
    sourceArtifactSha256: z.string().regex(SHA256),
  })
  .strict();

const pricingSchema = z
  .object({
    claimClass: z.enum([
      "asserted-from-dated-source",
      "synthetic-test-fixture",
    ]),
    currency: z.literal("USD"),
    onDemandInputUsdPerMillionTokens: z.number().nonnegative().finite(),
    onDemandOutputUsdPerMillionTokens: z.number().nonnegative().finite(),
    provisionedUsdPerGsuPeriod: z.number().nonnegative().finite(),
    provisionedPeriodHours: z.number().positive().finite(),
    sourceUrl: httpsUrl,
    sourceRetrievedAt: z.string().datetime({ offset: true }),
    sourceArtifactSha256: z.string().regex(SHA256),
  })
  .strict();

const inputSchema = z
  .object({
    evidenceMode: z.enum(["TEST_FIXTURE", "LIVE_POST_WAVE3"]),
    memoId: z.string().regex(SAFE_ID),
    generatedAt: z.string().datetime({ offset: true }),
    measurement: measurementSchema,
    capacity: capacitySchema,
    pricing: pricingSchema,
    assumptions: z
      .object({
        claimClass: z.literal("asserted"),
        headroomFactor: z.number().min(1).max(10).finite(),
        queueingNote: z.string().min(20).max(2_000),
        multimodalCapInvalidationNoted: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    const requiredClaimClasses =
      input.evidenceMode === "LIVE_POST_WAVE3"
        ? ({
            measurement: "measured",
            capacity: "asserted-from-dated-source",
            pricing: "asserted-from-dated-source",
          } as const)
        : ({
            measurement: "synthetic-test-fixture",
            capacity: "synthetic-test-fixture",
            pricing: "synthetic-test-fixture",
          } as const);
    for (const [field, actual] of [
      ["measurement", input.measurement.claimClass],
      ["capacity", input.capacity.claimClass],
      ["pricing", input.pricing.claimClass],
    ] as const) {
      if (actual !== requiredClaimClasses[field]) {
        context.addIssue({
          code: "custom",
          path: [field, "claimClass"],
          message: `${input.evidenceMode} requires ${requiredClaimClasses[field]}`,
        });
      }
    }

    const start = Date.parse(input.measurement.startedAt);
    const end = Date.parse(input.measurement.endedAt);
    const generated = Date.parse(input.generatedAt);
    if (end <= start) {
      context.addIssue({
        code: "custom",
        path: ["measurement", "endedAt"],
        message: "Measurement window must end after it starts",
      });
    }
    if (generated < end) {
      context.addIssue({
        code: "custom",
        path: ["generatedAt"],
        message: "Memo cannot precede the measured window end",
      });
    }
    for (const [path, retrievedAt] of [
      [["capacity", "sourceRetrievedAt"], input.capacity.sourceRetrievedAt],
      [["pricing", "sourceRetrievedAt"], input.pricing.sourceRetrievedAt],
    ] as const) {
      if (Date.parse(retrievedAt) > generated) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message:
            "Source retrieval timestamp cannot be in the future of the memo",
        });
      }
    }

    const expectedInputTotal =
      input.measurement.meanInputTokensPerQuery *
      input.measurement.requestCount;
    const expectedOutputTotal =
      input.measurement.meanOutputTokensPerQuery *
      input.measurement.requestCount;
    const consistent = (actual: number, expected: number) =>
      Math.abs(actual - expected) <= Math.max(1, expected * 1e-9);
    if (!consistent(input.measurement.totalInputTokens, expectedInputTotal)) {
      context.addIssue({
        code: "custom",
        path: ["measurement", "totalInputTokens"],
        message:
          "Measured input token total is inconsistent with request count and mean",
      });
    }
    if (!consistent(input.measurement.totalOutputTokens, expectedOutputTotal)) {
      context.addIssue({
        code: "custom",
        path: ["measurement", "totalOutputTokens"],
        message:
          "Measured output token total is inconsistent with request count and mean",
      });
    }
  });

export type S33PtSizingInput = z.input<typeof inputSchema>;

export interface S33PtMemoTemplate {
  schemaVersion: "arkova.s33.l2.pt-sizing/v1";
  memoId: string;
  status: "AWAITING_POST_WAVE3_MEASUREMENTS";
  measurement: null;
  capacitySource: null;
  pricingSource: null;
  recommendation: null;
  requiredClaims: {
    windowInputs: "measured";
    capacityAndPricing: "asserted-from-dated-source";
    projections: "derived-not-measured-spend";
  };
  formulas: {
    normalizedTokensPerSecond: "(meanInputTokens*inputBurndown + meanOutputTokens*outputBurndown) * peakQps";
    gsuWithHeadroom: "ceil((normalizedTokensPerSecond*headroom)/throughputPerGsu/minimumIncrement)*minimumIncrement";
    onDemandWindowCost: "inputTokens/1e6*inputPrice + outputTokens/1e6*outputPrice";
    provisionedWindowProjection: "recommendedGsu*pricePerGsuPeriod*(windowHours/periodHours)";
  };
}

export interface S33PtSizingResult {
  schemaVersion: "arkova.s33.l2.pt-sizing/v1";
  memoId: string;
  generatedAt: string;
  status:
    "TEST_ONLY_NOT_RELEASE_EVIDENCE" | "DRAFT_RECOMMENDATION_REQUIRES_CTO";
  measurement: z.infer<typeof measurementSchema>;
  capacity: z.infer<typeof capacitySchema>;
  pricing: z.infer<typeof pricingSchema>;
  assumptions: z.infer<typeof inputSchema>["assumptions"];
  formula: {
    normalizedTokensPerQuery: number;
    normalizedTokensPerSecond: number;
    normalizedTokensPerSecondWithHeadroom: number;
    rawGsu: number;
    minimumGsuIncrement: number;
  };
  recommendation: {
    recommendedGsu: number;
    scope: "project-region-model-version-specific";
    finalDecisionOwner: "CTO";
  };
  cost: {
    currency: "USD";
    inputWindowHours: number;
    onDemandEquivalentWindowUsd: number;
    provisionedEquivalentWindowUsd: number;
    classification: "derived-not-measured-spend";
  };
  claims: {
    measurement: "measured" | "synthetic-test-fixture";
    capacity: "asserted-from-dated-source" | "synthetic-test-fixture";
    pricing: "asserted-from-dated-source" | "synthetic-test-fixture";
    costProjection: "derived-not-measured-spend";
    recommendation: "derived-requires-cto-decision";
  };
}

export function buildS33PtMemoTemplate(memoId: string): S33PtMemoTemplate {
  if (!SAFE_ID.test(memoId)) throw new Error("PT memo ID is invalid");
  return Object.freeze({
    schemaVersion: "arkova.s33.l2.pt-sizing/v1",
    memoId,
    status: "AWAITING_POST_WAVE3_MEASUREMENTS",
    measurement: null,
    capacitySource: null,
    pricingSource: null,
    recommendation: null,
    requiredClaims: Object.freeze({
      windowInputs: "measured",
      capacityAndPricing: "asserted-from-dated-source",
      projections: "derived-not-measured-spend",
    }),
    formulas: Object.freeze({
      normalizedTokensPerSecond:
        "(meanInputTokens*inputBurndown + meanOutputTokens*outputBurndown) * peakQps",
      gsuWithHeadroom:
        "ceil((normalizedTokensPerSecond*headroom)/throughputPerGsu/minimumIncrement)*minimumIncrement",
      onDemandWindowCost:
        "inputTokens/1e6*inputPrice + outputTokens/1e6*outputPrice",
      provisionedWindowProjection:
        "recommendedGsu*pricePerGsuPeriod*(windowHours/periodHours)",
    }),
  });
}

export function calculateS33PtSizing(rawInput: unknown): S33PtSizingResult {
  const input = inputSchema.parse(rawInput);
  const normalizedTokensPerQuery =
    input.measurement.meanInputTokensPerQuery *
      input.capacity.inputTokenBurndown +
    input.measurement.meanOutputTokensPerQuery *
      input.capacity.outputTokenBurndown;
  const normalizedTokensPerSecond =
    normalizedTokensPerQuery * input.measurement.peakQueriesPerSecond;
  const normalizedTokensPerSecondWithHeadroom =
    normalizedTokensPerSecond * input.assumptions.headroomFactor;
  const rawGsu =
    normalizedTokensPerSecondWithHeadroom /
    input.capacity.normalizedTokensPerSecondPerGsu;
  const recommendedGsu =
    Math.ceil(rawGsu / input.capacity.minimumGsuIncrement) *
    input.capacity.minimumGsuIncrement;
  const inputWindowHours =
    (Date.parse(input.measurement.endedAt) -
      Date.parse(input.measurement.startedAt)) /
    3_600_000;
  const onDemandEquivalentWindowUsd =
    (input.measurement.totalInputTokens / 1_000_000) *
      input.pricing.onDemandInputUsdPerMillionTokens +
    (input.measurement.totalOutputTokens / 1_000_000) *
      input.pricing.onDemandOutputUsdPerMillionTokens;
  const provisionedEquivalentWindowUsd =
    (recommendedGsu *
      input.pricing.provisionedUsdPerGsuPeriod *
      inputWindowHours) /
    input.pricing.provisionedPeriodHours;

  return Object.freeze({
    schemaVersion: "arkova.s33.l2.pt-sizing/v1",
    memoId: input.memoId,
    generatedAt: input.generatedAt,
    status:
      input.evidenceMode === "TEST_FIXTURE"
        ? "TEST_ONLY_NOT_RELEASE_EVIDENCE"
        : "DRAFT_RECOMMENDATION_REQUIRES_CTO",
    measurement: Object.freeze({ ...input.measurement }),
    capacity: Object.freeze({ ...input.capacity }),
    pricing: Object.freeze({ ...input.pricing }),
    assumptions: Object.freeze({ ...input.assumptions }),
    formula: Object.freeze({
      normalizedTokensPerQuery,
      normalizedTokensPerSecond,
      normalizedTokensPerSecondWithHeadroom,
      rawGsu,
      minimumGsuIncrement: input.capacity.minimumGsuIncrement,
    }),
    recommendation: Object.freeze({
      recommendedGsu,
      scope: "project-region-model-version-specific",
      finalDecisionOwner: "CTO",
    }),
    cost: Object.freeze({
      currency: "USD",
      inputWindowHours,
      onDemandEquivalentWindowUsd,
      provisionedEquivalentWindowUsd,
      classification: "derived-not-measured-spend",
    }),
    claims: Object.freeze({
      measurement: input.measurement.claimClass,
      capacity: input.capacity.claimClass,
      pricing: input.pricing.claimClass,
      costProjection: "derived-not-measured-spend",
      recommendation: "derived-requires-cto-decision",
    }),
  });
}
