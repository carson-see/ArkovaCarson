/**
 * Injectable open-arrival runner kernel for the S3.3 Lane-2 plan.
 *
 * There is intentionally no fetch, filesystem, credential, gcloud, or Sentry
 * SDK adapter here. Wave 3 validates this kernel entirely offline. A future
 * post-Wave-3 operational adapter must be separately authorized and reviewed.
 */

import { z } from "zod";

import {
  iterateOpenArrivals,
  type S33LoadPlan,
  type S33LoadProfileId,
  type S33PlannedArrival,
} from "./s33-load-plan.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const dispatchObservationSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    observedAt: z.string().datetime({ offset: true }),
    status: z.number().int().min(0).max(599),
    correlationId: z.string().regex(SAFE_ID),
    injectedFailure: z.boolean(),
    retryAfterSec: z.number().int().nonnegative().safe().optional(),
    xRateLimitLimit: z
      .union([z.literal(30), z.literal(100), z.literal(1_000)])
      .optional(),
    quotaLimit: z.literal(10_000).optional(),
  })
  .strict();

const opsSloObservationSchema = z
  .object({
    passId: z.string().regex(SAFE_ID),
    observedAt: z.string().datetime({ offset: true }),
    artifactSha256: z.string().regex(SHA256),
    overallBreach: z.boolean(),
  })
  .strict();

const sentryObservationSchema = z
  .object({
    passId: z.string().regex(SAFE_ID),
    observedAt: z.string().datetime({ offset: true }),
    issueRatePerMinute: z.number().nonnegative().finite(),
    newCriticalIssueCount: z.number().int().nonnegative(),
    artifactSha256: z.string().regex(SHA256),
  })
  .strict();

const connectorObservationSchema = z
  .object({
    passId: z.string().regex(SAFE_ID),
    observedAt: z.string().datetime({ offset: true }),
    status: z.number().int().min(0).max(599),
    correlationId: z.string().regex(SAFE_ID),
    artifactSha256: z.string().regex(SHA256),
  })
  .strict();

const heartbeatObservationSchema = z
  .object({
    passId: z.string().regex(SAFE_ID),
    observedAt: z.string().datetime({ offset: true }),
    workerUp: z.boolean(),
    artifactSha256: z.string().regex(SHA256),
  })
  .strict();

const runnerArrivalRecordSchema = z
  .object({
    sequence: z.number().int().nonnegative().safe(),
    scheduledOffsetMs: z.number().int().nonnegative().safe(),
    profileId: z.enum(["fixture500", "stress5000", "prodShapeReplay"]),
    orgId: z.string().regex(SAFE_ID),
    sourceLaneId: z.string().regex(SAFE_ID),
    authLane: z.enum(["jwt-shard", "monthly-api-key"]),
    authIdentityLabel: z.string().regex(SAFE_ID),
    endpoint: z.enum(["/api/v1/ai/extract", "/api/v1/anchor"]),
    payloadCaseId: z.enum([
      "text-49999",
      "text-50000",
      "text-50001",
      "body-102401",
    ]),
    expectedStatus: z.union([
      z.literal(200),
      z.literal(400),
      z.literal(413),
      z.literal(429),
    ]),
    expectedClass: z.enum([
      "accepted",
      "zod-rejected",
      "express-body-limit",
      "monthly-quota",
    ]),
    jurisdictionFixtureId: z.string().regex(SAFE_ID),
    observedAt: z.string().datetime({ offset: true }),
    status: z.number().int().min(0).max(599),
    correlationId: z.string().regex(SAFE_ID),
    injectedFailure: z.boolean(),
    retryAfterSec: z.number().int().nonnegative().optional(),
    xRateLimitLimit: z
      .union([z.literal(30), z.literal(100), z.literal(1_000)])
      .optional(),
    quotaLimit: z.literal(10_000).optional(),
  })
  .strict();

const runnerObservationPassSchema = z
  .object({
    passId: z.string().regex(SAFE_ID),
    scheduledOffsetMs: z.number().int().nonnegative().safe(),
    opsSlo: opsSloObservationSchema,
    sentry: sentryObservationSchema,
    connector: connectorObservationSchema,
    heartbeat: heartbeatObservationSchema,
  })
  .strict();

