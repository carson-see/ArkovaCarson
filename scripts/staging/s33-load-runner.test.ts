import { describe, expect, it, vi } from "vitest";

import { buildS33LoadPlan, iterateOpenArrivals } from "./s33-load-plan.js";
import { loadPlanInput } from "./s33-load-plan.test.js";
import {
  runS33LoadProfile,
  type S33LoadRunnerAdapter,
} from "./s33-load-runner.js";

function adapter(
  overrides: Partial<S33LoadRunnerAdapter> = {},
): S33LoadRunnerAdapter {
  return {
    sleepUntilOffset: async () => {},
    dispatchArrival: async (arrival) => ({
      sequence: arrival.sequence,
      observedAt: "2026-07-16T00:00:01.000Z",
      status: 200,
      correlationId: `request-${arrival.sequence}`,
      injectedFailure: false,
    }),
    pollOpsSlo: async (pass) => ({
      passId: pass.passId,
      observedAt: "2026-07-16T00:00:02.000Z",
      artifactSha256: `sha256:${"c".repeat(64)}`,
      overallBreach: false,
    }),
    pollSentry: async (pass) => ({
      passId: pass.passId,
      observedAt: "2026-07-16T00:00:02.000Z",
      issueRatePerMinute: 0,
      newCriticalIssueCount: 0,
      artifactSha256: `sha256:${"d".repeat(64)}`,
    }),
    driveConnectorPressure: async (pass) => ({
      passId: pass.passId,
      observedAt: "2026-07-16T00:00:02.000Z",
      status: 200,
      correlationId: `connector-${pass.passId}`,
      artifactSha256: `sha256:${"f".repeat(64)}`,
    }),
    captureHeartbeat: async (pass) => ({
      passId: pass.passId,
      observedAt: "2026-07-16T00:00:02.000Z",
      workerUp: true,
      artifactSha256: `sha256:${"e".repeat(64)}`,
    }),
    ...overrides,
  };
}

function controlledAbsoluteClock() {
  let now = 0;
  const waiters: Array<{ offset: number; resolve: () => void }> = [];
  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  };
  return {
    now: () => now,
    sleepUntilOffset: (offset: number): Promise<void> => {
      if (offset <= now) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ offset, resolve }));
    },
    advanceTo: async (target: number): Promise<void> => {
      for (let iteration = 0; iteration < 20_000; iteration++) {
        await flush();
        const next = waiters
          .map((waiter) => waiter.offset)
          .filter((offset) => offset <= target)
          .sort((left, right) => left - right)[0];
        if (next === undefined) {
          now = target;
          await flush();
          return;
        }
        now = next;
        const due = waiters.filter((waiter) => waiter.offset === next);
        for (const waiter of due) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      throw new Error("Controlled clock exceeded its progress bound");
    },
    flush,
  };
}

