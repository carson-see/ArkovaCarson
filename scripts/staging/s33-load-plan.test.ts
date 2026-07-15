import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  buildExactJsonBody,
  buildS33LoadPlan,
  digestS33LoadPlan,
  iterateOpenArrivals,
  type S33LoadPlanInput,
} from "./s33-load-plan.js";

export function loadPlanInput(
  overrides: Partial<S33LoadPlanInput> = {},
): S33LoadPlanInput {
  return {
    evidenceMode: "OFFLINE_FIXTURE",
    runId: "s33-w3-l2b-fixture-20260715",
    seed: "s33-w3-l2b-seed-v1",
    exactHeadSha: "a".repeat(40),
    exactTreeSha: "b".repeat(40),
    plannedStartAt: "2026-07-16T00:00:00.000Z",
    stopPolicyDeclaredAt: "2026-07-15T23:00:00.000Z",
    durationMinutes: 60,
    orgIds: Array.from(
      { length: 30 },
      (_, index) => `org-${String(index + 1).padStart(2, "0")}`,
    ),
    jwtShardIds: [
      "jwt-shard-01",
      "jwt-shard-02",
      "jwt-shard-03",
      "jwt-shard-04",
    ],
    sourceLaneIds: ["source-lane-a", "source-lane-b"],
    monthlyApiKeyId: "monthly-key-fixture-01",
    sentryMaxIssueRatePerMinute: 2,
    ...overrides,
  };
}

