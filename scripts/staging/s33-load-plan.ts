/**
 * Pure S3.3 Lane-2 load-plan contract (SCRUM-2699/2790/2794).
 *
 * This module plans deterministic fixture traffic only. It contains identity
 * labels, never JWTs/API keys, and has no network/cloud imports. A later,
 * explicitly authorized post-Wave-3 adapter supplies credentials and performs
 * I/O. The 500/hour shape is deliberately called a fixture, not prod-shape;
 * the real replay remains null until an in-window baseline artifact exists.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_SAFE_SOURCE_RATE_PER_MINUTE = 50;
const ROLLING_RATE_WINDOW_MS = 60_000;
const ANONYMOUS_IP_LIMIT_PER_WINDOW = 100;
const AI_JWT_LIMIT_PER_WINDOW = 30;
const MAX_ADMITTED_ANONYMOUS_IP_COUNT = 99;
const MAX_ADMITTED_AI_JWT_COUNT = 29;
const MAX_MEASURED_REPLAY_RATE_PER_HOUR = 20_000;

const measuredBaselineSchema = z
  .object({
    claimClass: z.literal("measured-in-window"),
    ratePerHour: z
      .number()
      .positive()
      .max(MAX_MEASURED_REPLAY_RATE_PER_HOUR)
      .finite(),
    observedAt: z.string().datetime({ offset: true }),
    sourceArtifactSha256: z.string().regex(SHA256),
  })
  .strict();

const inputSchema = z
  .object({
    evidenceMode: z.enum(["OFFLINE_FIXTURE", "LIVE_POST_WAVE3"]),
    runId: z.string().regex(SAFE_ID),
    seed: z.string().regex(SAFE_ID),
    exactHeadSha: z.string().regex(GIT_SHA),
    exactTreeSha: z.string().regex(GIT_SHA),
    plannedStartAt: z.string().datetime({ offset: true }),
    stopPolicyDeclaredAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(1).max(2_910),
    orgIds: z.array(z.string().regex(SAFE_ID)).min(30),
    jwtShardIds: z.array(z.string().regex(SAFE_ID)).min(4),
    sourceLaneIds: z.array(z.string().regex(SAFE_ID)).min(2),
    monthlyApiKeyId: z.string().regex(SAFE_ID),
    sentryMaxIssueRatePerMinute: z.number().nonnegative().finite(),
    prodShapeBaseline: measuredBaselineSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const unique = (values: readonly string[]) =>
      new Set(values).size === values.length;
    if (input.orgIds.length < 30) {
      context.addIssue({
        code: "custom",
        path: ["orgIds"],
        message: "At least 30 organizations are required",
      });
    }
    if (input.jwtShardIds.length < 4) {
      context.addIssue({
        code: "custom",
        path: ["jwtShardIds"],
        message: "At least four JWT shards are required",
      });
    }
    if (input.sourceLaneIds.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["sourceLaneIds"],
        message:
          "At least two source lanes are required to keep the 5,000/hour profile safely below 100/min/source",
      });
    }
    if (!unique(input.orgIds)) {
      context.addIssue({
        code: "custom",
        path: ["orgIds"],
        message: "Organization IDs must be unique",
      });
    }
    if (!unique(input.jwtShardIds)) {
      context.addIssue({
        code: "custom",
        path: ["jwtShardIds"],
        message: "JWT shard IDs must be unique",
      });
    }
    if (!unique(input.sourceLaneIds)) {
      context.addIssue({
        code: "custom",
        path: ["sourceLaneIds"],
        message: "Source lane IDs must be unique",
      });
    }
    if (
      Date.parse(input.stopPolicyDeclaredAt) >= Date.parse(input.plannedStartAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stopPolicyDeclaredAt"],
        message: "Stop policy must be declared before the planned start",
      });
    }
    if (input.evidenceMode === "OFFLINE_FIXTURE" && input.prodShapeBaseline) {
      context.addIssue({
        code: "custom",
        path: ["prodShapeBaseline"],
        message:
          "Offline fixture plans cannot claim an in-window measured baseline",
      });
    }
    if (
      input.prodShapeBaseline &&
      Date.parse(input.prodShapeBaseline.observedAt) >=
        Date.parse(input.plannedStartAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["prodShapeBaseline", "observedAt"],
        message: "Production-shape baseline must be observed before planned start",
      });
    }
  });

export type S33LoadPlanInput = z.input<typeof inputSchema>;

export type S33LoadProfileId = "fixture500" | "stress5000" | "prodShapeReplay";

export interface S33LoadProfile {
  id: Exclude<S33LoadProfileId, "prodShapeReplay">;
  arrivalModel: "seeded-open-arrival";
  ratePerHour: 500 | 5_000;
  claimClass: "asserted-fixture" | "asserted-ceiling";
}

export interface S33MeasuredReplayProfile {
  status: "READY_FROM_IN_WINDOW_BASELINE";
  arrivalModel: "seeded-open-arrival";
  ratePerHour: number;
  observedAt: string;
  sourceArtifactSha256: string;
  claimClass: "measured-in-window";
}

export interface S33PendingReplayProfile {
  status: "AWAITING_IN_WINDOW_BASELINE";
  ratePerHour: null;
  sourceArtifactSha256: null;
  claimClass: "not-measured";
}

export interface S33PayloadCase {
  id: "text-49999" | "text-50000" | "text-50001" | "body-102401";
  textBytes: 49_999 | 50_000 | 50_001 | null;
  bodyBytes: number | null;
  expectedStatus: 200 | 400 | 413;
  expectedClass: "accepted" | "zod-rejected" | "express-body-limit";
}

export interface S33LoadPlan {
  schemaVersion: "arkova.s33.l2.load-plan/v1";
  evidenceMode: "OFFLINE_FIXTURE" | "LIVE_POST_WAVE3";
  runId: string;
  seed: string;
  exactHeadSha: string;
  exactTreeSha: string;
  plannedStartAt: string;
  durationMinutes: number;
  profiles: Readonly<{
    fixture500: Readonly<S33LoadProfile>;
    stress5000: Readonly<S33LoadProfile>;
    prodShapeReplay: Readonly<
      S33MeasuredReplayProfile | S33PendingReplayProfile
    >;
  }>;
  tenancy: Readonly<{
    orgIds: readonly string[];
    hotOrgId: string;
    hotShare: 0.9;
    smallTenantShare: 0.1;
    jwtShardIds: readonly string[];
    sourceLaneIds: readonly string[];
    nominalStressRatePerSourcePerMinute: number;
    monthlyApiKeyId: string;
    monthlyQuotaLimit: 10_000;
    monthlyFixtureUsageAtStart: 10_000;
  }>;
  rateAdmission: Readonly<{
    rollingWindowMs: 60_000;
    anonymousIpLimitPerWindow: 100;
    maxAdmittedAnonymousIpCount: 99;
    aiJwtLimitPerWindow: 30;
    maxAdmittedAiJwtCount: 29;
    profiles: readonly Readonly<{
      profileId: S33LoadProfileId;
      arrivalCount: number;
      maxAnonymousIpWindowCount: number;
      maxAnonymousIpSourceLaneId: string | null;
      maxAiJwtWindowCount: number;
      maxAiJwtShardLabel: string | null;
      admitted: true;
    }>[];
  }>;
  payloadCases: readonly Readonly<S33PayloadCase>[];
  jurisdictionFixtures: readonly Readonly<{
    fixtureId: string;
    jurisdiction: "AU" | "KE" | "OOD";
    synthetic: true;
    containsCustomerData: false;
  }>[];
  observation: Readonly<{
    cadenceMinutes: 5;
    opsSloEndpoint: "/api/admin/ops-slo-stats";
    pipelineBaselineEndpoint: "/api/admin/pipeline-stats";
    everyPassRequiresSloSnapshot: true;
    everyPassRequiresHeartbeat: true;
    sentryStopPolicy: Readonly<{
      declaredAt: string;
      maxIssueRatePerMinute: number;
      maxNewCriticalIssues: 0;
      nonInjectedErrorRateThreshold: 0.01;
      consecutiveFiveMinuteWindows: 3;
    }>;
  }>;
  connectorPressure: Readonly<{
    endpoint: "/jobs/drain-connector-artifacts";
    cadenceMinutes: 5;
    concurrentWithHeadline: true;
  }>;
  triggerBOscillation: Readonly<{
    threshold: 3_000;
    backlogTargets: readonly [2_999, 3_001, 2_999, 3_001];
    evidenceClass: "offline-scenario-only";
  }>;
  endpointEviction: Readonly<{
    scenarioId: string;
    designatedRollbackRehearsal: true;
    separateRunRequired: true;
    invalidatesHeadlineClock: true;
    executableByThisModule: false;
    expectedOutcome: "clean-failover-to-base-flash";
  }>;
  attribution: Readonly<{
    headlineBuckets: readonly [
      "anon-IP",
      "keyed",
      "aiRateLimiter",
      "usageTracking-monthly",
      "upstream-model",
    ];
    summedHeadlineForbidden: true;
    targetedOrgAndPayerExcluded: true;
  }>;
  releaseEvidence: "DEFERRED_POST_WAVE3";
}

export interface S33PlannedArrival {
  sequence: number;
  scheduledOffsetMs: number;
  profileId: Exclude<S33LoadProfileId, "prodShapeReplay"> | "prodShapeReplay";
  orgId: string;
  sourceLaneId: string;
  authLane: "jwt-shard" | "monthly-api-key";
  /** Credential label only; never a JWT or API-key value. */
  authIdentityLabel: string;
  endpoint: "/api/v1/ai/extract" | "/api/v1/anchor";
  payloadCaseId: S33PayloadCase["id"];
  expectedStatus: 200 | 400 | 413 | 429;
  expectedClass: S33PayloadCase["expectedClass"] | "monthly-quota";
  jurisdictionFixtureId: string;
}