describe("S3.3 load runner kernel", () => {
  it("dispatches against absolute seeded arrivals without waiting for the prior response", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: number[] = [];
    const run = runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        dispatchArrival: async (arrival) => {
          calls.push(arrival.sequence);
          if (arrival.sequence === 0) await firstPending;
          return {
            sequence: arrival.sequence,
            observedAt: "2026-07-16T00:00:01.000Z",
            status: 200,
            correlationId: `request-${arrival.sequence}`,
            injectedFailure: false,
          };
        },
      }),
    );

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1));
    releaseFirst();
    const output = await run;

    expect(output.arrivals.length).toBeGreaterThan(1);
    expect(output.arrivals.map((arrival) => arrival.sequence)).toEqual(
      [...output.arrivals]
        .sort((a, b) => a.sequence - b.sequence)
        .map((arrival) => arrival.sequence),
    );
    expect(output.arrivals[0]).toMatchObject({
      endpoint: "/api/v1/ai/extract",
      orgId: plan.tenancy.hotOrgId,
      expectedStatus: 200,
      expectedClass: "accepted",
    });
    expect(output.executionModel).toBe("open-arrival-absolute-schedule");
  });

  it("polls SLO and Sentry, drives connector pressure, and captures one heartbeat per pass", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 11 }));
    const output = await runS33LoadProfile(plan, "fixture500", adapter());

    expect(
      output.observationPasses.map((pass) => pass.scheduledOffsetMs),
    ).toEqual([0, 300_000, 600_000]);
    expect(
      output.observationPasses.every((pass) =>
        pass.opsSlo.artifactSha256.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(
      output.observationPasses.every((pass) =>
        pass.sentry.artifactSha256.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(
      output.observationPasses.every((pass) => pass.connector.status === 200),
    ).toBe(true);
    expect(
      output.observationPasses.every((pass) => pass.heartbeat.workerUp),
    ).toBe(true);
    expect(output.termination).toEqual({
      state: "COMPLETED",
      trigger: null,
      reasons: [],
      lastDispatchedSequence: output.arrivals.at(-1)?.sequence ?? null,
    });
  });

  it("keeps absolute arrivals flowing during a delayed poll and halts only after its stop signal resolves", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 11 }));
    const clock = controlledAbsoluteClock();
    const dispatched: Array<{ scheduled: number; actual: number }> = [];
    const polledPasses: string[] = [];
    let releaseStopPass!: () => void;
    const stopPassGate = new Promise<void>((resolve) => {
      releaseStopPass = resolve;
    });
    let stopPassStarted = false;
    const run = runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        sleepUntilOffset: clock.sleepUntilOffset,
        dispatchArrival: async (arrival) => {
          dispatched.push({
            scheduled: arrival.scheduledOffsetMs,
            actual: clock.now(),
          });
          return {
            sequence: arrival.sequence,
            observedAt: "2026-07-16T00:00:01.000Z",
            status: arrival.expectedStatus,
            correlationId: `request-${arrival.sequence}`,
            injectedFailure: false,
          };
        },
        pollSentry: async (pass) => {
          polledPasses.push(pass.passId);
          if (pass.passId === "pass-0001") {
            stopPassStarted = true;
            await stopPassGate;
          }
          return {
            passId: pass.passId,
            observedAt: "2026-07-16T00:00:02.000Z",
            issueRatePerMinute: pass.passId === "pass-0001" ? 2.01 : 0,
            newCriticalIssueCount: 0,
            artifactSha256: `sha256:${"d".repeat(64)}`,
          };
        },
      }),
    );
    await clock.advanceTo(300_000);
    expect(stopPassStarted).toBe(true);
    await clock.advanceTo(360_000);
    expect(dispatched.some(({ scheduled }) => scheduled > 300_000)).toBe(true);
    expect(
      dispatched.every(({ scheduled, actual }) => scheduled === actual),
    ).toBe(true);
    releaseStopPass();
    await clock.flush();
    const dispatchedAtStop = dispatched.length;
    await clock.advanceTo(11 * 60_000);
    const output = await run;

    expect(dispatched).toHaveLength(dispatchedAtStop);
    expect(polledPasses).toEqual(["pass-0000", "pass-0001"]);
    expect(output.termination).toEqual({
      state: "HARD_STOPPED",
      trigger: {
        kind: "OBSERVATION",
        passId: "pass-0001",
        scheduledOffsetMs: 300_000,
      },
      reasons: ["SENTRY_ISSUE_RATE_THRESHOLD"],
      lastDispatchedSequence: output.arrivals.at(-1)?.sequence ?? null,
    });
  });

  it("resolves the shared stop signal from an anonymous-IP 429 result", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const clock = controlledAbsoluteClock();
    const dispatched: number[] = [];
    const firstOffset = Array.from(iterateOpenArrivals(plan, "fixture500"))[0]!
      .scheduledOffsetMs;
    const run = runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        sleepUntilOffset: clock.sleepUntilOffset,
        dispatchArrival: async (arrival) => {
          dispatched.push(arrival.sequence);
          return {
            sequence: arrival.sequence,
            observedAt: "2026-07-16T00:00:01.000Z",
            status: 429,
            correlationId: `request-${arrival.sequence}`,
            injectedFailure: false,
            retryAfterSec: 12,
            xRateLimitLimit: 100,
          };
        },
      }),
    );
    await clock.advanceTo(firstOffset);
    await clock.flush();
    const output = await run;

    expect(dispatched).toEqual([0]);
    expect(output.termination).toEqual({
      state: "HARD_STOPPED",
      trigger: {
        kind: "ANON_IP_429",
        sequence: 0,
        correlationId: "request-0",
      },
      reasons: ["ANON_IP_429_SIGNAL"],
      lastDispatchedSequence: 0,
    });
  });

  it("does not treat the planned monthly-quota 429 lane as anonymous-IP", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 15 }));
    const output = await runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        dispatchArrival: async (arrival) => ({
          sequence: arrival.sequence,
          observedAt: "2026-07-16T00:00:01.000Z",
          status: arrival.expectedStatus,
          correlationId: `request-${arrival.sequence}`,
          injectedFailure: false,
          ...(arrival.authLane === "monthly-api-key"
            ? {
                retryAfterSec: 60,
                xRateLimitLimit: 1_000 as const,
                quotaLimit: 10_000 as const,
              }
            : {}),
        }),
      }),
    );

    expect(
      output.arrivals.some(
        (arrival) =>
          arrival.authLane === "monthly-api-key" && arrival.status === 429,
      ),
    ).toBe(true);
    expect(output.termination.state).toBe("COMPLETED");
  });

  it("fails closed on a dispatch rejection without leaving the arrival scheduler running", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const clock = controlledAbsoluteClock();
    const dispatched: number[] = [];
    const firstOffset = Array.from(iterateOpenArrivals(plan, "fixture500"))[0]!
      .scheduledOffsetMs;
    const run = runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        sleepUntilOffset: clock.sleepUntilOffset,
        dispatchArrival: async (arrival) => {
          dispatched.push(arrival.sequence);
          throw new Error("dispatch-adapter-failed");
        },
      }),
    );
    const rejection = expect(run).rejects.toThrow("dispatch-adapter-failed");
    await clock.advanceTo(firstOffset);
    await clock.flush();
    await rejection;
    await clock.advanceTo(60_000);

    expect(dispatched).toEqual([0]);
  });

  it("fails closed on a control-poll rejection before any later arrival can dispatch", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    const clock = controlledAbsoluteClock();
    const dispatched: number[] = [];
    const run = runS33LoadProfile(
      plan,
      "fixture500",
      adapter({
        sleepUntilOffset: clock.sleepUntilOffset,
        dispatchArrival: async (arrival) => {
          dispatched.push(arrival.sequence);
          return {
            sequence: arrival.sequence,
            observedAt: "2026-07-16T00:00:01.000Z",
            status: arrival.expectedStatus,
            correlationId: `request-${arrival.sequence}`,
            injectedFailure: false,
          };
        },
        pollOpsSlo: async () => {
          throw new Error("control-poll-failed");
        },
      }),
    );
    await expect(run).rejects.toThrow("control-poll-failed");
    await clock.advanceTo(60_000);

    expect(dispatched).toEqual([]);
  });

  it("rejects unbounded response/body fields instead of retaining secrets in evidence", async () => {
    const plan = buildS33LoadPlan(loadPlanInput({ durationMinutes: 1 }));
    await expect(
      runS33LoadProfile(
        plan,
        "fixture500",
        adapter({
          dispatchArrival: async (arrival) =>
            ({
              sequence: arrival.sequence,
              observedAt: "2026-07-16T00:00:01.000Z",
              status: 200,
              correlationId: `request-${arrival.sequence}`,
              injectedFailure: false,
              body: { token: "must-not-survive" },
            }) as never,
        }),
      ),
    ).rejects.toThrow(/unrecognized|body|strict/i);
  });
});
