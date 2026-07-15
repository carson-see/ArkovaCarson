/**
 * Fail-closed S3.3 Lane-2 evidence composer.
 *
 * The composer consumes normalized metadata only, preserves the frozen five
 * limiter buckets without a sum, and forces Wave-3 fixture output to remain
 * DEFERRED_POST_WAVE3. It does not collect or write evidence itself.
 */

import { z } from "zod";

import {
  S33_429_BUCKETS,
  buildS33429AttributionEvidence,
  type S33429AttributionEvidence,
  type S33429AttributionSourcePacket,
  type S33429Bucket,
  type S33429BucketEvidence,
} from "./s33-429-attribution.js";
import {
  buildS33LoadPlan,
  canonicalS33Json,
  digestS33LoadPlan,
  digestS33Value,
  iterateOpenArrivals,
  type S33LoadPlan,
  type S33LoadPlanInput,
  type S33LoadProfileId,
  type S33PlannedArrival,
} from "./s33-load-plan.js";
import {
  getS33HardStopReasons,
  parseS33LoadRunnerOutput,
  type S33LoadRunnerOutput,
} from "./s33-load-runner.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

const targetedLimiterLaneSchema = z
  .object({
    observed429s: z.number().int().nonnegative().safe(),
    headlineEligible: z.literal(false),
  })
  .strict();

const targetedLimiterTelemetrySchema = z
  .object({
    perOrgRateLimit: targetedLimiterLaneSchema,
    x402PayerRateLimit: targetedLimiterLaneSchema,
  })
  .strict();

const LOAD_EVIDENCE_INPUT_KEYS = Object.freeze([
  "plan",
  "planSourcePacket",
  "planDigestSha256",
  "runner",
  "runnerArtifactSha256",
  "attribution",
  "attributionSourcePacket",
  "attributionArtifactSha256",
  "targetedLimiterTelemetry",
  "rawArtifactDigests",
]);

export interface S33ErrorWindow {
  windowId: string;
  startedAt: string;
  totalRequests: number;
  injectedErrors: number;
  nonInjectedErrors: number;
}

export type S33TargetedLimiterTelemetry = z.infer<
  typeof targetedLimiterTelemetrySchema
>;

export interface S33LoadEvidenceInput {
  plan: S33LoadPlan;
  planSourcePacket: S33LoadPlanInput;
  planDigestSha256: string;
  runner: S33LoadRunnerOutput;
  runnerArtifactSha256: string;
  attribution: S33429AttributionEvidence;
  attributionSourcePacket: S33429AttributionSourcePacket;
  attributionArtifactSha256: string;
  targetedLimiterTelemetry: S33TargetedLimiterTelemetry;
  rawArtifactDigests: string[];
}

export interface S33LoadEvidence {
  schemaVersion: "arkova.s33.l2.load-evidence/v1";
  runId: string;
  profileId: S33LoadProfileId;
  evidenceMode: "OFFLINE_FIXTURE" | "LIVE_POST_WAVE3";
  exactHeadSha: string;
  exactTreeSha: string;
  windowStartedAt: string;
  windowEndedAt: string;
  planDigestSha256: string;
  runnerSchemaVersion: S33LoadRunnerOutput["schemaVersion"];
  runnerArtifactSha256: string;
  attributionArtifactSha256: string;
  rawArtifactDigests: readonly string[];
  headline429Buckets: Readonly<
    Record<S33429Bucket, Readonly<S33429BucketEvidence>>
  >;
  targetedLimiterTelemetry: Readonly<{
    perOrgRateLimit: Readonly<S33TargetedLimiterTelemetry["perOrgRateLimit"]>;
    x402PayerRateLimit: Readonly<
      S33TargetedLimiterTelemetry["x402PayerRateLimit"]
    >;
  }>;
  errorWindows: readonly S33ErrorWindow[];
  stopReasons: readonly string[];
  pauseReasons: readonly string[];
  executionDisposition: "CONTINUE" | "PAUSE" | "STOP";
  releaseStatus: "DEFERRED_POST_WAVE3" | "AWAITING_CTO_VERDICT";
  claims: Readonly<{
    measurements:
      "fixture-only-not-measured" | "measured-from-pinned-live-artifacts";
    headline429s: "five-separate-buckets-never-summed";
    targetedLimiters: "structural-only-excluded-from-headline";
  }>;
  evidenceDigestSha256: string;
}