const hardStopReasonSchema = z.enum([
  "OPS_SLO_BREACH",
  "WORKER_HEARTBEAT_DOWN",
  "CONNECTOR_PRESSURE_FAILURE",
  "SENTRY_ISSUE_RATE_THRESHOLD",
  "SENTRY_NEW_CRITICAL_ISSUE",
  "ANON_IP_429_SIGNAL",
]);

const runnerTerminationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("COMPLETED"),
      trigger: z.null(),
      reasons: z.tuple([]),
      lastDispatchedSequence: z.number().int().nonnegative().safe().nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal("HARD_STOPPED"),
      trigger: z.union([
        z
          .object({
            kind: z.literal("OBSERVATION"),
            passId: z.string().regex(SAFE_ID),
            scheduledOffsetMs: z.number().int().nonnegative().safe(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("ANON_IP_429"),
            sequence: z.number().int().nonnegative().safe(),
            correlationId: z.string().regex(SAFE_ID),
          })
          .strict(),
      ]),
      reasons: z.array(hardStopReasonSchema).min(1),
      lastDispatchedSequence: z.number().int().nonnegative().safe().nullable(),
    })
    .strict(),
]);

const runnerOutputSchema = z
  .object({
    schemaVersion: z.literal("arkova.s33.l2.load-runner-output/v1"),
    runId: z.string().regex(SAFE_ID),
    evidenceMode: z.enum(["OFFLINE_FIXTURE", "LIVE_POST_WAVE3"]),
    profileId: z.enum(["fixture500", "stress5000", "prodShapeReplay"]),
    executionModel: z.literal("open-arrival-absolute-schedule"),
    arrivals: z.array(runnerArrivalRecordSchema),
    observationPasses: z.array(runnerObservationPassSchema),
    termination: runnerTerminationSchema,
  })
  .strict();

export interface S33ObservationPassPlan {
  passId: string;
  scheduledOffsetMs: number;
}

export type S33DispatchObservation = z.infer<typeof dispatchObservationSchema>;
export type S33OpsSloObservation = z.infer<typeof opsSloObservationSchema>;
export type S33SentryObservation = z.infer<typeof sentryObservationSchema>;
export type S33ConnectorObservation = z.infer<
  typeof connectorObservationSchema
>;
export type S33HeartbeatObservation = z.infer<
  typeof heartbeatObservationSchema
>;

export interface S33AdapterCallContext {
  /** Cooperative cancellation for a stop, sibling failure, or timeout. */
  signal: AbortSignal;
  /** Maximum wall-clock duration for this individual adapter call. */
  timeoutMs: number;
}

export interface S33LoadRunnerOptions {
  /**
   * Bounds dispatch and observation adapters. For absolute scheduler sleeps,
   * this is the extra grace after the remaining planned offset.
   */
  adapterCallTimeoutMs?: number;
}