describe("S3.3 Lane 2 load plan", () => {
  it("freezes deterministic 500/hour and 5,000/hour open-arrival profiles without calling either prod-shape", () => {
    const plan = buildS33LoadPlan(loadPlanInput());

    expect(plan.schemaVersion).toBe("arkova.s33.l2.load-plan/v1");
    expect(plan.evidenceMode).toBe("OFFLINE_FIXTURE");
    expect(plan.profiles.fixture500).toMatchObject({
      arrivalModel: "seeded-open-arrival",
      ratePerHour: 500,
      claimClass: "asserted-fixture",
    });
    expect(plan.profiles.stress5000).toMatchObject({
      arrivalModel: "seeded-open-arrival",
      ratePerHour: 5_000,
      claimClass: "asserted-ceiling",
    });
    expect(plan.profiles.prodShapeReplay).toEqual({
      status: "AWAITING_IN_WINDOW_BASELINE",
      ratePerHour: null,
      sourceArtifactSha256: null,
      claimClass: "not-measured",
    });
  });

  it("requires at least 30 organizations, four JWT shards, and enough source lanes for <100/min each", () => {
    expect(() =>
      buildS33LoadPlan(
        loadPlanInput({ orgIds: loadPlanInput().orgIds.slice(0, 29) }),
      ),
    ).toThrow(/30 organizations/i);
    expect(() =>
      buildS33LoadPlan(loadPlanInput({ jwtShardIds: ["a", "b", "c"] })),
    ).toThrow(/four JWT/i);
    expect(() =>
      buildS33LoadPlan(loadPlanInput({ sourceLaneIds: ["only-one"] })),
    ).toThrow(/source lane|100\/min/i);
  });

  it("admits only exact schedules that stay inside every rolling source-IP and JWT window", () => {
    const plan = buildS33LoadPlan(loadPlanInput());
    const stress = plan.rateAdmission.profiles.find(
      (profile) => profile.profileId === "stress5000",
    );

    expect(plan.rateAdmission).toMatchObject({
      rollingWindowMs: 60_000,
      anonymousIpLimitPerWindow: 100,
      maxAdmittedAnonymousIpCount: 99,
      aiJwtLimitPerWindow: 30,
      maxAdmittedAiJwtCount: 29,
    });
    expect(
      plan.rateAdmission.profiles.map((profile) => profile.profileId),
    ).toEqual(["fixture500", "stress5000"]);
    expect(stress).toMatchObject({ admitted: true });
    expect(stress!.maxAnonymousIpWindowCount).toBeLessThan(100);
    expect(stress!.maxAiJwtWindowCount).toBeLessThan(30);
  });

  it("rejects an adversarial seed whose exact stress schedule bursts past a JWT shard ceiling", () => {
    expect(() =>
      buildS33LoadPlan(
        loadPlanInput({
          seed: "adversarial-jwt-22",
          durationMinutes: 60,
        }),
      ),
    ).toThrow(/stress5000.*AI JWT rolling limit.*has 30.*<30/i);
  });

  it("rejects an adversarial measured replay whose exact schedule bursts past a source-IP ceiling", () => {
    expect(() =>
      buildS33LoadPlan(
        loadPlanInput({
          evidenceMode: "LIVE_POST_WAVE3",
          seed: "adversarial-source-0",
          durationMinutes: 60,
          jwtShardIds: Array.from(
            { length: 16 },
            (_, index) => `jwt-shard-${String(index + 1).padStart(2, "0")}`,
          ),
          prodShapeBaseline: {
            claimClass: "measured-in-window",
            ratePerHour: 10_000,
            observedAt: "2026-07-15T23:30:00.000Z",
            sourceArtifactSha256: `sha256:${"9".repeat(64)}`,
          },
        }),
      ),
    ).toThrow(/prodShapeReplay.*anonymous-IP rolling limit.*has 100.*<100/i);
  });

  it("assigns exact deterministic 90/10 hot-tenant skew while rotating every small tenant", () => {
    const plan = buildS33LoadPlan(loadPlanInput());
    const arrivals = Array.from(iterateOpenArrivals(plan, "stress5000")).slice(
      0,
      1_000,
    );
    const hot = arrivals.filter(
      (arrival) => arrival.orgId === plan.tenancy.hotOrgId,
    );
    const small = new Set(
      arrivals
        .filter((arrival) => arrival.orgId !== plan.tenancy.hotOrgId)
        .map((arrival) => arrival.orgId),
    );

    expect(hot).toHaveLength(900);
    expect(small.size).toBe(29);
    expect(
      arrivals.map((arrival) => arrival.authIdentityLabel).slice(0, 8),
    ).toEqual([
      "jwt-shard-01",
      "jwt-shard-02",
      "jwt-shard-03",
      "jwt-shard-04",
      "jwt-shard-01",
      "jwt-shard-02",
      "jwt-shard-03",
      "jwt-shard-04",
    ]);
    expect(arrivals[99]).toMatchObject({
      authLane: "monthly-api-key",
      authIdentityLabel: "monthly-key-fixture-01", // gitleaks:allow -- synthetic label, never a credential
      expectedStatus: 429,
      expectedClass: "monthly-quota",
    });
  });

  it("replays one seed identically and changes the schedule when the seed changes", () => {
    const first = buildS33LoadPlan(loadPlanInput());
    const same = buildS33LoadPlan(loadPlanInput());
    const other = buildS33LoadPlan(
      loadPlanInput({ seed: "different-seed-v1" }),
    );
    const take = (plan: ReturnType<typeof buildS33LoadPlan>) =>
      Array.from(iterateOpenArrivals(plan, "fixture500")).slice(0, 25);

    expect(take(first)).toEqual(take(same));
    expect(take(first)).not.toEqual(take(other));
    expect(digestS33LoadPlan(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestS33LoadPlan(first)).toBe(digestS33LoadPlan(same));
  });

  it("freezes exact byte-boundary, jurisdiction, connector, oscillation, and eviction scenarios", () => {
    const plan = buildS33LoadPlan(loadPlanInput());

    expect(
      plan.payloadCases.map(({ id, textBytes, expectedStatus }) => ({
        id,
        textBytes,
        expectedStatus,
      })),
    ).toEqual([
      { id: "text-49999", textBytes: 49_999, expectedStatus: 200 },
      { id: "text-50000", textBytes: 50_000, expectedStatus: 200 },
      { id: "text-50001", textBytes: 50_001, expectedStatus: 400 },
      { id: "body-102401", textBytes: null, expectedStatus: 413 },
    ]);
    expect(plan.payloadCases.at(-1)?.bodyBytes).toBe(102_401);
    expect(
      plan.jurisdictionFixtures.map((fixture) => fixture.jurisdiction),
    ).toEqual(["AU", "KE", "OOD"]);
    expect(plan.connectorPressure).toMatchObject({
      endpoint: "/jobs/drain-connector-artifacts",
      concurrentWithHeadline: true,
    });
    expect(plan.triggerBOscillation.backlogTargets).toEqual([
      2_999, 3_001, 2_999, 3_001,
    ]);
    expect(plan.endpointEviction).toMatchObject({
      designatedRollbackRehearsal: true,
      separateRunRequired: true,
      invalidatesHeadlineClock: true,
      executableByThisModule: false,
    });
  });

  it("builds an exact ~100KB JSON body without embedding credentials or customer data", () => {
    const body = buildExactJsonBody(102_401, "AU");
    expect(Buffer.byteLength(body, "utf8")).toBe(102_401);
    expect(JSON.parse(body)).toMatchObject({
      fixture: true,
      jurisdiction: "AU",
    });
    expect(body).not.toMatch(/authorization|api[_-]?key|jwt|customer/i);
  });

  it("rejects a stop policy declared after the planned start", () => {
    expect(() =>
      buildS33LoadPlan(
        loadPlanInput({
          stopPolicyDeclaredAt: "2026-07-16T00:00:00.001Z",
        }),
      ),
    ).toThrow(/declared before/i);
  });
});
