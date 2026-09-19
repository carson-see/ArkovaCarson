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
const claimOwner = variable("claimOwner");
const claimedByOrdinaryBatch = variable("claimedByOrdinaryBatch");
const debitEverApplied = variable("debitEverApplied");
const funding = variable("funding");
const job = variable("job");

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
      enumType("STAGED", "QUEUED", "NEEDS_CREDIT", "CLAIMED", "JOURNALED", "SUBMITTED", "HELD", "RETRYABLE", "FAILED"),
      lit("STAGED"),
    ),
    action: mapVar("Intents", enumType("UNDECIDED", "QUEUE", "INSTANT"), lit("UNDECIDED")),
    credit: mapVar("Intents", enumType("NONE", "RESERVED", "SPENT", "REFUNDED"), lit("NONE")),
    matchingDebit: mapVar("Intents", boolType(), lit(false)),
    journal: mapVar("Intents", boolType(), lit(false)),
    broadcastObserved: mapVar("Intents", boolType(), lit(false)),
    claimOwner: mapVar("Intents", optionType(domainType("Workers")), lit(null)),
    claimedByOrdinaryBatch: mapVar("Intents", boolType(), lit(false)),
    debitEverApplied: mapVar("Intents", boolType(), lit(false)),
    funding: mapVar("Intents", enumType("EMPTY", "PREEXISTING", "PURCHASED"), lit("EMPTY")),
    job: mapVar("Intents", enumType("NONE", "INITIAL", "REARMED"), lit("NONE")),
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
        setMap("job", param("i"), lit("INITIAL")),
      ],
    },
    fundBeforeSubmit: {
      params: { i: "Intents" },
      guard: eq(index(phase, param("i")), lit("STAGED")),
      updates: [setMap("funding", param("i"), lit("PREEXISTING"))],
    },
    claimInsufficientCredit: {
      params: { i: "Intents", w: "Workers" },
      guard: and(
        eq(index(phase, param("i")), lit("QUEUED")),
        eq(index(action, param("i")), lit("INSTANT")),
        not(eq(index(job, param("i")), lit("NONE"))),
        eq(index(funding, param("i")), lit("EMPTY")),
        eq(index(claimOwner, param("i")), lit(null)),
      ),
      updates: [
        setMap("phase", param("i"), lit("NEEDS_CREDIT")),
        setMap("job", param("i"), lit("NONE")),
      ],
    },
    purchaseCredit: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("NEEDS_CREDIT")),
        not(index(debitEverApplied, param("i"))),
        eq(index(credit, param("i")), lit("NONE")),
      ),
      updates: [
        setMap("funding", param("i"), lit("PURCHASED")),
      ],
    },
    rearmAfterPurchase: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("NEEDS_CREDIT")),
        eq(index(funding, param("i")), lit("PURCHASED")),
        not(index(debitEverApplied, param("i"))),
        eq(index(claimOwner, param("i")), lit(null)),
        eq(index(job, param("i")), lit("NONE")),
        eq(index(credit, param("i")), lit("NONE")),
        not(index(journal, param("i"))),
        not(index(broadcastObserved, param("i"))),
      ),
      updates: [
        setMap("phase", param("i"), lit("QUEUED")),
        setMap("job", param("i"), lit("REARMED")),
      ],
    },
    claimAndReserveExact: {
      params: { i: "Intents", w: "Workers" },
      guard: and(
        eq(index(phase, param("i")), lit("QUEUED")),
        eq(index(action, param("i")), lit("INSTANT")),
        not(eq(index(job, param("i")), lit("NONE"))),
        not(eq(index(funding, param("i")), lit("EMPTY"))),
        eq(index(claimOwner, param("i")), lit(null)),
      ),
      updates: [
        setMap("phase", param("i"), lit("CLAIMED")),
        setMap("credit", param("i"), lit("RESERVED")),
        setMap("matchingDebit", param("i"), lit(true)),
        setMap("claimOwner", param("i"), param("w")),
        setMap("debitEverApplied", param("i"), lit(true)),
        setMap("funding", param("i"), lit("EMPTY")),
        setMap("job", param("i"), lit("NONE")),
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
        setMap("phase", param("i"), lit("FAILED")),
        setMap("credit", param("i"), lit("REFUNDED")),
        setMap("matchingDebit", param("i"), lit(false)),
        setMap("claimOwner", param("i"), lit(null)),
        setMap("funding", param("i"), lit("PREEXISTING")),
        setMap("job", param("i"), lit("NONE")),
      ],
    },
    retryWithoutPriorDebit: {
      params: { i: "Intents" },
      guard: and(
        eq(index(phase, param("i")), lit("RETRYABLE")),
        eq(index(credit, param("i")), lit("NONE")),
        not(index(debitEverApplied, param("i"))),
      ),
      updates: [
        setMap("phase", param("i"), lit("QUEUED")),
        setMap("job", param("i"), lit("INITIAL")),
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
        not(eq(index(credit, param("i")), lit("REFUNDED"))),
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
      description: "A live instant claim is represented by exactly one persisted worker owner",
      formula: forall("Intents", "i", or(
        not(eq(index(phase, param("i")), lit("CLAIMED"))),
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
    needsCreditHasNoDebit: {
      description: "An insufficient-credit intent has never reserved or debited credit",
      formula: forall("Intents", "i", or(
        not(eq(index(phase, param("i")), lit("NEEDS_CREDIT"))),
        and(
          eq(index(credit, param("i")), lit("NONE")),
          not(index(debitEverApplied, param("i"))),
        ),
      )),
    },
    rearmRequiresPurchase: {
      description: "Only a purchased, never-debited insufficient-credit intent can be explicitly rearmed",
      formula: forall("Intents", "i", or(
        not(eq(index(job, param("i")), lit("REARMED"))),
        eq(index(funding, param("i")), lit("PURCHASED")),
      )),
    },
    queuedInstantHasDurableJob: {
      description: "Every queued instant intent has a durable job available",
      formula: forall("Intents", "i", or(
        not(and(
          eq(index(phase, param("i")), lit("QUEUED")),
          eq(index(action, param("i")), lit("INSTANT")),
        )),
        not(eq(index(job, param("i")), lit("NONE"))),
      )),
    },
    refundedAttemptIsTerminal: {
      description: "A safely refunded attempt is terminal and cannot be rearmed",
      formula: forall("Intents", "i", or(
        not(eq(index(credit, param("i")), lit("REFUNDED"))),
        eq(index(phase, param("i")), lit("FAILED")),
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