function assertRawArtifactDigests(digests: readonly string[]): void {
  if (digests.length === 0)
    throw new Error("At least one raw artifact digest is required");
  if (digests.some((digest) => !SHA256.test(digest)))
    throw new Error("Raw artifact digest must be sha256:<64hex>");
  if (new Set(digests).size !== digests.length)
    throw new Error("Raw artifact digests must be unique");
}

function assertStrictLoadEvidenceInput(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Load-evidence source packet must be an object");
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Load-evidence source packet must be a plain object");
  }
  const actualKeys = Object.keys(input);
  const unknownKeys = actualKeys.filter(
    (key) => !LOAD_EVIDENCE_INPUT_KEYS.includes(key),
  );
  const missingKeys = LOAD_EVIDENCE_INPUT_KEYS.filter(
    (key) => !actualKeys.includes(key),
  );
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    throw new TypeError(
      `Load-evidence source packet keys are invalid; unknown=${unknownKeys.join(",") || "none"}; missing=${missingKeys.join(",") || "none"}`,
    );
  }
}

function rebuildLoadPlanArtifact(input: S33LoadEvidenceInput): S33LoadPlan {
  const rebuilt = buildS33LoadPlan(input.planSourcePacket);
  if (canonicalS33Json(input.plan) !== canonicalS33Json(rebuilt)) {
    throw new TypeError(
      "Serialized load plan does not match its strict source packet",
    );
  }
  const expectedDigest = digestS33LoadPlan(rebuilt);
  if (input.planDigestSha256 !== expectedDigest) {
    throw new Error(`Load plan digest mismatch: expected ${expectedDigest}`);
  }
  return rebuilt;
}

function parseRunnerArtifact(
  input: S33LoadEvidenceInput,
): S33LoadRunnerOutput {
  const parsed = parseS33LoadRunnerOutput(input.runner);
  if (canonicalS33Json(input.runner) !== canonicalS33Json(parsed)) {
    throw new TypeError(
      "Serialized load runner does not match its strict parsed artifact",
    );
  }
  return parsed;
}

function rebuildAttributionArtifact(
  input: S33LoadEvidenceInput,
): S33429AttributionEvidence {
  const rebuilt = buildS33429AttributionEvidence(
    input.attributionSourcePacket,
  );
  if (
    canonicalS33Json(input.attribution) !== canonicalS33Json(rebuilt)
  ) {
    throw new TypeError(
      "Validated attribution artifact bytes do not match the raw 429 source packet",
    );
  }
  const expectedDigest = digestS33Value(rebuilt);
  if (input.attributionArtifactSha256 !== expectedDigest) {
    throw new Error(
      `429 attribution artifact digest mismatch: expected ${expectedDigest}`,
    );
  }
  return rebuilt;
}

function assertArtifactBindings(
  input: S33LoadEvidenceInput,
  runner: S33LoadRunnerOutput,
  attribution: S33429AttributionEvidence,
): void {
  const expectedRunnerDigest = digestS33Value(runner);
  const expectedAttributionDigest = digestS33Value(attribution);
  if (input.runnerArtifactSha256 !== expectedRunnerDigest) {
    throw new Error(
      `Runner artifact digest mismatch: expected ${expectedRunnerDigest}`,
    );
  }
  if (input.attributionArtifactSha256 !== expectedAttributionDigest) {
    throw new Error(
      `429 attribution artifact digest mismatch: expected ${expectedAttributionDigest}`,
    );
  }
  const required = new Set<string>([
    input.runnerArtifactSha256,
    input.attributionArtifactSha256,
  ]);
  for (const pass of runner.observationPasses) {
    required.add(pass.opsSlo.artifactSha256);
    required.add(pass.sentry.artifactSha256);
    required.add(pass.connector.artifactSha256);
    required.add(pass.heartbeat.artifactSha256);
  }
  const supplied = new Set(input.rawArtifactDigests);
  const missing = [...required].filter((digest) => !supplied.has(digest));
  if (missing.length > 0) {
    throw new Error(`Raw artifact digest set is missing ${missing.join(", ")}`);
  }
}