interface RollingWindowState {
  offsets: number[];
  head: number;
}

function pushRollingWindow(
  windows: Map<string, RollingWindowState>,
  identity: string,
  scheduledOffsetMs: number,
): number {
  let state = windows.get(identity);
  if (!state) {
    state = { offsets: [], head: 0 };
    windows.set(identity, state);
  }
  state.offsets.push(scheduledOffsetMs);
  // Keep an arrival exactly 60 seconds earlier. This is deliberately more
  // conservative than a half-open limiter window and cannot undercount.
  while (
    state.offsets[state.head]! <
    scheduledOffsetMs - ROLLING_RATE_WINDOW_MS
  ) {
    state.head++;
  }
  return state.offsets.length - state.head;
}

function buildRollingRateAdmission(
  plan: S33LoadPlan,
  profileId: S33LoadProfileId,
): S33LoadPlan["rateAdmission"]["profiles"][number] {
  const sourceWindows = new Map<string, RollingWindowState>();
  const jwtWindows = new Map<string, RollingWindowState>();
  let arrivalCount = 0;
  let maxAnonymousIpWindowCount = 0;
  let maxAnonymousIpSourceLaneId: string | null = null;
  let maxAiJwtWindowCount = 0;
  let maxAiJwtShardLabel: string | null = null;

  for (const arrival of iterateOpenArrivals(plan, profileId)) {
    arrivalCount++;
    const sourceCount = pushRollingWindow(
      sourceWindows,
      arrival.sourceLaneId,
      arrival.scheduledOffsetMs,
    );
    if (sourceCount > maxAnonymousIpWindowCount) {
      maxAnonymousIpWindowCount = sourceCount;
      maxAnonymousIpSourceLaneId = arrival.sourceLaneId;
    }
    if (sourceCount > MAX_ADMITTED_ANONYMOUS_IP_COUNT) {
      throw new Error(
        `${profileId} exact schedule is not strictly below the anonymous-IP rolling limit: ${arrival.sourceLaneId} has ${sourceCount}; admission requires <${ANONYMOUS_IP_LIMIT_PER_WINDOW}`,
      );
    }

    if (arrival.authLane === "jwt-shard") {
      const jwtCount = pushRollingWindow(
        jwtWindows,
        arrival.authIdentityLabel,
        arrival.scheduledOffsetMs,
      );
      if (jwtCount > maxAiJwtWindowCount) {
        maxAiJwtWindowCount = jwtCount;
        maxAiJwtShardLabel = arrival.authIdentityLabel;
      }
      if (jwtCount > MAX_ADMITTED_AI_JWT_COUNT) {
        throw new Error(
          `${profileId} exact schedule is not strictly below the AI JWT rolling limit: ${arrival.authIdentityLabel} has ${jwtCount}; admission requires <${AI_JWT_LIMIT_PER_WINDOW}`,
        );
      }
    }
  }

  return {
    profileId,
    arrivalCount,
    maxAnonymousIpWindowCount,
    maxAnonymousIpSourceLaneId,
    maxAiJwtWindowCount,
    maxAiJwtShardLabel,
    admitted: true,
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}

/** Stable JSON for immutable plan/evidence digests. */
export function canonicalS33Json(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    )
      return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new Error("Canonical S3.3 JSON rejects non-finite numbers");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    throw new Error(`Canonical S3.3 JSON rejects ${typeof candidate}`);
  };
  return JSON.stringify(visit(value));
}

