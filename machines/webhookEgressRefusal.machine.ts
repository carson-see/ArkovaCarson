/**
 * SCRUM-4983 — the webhook delivery lifecycle once the outbound socket is
 * IP-pinned (`services/worker/src/webhooks/egress.ts`).
 *
 * The PR adds a genuinely new terminal edge to a lifecycle that had no
 * `.machine.ts`: a refusal from the pinned layer (`private_target`,
 * `unresolvable`, `scheme_not_allowed`, `invalid_url`, `redirect_invalid`) is
 * PERMANENT — same URL, same answer — so it must skip the retry ladder, open no
 * socket, and dead-letter in one attempt. Everything else (receiver 5xx,
 * timeout, reset) stays on the ladder.
 *
 * `dlqKind` deliberately carries a value the database CANNOT store. Migration
 * 0338 ships `CHECK (failure_kind IN ('http_delivery', 'log_write'))`, live on
 * prod, and the DLQ write is a PostgREST upsert whose rejection arrives in
 * `{ error }` rather than as a throw — so a third value loses the audit row
 * silently. `dlqKindSatisfiesMigration0338Check` is the ratchet: reintroducing
 * `failure_kind: 'egress_refused'` without a migration widening the CHECK makes
 * `check` fail here rather than in prod.
 *
 * One domain element is one in-flight delivery of one event to one endpoint.
 * The three-rung ladder (A1/A2/AMAX) stands in for MAX_RETRIES = 5: the model
 * proves the SHAPE of the ladder, not its depth.
 */
import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
  or,
  not,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
} from "tla-precheck";

const status = variable("status");
const attempt = variable("attempt");
const refusedAtPinnedLayer = variable("refusedAtPinnedLayer");
const lastAttemptOpenedSocket = variable("lastAttemptOpenedSocket");
const dlqKind = variable("dlqKind");

/** Delivery is still live and schedulable (initial attempt or a queued retry). */
const live = (d: string) =>
  or(
    eq(index(status, param(d)), lit("PENDING")),
    eq(index(status, param(d)), lit("RETRYING")),
  );

