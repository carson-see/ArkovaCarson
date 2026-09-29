import { dispatchWebhookEvent, processAgentWebhookOutbox } from "./delivery.js";
import { logger } from "../utils/logger.js";
import { Sentry } from "../utils/sentry.js";

type AgentEventBase = {
  orgId: string;
  agentId: string;
  source: "api" | "computeid";
  eventId: string;
  occurredAt?: string;
  orgPublicId?: string;
};
export type AgentEventInput = AgentEventBase &
  (
    | {
        eventType: "agent.registered" | "agent.updated";
        status: "active" | "suspended" | "revoked";
        keyId?: never;
      }
    | { eventType: "agent.revoked"; status: "revoked"; keyId?: never }
    | { eventType: "agent.key_created"; keyId: string; status?: never }
  );

/** Start a secret-free refresh notification after the lifecycle commit. */
export function emitAgentEvent(input: AgentEventInput): void {
  const data: Record<string, unknown> = {
    agent_id: input.agentId,
    source: input.source,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    ...(input.orgPublicId ? { org_public_id: input.orgPublicId } : {}),
    ...(input.eventType === "agent.key_created"
      ? { key_id: input.keyId }
      : { status: input.status }),
  };
  let dispatch: ReturnType<typeof dispatchWebhookEvent>;
  switch (input.eventType) {
    case "agent.registered":
      dispatch = dispatchWebhookEvent(input.orgId, "agent.registered", input.eventId, data);
      break;
    case "agent.updated":
      dispatch = dispatchWebhookEvent(input.orgId, "agent.updated", input.eventId, data);
      break;
    case "agent.revoked":
      dispatch = dispatchWebhookEvent(input.orgId, "agent.revoked", input.eventId, data);
      break;
    case "agent.key_created":
      dispatch = dispatchWebhookEvent(input.orgId, "agent.key_created", input.eventId, data);
      break;
    default: {
      const exhaustive: never = input;
      throw new Error(`unhandled agent event: ${String(exhaustive)}`);
    }
  }
  void dispatch
    .then((result) => {
      if (!result.ok) throw new Error("agent webhook dispatch failed");
    })
    .catch(() => {
      logger.error(
        { eventType: input.eventType, agentId: input.agentId },
        "Agent lifecycle notification failed",
      );
      Sentry.captureMessage("agent_lifecycle_notification_failed", {
        level: "error",
        tags: { subsystem: "webhooks", event_type: input.eventType },
      });
    });
}

/** Best-effort latency hint; the scheduled drainer remains authoritative. */
let promptDrainScheduled = false;
export function hintAgentWebhookDrain(): void {
  if (promptDrainScheduled) return;
  promptDrainScheduled = true;
  queueMicrotask(() => {
    void processAgentWebhookOutbox().catch(() => {
      logger.error('Agent webhook prompt drain failed; scheduled recovery remains pending');
      Sentry.captureMessage('agent_webhook_prompt_drain_failed', {
        level: 'error', tags: { subsystem: 'webhooks' },
      });
    }).finally(() => {
      promptDrainScheduled = false;
    });
  });
}
