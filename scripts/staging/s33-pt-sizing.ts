/**
 * SCRUM-2708 PT/GSU memo schema, template, and arithmetic.
 *
 * No price, throughput, or measurement is hardcoded. The operator must supply
 * digest-pinned, dated Google capacity/pricing inputs and a measured window.
 * Cost outputs are projections from asserted prices, never measured spend.
 */

import { z } from "zod";

import {
  buildS33LoadEvidence,
  type S33LoadEvidence,
  type S33LoadEvidenceInput,
} from "./s33-load-evidence.js";
import { canonicalS33Json, digestS33Value } from "./s33-load-plan.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
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
    exactHeadSha: z.string().regex(GIT_SHA),
    exactTreeSha: z.string().regex(GIT_SHA),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const liveEvidencePacketSchema = z
  .object({
    artifact: z.custom<S33LoadEvidence>(isPlainObject, {
      message: "Load-evidence artifact must be a plain object",
    }),
    source: z.custom<S33LoadEvidenceInput>(isPlainObject, {
      message: "Load-evidence source must be a plain object",
    }),
  })
  .strict();

const liveEvidencePacketsSchema = z
  .object({
    fixture500: liveEvidencePacketSchema,
    stress5000: liveEvidencePacketSchema,
  })
  .strict();

type LiveEvidencePackets = z.infer<typeof liveEvidencePacketsSchema>;

export interface S33VerifiedLiveEvidenceBinding {
  profileId: "fixture500" | "stress5000";
  runId: string;
  exactHeadSha: string;
  exactTreeSha: string;
  windowStartedAt: string;
  windowEndedAt: string;
  loadEvidenceArtifactSha256: string;
}

function validateLiveEvidencePacketPresence(
  evidenceMode: "TEST_FIXTURE" | "LIVE_POST_WAVE3",
  packets: LiveEvidencePackets | undefined,
  context: z.RefinementCtx,
): void {
  if (evidenceMode === "TEST_FIXTURE") {
    if (packets) {
      context.addIssue({
        code: "custom",
        path: ["liveEvidencePackets"],
        message: "TEST_FIXTURE cannot carry live load-evidence packets",
      });
    }
    return;
  }
  if (!packets) {
    context.addIssue({
      code: "custom",
      path: ["liveEvidencePackets"],
      message:
        "LIVE_POST_WAVE3 requires independently verifiable load-evidence packets for fixture500 and stress5000",
    });
  }
}

function assertSerializedEvidenceDigest(artifact: unknown, profile: string): void {
  if (!isPlainObject(artifact)) {
    throw new TypeError(`${profile} load-evidence artifact must be an object`);
  }
  const { evidenceDigestSha256, ...body } = artifact as Record<string, unknown>;
  if (
    typeof evidenceDigestSha256 !== "string" ||
    evidenceDigestSha256 !== digestS33Value(body)
  ) {
    throw new Error(`${profile} load-evidence artifact digest is invalid`);
  }
}

function assertVerifiedEvidenceIdentity(
  evidence: S33LoadEvidence,
  expectedProfile: "fixture500" | "stress5000",
  measurement: z.infer<typeof measurementSchema>,
): void {
  if (evidence.profileId !== expectedProfile) {
    throw new Error(
      `${expectedProfile} packet contains swapped profile ${evidence.profileId}`,
    );
  }
  if (
    evidence.evidenceMode !== "LIVE_POST_WAVE3" ||
    evidence.claims.measurements !== "measured-from-pinned-live-artifacts" ||
    evidence.executionDisposition !== "CONTINUE" ||
    evidence.releaseStatus !== "AWAITING_CTO_VERDICT"
  ) {
    throw new Error(
      `${expectedProfile} requires continuing measured live load evidence awaiting CTO verdict`,
    );
  }
  if (evidence.runId !== measurement.runId) {
    throw new Error(`${expectedProfile} evidence run does not match measurement`);
  }
  if (
    evidence.exactHeadSha !== measurement.exactHeadSha ||
    evidence.exactTreeSha !== measurement.exactTreeSha
  ) {
    throw new Error(
      `${expectedProfile} evidence does not bind the measured exact head and tree`,
    );
  }
  if (
    evidence.windowStartedAt !== measurement.startedAt ||
    evidence.windowEndedAt !== measurement.endedAt
  ) {
    throw new Error(
      `${expectedProfile} load-evidence window does not match the measured window`,
    );
  }
}

