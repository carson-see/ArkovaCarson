/**
 * Fail-closed S3.3 Lane-2 evidence composer.
 *
 * The composer consumes normalized metadata only, preserves the frozen five
 * limiter buckets without a sum, and forces Wave-3 fixture output to remain
 * DEFERRED_POST_WAVE3. It does not collect or write evidence itself.
 */

import {
  S33_429_BUCKETS,
  type S33429AttributionEvidence,
  type S33429Bucket,
  type S33429BucketEvidence,
} from "./s33-429-attribution.js";
import {
  canonicalS33Json,
  digestS33LoadPlan,
  digestS33Value,
  iterateOpenArrivals,
  type S33LoadPlan,
  type S33PlannedArrival,
} from "./s33-load-plan.js";
import {
  getS33HardStopReasons,
  type S33LoadRunnerOutput,
} from "./s33-load-runner.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export interface S33ErrorWindow {
  windowId: string;
  startedAt: string;
  totalRequests: number;
  injectedErrors: number;
  nonInjectedErrors: number;
}

export interface S33TargetedLimiterTelemetry {
  perOrgRateLimit: { observed429s: number; headlineEligible: false };
  x402PayerRateLimit: { observed429s: number; headlineEligible: false };
}

export interface S33LoadEvidenceInput {
  plan: S33LoadPlan;
  planDigestSha256: string;
  runner: S33LoadRunnerOutput;
  runnerArtifactSha256: string;
  attribution: S33429AttributionEvidence;
  attributionArtifactSha256: string;
  targetedLimiterTelemetry: S33TargetedLimiterTelemetry;
  rawArtifactDigests: string[];
}

export interface S33LoadEvidence {
  schemaVersion: "arkova.s33.l2.load-evidence/v1";
  runId: string;
  evidenceMode: "OFFLINE_FIXTURE" | "LIVE_POST_WAVE3";
  exactHeadSha: string;
  exactTreeSha: string;
  planDigestSha256: string;
  runnerSchemaVersion: S33LoadRunnerOutput["schemaVersion"];
  runnerArtifactSha256: string;
  attributionArtifactSha256: string;
  rawArtifactDigests: readonly string[];
  headline429Buckets: Readonly<
    Record<S33429Bucket, Readonly<S33429BucketEvidence>>
  >;
  targetedLimiterTelemetry: S33TargetedLimiterTelemetry;
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

function assertFiniteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}

function assertRawArtifactDigests(digests: readonly string[]): void {
  if (digests.length === 0)
    throw new Error("At least one raw artifact digest is required");
  if (digests.some((digest) => !SHA256.test(digest)))
    throw new Error("Raw artifact digest must be sha256:<64hex>");
  if (new Set(digests).size !== digests.length)
    throw new Error("Raw artifact digests must be unique");
}

