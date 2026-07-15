import { describe, expect, it } from "vitest";

import { buildS33429AttributionEvidence } from "./s33-429-attribution.js";
import {
  buildS33LoadEvidence,
  type S33LoadEvidenceInput,
} from "./s33-load-evidence.js";
import {
  buildS33LoadPlan,
  digestS33LoadPlan,
  digestS33Value,
  iterateOpenArrivals,
  type S33LoadPlan,
} from "./s33-load-plan.js";
import { loadPlanInput } from "./s33-load-plan.test.js";
import type { S33LoadRunnerOutput } from "./s33-load-runner.js";

const SHA = (character: string) => `sha256:${character.repeat(64)}`;

function attribution(anon429 = false) {
  return buildS33429AttributionEvidence({
    run: {
      runId: "s33-w3-l2b-fixture-20260715",
      arm: "public",
      apiSurface: "Developer-API",
      model: "gemini-2.5-flash",
      tunedModel: null,
      region: "global",
      v6PromptActive: false,
      responseSchema: "unset",
      responseMimeType: "application/json",
    },
    client429s: anon429
      ? [
          {
            correlationId: "anon-rate-limit-001",
            observedAt: "2026-07-16T00:01:00.000Z",
            path: "/api/v1/verify/fixture",
            status: 429,
            xRateLimitLimit: 100,
            retryAfterSec: 12,
          },
        ]
      : [],
    limiterLogs: anon429
      ? [
          {
            correlationId: "anon-rate-limit-001",
            observedAt: "2026-07-16T00:01:01.000Z",
            source: "worker-structured-log",
            event: "rate_limit_exceeded",
            maxRequests: 100,
            keyClass: "ip",
          },
        ]
      : [],
    upstream429s: [],
  });
}

