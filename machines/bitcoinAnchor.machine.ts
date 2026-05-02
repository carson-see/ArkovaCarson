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
const actor = variable("actor");
const softDeleted = variable("softDeleted");

// SCRUM-1274 (R3-1) — Confluence audit page covers the rationale for
// version 3 changes: SUPERSEDED + reorgDetected + softDeleted axis added,
// INV-7 (credentialTypeImmutableAfterPending) dropped because migration
// 0172_fix_credential_type_trigger_service_role.sql made service_role
// exempt deliberately for backfill / repair flows. Spec now matches code.
export const bitcoinAnchorMachine = defineMachine({
  // tla-precheck's DSL schema is currently version 2. The SCRUM-1274
  // anchor model revision is documented in the header above.
  version: 2,
  moduleName: "BitcoinAnchor",

  variables: {
    // Core anchor lifecycle status
    // PENDING       = just created, awaiting chain submission
    // BROADCASTING  = worker has claimed anchor, broadcast in progress (transient)
    // SUBMITTED     = worker has broadcast to mempool (tx unconfirmed)
    // SECURED       = chain_tx_id confirmed on-chain (check-confirmations cron)
    // REVOKED       = org admin revoked (terminal)
    // SUPERSEDED    = newer anchor in lineage replaces this one (terminal).
    //                 Maps to: anchor_status enum value added in
    //                 0225_ark104_superseded_enum.sql + supersede_anchor()
    //                 RPC in 0226_ark104_lineage_rpcs.sql.
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

    // Legal hold flag — blocks revocation and supersede
    legalHold: mapVar("Anchors", boolType(), lit(false)),

    // Who is performing the action: "client" or "worker"
    // Enforces that only worker can transition to SUBMITTED/SECURED
    actor: mapVar(
      "Anchors",
      enumType("client", "worker"),
      lit("client")
    ),

    // Soft-delete axis (deleted_at IS NOT NULL). Orthogonal to lifecycle.
    // Maps to: anchor.ts:483 + check-confirmations.ts:340 deleted_at handling.
    // Soft-deleted rows are preserved for audit but excluded from active queries.
    softDeleted: mapVar("Anchors", boolType(), lit(false))
  },

  actions: {
    // Worker claims a PENDING anchor before broadcasting.
    // Maps to: claim_pending_anchors() RPC (atomic FOR UPDATE SKIP LOCKED)
    // Result: PENDING → BROADCASTING, fingerprint locked
    workerClaim: {
      params: { a: "Anchors" },
      guard: eq(index(status, param("a")), lit("PENDING")),
      updates: [
        setMap("status", param("a"), lit("BROADCASTING")),
        setMap("actor", param("a"), lit("worker")),
        setMap("fingerprintLocked", param("a"), lit(true))
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
        setMap("fingerprintLocked", param("a"), lit(false))
      ]
    },

    // Chain submission fails after broadcast — tx dropped from mempool.
    // Maps to: recover_stuck_broadcasts() RPC (operator-initiated reset)
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
        setMap("fingerprintLocked", param("a"), lit(false))
      ]
    },

    // SCRUM-1274: chain reorg flips a SECURED anchor back to SUBMITTED.
    // Triggered when both UTXO providers (mempool.space + blockstream)
    // confirm the tx is no longer in the canonical chain.
    // Maps to: chain-maintenance.ts:152 reorg detection path.
    // Result: SECURED → SUBMITTED, chain_tx_id retained (tx still references
    // a real broadcast; chainConfirm can re-validate after re-org settles).
    // metadataLocked is NOT cleared — the org committed to those values
    // before reorg; subsequent chainConfirm re-secures the same metadata.
    // Legal hold blocks reorg processing — worker must skip held rows so
    // INV-6 (legalHold ⟹ status ≠ PENDING) is preserved through the
    // reorg → chainSubmitFail → PENDING fallback path.
    reorgDetected: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SECURED")),
        eq(index(actor, param("a")), lit("worker")),
        eq(index(chainTxId, param("a")), lit("has_tx")),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED"))
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

    // SCRUM-1274: lineage supersede — newer anchor replaces this one.
    // Maps to: supersede_anchor() RPC in 0226_ark104_lineage_rpcs.sql,
    // which writes status='SUPERSEDED' from any non-terminal lifecycle state.
    // Cannot fire on REVOKED or SUPERSEDED (terminal — guard excludes them).
    // Legal hold blocks supersede the same way it blocks revoke.
    // SUPERSEDED is terminal, so fingerprint is locked here even if supersede
    // fires from PENDING (idempotent for BROADCASTING/SUBMITTED/SECURED).
    // Returning actor to client removes any conceptual active worker claim
    // when a BROADCASTING or SUBMITTED anchor is superseded.
    supersede: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(
          lit("PENDING"),
          lit("BROADCASTING"),
          lit("SUBMITTED"),
          lit("SECURED")
        )),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUPERSEDED")),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(true))
      ]
    },

    // Admin places legal hold (on SECURED, REVOKED, or SUPERSEDED anchors).
    // SUPERSEDED is included for SCRUM-1274: superseded rows still need
    // litigation hold for e-discovery. Pre-confirmation states (PENDING,
    // BROADCASTING, SUBMITTED) cannot carry legal hold — anchor isn't yet
    // an evidentiary record.
    placeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(
          lit("SECURED"),
          lit("REVOKED"),
          lit("SUPERSEDED")
        )),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(true))
      ]
    },

    // Admin removes legal hold (on SECURED, REVOKED, or SUPERSEDED anchors)
    removeLegalHold: {
      params: { a: "Anchors" },
      guard: and(
        isin(index(status, param("a")), setOf(
          lit("SECURED"),
          lit("REVOKED"),
          lit("SUPERSEDED")
        )),
        index(legalHold, param("a"))
      ),
      updates: [
        setMap("legalHold", param("a"), lit(false))
      ]
    },

    // SCRUM-1274: soft-delete sets deleted_at IS NOT NULL.
    // Orthogonal to lifecycle status — soft-deleted rows are preserved
    // but excluded from active queries (anchor.ts:483 query-builder).
    // One-way in this model; un-delete is operator-only via direct SQL.
    softDelete: {
      params: { a: "Anchors" },
      guard: not(index(softDeleted, param("a"))),
      updates: [
        setMap("softDeleted", param("a"), lit(true))
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

    // INV-3 (SCRUM-1274): REVOKED + SUPERSEDED are terminal lifecycle states.
    // No outbound transitions exist — verified structurally by every action's
    // guard (none accepts REVOKED or SUPERSEDED as a source status). This
    // invariant additionally pins the chain_tx_id retention property: REVOKED
    // is only reachable from SECURED, so chain_tx_id must be set.
    revokedHasChainTx: {
      description: "REVOKED is terminal and retains chain_tx_id (only reachable from SECURED)",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("REVOKED"))),
          eq(index(chainTxId, param("a")), lit("has_tx"))
        )
      )
    },

    // INV-4: Metadata is locked once SECURED or REVOKED.
    // SUPERSEDED is intentionally excluded — supersede can fire from PENDING
    // (before metadata is committed to chain), so metadataLocked is not
    // guaranteed to be true post-supersede. SUPERSEDED-from-SECURED preserves
    // the metadataLocked=true setting through the supersede transition; that's
    // a property of the action, not a state predicate.
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

    // INV-6: Legal hold can only exist on evidentiary terminal/secured rows.
    // placeLegalHold limits creation to SECURED/REVOKED/SUPERSEDED and every
    // transition that would escape that set is blocked while legalHold=true.
    legalHoldPreventsSecuredToRevoked: {
      description: "Legal hold can only exist on SECURED, REVOKED, or SUPERSEDED anchors",
      formula: forall("Anchors", "a",
        or(
          not(index(legalHold, param("a"))),
          isin(index(status, param("a")), setOf(
            lit("SECURED"),
            lit("REVOKED"),
            lit("SUPERSEDED")
          ))
        )
      )
    }

    // INV-7 (credentialTypeImmutableAfterPending) intentionally REMOVED —
    // see SCRUM-1274. Migration 0172_fix_credential_type_trigger_service_role.sql
    // makes service_role exempt for backfill/repair flows. CLAUDE.md §1.4
    // documents that credential_type is monotonic for `authenticated` only;
    // service_role can mutate post-PENDING with audit_events row required.
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Anchors: ids({ prefix: "a", size: 2 })
        },
        // State count for size=2: 6 statuses × 2 (chainTxId) × 2
        // (fingerprintLocked) × 2 (metadataLocked) × 2 (legalHold) × 2
        // (actor) × 2 (softDeleted) = 384 per anchor; 384^2 = 147,456
        // for the cross-product. Marginally above the tla-precheck 100k
        // graph-equivalence cap, so disable graphEquivalence and bump
        // the budget to 200k to leave headroom for future axes.
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
          // size=3 → 384^3 = 56,623,104 states; bump to 75M for headroom.
          maxEstimatedStates: 75_000_000,
          maxEstimatedBranching: 1_000_000
        }
      }
    }
  },

  metadata: {
    // Documentation only — this TLA+ machine models anchor lifecycle state
    // but is not code-generated into a runtime DB adapter. Several machine
    // variables (fingerprintLocked, metadataLocked, actor, softDeleted) are
    // derived/conceptual state with no 1:1 DB column, so the tla-precheck
    // runtimeAdapter (which requires same-named variable↔column mapping)
    // is intentionally omitted.
    ownedTables: ["anchors"],
    ownedColumns: {
      anchors: ["status", "chain_tx_id", "legal_hold", "deleted_at"]
    }
  }
});

export default bitcoinAnchorMachine;