export interface S33LoadRunnerAdapter {
  /** Sleep against the absolute offset from plan start, never response latency. */
  sleepUntilOffset: (
    scheduledOffsetMs: number,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<void>;
  dispatchArrival: (
    arrival: Readonly<S33PlannedArrival>,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<S33DispatchObservation>;
  pollOpsSlo: (
    pass: Readonly<S33ObservationPassPlan>,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<S33OpsSloObservation>;
  pollSentry: (
    pass: Readonly<S33ObservationPassPlan>,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<S33SentryObservation>;
  driveConnectorPressure: (
    pass: Readonly<S33ObservationPassPlan>,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<S33ConnectorObservation>;
  captureHeartbeat: (
    pass: Readonly<S33ObservationPassPlan>,
    context: Readonly<S33AdapterCallContext>,
  ) => Promise<S33HeartbeatObservation>;
}

export interface S33RunnerArrivalRecord
  extends S33DispatchObservation, S33PlannedArrival {}

export interface S33RunnerObservationPass extends S33ObservationPassPlan {
  opsSlo: S33OpsSloObservation;
  sentry: S33SentryObservation;
  connector: S33ConnectorObservation;
  heartbeat: S33HeartbeatObservation;
}

export type S33RunnerHardStopReason =
  | "OPS_SLO_BREACH"
  | "WORKER_HEARTBEAT_DOWN"
  | "CONNECTOR_PRESSURE_FAILURE"
  | "SENTRY_ISSUE_RATE_THRESHOLD"
  | "SENTRY_NEW_CRITICAL_ISSUE"
  | "ANON_IP_429_SIGNAL";

export type S33RunnerStopTrigger =
  | {
      kind: "OBSERVATION";
      passId: string;
      scheduledOffsetMs: number;
    }
  | {
      kind: "ANON_IP_429";
      sequence: number;
      correlationId: string;
    };

export type S33RunnerTermination =
  | {
      state: "COMPLETED";
      trigger: null;
      reasons: readonly [];
      lastDispatchedSequence: number | null;
    }
  | {
      state: "HARD_STOPPED";
      trigger: Readonly<S33RunnerStopTrigger>;
      reasons: readonly S33RunnerHardStopReason[];
      lastDispatchedSequence: number | null;
    };

export interface S33LoadRunnerOutput {
  schemaVersion: "arkova.s33.l2.load-runner-output/v1";
  runId: string;
  evidenceMode: "OFFLINE_FIXTURE" | "LIVE_POST_WAVE3";
  profileId: S33LoadProfileId;
  executionModel: "open-arrival-absolute-schedule";
  arrivals: S33RunnerArrivalRecord[];
  observationPasses: S33RunnerObservationPass[];
  termination: S33RunnerTermination;
}

/** Strictly validate a serialized runner artifact before evidence composition. */
export function parseS33LoadRunnerOutput(
  candidate: unknown,
): S33LoadRunnerOutput {
  return runnerOutputSchema.parse(candidate) as S33LoadRunnerOutput;
}

function observationPasses(plan: S33LoadPlan): S33ObservationPassPlan[] {
  const durationMs = plan.durationMinutes * 60_000;
  const cadenceMs = plan.observation.cadenceMinutes * 60_000;
  const passes: S33ObservationPassPlan[] = [];
  for (
    let offset = 0, index = 0;
    offset < durationMs;
    offset += cadenceMs, index++
  ) {
    passes.push({
      passId: `pass-${String(index).padStart(4, "0")}`,
      scheduledOffsetMs: offset,
    });
  }
  return passes;
}

function assertPassIdentity(
  pass: S33ObservationPassPlan,
  observations: readonly { passId: string }[],
): void {
  if (observations.some((observation) => observation.passId !== pass.passId)) {
    throw new Error(`Observation pass identity mismatch for ${pass.passId}`);
  }
}

const DEFAULT_ADAPTER_CALL_TIMEOUT_MS = 30_000;
const MAX_ADAPTER_CALL_TIMEOUT_MS = 300_000;

class S33AdapterCallCancelledError extends Error {
  constructor(label: string) {
    super(`${label} was cancelled`);
    this.name = "S33AdapterCallCancelledError";
  }
}

function parseAdapterCallTimeout(options: S33LoadRunnerOptions): number {
  const timeoutMs =
    options.adapterCallTimeoutMs ?? DEFAULT_ADAPTER_CALL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_ADAPTER_CALL_TIMEOUT_MS
  ) {
    throw new TypeError(
      `adapterCallTimeoutMs must be a positive safe integer no greater than ${MAX_ADAPTER_CALL_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

/**
 * Invoke an adapter with a hard wall-clock bound and cancellation. Handlers
 * remain attached to the underlying promise so a late rejection cannot become
 * unhandled after this wrapper has already failed closed.
 */
function boundedAdapterCall<T>(
  label: string,
  signal: AbortSignal,
  timeoutMs: number,
  invoke: (context: Readonly<S33AdapterCallContext>) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = signal.reason;
      finish(() =>
        reject(
          reason instanceof Error
            ? reason
            : new S33AdapterCallCancelledError(label),
        ),
      );
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(new Error(`${label} exceeded adapter timeout ${timeoutMs}ms`)),
      );
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let rawPromise: Promise<T>;
    try {
      rawPromise = invoke(Object.freeze({ signal, timeoutMs }));
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(rawPromise).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function executeObservationPass(
  pass: S33ObservationPassPlan,
  adapter: S33LoadRunnerAdapter,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<S33RunnerObservationPass> {
  const [rawOpsSlo, rawSentry, rawConnector, rawHeartbeat] = await Promise.all([
    boundedAdapterCall("ops-SLO poll", signal, timeoutMs, (context) =>
      adapter.pollOpsSlo(pass, context),
    ),
    boundedAdapterCall("Sentry poll", signal, timeoutMs, (context) =>
      adapter.pollSentry(pass, context),
    ),
    boundedAdapterCall("connector pressure", signal, timeoutMs, (context) =>
      adapter.driveConnectorPressure(pass, context),
    ),
    boundedAdapterCall("heartbeat capture", signal, timeoutMs, (context) =>
      adapter.captureHeartbeat(pass, context),
    ),
  ]);
  const opsSlo = opsSloObservationSchema.parse(rawOpsSlo);
  const sentry = sentryObservationSchema.parse(rawSentry);
  const connector = connectorObservationSchema.parse(rawConnector);
  const heartbeat = heartbeatObservationSchema.parse(rawHeartbeat);
  assertPassIdentity(pass, [opsSlo, sentry, connector, heartbeat]);
  return { ...pass, opsSlo, sentry, connector, heartbeat };
}

export function getS33HardStopReasons(
  plan: S33LoadPlan,
  pass: S33RunnerObservationPass,
): S33RunnerHardStopReason[] {
  const reasons: S33RunnerHardStopReason[] = [];
  if (pass.opsSlo.overallBreach) reasons.push("OPS_SLO_BREACH");
  if (!pass.heartbeat.workerUp) reasons.push("WORKER_HEARTBEAT_DOWN");
  if (pass.connector.status !== 200) reasons.push("CONNECTOR_PRESSURE_FAILURE");
  if (
    pass.sentry.issueRatePerMinute >
    plan.observation.sentryStopPolicy.maxIssueRatePerMinute
  ) {
    reasons.push("SENTRY_ISSUE_RATE_THRESHOLD");
  }
  if (
    pass.sentry.newCriticalIssueCount >
    plan.observation.sentryStopPolicy.maxNewCriticalIssues
  ) {
    reasons.push("SENTRY_NEW_CRITICAL_ISSUE");
  }
  return reasons;
}

/**
 * Execute one deterministic profile. The absolute arrival scheduler and the
 * control-pass scheduler run concurrently. Neither response latency nor a slow
 * observation poll can close the arrival loop or create a catch-up burst.
 * The first resolved hard-stop signal wakes both schedulers and prevents every
 * later dispatch while already-dispatched results are retained as a prefix.
 */
export async function runS33LoadProfile(
  plan: S33LoadPlan,
  profileId: S33LoadProfileId,
  adapter: S33LoadRunnerAdapter,
  options: S33LoadRunnerOptions = {},
): Promise<S33LoadRunnerOutput> {
  type DispatchResult =
    | { ok: true; record: S33RunnerArrivalRecord }
    | { ok: false; error: unknown };
  const plannedArrivals = Array.from(iterateOpenArrivals(plan, profileId));
  const plannedPasses = observationPasses(plan);
  const adapterCallTimeoutMs = parseAdapterCallTimeout(options);
  const runnerStartedAtMs = Date.now();
  const schedulerController = new AbortController();
  const controlController = new AbortController();
  const dispatchController = new AbortController();
  const pendingArrivals: Promise<DispatchResult>[] = [];
  const passes: S33RunnerObservationPass[] = [];
  let lastDispatchedSequence: number | null = null;
  let aborted = false;
  let hasFailure = false;
  let firstFailure: unknown;
  let termination: S33RunnerTermination = {
    state: "COMPLETED",
    trigger: null,
    reasons: [],
    lastDispatchedSequence: null,
  };
  let resolveStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const signalAbort = (error: unknown): void => {
    if (!hasFailure) {
      hasFailure = true;
      firstFailure = error;
    }
    aborted = true;
    schedulerController.abort(error);
    controlController.abort(error);
    dispatchController.abort(error);
    resolveStop();
  };
  const schedulingStopped = (): boolean =>
    aborted || termination.state === "HARD_STOPPED";
  const signalStop = (
    trigger: S33RunnerStopTrigger,
    reasons: readonly S33RunnerHardStopReason[],
  ): void => {
    if (schedulingStopped()) return;
    termination = {
      state: "HARD_STOPPED",
      trigger,
      reasons: [...reasons],
      lastDispatchedSequence,
    };
    const stopCancellation = new S33AdapterCallCancelledError(
      "load runner after hard stop",
    );
    schedulerController.abort(stopCancellation);
    controlController.abort(stopCancellation);
    resolveStop();
  };
  const sleepUntilDueOrStop = async (offset: number): Promise<boolean> => {
    if (schedulingStopped()) return false;
    const elapsedMs = Math.max(0, Date.now() - runnerStartedAtMs);
    const remainingUntilOffsetMs = Math.max(0, offset - elapsedMs);
    const schedulerTimeoutMs =
      remainingUntilOffsetMs + adapterCallTimeoutMs;
    const result = await Promise.race([
      boundedAdapterCall(
        `absolute schedule sleep ${offset}`,
        schedulerController.signal,
        schedulerTimeoutMs,
        (context) => adapter.sleepUntilOffset(offset, context),
      ).then(() => "DUE" as const),
      stopSignal.then(() => "STOPPED" as const),
    ]);
    return result === "DUE" && !schedulingStopped();
  };

  const scheduleArrivals = async (): Promise<void> => {
    try {
      for (const arrival of plannedArrivals) {
        if (!(await sleepUntilDueOrStop(arrival.scheduledOffsetMs))) return;
        const rawPromise = boundedAdapterCall(
          `arrival dispatch ${arrival.sequence}`,
          dispatchController.signal,
          adapterCallTimeoutMs,
          (context) => adapter.dispatchArrival(arrival, context),
        );
        lastDispatchedSequence = arrival.sequence;
        pendingArrivals.push(
          Promise.resolve(rawPromise).then(
            (raw): DispatchResult => {
              try {
                const observation = dispatchObservationSchema.parse(raw);
                if (observation.sequence !== arrival.sequence) {
                  throw new Error(
                    `Arrival sequence mismatch: planned ${arrival.sequence}, observed ${observation.sequence}`,
                  );
                }
                if (
                  observation.status === 429 &&
                  observation.xRateLimitLimit === 100
                ) {
                  signalStop(
                    {
                      kind: "ANON_IP_429",
                      sequence: arrival.sequence,
                      correlationId: observation.correlationId,
                    },
                    ["ANON_IP_429_SIGNAL"],
                  );
                }
                return { ok: true, record: { ...arrival, ...observation } };
              } catch (error) {
                signalAbort(error);
                return { ok: false, error };
              }
            },
            (error): DispatchResult => {
              signalAbort(error);
              return { ok: false, error };
            },
          ),
        );
      }
    } catch (error) {
      if (termination.state === "HARD_STOPPED") return;
      signalAbort(error);
      throw error;
    }
  };

  const scheduleControlPasses = async (): Promise<void> => {
    try {
      for (const passPlan of plannedPasses) {
        if (!(await sleepUntilDueOrStop(passPlan.scheduledOffsetMs))) return;
        const pass = await executeObservationPass(
          passPlan,
          adapter,
          controlController.signal,
          adapterCallTimeoutMs,
        );
        passes.push(pass);
        const reasons = getS33HardStopReasons(plan, pass);
        if (reasons.length > 0) {
          signalStop(
            {
              kind: "OBSERVATION",
              passId: pass.passId,
              scheduledOffsetMs: pass.scheduledOffsetMs,
            },
            reasons,
          );
          return;
        }
        if (schedulingStopped()) return;
      }
    } catch (error) {
      if (termination.state === "HARD_STOPPED") return;
      signalAbort(error);
      throw error;
    }
  };

  const schedulerResults = await Promise.allSettled([
    scheduleArrivals(),
    scheduleControlPasses(),
  ]);
  const dispatchResults = await Promise.all(pendingArrivals);
  if (!hasFailure) {
    const schedulerFailure = schedulerResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const dispatchFailure = dispatchResults.find((result) => !result.ok);
    if (schedulerFailure) signalAbort(schedulerFailure.reason);
    else if (dispatchFailure && !dispatchFailure.ok)
      signalAbort(dispatchFailure.error);
  }
  if (hasFailure) throw firstFailure;

  const arrivals = dispatchResults
    .filter(
      (result): result is Extract<DispatchResult, { ok: true }> => result.ok,
    )
    .map((result) => result.record);
  arrivals.sort((left, right) => left.sequence - right.sequence);
  passes.sort(
    (left, right) => left.scheduledOffsetMs - right.scheduledOffsetMs,
  );
  if (termination.state === "COMPLETED") {
    termination = {
      ...termination,
      lastDispatchedSequence,
    };
  }

  return {
    schemaVersion: "arkova.s33.l2.load-runner-output/v1",
    runId: plan.runId,
    evidenceMode: plan.evidenceMode,
    profileId,
    executionModel: "open-arrival-absolute-schedule",
    arrivals,
    observationPasses: passes,
    termination,
  };
}
