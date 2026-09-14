import {
  defineMachine,
  enumType,
  boolType,
  optionType,
  domainType,
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

const phase = variable("phase");
const action = variable("action");
const credit = variable("credit");
const matchingDebit = variable("matchingDebit");
const journal = variable("journal");
const broadcastObserved = variable("broadcastObserved");
const claimed = variable("claimed");
const claimOwner = variable("claimOwner");
const claimedByOrdinaryBatch = variable("claimedByOrdinaryBatch");
const debitEverApplied = variable("debitEverApplied");
const refundEverApplied = variable("refundEverApplied");

/**
 * SCRUM-5139 manual instant-secure intent.
 *
 * This is a design model rather than an adapter-owned machine: the runtime
 * transition spans anchors, private tags, job_queue, a credit ledger, and the
 * existing txid journal. The implementation must keep each named transition
 * atomic at its database boundary.
 */
export const instantSecureIntentMachine = defineMachine({
  version: 2,
  moduleName: "InstantSecureIntent",
  variables: {
    phase: mapVar(
      "Intents",
      enumType("STAGED", "QUEUED", "CLAIMED", "JOURNALED", "SUBMITTED", "HELD", "RETRYABLE", "FAILED"),
      lit("STAGED"),
    ),
    action: mapVar("Intents", enumType("UNDECIDED", "QUEUE", "INSTANT"), lit("UNDECIDED")),
    credit: mapVar("Intents", enumType("NONE", "RESERVED", "SPENT", "REFUNDED"), lit("NONE")),
    matchingDebit: mapVar("Intents", boolType(), lit(false)),
    journal: mapVar("Intents", boolType(), lit(false)),
    broadcastObserved: mapVar("Intents", boolType(), lit(false)),
    claimed: mapVar("Intents", boolType(), lit(false)),
    claimOwner: mapVar("Intents", optionType(domainType("Workers")), lit(null)),
    claimedByOrdinaryBatch: mapVar("Intents", boolType(), lit(false)),
    debitEverApplied: mapVar("Intents", boolType(), lit(false)),
    refundEverApplied: mapVar("Intents", boolType(), lit(false)),
  },
  actions: {
    chooseQueue: {
      params: { i: "Intents" },
      guard: eq(index(phase, param("i")), lit("STAGED")),
      updates: [
        setMap("phase", param("i"), lit("QUEUED")),
        setMap("action", param("i"), lit("QUEUE")),
      ],
    },
    enqueueInstant: {
      params: { i: "Intents" },
      guard: eq(index(phase, param("i")), lit("STAGED")),
      updates: [
        setMap("phase", param("i"), lit("QUEUED")),
        setMap("action", param("i"), lit("INSTANT")),
      ],
    },
    claimAndReserveExact: {
      params: { i: "Intents", w: "Workers" },
      guard: and(
        eq(index(phase, param("i")), lit("QUEUED")),
        eq(index(action, param("i")), lit("INSTANT")),
        not(index(claimed, param("i"))),
        eq(index(claimOwner, param("i")), lit(null)),
      ),
      updates: [
        setMap("phase", param("i"), lit("CLAIMED")),
        setMap("credit", param("i"), lit("RESERVED")),
        setMap("matchingDebit", param("i"), lit(true)),
        setMap("claimed", param("i"), lit(true)),
        setMap("claimOwner", param("i"), param("w")),
        setMap("debitEverApplied", param("i"), lit(true)),
      ],
    },
    ordinaryQueueClaim: {
      params: { i: "Intents", w: "Workers" },
      guard: and(
        eq(index(phase, param("i")), lit("QUEUED")),
        eq(index(action, param("i")), lit("QUEUE")),
        eq(index(claimOwner, param("i")), lit(null)),
      ),
      updates: [
        setMap("claimed", param("i"), lit(true)),
        setMap("claimOwner", param("i"), param("w")),
        setMap("claimedByOrdinaryBatch", param("i"), lit(true)),
      ],
    },
    persistJournal: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("CLAIMED")),
        eq(index(credit, param("i")), lit("RESERVED")),
        not(index(journal, param("i"))),
      ),
      updates: [
        setMap("phase", param("i"), lit("JOURNALED")),
        setMap("journal", param("i"), lit(true)),
      ],
    },
    broadcast: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("JOURNALED")),
        index(journal, param("i")),
        eq(index(credit, param("i")), lit("RESERVED")),
      ),
      updates: [setMap("broadcastObserved", param("i"), lit(true))],
    },
    finalizeSubmitted: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("JOURNALED")),
        index(broadcastObserved, param("i")),
      ),
      updates: [
        setMap("phase", param("i"), lit("SUBMITTED")),
        setMap("credit", param("i"), lit("SPENT")),
        setMap("claimed", param("i"), lit(false)),
        setMap("claimOwner", param("i"), lit(null)),
      ],
    },
    holdAmbiguous: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("JOURNALED")),
        index(journal, param("i")),
      ),
      updates: [
        setMap("phase", param("i"), lit("HELD")),
        setMap("claimed", param("i"), lit(false)),
        setMap("claimOwner", param("i"), lit(null)),
      ],
    },
    adoptHeld: {
      params: { i: "Intents" },
      guard: eq(index(phase, param("i")), lit("HELD")),
      updates: [
        setMap("phase", param("i"), lit("SUBMITTED")),
        setMap("credit", param("i"), lit("SPENT")),
        setMap("broadcastObserved", param("i"), lit(true)),
      ],
    },
    rejectBeforeJournalAndRefund: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("CLAIMED")),
        eq(index(credit, param("i")), lit("RESERVED")),
        index(matchingDebit, param("i")),
        not(index(journal, param("i"))),
        not(index(broadcastObserved, param("i"))),
      ),
      updates: [
        setMap("phase", param("i"), lit("RETRYABLE")),
        setMap("credit", param("i"), lit("REFUNDED")),
        setMap("matchingDebit", param("i"), lit(false)),
        setMap("claimed", param("i"), lit(false)),
        setMap("claimOwner", param("i"), lit(null)),
        setMap("refundEverApplied", param("i"), lit(true)),
      ],
    },
    retryWithNewAttempt: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("RETRYABLE")),
        eq(index(credit, param("i")), lit("REFUNDED")),
      ),
      updates: [
        setMap("phase", param("i"), lit("QUEUED")),
        setMap("credit", param("i"), lit("NONE")),
      ],
    },
    failRetryable: {
      params: { i: "Intents" },
      guard: eq(index(phase, param("i")), lit("RETRYABLE")),
      updates: [setMap("phase", param("i"), lit("FAILED"))],
    },
  },
  invariants: {
    queueNeverConsumesCredit: {
      description: "The free queue choice never reserves, spends, or refunds a credit",
      formula: forall("Intents", "i", or(
        not(eq(index(action, param("i")), lit("QUEUE"))),
        eq(index(credit, param("i")), lit("NONE")),
      )),
    },
    refundRequiresMatchingDebit: {
      description: "A refund can only result from a prior matching reservation",
      formula: forall("Intents", "i", or(
        not(index(refundEverApplied, param("i"))),
        index(debitEverApplied, param("i")),
      )),
    },
    journalOrBroadcastNeverRefunded: {
      description: "Journaled or possibly broadcast work is never refunded",
      formula: forall("Intents", "i", or(
        and(not(index(journal, param("i"))), not(index(broadcastObserved, param("i")))),
        not(eq(index(credit, param("i")), lit("REFUNDED"))),
      )),
    },
    broadcastRequiresJournal: {
      description: "No external broadcast is possible before durable txid journal evidence",
      formula: forall("Intents", "i", or(
        not(index(broadcastObserved, param("i"))),
        index(journal, param("i")),
      )),
    },
    exclusiveClaim: {
      description: "A claimed instant attempt has one persisted worker owner",
      formula: forall("Intents", "i", or(
        not(index(claimed, param("i"))),
        not(eq(index(claimOwner, param("i")), lit(null))),
      )),
    },
    ordinaryBatchCannotWinInstantRace: {
      description: "An anchor carrying a live instant intent is never claimed by the ordinary queue consumer",
      formula: forall("Intents", "i", or(
        not(eq(index(action, param("i")), lit("INSTANT"))),
        not(index(claimedByOrdinaryBatch, param("i"))),
      )),
    },
    submittedIsTruthful: {
      description: "A submitted receipt requires observed broadcast and a spent reservation",
      formula: forall("Intents", "i", or(
        not(eq(index(phase, param("i")), lit("SUBMITTED"))),
        and(
          index(broadcastObserved, param("i")),
          eq(index(credit, param("i")), lit("SPENT")),
        ),
      )),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: { Intents: ids({ prefix: "i", size: 1 }), Workers: ids({ prefix: "w", size: 2 }) },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false, graphEquivalence: true },
      },
    },
  },
});
