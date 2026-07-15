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
    retryAfterSec: z.number().int().nonnegative().optional(),
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

export interface S33LoadRunnerAdapter {
  /** Sleep against the absolute offset from plan start, never response latency. */
  sleepUntilOffset: (scheduledOffsetMs: number) => Promise<void>;
  dispatchArrival: (
    arrival: Readonly<S33PlannedArrival>,
  ) => Promise<S33DispatchObservation>;
  pollOpsSlo: (
    pass: Readonly<S33ObservationPassPlan>,
  ) => Promise<S33OpsSloObservation>;
  pollSentry: (
    pass: Readonly<S33ObservationPassPlan>,
  ) => Promise<S33SentryObservation>;
  driveConnectorPressure: (
    pass: Readonly<S33ObservationPassPlan>,
  ) => Promise<S33ConnectorObservation>;
  captureHeartbeat: (
    pass: Readonly<S33ObservationPassPlan>,
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

async function executeObservationPass(
  pass: S33ObservationPassPlan,
  adapter: S33LoadRunnerAdapter,
): Promise<S33RunnerObservationPass> {
  const [rawOpsSlo, rawSentry, rawConnector, rawHeartbeat] = await Promise.all([
    adapter.pollOpsSlo(pass),
    adapter.pollSentry(pass),
    adapter.driveConnectorPressure(pass),
    adapter.captureHeartbeat(pass),
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
): Promise<S33LoadRunnerOutput> {
  type DispatchResult =
    | { ok: true; record: S33RunnerArrivalRecord }
    | { ok: false; error: unknown };
  const plannedArrivals = Array.from(iterateOpenArrivals(plan, profileId));
  const plannedPasses = observationPasses(plan);
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
    resolveStop();
  };
  const sleepUntilDueOrStop = async (offset: number): Promise<boolean> => {
    if (schedulingStopped()) return false;
    const result = await Promise.race([
      Promise.resolve()
        .then(() => adapter.sleepUntilOffset(offset))
        .then(() => "DUE" as const),
      stopSignal.then(() => "STOPPED" as const),
    ]);
    return result === "DUE" && !schedulingStopped();
  };

  const scheduleArrivals = async (): Promise<void> => {
    try {
      for (const arrival of plannedArrivals) {
        if (!(await sleepUntilDueOrStop(arrival.scheduledOffsetMs))) return;
        const rawPromise = adapter.dispatchArrival(arrival);
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
      signalAbort(error);
      throw error;
    }
  };

  const scheduleControlPasses = async (): Promise<void> => {
    try {
      for (const passPlan of plannedPasses) {
        if (!(await sleepUntilDueOrStop(passPlan.scheduledOffsetMs))) return;
        const pass = await executeObservationPass(passPlan, adapter);
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
