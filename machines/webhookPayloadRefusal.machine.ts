/**
 * Webhook payload refusal (SCRUM-3982, CTO review ruling Z1).
 *
 * The banned-field ratchet has to hold on every path a payload can leave the
 * process, and it introduced a NEW terminal transition into a queue that has
 * per-resource head-of-line ordering. Both halves of that are worth proving
 * rather than reasoning about, because they pull against each other:
 *
 *   SAFETY    A payload carrying a banned field is never delivered — not on
 *             first dispatch, not on replay, not on a retry sweep.
 *   LIVENESS  A refusal is PERMANENT (the stored bytes do not change), so a
 *             refused row must LEAVE the retry state. If it stays `retrying`
 *             it is re-read every sweep forever AND, because the sweep only
 *             advances the lowest-sequence row per resource, it blocks every
 *             newer event for that resource permanently. "Refuse and return
 *             false" — the obvious implementation — is exactly this bug.
 *
 * Modelled as safety: `refusalIsTerminal` says an evaluated refused delivery
 * is never still in `RETRYING`, which is the head-of-line freedom property
 * expressed as a state predicate. Removing the `status := TERMINATED` write
 * from processWebhookRetries violates it.
 *
 * Deliberately small. One delivery row per domain element, no attempt counter
 * (the count is irrelevant to both properties — a refusal does not consume an
 * attempt, it ends the row), no endpoint domain (refusal happens before the
 * endpoint is contacted).
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
const carriesBannedField = variable("carriesBannedField");
const evaluated = variable("evaluated");

export const webhookPayloadRefusalMachine = defineMachine({
  version: 2,
  moduleName: "WebhookPayloadRefusal",
  variables: {
    /**
     * NEW      → not yet dispatched.
     * RETRYING → a `webhook_delivery_logs` row awaiting the sweep.
     * DELIVERED→ signed and sent to the customer endpoint.
     * TERMINATED → `status='failed'` with the refusal reason; leaves the
     *              sweep's `status='retrying'` filter, so the next event for
     *              the resource becomes the head.
     */
    status: mapVar(
      "Deliveries",
      enumType("NEW", "RETRYING", "DELIVERED", "TERMINATED"),
      lit("NEW"),
    ),
    /**
     * Whether the payload contains a key the outbound ban list refuses. Set at
     * enqueue and never changed: the bytes in `webhook_delivery_logs.payload`
     * are frozen, which is precisely why a refusal is permanent.
     */
    carriesBannedField: mapVar("Deliveries", boolType(), lit(false)),
    /** The row has been inspected by a sweep or a replay at least once. */
    evaluated: mapVar("Deliveries", boolType(), lit(false)),
  },
  actions: {
    /** First dispatch of a clean payload — validation passes, row persisted. */
    enqueueClean: {
      params: { d: "Deliveries" },
      guard: eq(index(status, param("d")), lit("NEW")),
      updates: [
        setMap("status", param("d"), lit("RETRYING")),
        setMap("carriesBannedField", param("d"), lit(false)),
      ],
    },
    /**
     * A row that carries a banned field is already in the queue. This is not
     * hypothetical: every delivery log written before the ratchet landed took
     * this shape, and `attestation.created` rows carried `fingerprint`. The
     * model admits them so the properties are about what the RETRY and REPLAY
     * paths do, not only about what first dispatch refuses.
     */
    enqueueLegacyLeaky: {
      params: { d: "Deliveries" },
      guard: eq(index(status, param("d")), lit("NEW")),
      updates: [
        setMap("status", param("d"), lit("RETRYING")),
        setMap("carriesBannedField", param("d"), lit(true)),
      ],
    },
    /** Sweep picks the row, validation passes, it is signed and sent. */
    sweepDeliver: {
      params: { d: "Deliveries" },
      guard: and(
        eq(index(status, param("d")), lit("RETRYING")),
        not(index(carriesBannedField, param("d"))),
      ),
      updates: [
        setMap("status", param("d"), lit("DELIVERED")),
        setMap("evaluated", param("d"), lit(true)),
      ],
    },
    /**
     * Sweep picks the row and `validateWebhookPayload` refuses it. The row is
     * TERMINATED, not left in RETRYING — that write is the whole point of this
     * action and of `refusalIsTerminal` below.
     */
    sweepRefuse: {
      params: { d: "Deliveries" },
      guard: and(
        eq(index(status, param("d")), lit("RETRYING")),
        index(carriesBannedField, param("d")),
      ),
      updates: [
        setMap("status", param("d"), lit("TERMINATED")),
        setMap("evaluated", param("d"), lit(true)),
      ],
    },
    /**
     * `POST /webhooks/deliveries/:id/replay` on a row that has already been
     * refused and terminated. It must stay refused — a terminated row is not a
     * second chance to deliver the same bytes.
     */
    replayTerminated: {
      params: { d: "Deliveries" },
      guard: and(
        eq(index(status, param("d")), lit("TERMINATED")),
        index(carriesBannedField, param("d")),
      ),
      updates: [setMap("evaluated", param("d"), lit(true))],
    },
    /** Replay of a delivered clean row — allowed, re-signs the same bytes. */
    replayDelivered: {
      params: { d: "Deliveries" },
      guard: and(
        eq(index(status, param("d")), lit("DELIVERED")),
        not(index(carriesBannedField, param("d"))),
      ),
      updates: [setMap("evaluated", param("d"), lit(true))],
    },
  },
  invariants: {
    bannedFieldNeverDelivered: {
      description:
        "A payload carrying a banned field is never DELIVERED, by any path — first dispatch, replay, or retry sweep (CLAUDE.md §6 + §1.6)",
      formula: forall("Deliveries", "d",
        or(
          not(index(carriesBannedField, param("d"))),
          not(eq(index(status, param("d")), lit("DELIVERED"))),
        ),
      ),
    },
    refusalIsTerminal: {
      description:
        "Once a refused delivery has been evaluated it is never still RETRYING — a permanent refusal left in the retry state is re-read every sweep forever and head-of-line-blocks every newer event for the same resource",
      formula: forall("Deliveries", "d",
        or(
          not(and(
            index(evaluated, param("d")),
            index(carriesBannedField, param("d")),
          )),
          not(eq(index(status, param("d")), lit("RETRYING"))),
        ),
      ),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      equivalence: {
        domains: { Deliveries: ids({ prefix: "d", size: 1 }) },
        graphEquivalence: true,
        budgets: { maxEstimatedStates: 100_000 },
      },
      pr: {
        domains: { Deliveries: ids({ prefix: "d", size: 3 }) },
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 1_000_000 },
      },
    },
  },
});
export default webhookPayloadRefusalMachine;