function assertArtifactBindings(input: S33LoadEvidenceInput): void {
  const expectedRunnerDigest = digestS33Value(input.runner);
  const expectedAttributionDigest = digestS33Value(input.attribution);
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
  for (const pass of input.runner.observationPasses) {
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

function assertRunnerCoverage(
  plan: S33LoadPlan,
  runner: S33LoadRunnerOutput,
): void {
  if (runner.runId !== plan.runId)
    throw new Error("Runner run ID does not match the load plan");
  if (runner.evidenceMode !== plan.evidenceMode)
    throw new Error("Runner evidence mode does not match the load plan");
  if (runner.executionModel !== "open-arrival-absolute-schedule") {
    throw new Error(
      "Runner did not use the required open-arrival absolute schedule",
    );
  }
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
    const expectedPassId = `pass-${String(index).padStart(4, "0")}`;
    const expectedOffset = index * plan.observation.cadenceMinutes * 60_000;
    if (
      pass.passId !== expectedPassId ||
      pass.scheduledOffsetMs !== expectedOffset
    ) {
      throw new Error(
        `Observation pass ${index} does not bind to the plan cadence`,
      );
    }
    if (seen.has(pass.passId))
      throw new Error(`Duplicate observation pass ${pass.passId}`);
    seen.add(pass.passId);
    if (
      pass.opsSlo.passId !== pass.passId ||
      pass.sentry.passId !== pass.passId ||
      pass.connector.passId !== pass.passId ||
      pass.heartbeat.passId !== pass.passId
    ) {
      throw new Error(`Observation identity mismatch for ${pass.passId}`);
    }
    if (
      ![
        pass.opsSlo.artifactSha256,
        pass.sentry.artifactSha256,
        pass.connector.artifactSha256,
        pass.heartbeat.artifactSha256,
      ].every((digest) => SHA256.test(digest))
    ) {
      throw new Error(
        `Observation pass ${pass.passId} lacks a pinned raw artifact`,
      );
    }
    if (
      [pass.opsSlo, pass.sentry, pass.connector, pass.heartbeat].some(
        (observation) => !Number.isFinite(Date.parse(observation.observedAt)),
      )
    ) {
      throw new Error(
        `Observation pass ${pass.passId} has an invalid timestamp`,
      );
    }
    const hardStopReasons = getS33HardStopReasons(plan, pass);
    if (hardStopReasons.length > 0 && firstHardStopIndex === null) {
      firstHardStopIndex = index;
      firstHardStopReasons = hardStopReasons;
    }
  }

  if (runner.termination.state === "COMPLETED") {
    if (runner.observationPasses.length !== fullExpectedPasses) {
      throw new Error(
        `Missing per-pass SLO/Sentry/heartbeat observation: expected ${fullExpectedPasses}, received ${runner.observationPasses.length}`,
      );
    }
    if (firstHardStopIndex !== null) {
      throw new Error(
        "Runner claims completion despite a predeclared hard-stop observation",
      );
    }
  } else if (runner.termination.state === "HARD_STOPPED") {
    if (runner.termination.trigger.kind === "OBSERVATION") {
      const lastIndex = runner.observationPasses.length - 1;
      const stopPass = runner.observationPasses[lastIndex]!;
      if (firstHardStopIndex === null || firstHardStopIndex !== lastIndex) {
        throw new Error(
          "Runner observation hard-stop is not the exact first-stop pass prefix",
        );
      }
      if (
        runner.termination.trigger.passId !== stopPass.passId ||
        runner.termination.trigger.scheduledOffsetMs !==
          stopPass.scheduledOffsetMs ||
        canonicalS33Json(runner.termination.reasons) !==
          canonicalS33Json(firstHardStopReasons)
      ) {
        throw new Error(
          "Runner hard-stop metadata does not bind to the stop pass",
        );
      }
    } else if (
      canonicalS33Json(runner.termination.reasons) !==
      canonicalS33Json(["ANON_IP_429_SIGNAL"])
    ) {
      throw new Error("Runner anonymous-IP stop has invalid reasons");
    }
  } else {
    throw new Error("Runner termination state is invalid");
  }

  const fullExpectedArrivals = Array.from(
    iterateOpenArrivals(plan, runner.profileId),
  );
  const lastDispatchedSequence = runner.termination.lastDispatchedSequence;
  if (
    lastDispatchedSequence !== null &&
    (!Number.isSafeInteger(lastDispatchedSequence) ||
      lastDispatchedSequence < 0 ||
      lastDispatchedSequence >= fullExpectedArrivals.length)
  ) {
    throw new Error("Runner last-dispatched sequence is outside the load plan");
  }
  const expectedArrivals = fullExpectedArrivals.slice(
    0,
    lastDispatchedSequence === null ? 0 : lastDispatchedSequence + 1,
  );
  if (
    runner.termination.state === "COMPLETED" &&
    expectedArrivals.length !== fullExpectedArrivals.length
  ) {
    throw new Error("Completed runner does not bind the full arrival schedule");
  }
  if (runner.arrivals.length !== expectedArrivals.length) {
    throw new Error(
      `Runner arrival coverage mismatch: expected ${expectedArrivals.length}, received ${runner.arrivals.length}`,
    );
  }
  const plannedFields = (arrival: S33PlannedArrival): S33PlannedArrival => ({
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
  });
  for (let index = 0; index < expectedArrivals.length; index++) {
    const expected = expectedArrivals[index]!;
    const actual = runner.arrivals[index]!;
    if (
      canonicalS33Json(plannedFields(actual)) !== canonicalS33Json(expected)
    ) {
      throw new Error(
        `Runner arrival ${index} does not bind to the exact seeded plan`,
      );
    }
    if (!Number.isFinite(Date.parse(actual.observedAt))) {
      throw new Error(
        `Runner arrival ${index} has an invalid observation timestamp`,
      );
    }
  }
  const anonSignals = runner.arrivals.filter(
    (arrival) => arrival.status === 429 && arrival.xRateLimitLimit === 100,
  );
  if (runner.termination.state === "COMPLETED" && anonSignals.length > 0) {
    throw new Error("Runner ignored an anonymous-IP 429 hard-stop signal");
  }
  if (
    runner.termination.state === "HARD_STOPPED" &&
    runner.termination.trigger.kind === "ANON_IP_429"
  ) {
    const trigger = runner.termination.trigger;
    const match = anonSignals.find(
      (arrival) =>
        arrival.sequence === trigger.sequence &&
        arrival.correlationId === trigger.correlationId,
    );
    if (!match) {
      throw new Error(
        "Runner anonymous-IP stop does not bind to a dispatched 429 result",
      );
    }
  }
}

function assertAnonAttributionBinding(input: S33LoadEvidenceInput): void {
  const runnerCorrelationIds = input.runner.arrivals
    .filter(
      (arrival) => arrival.status === 429 && arrival.xRateLimitLimit === 100,
    )
    .map((arrival) => arrival.correlationId)
    .sort();
  const attributedCorrelationIds = input.attribution.buckets["anon-IP"].events
    .map((event) => event.correlationId)
    .sort();
  if (
    canonicalS33Json(runnerCorrelationIds) !==
    canonicalS33Json(attributedCorrelationIds)
  ) {
    throw new Error(
      "Anonymous-IP runner signals require an exact final header/log attribution join",
    );
  }
  if (
    input.runner.termination.state === "HARD_STOPPED" &&
    input.runner.termination.trigger.kind === "ANON_IP_429" &&
    !attributedCorrelationIds.includes(
      input.runner.termination.trigger.correlationId,
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
    consecutive =
      adjacent && window.rate > 0.01
        ? consecutive + 1
        : window.rate > 0.01
          ? 1
          : 0;
    if (consecutive >= 3) return true;
    previousAt = at;
  }
  return false;
}

function assertTargetedTelemetry(telemetry: S33TargetedLimiterTelemetry): void {
  assertFiniteCount(
    telemetry.perOrgRateLimit.observed429s,
    "perOrgRateLimit.observed429s",
  );
  assertFiniteCount(
    telemetry.x402PayerRateLimit.observed429s,
    "x402PayerRateLimit.observed429s",
  );
  if (
    telemetry.perOrgRateLimit.headlineEligible !== false ||
    telemetry.x402PayerRateLimit.headlineEligible !== false
  ) {
    throw new Error(
      "Targeted organization/payer limiter telemetry is never headline eligible",
    );
  }
}

export function buildS33LoadEvidence(
  input: S33LoadEvidenceInput,
): S33LoadEvidence {
  const expectedPlanDigest = digestS33LoadPlan(input.plan);
  if (input.planDigestSha256 !== expectedPlanDigest) {
    throw new Error(
      `Load plan digest mismatch: expected ${expectedPlanDigest}`,
    );
  }
  assertRawArtifactDigests(input.rawArtifactDigests);
  assertExactFiveBuckets(input.attribution);
  assertRunnerCoverage(input.plan, input.runner);
  assertAnonAttributionBinding(input);
  assertTargetedTelemetry(input.targetedLimiterTelemetry);
  assertArtifactBindings(input);
  if (input.attribution.run.runId !== input.plan.runId) {
    throw new Error("429 attribution run ID does not match the load plan");
  }

  const stopReasons: string[] = [];
  const pauseReasons: string[] = [];
  if (input.attribution.buckets["anon-IP"].count > 0)
    stopReasons.push("SELF_INFLICTED_ANON_IP_429");

  for (const pass of input.runner.observationPasses) {
    stopReasons.push(...getS33HardStopReasons(input.plan, pass));
  }

  const errorWindows = deriveErrorWindows(input.plan, input.runner);
  if (hasThreeConsecutiveBreaches(errorWindows)) {
    pauseReasons.push("NON_INJECTED_ERROR_RATE_GT_1_PERCENT_3X5M");
  }
  const uniqueStops = [...new Set(stopReasons)];
  const uniquePauses = [...new Set(pauseReasons)];
  const executionDisposition: S33LoadEvidence["executionDisposition"] =
    uniqueStops.length > 0
      ? "STOP"
      : uniquePauses.length > 0
        ? "PAUSE"
        : "CONTINUE";

  const evidenceWithoutDigest = {
    schemaVersion: "arkova.s33.l2.load-evidence/v1" as const,
    runId: input.plan.runId,
    evidenceMode: input.plan.evidenceMode,
    exactHeadSha: input.plan.exactHeadSha,
    exactTreeSha: input.plan.exactTreeSha,
    planDigestSha256: input.planDigestSha256,
    runnerSchemaVersion: input.runner.schemaVersion,
    runnerArtifactSha256: input.runnerArtifactSha256,
    attributionArtifactSha256: input.attributionArtifactSha256,
    rawArtifactDigests: Object.freeze([...input.rawArtifactDigests]),
    headline429Buckets: input.attribution.buckets,
    targetedLimiterTelemetry: input.targetedLimiterTelemetry,
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
      input.plan.evidenceMode === "OFFLINE_FIXTURE"
        ? ("DEFERRED_POST_WAVE3" as const)
        : ("AWAITING_CTO_VERDICT" as const),
    claims: Object.freeze({
      measurements:
        input.plan.evidenceMode === "OFFLINE_FIXTURE"
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