function runnerOutput(plan: S33LoadPlan): S33LoadRunnerOutput {
  const startedAt = Date.parse(plan.plannedStartAt);
  const arrivals = Array.from(iterateOpenArrivals(plan, "fixture500")).map(
    (arrival) => ({
      ...arrival,
      observedAt: new Date(startedAt + arrival.scheduledOffsetMs).toISOString(),
      status: arrival.expectedStatus,
      correlationId: `request-${arrival.sequence}`,
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
          artifactSha256: digestS33Value({ passId, kind: "ops-slo" }),
          overallBreach: false,
        },
        sentry: {
          passId,
          observedAt,
          issueRatePerMinute: 0,
          newCriticalIssueCount: 0,
          artifactSha256: digestS33Value({ passId, kind: "sentry" }),
        },
        connector: {
          passId,
          observedAt,
          status: 200,
          correlationId: `connector-${passId}`,
          artifactSha256: digestS33Value({ passId, kind: "connector" }),
        },
        heartbeat: {
          passId,
          observedAt,
          workerUp: true,
          artifactSha256: digestS33Value({ passId, kind: "heartbeat" }),
        },
      };
    },
  );
  return {
    schemaVersion: "arkova.s33.l2.load-runner-output/v1",
    runId: plan.runId,
    evidenceMode: plan.evidenceMode,
    profileId: "fixture500",
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

function evidenceInput(
  overrides: Partial<S33LoadEvidenceInput> = {},
): S33LoadEvidenceInput {
  const plan =
    overrides.plan ?? buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
  const runner = overrides.runner ?? runnerOutput(plan);
  const attributionEvidence = overrides.attribution ?? attribution();
  const runnerArtifactSha256 =
    overrides.runnerArtifactSha256 ?? digestS33Value(runner);
  const attributionArtifactSha256 =
    overrides.attributionArtifactSha256 ?? digestS33Value(attributionEvidence);
  const observationDigests = runner.observationPasses.flatMap((pass) => [
    pass.opsSlo.artifactSha256,
    pass.sentry.artifactSha256,
    pass.connector.artifactSha256,
    pass.heartbeat.artifactSha256,
  ]);
  return {
    plan,
    planDigestSha256: overrides.planDigestSha256 ?? digestS33LoadPlan(plan),
    runner,
    runnerArtifactSha256,
    attribution: attributionEvidence,
    attributionArtifactSha256,
    targetedLimiterTelemetry: overrides.targetedLimiterTelemetry ?? {
      perOrgRateLimit: { observed429s: 0, headlineEligible: false },
      x402PayerRateLimit: { observed429s: 0, headlineEligible: false },
    },
    rawArtifactDigests: overrides.rawArtifactDigests ?? [
      ...new Set([
        runnerArtifactSha256,
        attributionArtifactSha256,
        ...observationDigests,
      ]),
    ],
  };
}

function injectUnexpectedStatus(
  runner: S33LoadRunnerOutput,
  windowIndexes: readonly number[],
): void {
  for (const windowIndex of windowIndexes) {
    const start = windowIndex * 5 * 60_000;
    const end = start + 5 * 60_000;
    const arrival = runner.arrivals.find(
      (candidate) =>
        candidate.scheduledOffsetMs >= start &&
        candidate.scheduledOffsetMs < end,
    );
    if (!arrival)
      throw new Error(`Fixture seed has no arrival in window ${windowIndex}`);
    arrival.status = 500;
    arrival.injectedFailure = false;
  }
}

describe("S3.3 load evidence", () => {
  it("composes exactly five unsummed headline buckets and keeps targeted org/payer telemetry outside them", () => {
    const evidence = buildS33LoadEvidence(evidenceInput());

    expect(Object.keys(evidence.headline429Buckets)).toEqual([
      "anon-IP",
      "keyed",
      "aiRateLimiter",
      "usageTracking-monthly",
      "upstream-model",
    ]);
    expect(evidence.targetedLimiterTelemetry).toEqual({
      perOrgRateLimit: { observed429s: 0, headlineEligible: false },
      x402PayerRateLimit: { observed429s: 0, headlineEligible: false },
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /total429|429Total|combined429/i,
    );
    expect(evidence.releaseStatus).toBe("DEFERRED_POST_WAVE3");
    expect(evidence.evidenceDigestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("hard-stops on one self-inflicted anonymous-IP 429", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const runner = runnerOutput(plan);
    const arrival = runner.arrivals[0]!;
    arrival.status = 429;
    arrival.correlationId = "anon-rate-limit-001";
    arrival.retryAfterSec = 12;
    arrival.xRateLimitLimit = 100;
    runner.arrivals = [arrival];
    runner.termination = {
      state: "HARD_STOPPED",
      trigger: {
        kind: "ANON_IP_429",
        sequence: arrival.sequence,
        correlationId: arrival.correlationId,
      },
      reasons: ["ANON_IP_429_SIGNAL"],
      lastDispatchedSequence: arrival.sequence,
    };
    const evidence = buildS33LoadEvidence(
      evidenceInput({ plan, runner, attribution: attribution(true) }),
    );
    expect(evidence.stopReasons).toContain("SELF_INFLICTED_ANON_IP_429");
    expect(evidence.executionDisposition).toBe("STOP");
    expect(() =>
      buildS33LoadEvidence(
        evidenceInput({ plan, runner, attribution: attribution(false) }),
      ),
    ).toThrow(/exact final header\/log attribution join/i);
  });

  it("pauses only after >1% non-injected errors in three consecutive five-minute windows", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 16 }));
    const threeBreaches = runnerOutput(plan);
    const twoBreaches = structuredClone(threeBreaches);
    injectUnexpectedStatus(threeBreaches, [0, 1, 2]);
    injectUnexpectedStatus(twoBreaches, [0, 1]);
    const paused = buildS33LoadEvidence(
      evidenceInput({ plan, runner: threeBreaches }),
    );
    const notYet = buildS33LoadEvidence(
      evidenceInput({ plan, runner: twoBreaches }),
    );

    expect(paused.pauseReasons).toContain(
      "NON_INJECTED_ERROR_RATE_GT_1_PERCENT_3X5M",
    );
    expect(paused.executionDisposition).toBe("PAUSE");
    expect(notYet.pauseReasons).toEqual([]);
  });

  it("accepts and binds the exact stopped prefix when a predeclared Sentry threshold is crossed", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 6 }));
    const runner = runnerOutput(plan);
    runner.observationPasses[1]!.sentry.issueRatePerMinute = 2.01;
    runner.arrivals = runner.arrivals.filter(
      (arrival) => arrival.scheduledOffsetMs < 300_000,
    );
    runner.observationPasses = runner.observationPasses.slice(0, 2);
    runner.termination = {
      state: "HARD_STOPPED",
      trigger: {
        kind: "OBSERVATION",
        passId: "pass-0001",
        scheduledOffsetMs: 300_000,
      },
      reasons: ["SENTRY_ISSUE_RATE_THRESHOLD"],
      lastDispatchedSequence: runner.arrivals.at(-1)?.sequence ?? null,
    };
    const evidence = buildS33LoadEvidence(evidenceInput({ plan, runner }));
    expect(evidence.stopReasons).toContain("SENTRY_ISSUE_RATE_THRESHOLD");
    expect(evidence.executionDisposition).toBe("STOP");
    expect(evidence.errorWindows).toHaveLength(2);
  });

  it("rejects an incomplete prefix without an authorized first-stop binding", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 6 }));
    const runner = runnerOutput(plan);
    runner.arrivals = runner.arrivals.filter(
      (arrival) => arrival.scheduledOffsetMs < 300_000,
    );
    runner.observationPasses = runner.observationPasses.slice(0, 1);

    expect(() => buildS33LoadEvidence(evidenceInput({ plan, runner }))).toThrow(
      /missing per-pass|completion/i,
    );
  });

  it("fails closed on missing per-pass observation or plan-digest drift", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const runner = runnerOutput(plan);
    runner.observationPasses = [];
    expect(() => buildS33LoadEvidence(evidenceInput({ plan, runner }))).toThrow(
      /observation|SLO|pass/i,
    );
    expect(() =>
      buildS33LoadEvidence(evidenceInput({ planDigestSha256: SHA("f") })),
    ).toThrow(/plan digest/i);
  });

  it("fails closed when runner arrivals drift from the seeded plan", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const runner = runnerOutput(plan);
    runner.arrivals[0]!.orgId = "org-tampered";

    expect(() => buildS33LoadEvidence(evidenceInput({ plan, runner }))).toThrow(
      /exact seeded plan/i,
    );
  });

  it("fails closed when an observation pass drifts from the declared cadence", () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 6 }));
    const runner = runnerOutput(plan);
    runner.observationPasses[1]!.scheduledOffsetMs++;

    expect(() => buildS33LoadEvidence(evidenceInput({ plan, runner }))).toThrow(
      /plan cadence/i,
    );
  });

  it("requires every runner, attribution, SLO, Sentry, connector, and heartbeat artifact digest", () => {
    const input = evidenceInput();
    const connectorDigest =
      input.runner.observationPasses[0]!.connector.artifactSha256;
    input.rawArtifactDigests = input.rawArtifactDigests.filter(
      (digest) => digest !== connectorDigest,
    );

    expect(() => buildS33LoadEvidence(input)).toThrow(
      /raw artifact digest set is missing/i,
    );
  });

  it("never upgrades fixture output into live measurements or release PASS", () => {
    const evidence = buildS33LoadEvidence(evidenceInput());
    expect(evidence.claims.measurements).toBe("fixture-only-not-measured");
    expect(evidence.releaseStatus).not.toMatch(/PASS|GO/);
  });
});