function assertExactFiveBuckets(attribution: S33429AttributionEvidence): void {
  const actual = Object.keys(attribution.buckets);
  if (
    actual.length !== S33_429_BUCKETS.length ||
    S33_429_BUCKETS.some((bucket, index) => actual[index] !== bucket)
  ) {
    throw new Error(
      `Headline 429 evidence must contain exactly five ordered buckets: ${S33_429_BUCKETS.join(", ")}`,
    );
  }
  for (const bucket of S33_429_BUCKETS) {
    const evidence = attribution.buckets[bucket];
    if (evidence.count !== evidence.events.length) {
      throw new Error(
        `Headline 429 bucket ${bucket} count does not match its events`,
      );
    }
  }
  if (
    attribution.reportedNotMeasured.perOrgRateLimit.status !==
      "mounted_excluded" ||
    attribution.reportedNotMeasured.x402PayerRateLimit.status !==
      "mounted_excluded"
  ) {
    throw new Error(
      "Targeted organization and payer limiter lanes must remain excluded from headline buckets",
    );
  }
}

type RunnerPass = S33LoadRunnerOutput["observationPasses"][number];
type HardStoppedTermination = Extract<
  S33LoadRunnerOutput["termination"],
  { state: "HARD_STOPPED" }
>;

interface RunnerPassInspection {
  fullExpectedPasses: number;
  firstHardStopIndex: number | null;
  firstHardStopReasons: readonly string[];
}

function assertRunnerPlanIdentity(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): void {
  if (runner.runId !== plan.runId) {
    throw new Error("Runner run ID does not match the load plan");
  }
  if (runner.evidenceMode !== plan.evidenceMode) {
    throw new Error("Runner evidence mode does not match the load plan");
  }
  if (runner.executionModel !== "open-arrival-absolute-schedule") {
    throw new Error(
      "Runner did not use the required open-arrival absolute schedule",
    );
  }
}

function assertObservationPass(
  plan: S33LoadPlan,
  pass: RunnerPass,
  index: number,
  seen: Set<string>,
): readonly string[] {
  const expectedPassId = `pass-${String(index).padStart(4, "0")}`;
  const expectedOffset = index * plan.observation.cadenceMinutes * 60_000;
  if (
    pass.passId !== expectedPassId ||
    pass.scheduledOffsetMs !== expectedOffset
  ) {
    throw new Error(`Observation pass ${index} does not bind to the plan cadence`);
  }
  if (seen.has(pass.passId)) {
    throw new Error(`Duplicate observation pass ${pass.passId}`);
  }
  seen.add(pass.passId);
  const observations = [
    pass.opsSlo,
    pass.sentry,
    pass.connector,
    pass.heartbeat,
  ];
  if (observations.some((observation) => observation.passId !== pass.passId)) {
    throw new Error(`Observation identity mismatch for ${pass.passId}`);
  }
  if (
    observations.some(
      (observation) => !SHA256.test(observation.artifactSha256),
    )
  ) {
    throw new Error(
      `Observation pass ${pass.passId} lacks a pinned raw artifact`,
    );
  }
  if (
    observations.some(
      (observation) => !Number.isFinite(Date.parse(observation.observedAt)),
    )
  ) {
    throw new TypeError(
      `Observation pass ${pass.passId} has an invalid timestamp`,
    );
  }
  return getS33HardStopReasons(plan, pass);
}

function inspectObservationCoverage(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): RunnerPassInspection {
  const fullExpectedPasses = Math.ceil(
    plan.durationMinutes / plan.observation.cadenceMinutes,
  );
  if (runner.observationPasses.length === 0) {
    throw new Error(
      "Missing per-pass SLO/Sentry/heartbeat observation: received zero passes",
    );
  }
  if (runner.observationPasses.length > fullExpectedPasses) {
    throw new Error("Runner contains observation passes beyond the load plan");
  }
  const seen = new Set<string>();
  let firstHardStopIndex: number | null = null;
  let firstHardStopReasons: readonly string[] = [];
  for (const [index, pass] of runner.observationPasses.entries()) {
    const reasons = assertObservationPass(plan, pass, index, seen);
    if (reasons.length > 0 && firstHardStopIndex === null) {
      firstHardStopIndex = index;
      firstHardStopReasons = reasons;
    }
  }
  return { fullExpectedPasses, firstHardStopIndex, firstHardStopReasons };
}

function assertCompletedTermination(
  runner: S33LoadRunnerOutput,
  inspection: RunnerPassInspection,
): void {
  if (runner.observationPasses.length !== inspection.fullExpectedPasses) {
    throw new Error(
      `Missing per-pass SLO/Sentry/heartbeat observation: expected ${inspection.fullExpectedPasses}, received ${runner.observationPasses.length}`,
    );
  }
  if (inspection.firstHardStopIndex !== null) {
    throw new Error(
      "Runner claims completion despite a predeclared hard-stop observation",
    );
  }
}