function verifyLiveEvidencePacket(
  packet: LiveEvidencePackets["fixture500"],
  expectedProfile: "fixture500" | "stress5000",
  measurement: z.infer<typeof measurementSchema>,
): S33LoadEvidence {
  assertSerializedEvidenceDigest(packet.artifact, expectedProfile);
  const rebuilt = buildS33LoadEvidence(packet.source);
  if (canonicalS33Json(packet.artifact) !== canonicalS33Json(rebuilt)) {
    throw new Error(
      `${expectedProfile} serialized load-evidence artifact does not match its verified source packet`,
    );
  }
  assertVerifiedEvidenceIdentity(rebuilt, expectedProfile, measurement);
  return rebuilt;
}

function evidenceBinding(
  evidence: S33LoadEvidence,
): Readonly<S33VerifiedLiveEvidenceBinding> {
  return Object.freeze({
    profileId: evidence.profileId as "fixture500" | "stress5000",
    runId: evidence.runId,
    exactHeadSha: evidence.exactHeadSha,
    exactTreeSha: evidence.exactTreeSha,
    windowStartedAt: evidence.windowStartedAt,
    windowEndedAt: evidence.windowEndedAt,
    loadEvidenceArtifactSha256: evidence.evidenceDigestSha256,
  });
}

function verifyLiveEvidencePackets(
  evidenceMode: "TEST_FIXTURE" | "LIVE_POST_WAVE3",
  packets: LiveEvidencePackets | undefined,
  measurement: z.infer<typeof measurementSchema>,
): S33PtSizingResult["liveEvidenceBindings"] {
  if (evidenceMode === "TEST_FIXTURE") return null;
  if (!packets) {
    throw new Error("Live load-evidence packets are required");
  }
  const fixture = verifyLiveEvidencePacket(
    packets.fixture500,
    "fixture500",
    measurement,
  );
  const stress = verifyLiveEvidencePacket(
    packets.stress5000,
    "stress5000",
    measurement,
  );
  if (fixture.evidenceDigestSha256 === stress.evidenceDigestSha256) {
    throw new Error("Live profiles require distinct load-evidence artifacts");
  }
  if (!stress.rawArtifactDigests.includes(measurement.sourceArtifactSha256)) {
    throw new Error(
      "stress5000 load evidence does not pin the sizing measurement artifact",
    );
  }
  return Object.freeze({
    fixture500: evidenceBinding(fixture),
    stress5000: evidenceBinding(stress),
  });
}

const inputSchema = z
  .object({
    evidenceMode: z.enum(["TEST_FIXTURE", "LIVE_POST_WAVE3"]),
    memoId: z.string().regex(SAFE_ID),
    generatedAt: z.string().datetime({ offset: true }),
    measurement: measurementSchema,
    liveEvidencePackets: liveEvidencePacketsSchema.optional(),
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
    validateLiveEvidencePacketPresence(
      input.evidenceMode,
      input.liveEvidencePackets,
      context,
    );
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
    profileEvidence: "exact-head-bound-fixture500-and-stress5000";
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
  liveEvidenceBindings: Readonly<{
    fixture500: Readonly<S33VerifiedLiveEvidenceBinding>;
    stress5000: Readonly<S33VerifiedLiveEvidenceBinding>;
  }> | null;
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
    profileEvidence:
      | "test-fixture-no-live-binding"
      | "exact-head-bound-fixture500-and-stress5000";
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
      profileEvidence: "exact-head-bound-fixture500-and-stress5000",
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
  const liveEvidenceBindings = verifyLiveEvidencePackets(
    input.evidenceMode,
    input.liveEvidencePackets,
    input.measurement,
  );
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
    liveEvidenceBindings,
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
      profileEvidence:
        input.evidenceMode === "TEST_FIXTURE"
          ? "test-fixture-no-live-binding"
          : "exact-head-bound-fixture500-and-stress5000",
    }),
  });
}
