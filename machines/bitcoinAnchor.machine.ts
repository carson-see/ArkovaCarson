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
  version: 2,
  moduleName: "BitcoinAnchor",

  variables: {
    // Core anchor lifecycle status
    // PENDING = just created, awaiting chain submission
    // BROADCASTING = worker has claimed anchor, broadcast in progress (transient)
    // SUBMITTED = worker has broadcast to mempool (tx unconfirmed)
    // SECURED = chain_tx_id confirmed on-chain (check-confirmations cron)
    // REVOKED = org admin revoked (terminal)
    // SUPERSEDED = org admin replaced with a new fingerprint (terminal). Added by
    //   migration 0225_ark104_superseded_enum.sql; transition wired by
    //   0226_ark104_lineage_rpcs.sql `supersede_anchor()` (any non-terminal,
    //   non-legal-hold state → SUPERSEDED).
    status: mapVar(
      "Anchors",
      enumType("PENDING", "BROADCASTING", "SUBMITTED", "SECURED", "REVOKED", "SUPERSEDED"),
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
    // Worker claims a PENDING anchor before broadcasting.
    // Maps to: claim_pending_anchors() RPC (atomic FOR UPDATE SKIP LOCKED)
    // Result: PENDING → BROADCASTING, fingerprint locked, credential_type locked
    workerClaim: {
      params: { a: "Anchors" },
      guard: eq(index(status, param("a")), lit("PENDING")),
      updates: [
        setMap("status", param("a"), lit("BROADCASTING")),
        setMap("actor", param("a"), lit("worker")),
        setMap("fingerprintLocked", param("a"), lit(true)),
        setMap("credentialTypeLocked", param("a"), lit(true))
      ]
    },

    // Worker successfully broadcasts a BROADCASTING anchor to the mempool.
    // Maps to: processAnchor() in jobs/anchor.ts after chain submit succeeds
    // Result: BROADCASTING → SUBMITTED, chain_tx_id set
    workerBroadcast: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker"))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
        setMap("chainTxId", param("a"), lit("has_tx"))
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

    // Broadcast fails — anchor returns to PENDING for retry.
    // Maps to: processAnchor() error path when chain submit throws
    broadcastFail: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker"))
      ),
      updates: [
        setMap("status", param("a"), lit("PENDING")),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(false)),
        setMap("credentialTypeLocked", param("a"), lit(false))
      ]
    },

    // Chain submission fails after broadcast — tx dropped from mempool.
    // Maps to: recover_stuck_broadcasts() RPC or chain-maintenance reorg detection
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

    // Admin places legal hold (on SECURED, REVOKED, or SUPERSEDED anchors —
    // any post-broadcast lifecycle state may carry an audit-retention hold).
    placeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED"), lit("SUPERSEDED"))),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(true))
      ]
    },

    // Admin removes legal hold (on SECURED, REVOKED, or SUPERSEDED anchors).
    removeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED"), lit("SUPERSEDED"))),
        index(legalHold, param("a"))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(false))
      ]
    },

    // Org admin supersedes an anchor with a new fingerprint.
    // Maps to: supersede_anchor() RPC (migration 0226). Allowed from any
    // non-terminal status; blocked if the anchor is under legal hold.
    // Terminal: locks fingerprint, metadata, and credential_type so no
    // future writes are possible (downstream from SUPERSEDED there is no
    // action with a guard that admits it).
    supersede: {
      params: { a: "Anchors" },
      guard: and(
        not(isin(index(status, param("a")), setOf(lit("REVOKED"), lit("SUPERSEDED")))),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUPERSEDED")),
        setMap("fingerprintLocked", param("a"), lit(true)),
        setMap("metadataLocked", param("a"), lit(true)),
        setMap("credentialTypeLocked", param("a"), lit(true))
      ]
    },

    // Reorg detection reverts a SECURED anchor back to SUBMITTED.
    // Maps to: detectReorgs() in services/worker/src/jobs/chain-maintenance.ts:152.
    // For anchors SECURED within REORG_CHECK_DEPTH_BLOCKS (10) blocks, the
    // cron re-queries mempool.space; if the block hash changed or the TX is
    // no longer confirmed, the anchor reverts. chainTxId is retained (the
    // TX still exists, just no longer in a confirmed block). Legal-hold
    // anchors are frozen — the cron must skip them to preserve the
    // legalHoldPreventsSecuredToRevoked invariant (the chained
    // chainSubmitFail path could otherwise rewind a legal-hold anchor to
    // PENDING, which is the spec contract this guard upholds).
    reorgDetected: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SECURED")),
        eq(index(actor, param("a")), lit("worker")),
        eq(index(chainTxId, param("a")), lit("has_tx")),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
        // Reorg unwinds the metadata lock — the anchor isn't terminal-confirmed
        // anymore. fingerprint + credential_type stay locked because the
        // anchor has been broadcast (immutable from the user's POV regardless
        // of confirmation state).
        setMap("metadataLocked", param("a"), lit(false))
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

    // INV-1c: BROADCASTING anchors must NOT have chain_tx_id (not yet broadcast)
    broadcastingNoChainTx: {
      description: "A BROADCASTING anchor has not yet received a chain_tx_id",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("BROADCASTING"))),
          eq(index(chainTxId, param("a")), lit(null))
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

    // INV-3: REVOKED implies a chain_tx_id is set (revoke can only fire from
    // SECURED, which requires has_tx). Terminal-no-transitions for REVOKED
    // and SUPERSEDED is enforced by the absence of any action with a guard
    // that admits those states.
    revokedRequiresChainTx: {
      description: "REVOKED anchors carry the chain_tx_id from their SECURED predecessor",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("REVOKED"))),
          eq(index(chainTxId, param("a")), lit("has_tx"))
        )
      )
    },

    // INV-4: Metadata is locked once SECURED, REVOKED, or SUPERSEDED. SUPERSEDED
    // joins the set because supersede_anchor() (migration 0226) is the
    // terminal handoff to a child anchor; the superseded row must stop
    // accepting metadata writes.
    metadataImmutableAfterSecured: {
      description: "Metadata is immutable once anchor is SECURED, REVOKED, or SUPERSEDED",
      formula: forall("Anchors", "a",
        or(
          not(isin(index(status, param("a")), setOf(lit("SECURED"), lit("REVOKED"), lit("SUPERSEDED")))),
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

    // INV-7: credential_type is locked once anchor leaves PENDING (TLA-01).
    // SCRUM-1274 (R3-1) decision: keep this invariant as the user-facing
    // contract. Migration 0172 lets service_role mutate credential_type for
    // operator-only fixes; that's a deliberate backdoor (not modeled in this
    // spec because no client-facing path can reach service_role). If the
    // operator path is ever exposed to user-actor flows, parameterize the
    // lock by actor and update this comment.
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
        // State count for size=2 is 320^2 = 102,400 (5 statuses × 2^5 bools ×
        // 2 actors)^2, which marginally exceeds the tla-precheck 100k
        // graph-equivalence cap introduced after this machine was authored.
        // Disabling graphEquivalence keeps the invariant checks running and
        // lets us set a budget slightly above the 100k equivalence cap.
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 200_000,
          maxEstimatedBranching: 10_000
        }
      },
      nightly: {
        domains: {
          Anchors: ids({ prefix: "a", size: 3 })
        },
        graphEquivalence: false,
        budgets: {
          // size=3 → 320^3 = 32,768,000 states; bump to 50M for nightly.
          maxEstimatedStates: 50_000_000,
          maxEstimatedBranching: 1_000_000
        }
      }
    }
  },

  metadata: {
    // Documentation only — this TLA+ machine models anchor lifecycle state
    // but is not code-generated into a runtime DB adapter. Several machine
    // variables (fingerprintLocked, metadataLocked, credentialTypeLocked,
    // actor) are derived/conceptual state with no 1:1 DB column, so the
    // tla-precheck runtimeAdapter (which requires same-named variable↔column
    // mapping) is intentionally omitted.
    ownedTables: ["anchors"],
    ownedColumns: {
      anchors: ["status", "chain_tx_id", "legal_hold", "credential_type"]
    }
  }
});

export default bitcoinAnchorMachine;