function assertObservationStopBinding(
  runner: S33LoadRunnerOutput,
  termination: HardStoppedTermination,
  inspection: RunnerPassInspection,
): void {
  const lastIndex = runner.observationPasses.length - 1;
  const stopPass = runner.observationPasses[lastIndex]!;
  if (
    inspection.firstHardStopIndex === null ||
    inspection.firstHardStopIndex !== lastIndex
  ) {
    throw new Error(
      "Runner observation hard-stop is not the exact first-stop pass prefix",
    );
  }
  if (
    termination.trigger.kind !== "OBSERVATION" ||
    termination.trigger.passId !== stopPass.passId ||
    termination.trigger.scheduledOffsetMs !== stopPass.scheduledOffsetMs ||
    canonicalS33Json(termination.reasons) !==
      canonicalS33Json(inspection.firstHardStopReasons)
  ) {
    throw new Error("Runner hard-stop metadata does not bind to the stop pass");
  }
}

function assertHardStoppedTermination(
  runner: S33LoadRunnerOutput,
  termination: HardStoppedTermination,
  inspection: RunnerPassInspection,
): void {
  if (termination.trigger.kind === "OBSERVATION") {
    assertObservationStopBinding(runner, termination, inspection);
    return;
  }
  if (termination.trigger.kind === "ANON_IP_429") {
    if (
      canonicalS33Json(termination.reasons) !==
      canonicalS33Json(["ANON_IP_429_SIGNAL"])
    ) {
      throw new Error("Runner anonymous-IP stop has invalid reasons");
    }
    return;
  }
  throw new Error("Runner hard-stop trigger is invalid");
}

function assertRunnerTermination(
  runner: S33LoadRunnerOutput,
  inspection: RunnerPassInspection,
): void {
  if (runner.termination.state === "COMPLETED") {
    assertCompletedTermination(runner, inspection);
    return;
  }
  if (runner.termination.state === "HARD_STOPPED") {
    assertHardStoppedTermination(runner, runner.termination, inspection);
    return;
  }
  throw new Error("Runner termination state is invalid");
}

function plannedArrivalFields(
  arrival: S33PlannedArrival,
): S33PlannedArrival {
  return {
    sequence: arrival.sequence,
    scheduledOffsetMs: arrival.scheduledOffsetMs,
    profileId: arrival.profileId,
    orgId: arrival.orgId,
    sourceLaneId: arrival.sourceLaneId,
    authLane: arrival.authLane,
    authIdentityLabel: arrival.authIdentityLabel,
    endpoint: arrival.endpoint,
    payloadCaseId: arrival.payloadCaseId,
    expectedStatus: arrival.expectedStatus,
    expectedClass: arrival.expectedClass,
    jurisdictionFixtureId: arrival.jurisdictionFixtureId,
  };
}

function expectedArrivalPrefix(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): S33PlannedArrival[] {
  const fullSchedule = Array.from(iterateOpenArrivals(plan, runner.profileId));
  const lastSequence = runner.termination.lastDispatchedSequence;
  if (
    lastSequence !== null &&
    (!Number.isSafeInteger(lastSequence) ||
      lastSequence < 0 ||
      lastSequence >= fullSchedule.length)
  ) {
    throw new Error("Runner last-dispatched sequence is outside the load plan");
  }
  const prefix = fullSchedule.slice(0, lastSequence === null ? 0 : lastSequence + 1);
  if (
    runner.termination.state === "COMPLETED" &&
    prefix.length !== fullSchedule.length
  ) {
    throw new Error("Completed runner does not bind the full arrival schedule");
  }
  return prefix;
}

function assertArrivalRecords(
  runner: S33LoadRunnerOutput,
  expectedArrivals: readonly S33PlannedArrival[],
): void {
  if (runner.arrivals.length !== expectedArrivals.length) {
    throw new Error(
      `Runner arrival coverage mismatch: expected ${expectedArrivals.length}, received ${runner.arrivals.length}`,
    );
  }
  for (const [index, expected] of expectedArrivals.entries()) {
    const actual = runner.arrivals[index]!;
    if (
      canonicalS33Json(plannedArrivalFields(actual)) !==
      canonicalS33Json(expected)
    ) {
      throw new Error(
        `Runner arrival ${index} does not bind to the exact seeded plan`,
      );
    }
    if (!Number.isFinite(Date.parse(actual.observedAt))) {
      throw new TypeError(
        `Runner arrival ${index} has an invalid observation timestamp`,
      );
    }
  }
}

