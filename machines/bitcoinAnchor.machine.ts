import {
  defineMachine,
  enumType,
  optionType,
  boolType,
  eq,
  and,
  not,
  or,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
  isin,
  setOf
} from "tla-precheck";

// Variable references for use in expressions
const status = variable("status");
const chainTxId = variable("chainTxId");
const fingerprintLocked = variable("fingerprintLocked");
const metadataLocked = variable("metadataLocked");
const legalHold = variable("legalHold");
const credentialTypeLocked = variable("credentialTypeLocked");
const actor = variable("actor");

export const bitcoinAnchorMachine = defineMachine({
  version: 3,
  moduleName: "BitcoinAnchor",

  variables: {
    // Core anchor lifecycle status
    // PENDING = just created, awaiting chain submission
    // SUBMITTED = worker has broadcast to mempool (tx unconfirmed)
    // SECURED = chain_tx_id confirmed on-chain (check-confirmations cron)
    // REVOKED = org admin revoked (terminal)
    status: mapVar(
      "Anchors",
      enumType("PENDING", "SUBMITTED", "SECURED", "REVOKED"),
      lit("PENDING")
    ),

    // Whether chain_tx_id is set (non-null)
    // null = no tx, "has_tx" = valid chain_tx_id present
    chainTxId: mapVar(
      "Anchors",
      optionType(enumType("has_tx")),
      lit(null)
    ),

    // Once an anchor leaves PENDING, its fingerprint is immutable
    fingerprintLocked: mapVar("Anchors", boolType(), lit(false)),

    // Once SECURED, metadata becomes immutable
    metadataLocked: mapVar("Anchors", boolType(), lit(false)),

    // TLA-01: credential_type is immutable once anchor leaves PENDING
    credentialTypeLocked: mapVar("Anchors", boolType(), lit(false)),

    // Legal hold flag — blocks revocation
    legalHold: mapVar("Anchors", boolType(), lit(false)),

    // Who is performing the action: "client" or "worker"
    // Enforces that only worker can transition to SUBMITTED/SECURED
    actor: mapVar(
      "Anchors",
      enumType("client", "worker"),
      lit("client")
    )
  },

  actions: {
    // Worker broadcasts a PENDING anchor to the mempool.
    // Maps to: processAnchor() in jobs/anchor.ts, processBatchAnchors() in jobs/batch-anchor.ts
    // Result: PENDING → SUBMITTED, chain_tx_id set, fingerprint locked
    workerBroadcast: {
      params: { a: "Anchors" },
      guard: eq(index(status, param("a")), lit("PENDING")),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
        setMap("actor", param("a"), lit("worker")),
        setMap("chainTxId", param("a"), lit("has_tx")),
        setMap("fingerprintLocked", param("a"), lit(true)),
        setMap("credentialTypeLocked", param("a"), lit(true))
      ]
    },

    // Cron confirms a SUBMITTED anchor after on-chain confirmation.
    // Maps to: checkConfirmations() in jobs/check-confirmations.ts
    // Result: SUBMITTED → SECURED, metadata locked
    chainConfirm: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SUBMITTED")),
        eq(index(actor, param("a")), lit("worker")),
        eq(index(chainTxId, param("a")), lit("has_tx"))
      ),
      updates: [
        setMap("status", param("a"), lit("SECURED")),
        setMap("metadataLocked", param("a"), lit(true))
      ]
    },

    // Chain submission fails — anchor returns to PENDING for retry.
    // Maps to: processAnchor() error path, or tx dropped from mempool
    chainSubmitFail: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SUBMITTED")),
        eq(index(actor, param("a")), lit("worker"))
      ),
      updates: [
        setMap("status", param("a"), lit("PENDING")),
        setMap("chainTxId", param("a"), lit(null)),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(false)),
        setMap("credentialTypeLocked", param("a"), lit(false))
      ]
    },

    // Org admin revokes a SECURED anchor (not under legal hold)
    revoke: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SECURED")),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("REVOKED"))
      ]
    },

    // Admin places legal hold (on SECURED or REVOKED anchors)
    placeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED"))),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(true))
      ]
    },

    // Admin removes legal hold (on SECURED or REVOKED anchors)
    removeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED"))),
        index(legalHold, param("a"))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(false))
      ]
    }
  },

  invariants: {
    // INV-1: SECURED anchors MUST have a chain_tx_id
    securedRequiresChainTx: {
      description: "A document cannot be SECURED without a valid chain_tx_id",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("SECURED"))),
          eq(index(chainTxId, param("a")), lit("has_tx"))
        )
      )
    },

    // INV-1b: SUBMITTED anchors MUST have a chain_tx_id (broadcast already happened)
    submittedRequiresChainTx: {
      description: "A document cannot be SUBMITTED without a valid chain_tx_id",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("SUBMITTED"))),
          eq(index(chainTxId, param("a")), lit("has_tx"))
        )
      )
    },

    // INV-2: Fingerprint is locked once anchor leaves PENDING
    fingerprintImmutableAfterPending: {
      description: "Fingerprint is immutable once status leaves initial PENDING",
      formula: forall("Anchors", "a",
        or(
          eq(index(status, param("a")), lit("PENDING")),
          index(fingerprintLocked, param("a"))
        )
      )
    },

    // INV-3: REVOKED is terminal — no transitions out
    revokedIsTerminal: {
      description: "REVOKED is a terminal state with no outbound transitions",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("REVOKED"))),
          eq(index(chainTxId, param("a")), lit("has_tx"))
        )
      )
    },

    // INV-4: Metadata is locked once SECURED
    metadataImmutableAfterSecured: {
      description: "Metadata is immutable once anchor is SECURED or REVOKED",
      formula: forall("Anchors", "a",
        or(
          not(isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED")))),
          index(metadataLocked, param("a"))
        )
      )
    },

    // INV-5: Only worker actor can reach SECURED
    onlyWorkerSecures: {
      description: "No direct client transition to SECURED — worker-only via service_role",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("SECURED"))),
          eq(index(actor, param("a")), lit("worker"))
        )
      )
    },

    // INV-7: credential_type is locked once anchor leaves PENDING (TLA-01)
    credentialTypeImmutableAfterPending: {
      description: "credential_type is immutable once status leaves initial PENDING",
      formula: forall("Anchors", "a",
        or(
          eq(index(status, param("a")), lit("PENDING")),
          index(credentialTypeLocked, param("a"))
        )
      )
    },

    // INV-6: Legal hold blocks revocation transition
    legalHoldPreventsSecuredToRevoked: {
      description: "SECURED anchors under legal hold remain SECURED (guard blocks revoke)",
      formula: forall("Anchors", "a",
        or(
          not(index(legalHold, param("a"))),
          not(eq(index(status, param("a")), lit("PENDING")))
        )
      )
    }
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Anchors: ids({ prefix: "a", size: 2 })
        },
        budgets: {
          maxEstimatedStates: 100_000,
          maxEstimatedBranching: 10_000
        }
      },
      nightly: {
        domains: {
          Anchors: ids({ prefix: "a", size: 3 })
        },
        budgets: {
          maxEstimatedStates: 100_000,
          maxEstimatedBranching: 10_000
        }
      }
    }
  },

  metadata: {
    ownedTables: ["anchors"],
    ownedColumns: {
      anchors: ["status", "chain_tx_id", "legal_hold", "credential_type"]
    },
    runtimeAdapter: {
      schema: "public",
      table: "anchors",
      rowDomain: "Anchors",
      keyColumn: "id",
      keySqlType: "uuid"
    }
  }
});

export default bitcoinAnchorMachine;