export function digestS33Value(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalS33Json(value)).digest("hex")}`;
}

export function digestS33LoadPlan(plan: S33LoadPlan): string {
  return digestS33Value(plan);
}

export function buildExactJsonBody(
  targetBytes: number,
  jurisdiction: "AU" | "KE",
): string {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 128) {
    throw new Error("targetBytes must be an integer of at least 128 bytes");
  }
  const empty = JSON.stringify({
    fixture: true,
    jurisdiction,
    syntheticText: "",
  });
  const fillerBytes = targetBytes - Buffer.byteLength(empty, "utf8");
  if (fillerBytes < 0)
    throw new Error("targetBytes is smaller than the fixture envelope");
  const body = JSON.stringify({
    fixture: true,
    jurisdiction,
    syntheticText: "x".repeat(fillerBytes),
  });
  if (Buffer.byteLength(body, "utf8") !== targetBytes) {
    throw new Error("Unable to build the requested exact-byte JSON fixture");
  }
  return body;
}

export function buildS33LoadPlan(rawInput: S33LoadPlanInput): S33LoadPlan {
  const input = inputSchema.parse(rawInput);
  // The stress profile is spread across at least two source identities. This
  // leaves deterministic headroom below the 100/min/IP limiter even though the
  // seeded open-arrival process includes bursts.
  const nominalStressRatePerSourcePerMinute =
    5_000 / 60 / input.sourceLaneIds.length;
  if (nominalStressRatePerSourcePerMinute > MAX_SAFE_SOURCE_RATE_PER_MINUTE) {
    throw new Error(
      "Source lane plan cannot keep the stress profile safely below 100/min/source",
    );
  }

  const prodShapeReplay: S33MeasuredReplayProfile | S33PendingReplayProfile =
    input.prodShapeBaseline
      ? {
          status: "READY_FROM_IN_WINDOW_BASELINE",
          arrivalModel: "seeded-open-arrival",
          ratePerHour: input.prodShapeBaseline.ratePerHour,
          observedAt: input.prodShapeBaseline.observedAt,
          sourceArtifactSha256: input.prodShapeBaseline.sourceArtifactSha256,
          claimClass: "measured-in-window",
        }
      : {
          status: "AWAITING_IN_WINDOW_BASELINE",
          ratePerHour: null,
          sourceArtifactSha256: null,
          claimClass: "not-measured",
        };

  const plan: S33LoadPlan = {
    schemaVersion: "arkova.s33.l2.load-plan/v1",
    evidenceMode: input.evidenceMode,
    runId: input.runId,
    seed: input.seed,
    exactHeadSha: input.exactHeadSha,
    exactTreeSha: input.exactTreeSha,
    plannedStartAt: input.plannedStartAt,
    durationMinutes: input.durationMinutes,
    profiles: {
      fixture500: {
        id: "fixture500",
        arrivalModel: "seeded-open-arrival",
        ratePerHour: 500,
        claimClass: "asserted-fixture",
      },
      stress5000: {
        id: "stress5000",
        arrivalModel: "seeded-open-arrival",
        ratePerHour: 5_000,
        claimClass: "asserted-ceiling",
      },
      prodShapeReplay,
    },
    tenancy: {
      orgIds: [...input.orgIds],
      hotOrgId: input.orgIds[0]!,
      hotShare: 0.9,
      smallTenantShare: 0.1,
      jwtShardIds: [...input.jwtShardIds],
      sourceLaneIds: [...input.sourceLaneIds],
      nominalStressRatePerSourcePerMinute,
      monthlyApiKeyId: input.monthlyApiKeyId,
      monthlyQuotaLimit: 10_000,
      monthlyFixtureUsageAtStart: 10_000,
    },
    rateAdmission: {
      rollingWindowMs: ROLLING_RATE_WINDOW_MS,
      anonymousIpLimitPerWindow: ANONYMOUS_IP_LIMIT_PER_WINDOW,
      maxAdmittedAnonymousIpCount: MAX_ADMITTED_ANONYMOUS_IP_COUNT,
      aiJwtLimitPerWindow: AI_JWT_LIMIT_PER_WINDOW,
      maxAdmittedAiJwtCount: MAX_ADMITTED_AI_JWT_COUNT,
      profiles: [],
    },
    payloadCases: [
      {
        id: "text-49999",
        textBytes: 49_999,
        bodyBytes: null,
        expectedStatus: 200,
        expectedClass: "accepted",
      },
      {
        id: "text-50000",
        textBytes: 50_000,
        bodyBytes: null,
        expectedStatus: 200,
        expectedClass: "accepted",
      },
      {
        id: "text-50001",
        textBytes: 50_001,
        bodyBytes: null,
        expectedStatus: 400,
        expectedClass: "zod-rejected",
      },
      {
        id: "body-102401",
        textBytes: null,
        bodyBytes: 102_401,
        expectedStatus: 413,
        expectedClass: "express-body-limit",
      },
    ],
    jurisdictionFixtures: [
      {
        fixtureId: "synthetic-au-aqf",
        jurisdiction: "AU",
        synthetic: true,
        containsCustomerData: false,
      },
      {
        fixtureId: "synthetic-ke-ecitizen",
        jurisdiction: "KE",
        synthetic: true,
        containsCustomerData: false,
      },
      {
        fixtureId: "synthetic-ood-abstention",
        jurisdiction: "OOD",
        synthetic: true,
        containsCustomerData: false,
      },
    ],
    observation: {
      cadenceMinutes: 5,
      opsSloEndpoint: "/api/admin/ops-slo-stats",
      pipelineBaselineEndpoint: "/api/admin/pipeline-stats",
      everyPassRequiresSloSnapshot: true,
      everyPassRequiresHeartbeat: true,
      sentryStopPolicy: {
        declaredAt: input.stopPolicyDeclaredAt,
        maxIssueRatePerMinute: input.sentryMaxIssueRatePerMinute,
        maxNewCriticalIssues: 0,
        nonInjectedErrorRateThreshold: 0.01,
        consecutiveFiveMinuteWindows: 3,
      },
    },
    connectorPressure: {
      endpoint: "/jobs/drain-connector-artifacts",
      cadenceMinutes: 5,
      concurrentWithHeadline: true,
    },
    triggerBOscillation: {
      threshold: 3_000,
      backlogTargets: [2_999, 3_001, 2_999, 3_001],
      evidenceClass: "offline-scenario-only",
    },
    endpointEviction: {
      scenarioId: `${input.runId}:endpoint-eviction`,
      designatedRollbackRehearsal: true,
      separateRunRequired: true,
      invalidatesHeadlineClock: true,
      executableByThisModule: false,
      expectedOutcome: "clean-failover-to-base-flash",
    },
    attribution: {
      headlineBuckets: [
        "anon-IP",
        "keyed",
        "aiRateLimiter",
        "usageTracking-monthly",
        "upstream-model",
      ],
      summedHeadlineForbidden: true,
      targetedOrgAndPayerExcluded: true,
    },
    releaseEvidence: "DEFERRED_POST_WAVE3",
  };
  const admittedProfileIds: S33LoadProfileId[] = ["fixture500", "stress5000"];
  if (prodShapeReplay.status === "READY_FROM_IN_WINDOW_BASELINE") {
    admittedProfileIds.push("prodShapeReplay");
  }
  const admittedPlan: S33LoadPlan = {
    ...plan,
    rateAdmission: {
      ...plan.rateAdmission,
      profiles: admittedProfileIds.map((profileId) =>
        buildRollingRateAdmission(plan, profileId),
      ),
    },
  };
  return deepFreeze(admittedPlan) as S33LoadPlan;
}

function deterministicUnit(
  seed: string,
  profileId: string,
  sequence: number,
): number {
  const digest = createHash("sha256")
    .update(`${seed}\u0000${profileId}\u0000${sequence}`)
    .digest();
  const integer = digest.readUIntBE(0, 6);
  // Strictly inside (0,1) so -log(1-u) is finite and nonzero.
  return (integer + 0.5) / 2 ** 48;
}

function profileRate(plan: S33LoadPlan, profileId: S33LoadProfileId): number {
  if (profileId === "prodShapeReplay") {
    const replay = plan.profiles.prodShapeReplay;
    if (replay.status !== "READY_FROM_IN_WINDOW_BASELINE") {
      throw new Error(
        "Prod-shape replay requires an in-window measured baseline artifact",
      );
    }
    return replay.ratePerHour;
  }
  return plan.profiles[profileId].ratePerHour;
}

/** Deterministic exponential inter-arrival schedule; responses never influence it. */
export function* iterateOpenArrivals(
  plan: S33LoadPlan,
  profileId: S33LoadProfileId,
): Generator<S33PlannedArrival> {
  const ratePerHour = profileRate(plan, profileId);
  const meanIntervalMs = 3_600_000 / ratePerHour;
  const durationMs = plan.durationMinutes * 60_000;
  const smallOrgs = plan.tenancy.orgIds.slice(1);
  let offsetMs = 0;
  let sequence = 0;

  while (true) {
    const unit = deterministicUnit(plan.seed, profileId, sequence);
    offsetMs += -Math.log(1 - unit) * meanIntervalMs;
    if (offsetMs >= durationMs) return;
    const decadePosition = sequence % 10;
    const smallIndex = Math.floor(sequence / 10) % smallOrgs.length;
    const payloadCase = plan.payloadCases[sequence % plan.payloadCases.length]!;
    const jurisdiction =
      plan.jurisdictionFixtures[sequence % plan.jurisdictionFixtures.length]!;
    const authLane =
      sequence % 100 === 99
        ? ("monthly-api-key" as const)
        : ("jwt-shard" as const);
    const jwtShardId =
      plan.tenancy.jwtShardIds[sequence % plan.tenancy.jwtShardIds.length]!;
    yield {
      sequence,
      scheduledOffsetMs: Math.round(offsetMs),
      profileId,
      orgId:
        decadePosition < 9 ? plan.tenancy.hotOrgId : smallOrgs[smallIndex]!,
      sourceLaneId:
        plan.tenancy.sourceLaneIds[
          sequence % plan.tenancy.sourceLaneIds.length
        ]!,
      authLane,
      authIdentityLabel:
        authLane === "monthly-api-key"
          ? plan.tenancy.monthlyApiKeyId
          : jwtShardId,
      endpoint:
        authLane === "monthly-api-key"
          ? "/api/v1/anchor"
          : "/api/v1/ai/extract",
      payloadCaseId: payloadCase.id,
      expectedStatus:
        authLane === "monthly-api-key" ? 429 : payloadCase.expectedStatus,
      expectedClass:
        authLane === "monthly-api-key"
          ? "monthly-quota"
          : payloadCase.expectedClass,
      jurisdictionFixtureId: jurisdiction.fixtureId,
    };
    sequence++;
  }
}