function assertAnonymousStopBinding(runner: S33LoadRunnerOutput): void {
  const anonSignals = runner.arrivals.filter(
    (arrival) => arrival.status === 429 && arrival.xRateLimitLimit === 100,
  );
  if (runner.termination.state === "COMPLETED" && anonSignals.length > 0) {
    throw new Error("Runner ignored an anonymous-IP 429 hard-stop signal");
  }
  if (
    runner.termination.state !== "HARD_STOPPED" ||
    runner.termination.trigger.kind !== "ANON_IP_429"
  ) {
    return;
  }
  const trigger = runner.termination.trigger;
  const matchesTrigger = anonSignals.some(
    (arrival) =>
      arrival.sequence === trigger.sequence &&
      arrival.correlationId === trigger.correlationId,
  );
  if (!matchesTrigger) {
    throw new Error(
      "Runner anonymous-IP stop does not bind to a dispatched 429 result",
    );
  }
}

function assertRunnerCoverage(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): void {
  assertRunnerPlanIdentity(plan, runner);
  const inspection = inspectObservationCoverage(plan, runner);
  assertRunnerTermination(runner, inspection);
  assertArrivalRecords(runner, expectedArrivalPrefix(plan, runner));
  assertAnonymousStopBinding(runner);
}

function assertAnonAttributionBinding(
  runner: S33LoadRunnerOutput,
  attribution: S33429AttributionEvidence,
): void {
  const runnerCorrelationIds = runner.arrivals
    .filter(
      (arrival) => arrival.status === 429 && arrival.xRateLimitLimit === 100,
    )
    .map((arrival) => arrival.correlationId)
    .sort((left, right) => left.localeCompare(right));
  const attributedCorrelationIds = attribution.buckets["anon-IP"].events
    .map((event) => event.correlationId)
    .sort((left, right) => left.localeCompare(right));
  if (
    canonicalS33Json(runnerCorrelationIds) !==
    canonicalS33Json(attributedCorrelationIds)
  ) {
    throw new Error(
      "Anonymous-IP runner signals require an exact final header/log attribution join",
    );
  }
  if (
    runner.termination.state === "HARD_STOPPED" &&
    runner.termination.trigger.kind === "ANON_IP_429" &&
    !attributedCorrelationIds.includes(
      runner.termination.trigger.correlationId,
    )
  ) {
    throw new Error(
      "Runner anonymous-IP stop correlation is absent from final attribution",
    );
  }
}

function deriveErrorWindows(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): Array<S33ErrorWindow & { rate: number }> {
  const windowMs = 5 * 60_000;
  const count =
    runner.termination.state === "HARD_STOPPED"
      ? Math.max(1, runner.observationPasses.length)
      : Math.ceil(plan.durationMinutes / 5);
  const start = Date.parse(plan.plannedStartAt);
  const windows = Array.from({ length: count }, (_, index) => ({
    windowId: `window-${String(index + 1).padStart(4, "0")}`,
    startedAt: new Date(start + index * windowMs).toISOString(),
    totalRequests: 0,
    injectedErrors: 0,
    nonInjectedErrors: 0,
    rate: 0,
  }));
  for (const arrival of runner.arrivals) {
    const index = Math.min(
      windows.length - 1,
      Math.floor(arrival.scheduledOffsetMs / windowMs),
    );
    const window = windows[index]!;
    window.totalRequests++;
    if (arrival.status !== arrival.expectedStatus) {
      if (arrival.injectedFailure) window.injectedErrors++;
      else window.nonInjectedErrors++;
    }
  }
  for (const window of windows) {
    const eligible = window.totalRequests - window.injectedErrors;
    window.rate = eligible === 0 ? 0 : window.nonInjectedErrors / eligible;
  }
  return windows;
}

function hasThreeConsecutiveBreaches(
  windows: readonly (S33ErrorWindow & { rate: number })[],
): boolean {
  let consecutive = 0;
  let previousAt: number | null = null;
  for (const window of windows) {
    const at = Date.parse(window.startedAt);
    const adjacent = previousAt === null || at - previousAt === 5 * 60_000;
    if (window.rate <= 0.01) consecutive = 0;
    else if (adjacent) consecutive++;
    else consecutive = 1;
    if (consecutive >= 3) return true;
    previousAt = at;
  }
  return false;
}