export const webhookEgressRefusalMachine = defineMachine({
  version: 2,
  moduleName: "WebhookEgressRefusal",
  variables: {
    status: mapVar(
      "Deliveries",
      enumType("PENDING", "RETRYING", "SUCCESS", "FAILED"),
      lit("PENDING"),
    ),
    attempt: mapVar("Deliveries", enumType("A1", "A2", "AMAX"), lit("A1")),
    refusedAtPinnedLayer: mapVar("Deliveries", boolType(), lit(false)),
    lastAttemptOpenedSocket: mapVar("Deliveries", boolType(), lit(false)),
    dlqKind: mapVar(
      "Deliveries",
      // EGRESS_REFUSED is representable ON PURPOSE so the invariant below can
      // forbid it. The database CHECK permits only the first three.
      enumType("NONE", "HTTP_DELIVERY", "LOG_WRITE", "EGRESS_REFUSED"),
      lit("NONE"),
    ),
  },
  actions: {
    /** delivery_log insert failed persistently — SCRUM-2244 audit backstop. */
    logWriteFails: {
      params: { d: "Deliveries" },
      guard: eq(index(status, param("d")), lit("PENDING")),
      updates: [
        setMap("status", param("d"), lit("FAILED")),
        setMap("dlqKind", param("d"), lit("LOG_WRITE")),
      ],
    },

    /**
     * The pinned layer refused the destination before any socket was opened.
     * Terminal in ONE attempt, whatever rung the ladder was on.
     */
    refuseAtPinnedLayer: {
      params: { d: "Deliveries" },
      guard: live("d"),
      updates: [
        setMap("refusedAtPinnedLayer", param("d"), lit(true)),
        setMap("lastAttemptOpenedSocket", param("d"), lit(false)),
        setMap("status", param("d"), lit("FAILED")),
        // Schema-legal kind; the reason rides in error_message.
        setMap("dlqKind", param("d"), lit("HTTP_DELIVERY")),
      ],
    },

    /** Receiver accepted (any 2xx, 204 No Content included). */
    dispatchAccepted: {
      params: { d: "Deliveries" },
      guard: live("d"),
      updates: [
        setMap("lastAttemptOpenedSocket", param("d"), lit(true)),
        setMap("status", param("d"), lit("SUCCESS")),
      ],
    },

    /** Receiver/network failure with ladder left — schedule a retry. */
    dispatchTransientFailureFromA1: {
      params: { d: "Deliveries" },
      guard: and(live("d"), eq(index(attempt, param("d")), lit("A1"))),
      updates: [
        setMap("lastAttemptOpenedSocket", param("d"), lit(true)),
        setMap("status", param("d"), lit("RETRYING")),
        setMap("attempt", param("d"), lit("A2")),
      ],
    },
    dispatchTransientFailureFromA2: {
      params: { d: "Deliveries" },
      guard: and(live("d"), eq(index(attempt, param("d")), lit("A2"))),
      updates: [
        setMap("lastAttemptOpenedSocket", param("d"), lit(true)),
        setMap("status", param("d"), lit("RETRYING")),
        setMap("attempt", param("d"), lit("AMAX")),
      ],
    },

    /** Ladder exhausted — terminal failure, dead-lettered. */
    dispatchFinalFailure: {
      params: { d: "Deliveries" },
      guard: and(live("d"), eq(index(attempt, param("d")), lit("AMAX"))),
      updates: [
        setMap("lastAttemptOpenedSocket", param("d"), lit(true)),
        setMap("status", param("d"), lit("FAILED")),
        setMap("dlqKind", param("d"), lit("HTTP_DELIVERY")),
      ],
    },
  },
  invariants: {
    refusalIsTerminal: {
      description:
        "A pinned-layer refusal never leaves the delivery on the retry ladder — same URL, same answer, so RETRYING is never a legal state for a refused delivery",
      formula: forall("Deliveries", "d",
        or(
          not(index(refusedAtPinnedLayer, param("d"))),
          eq(index(status, param("d")), lit("FAILED")),
        ),
      ),
    },
    refusalNeverOpensASocket: {
      description:
        "The attempt that was refused opened no socket — the whole point of resolving, validating and pinning before connect",
      formula: forall("Deliveries", "d",
        or(
          not(index(refusedAtPinnedLayer, param("d"))),
          not(index(lastAttemptOpenedSocket, param("d"))),
        ),
      ),
    },
    terminalFailureIsAlwaysDeadLettered: {
      description:
        "Every FAILED delivery has a dead-letter row — the audit-integrity backstop holds on the refusal path too, not just the HTTP path",
      formula: forall("Deliveries", "d",
        or(
          not(eq(index(status, param("d")), lit("FAILED"))),
          not(eq(index(dlqKind, param("d")), lit("NONE"))),
        ),
      ),
    },
    acceptedDeliveryIsNeverDeadLettered: {
      description:
        "A delivery the receiver accepted never lands in the DLQ — the 204 regression (an accepted delivery classified as a transient network error) is exactly this invariant failing",
      formula: forall("Deliveries", "d",
        or(
          not(eq(index(status, param("d")), lit("SUCCESS"))),
          eq(index(dlqKind, param("d")), lit("NONE")),
        ),
      ),
    },
    dlqKindSatisfiesMigration0338Check: {
      description:
        "failure_kind stays inside migration 0338's CHECK (http_delivery, log_write) — a value the CHECK rejects is dropped silently by the PostgREST upsert, so the audit row is lost",
      formula: forall("Deliveries", "d",
        not(eq(index(dlqKind, param("d")), lit("EGRESS_REFUSED"))),
      ),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      // SUCCESS and FAILED are by-design terminal: a delivery that has been
      // acknowledged or dead-lettered is DONE, so a state where every delivery
      // is terminal has no successor. That is the intended end state, not a
      // liveness bug — TLC's deadlock check is off, same as partnerProvisioning
      // and drainRunAccounting.
      equivalence: {
        domains: { Deliveries: ids({ prefix: "d", size: 1 }) },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
      },
      pr: {
        domains: { Deliveries: ids({ prefix: "d", size: 2 }) },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
      },
      nightly: {
        // Above the graph-equivalence cap at this domain size, so equivalence
        // is proven by the `pr`/`equivalence` tiers and this tier is TLC-only.
        graphEquivalence: false,
        domains: { Deliveries: ids({ prefix: "d", size: 3 }) },
        budgets: { maxEstimatedStates: 10_000_000 },
        checks: { deadlock: false },
      },
    },
  },
});

export default webhookEgressRefusalMachine;
