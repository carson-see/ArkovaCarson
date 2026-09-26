import { beforeEach, describe, expect, it, vi } from "vitest";
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("./delivery.js", () => ({ dispatchWebhookEvent: dispatchMock }));
vi.mock("../utils/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("../utils/sentry.js", () => ({ Sentry: { captureMessage: vi.fn() } }));
import { PAYLOAD_SCHEMAS_BY_EVENT_TYPE } from "./payload-schemas.js";
import { emitAgentEvent } from "./agentEvents.js";
import { logger } from "../utils/logger.js";
import { Sentry } from "../utils/sentry.js";

beforeEach(() =>
  dispatchMock
    .mockReset()
    .mockResolvedValue({
      ok: true,
      ownEndpointCount: 1,
      descendantEndpointCount: 0,
      failures: [],
    }),
);

describe("agent lifecycle outbound event registry (SCRUM-3983)", () => {
  it("registers all four app-visible agent lifecycle notifications", () => {
    expect(Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)).toEqual(
      expect.arrayContaining([
        "agent.registered",
        "agent.updated",
        "agent.revoked",
        "agent.key_created",
      ]),
    );
  });
  it.each([
    ["agent.registered", { status: "active" }, "agent-1"],
    ["agent.updated", { status: "suspended" }, "update-1"],
    ["agent.revoked", { status: "revoked" }, "agent-1"],
    [
      "agent.key_created",
      { keyId: "44444444-4444-4444-8444-444444444444" },
      "key-1",
    ],
  ] as const)(
    "projects a strict secret-free %s payload",
    async (eventType, extra, eventId) => {
      emitAgentEvent({
        eventType,
        orgId: "org-1",
        agentId: "22222222-2222-4222-8222-222222222222",
        source: "api",
        eventId,
        occurredAt: "2026-09-26T00:00:00.000Z",
        ...extra,
      } as never);
      await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledOnce());
      const [, type, id, data] = dispatchMock.mock.calls[0];
      expect([type, id]).toEqual([eventType, eventId]);
      expect(
        PAYLOAD_SCHEMAS_BY_EVENT_TYPE[eventType].safeParse(data).success,
      ).toBe(true);
      expect(JSON.stringify(data)).not.toMatch(
        /secret|metadata|passport|key_prefix|raw/i,
      );
    },
  );
  it("rejects incomplete lifecycle projections at the strict registry boundary", () => {
    expect(
      PAYLOAD_SCHEMAS_BY_EVENT_TYPE["agent.updated"].safeParse({
        agent_id: "22222222-2222-4222-8222-222222222222",
        source: "api",
        occurred_at: "2026-09-26T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      PAYLOAD_SCHEMAS_BY_EVENT_TYPE["agent.key_created"].safeParse({
        agent_id: "22222222-2222-4222-8222-222222222222",
        source: "api",
        occurred_at: "2026-09-26T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
  it("isolates dispatch rejection and logs no secret-bearing input", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("upstream body SECRET"));
    expect(() =>
      emitAgentEvent({
        eventType: "agent.key_created",
        orgId: "org-1",
        agentId: "22222222-2222-4222-8222-222222222222",
        keyId: "44444444-4444-4444-8444-444444444444",
        source: "api",
        eventId: "key-1",
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      "SECRET",
    );
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });
});