function parseTargetedTelemetry(
  telemetry: unknown,
): S33LoadEvidence["targetedLimiterTelemetry"] {
  const parsed = targetedLimiterTelemetrySchema.parse(telemetry);
  return Object.freeze({
    perOrgRateLimit: Object.freeze({ ...parsed.perOrgRateLimit }),
    x402PayerRateLimit: Object.freeze({ ...parsed.x402PayerRateLimit }),
  });
}

function deriveExecutionDisposition(
  stopReasons: readonly string[],
  pauseReasons: readonly string[],
): S33LoadEvidence["executionDisposition"] {
  if (stopReasons.length > 0) return "STOP";
  if (pauseReasons.length > 0) return "PAUSE";
  return "CONTINUE";
}

export function buildS33LoadEvidence(
  input: S33LoadEvidenceInput,
): S33LoadEvidence {
  assertStrictLoadEvidenceInput(input);
  const plan = rebuildLoadPlanArtifact(input);
  const runner = parseRunnerArtifact(input);
  const attribution = rebuildAttributionArtifact(input);
  assertRawArtifactDigests(input.rawArtifactDigests);
  assertExactFiveBuckets(attribution);
  assertRunnerCoverage(plan, runner);
  assertAnonAttributionBinding(runner, attribution);
  const targetedLimiterTelemetry = parseTargetedTelemetry(
    input.targetedLimiterTelemetry,
  );
  assertArtifactBindings(input, runner, attribution);
  if (attribution.run.runId !== plan.runId) {
    throw new Error("429 attribution run ID does not match the load plan");
  }

  const stopReasons: string[] = [];
  const pauseReasons: string[] = [];
  if (attribution.buckets["anon-IP"].count > 0)
    stopReasons.push("SELF_INFLICTED_ANON_IP_429");

  for (const pass of runner.observationPasses) {
    stopReasons.push(...getS33HardStopReasons(plan, pass));
  }

  const errorWindows = deriveErrorWindows(plan, runner);
  if (hasThreeConsecutiveBreaches(errorWindows)) {
    pauseReasons.push("NON_INJECTED_ERROR_RATE_GT_1_PERCENT_3X5M");
  }
  const uniqueStops = [...new Set(stopReasons)];
  const uniquePauses = [...new Set(pauseReasons)];
  const executionDisposition = deriveExecutionDisposition(
    uniqueStops,
    uniquePauses,
  );

  const evidenceWithoutDigest = {
    schemaVersion: "arkova.s33.l2.load-evidence/v1" as const,
    runId: plan.runId,
    profileId: runner.profileId,
    evidenceMode: plan.evidenceMode,
    exactHeadSha: plan.exactHeadSha,
    exactTreeSha: plan.exactTreeSha,
    windowStartedAt: plan.plannedStartAt,
    windowEndedAt: new Date(
      Date.parse(plan.plannedStartAt) + plan.durationMinutes * 60_000,
    ).toISOString(),
    planDigestSha256: input.planDigestSha256,
    runnerSchemaVersion: runner.schemaVersion,
    runnerArtifactSha256: input.runnerArtifactSha256,
    attributionArtifactSha256: input.attributionArtifactSha256,
    rawArtifactDigests: Object.freeze([...input.rawArtifactDigests]),
    headline429Buckets: attribution.buckets,
    targetedLimiterTelemetry,
    errorWindows: Object.freeze(
      errorWindows.map((window) =>
        Object.freeze({
          windowId: window.windowId,
          startedAt: window.startedAt,
          totalRequests: window.totalRequests,
          injectedErrors: window.injectedErrors,
          nonInjectedErrors: window.nonInjectedErrors,
        }),
      ),
    ),
    stopReasons: Object.freeze(uniqueStops),
    pauseReasons: Object.freeze(uniquePauses),
    executionDisposition,
    releaseStatus:
      plan.evidenceMode === "OFFLINE_FIXTURE"
        ? ("DEFERRED_POST_WAVE3" as const)
        : ("AWAITING_CTO_VERDICT" as const),
    claims: Object.freeze({
      measurements:
        plan.evidenceMode === "OFFLINE_FIXTURE"
          ? ("fixture-only-not-measured" as const)
          : ("measured-from-pinned-live-artifacts" as const),
      headline429s: "five-separate-buckets-never-summed" as const,
      targetedLimiters: "structural-only-excluded-from-headline" as const,
    }),
  };
  return Object.freeze({
    ...evidenceWithoutDigest,
    evidenceDigestSha256: digestS33Value(evidenceWithoutDigest),
  });
}
