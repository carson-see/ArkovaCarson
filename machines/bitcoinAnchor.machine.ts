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
const intentPersisted = variable("intentPersisted");

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
    ),

    // S3-P0 (batch producer, no-double-broadcast): TRUE while a signed
    // broadcast intent for this anchor's batch is durably persisted
    // (DB shape: anchors.chain_tx_id set while status=BROADCASTING, plus the
    // anchor_proofs intent record carrying the signed tx hex). The RACE-1
    // recover_stuck_broadcasts sweep only resets BROADCASTING rows whose
    // chain_tx_id IS NULL, so an intent-persisted anchor can never be
    // reverted to PENDING by the crash sweep — the crash-resume reconcile
    // either finds the tx on-chain (finalize, no rebroadcast) or rebroadcasts
    // the SAME signed bytes (same txid). Conceptual/derived state like
    // `actor` — no dedicated DB column.
    intentPersisted: mapVar("Anchors", boolType(), lit(false))
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

    // Worker successfully broadcasts a BROADCASTING anchor to the mempool
    // WITHOUT a persisted pre-broadcast intent (legacy single-anchor path in
    // jobs/anchor.ts and the legacy batch fallback — broadcast happens first,
    // chain_tx_id is recorded after).
    // Maps to: processAnchor() in jobs/anchor.ts after chain submit succeeds
    // Result: BROADCASTING → SUBMITTED, chain_tx_id set
    // S3-P0: guarded not(intentPersisted) — the intent path finalizes via
    // broadcastResumeFinalize instead, so the intent flag can never leak into
    // SUBMITTED (intentOnlyWhileBroadcasting).
    workerBroadcast: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker")),
        not(index(intentPersisted, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
        setMap("chainTxId", param("a"), lit("has_tx"))
      ]
    },

    // S3-P0: Worker persists the signed pre-broadcast intent for a claimed
    // batch BEFORE any bytes hit the network.
    // Maps to: batch-anchor.ts Phase 3b — prepareFingerprintTx() (build+sign,
    // no broadcast), then durably write (i) anchor_proofs rows keyed by the
    // precomputed txid (receipt_id) with the signed tx hex on the intent row,
    // and (ii) anchors.chain_tx_id on every claimed BROADCASTING row.
    // Result: chain_tx_id set while still BROADCASTING — the RACE-1 sweep
    // (chain_tx_id IS NULL filter) can no longer revert these rows.
    persistBroadcastIntent: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker")),
        eq(index(chainTxId, param("a")), lit(null)),
        not(index(intentPersisted, param("a")))
      ),
      updates: [
        setMap("chainTxId", param("a"), lit("has_tx")),
        setMap("intentPersisted", param("a"), lit(true))
      ]
    },

    // S3-P0: Finalize an intent-persisted batch anchor to SUBMITTED. This is
    // BOTH the happy path (broadcast succeeded in-process, then
    // submit_batch_anchors) AND the crash-resume path (worker died between
    // intent persistence and submit_batch_anchors; the next run's
    // reconcileBroadcastIntents() finds the txid already on-chain — or
    // rebroadcasts the SAME signed bytes, yielding the SAME txid — and then
    // finalizes). Identical DB write either way: submit_batch_anchors moves
    // BROADCASTING → SUBMITTED. A batch that broadcast once can NEVER
    // broadcast twice: resume either observes the tx or re-sends identical
    // bytes (already-known == success at the provider layer).
    broadcastResumeFinalize: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker")),
        index(intentPersisted, param("a")),
        eq(index(chainTxId, param("a")), lit("has_tx"))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
        setMap("intentPersisted", param("a"), lit(false))
      ]
    },

    // S3-P0: DEFINITIVE broadcast rejection of an intent-persisted batch —
    // the provider answered with a non-retryable application error (e.g.
    // dust/min-relay-fee validation reject), i.e. the signed tx was refused
    // admission to the mempool and provably never relayed. Only then is it
    // safe to unwind the intent: clear chain_tx_id, delete this batch's
    // anchor_proofs intent rows, refund queue-run credits, revert to PENDING.
    // A transient/unknown-outcome failure (timeout / 5xx / 429 after bounded
    // retries) must NOT take this edge — the tx may have landed; those rows
    // stay BROADCASTING+intent for reconcileBroadcastIntents().
    broadcastIntentReject: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker")),
        index(intentPersisted, param("a"))
      ),
      updates: [
        setMap("status", param("a"), lit("PENDING")),
        setMap("chainTxId", param("a"), lit(null)),
        setMap("intentPersisted", param("a"), lit(false)),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(false)),
        setMap("credentialTypeLocked", param("a"), lit(false))
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

    // Broadcast fails BEFORE any intent is persisted — anchor returns to
    // PENDING for retry. Nothing was signed-and-recorded, so nothing can have
    // reached the network under a recorded txid; a fresh tx next tick is the
    // FIRST broadcast, not a double.
    // Maps to: processAnchor() error path when chain submit throws, the
    // batch pre-intent abort path, AND recover_stuck_broadcasts() (RACE-1) —
    // whose `chain_tx_id IS NULL` filter is exactly the not(intentPersisted)
    // guard here (S3-P0: intent-persisted rows are shielded from the sweep).
    broadcastFail: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("BROADCASTING")),
        eq(index(actor, param("a")), lit("worker")),
        not(index(intentPersisted, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("PENDING")),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(false)),
        setMap("credentialTypeLocked", param("a"), lit(false))
      ]
    },

    // Chain submission fails after broadcast — tx dropped from mempool.
    // Maps to: recover_stuck_broadcasts() RPC or chain-maintenance reorg detection.
    // Lane 1 i4 / BUG-C: guarded not(legalHold). A legal-hold anchor must never
    // reach PENDING (legalHoldPreventsSecuredToRevoked). The worker selects
    // that drive this transition now carry an explicit `.eq('legal_hold',
    // false)` so a held SUBMITTED anchor is never abandoned SUBMITTED → PENDING.
    chainSubmitFail: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SUBMITTED")),
        eq(index(actor, param("a")), lit("worker")),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("PENDING")),
        setMap("chainTxId", param("a"), lit(null)),
        setMap("actor", param("a"), lit("client")),
        setMap("fingerprintLocked", param("a"), lit(false)),
        setMap("credentialTypeLocked", param("a"), lit(false))
      ]
    },

    // NET-1 / NET-3 stuck/dropped-TX abandon path — the 72h + max-rebroadcast
    // recovery in services/worker/src/jobs/chain-maintenance.ts
    // (abandonSubmittedAnchor / rebroadcastDroppedTransactions). A SUBMITTED
    // anchor whose TX never confirms (or is dropped from mempool) is reverted
    // to PENDING for resubmission with a fresh fee.
    //
    // Lane 1 i4 / BUG-C: guarded not(legalHold). Before the fix, the NET-1 +
    // NET-3 candidate selects lacked the `.eq('legal_hold', false)` filter that
    // detectReorgs already had, so a held SUBMITTED anchor could be rewound
    // SUBMITTED → PENDING — violating legalHoldPreventsSecuredToRevoked.
    // Modeled as its own action (vs reusing chainSubmitFail) so the spec names
    // the exact production code path the fix freezes. chainTxId is cleared
    // because abandonment discards the stuck TX.
    chainSubmitAbandon: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SUBMITTED")),
        eq(index(actor, param("a")), lit("worker")),
        not(index(legalHold, param("a")))
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
        setMap("credentialTypeLocked", param("a"), lit(true)),
        // S3-P0: a supersede that lands mid-broadcast consumes the intent —
        // the row leaves BROADCASTING, so submit_batch_anchors (which only
        // touches BROADCASTING/PENDING rows) skips it and the reconcile
        // (which scans BROADCASTING rows) no longer sees it. The already-
        // signed tx may still commit the fingerprint on-chain; that is
        // harmless surplus evidence for a SUPERSEDED row.
        setMap("intentPersisted", param("a"), lit(false))
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
    },

    // Lane 1 i4 / BUG-A: same-height reorg revert. detectReorgs() now persists
    // and compares chain_block_hash, not just chain_block_height. A reorg that
    // re-mines the TX into a DIFFERENT block at the SAME height (storedHash !==
    // confirmed block_hash, equal height) used to leave the anchor falsely
    // SECURED because the prior height-only check saw no change. With the
    // stored block hash, that case now reverts SECURED → SUBMITTED. Modeled as
    // its own action so the spec records the equal-height revert trigger; the
    // transition is otherwise identical to reorgDetected (same not(legalHold)
    // freeze, chainTxId retained, metadata lock unwound). The legacy
    // height-only fallback (storedHash NULL) is strictly-better superset
    // behavior and does not weaken any invariant.
    reorgSameHeightRevert: {
      params: { a: "Anchors" },
      guard: and(
        eq(index(status, param("a")), lit("SECURED")),
        eq(index(actor, param("a")), lit("worker")),
        eq(index(chainTxId, param("a")), lit("has_tx")),
        not(index(legalHold, param("a")))
      ),
      updates: [
        setMap("status", param("a"), lit("SUBMITTED")),
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

    // INV-1c (S3-P0 REVISED): while BROADCASTING, chain_tx_id is set IFF the
    // signed pre-broadcast intent is persisted. Pre-S3-P0 this read
    // "BROADCASTING ⇒ chainTxId = null"; the batch producer now records the
    // precomputed txid + signed tx hex BEFORE broadcasting (the intent), so
    // the crash sweep (RACE-1, chain_tx_id IS NULL filter) can never revert
    // an anchor whose tx may already be on the network — the exact
    // double-broadcast window this revision closes.
    broadcastingIntentChainTxCoupling: {
      description: "A BROADCASTING anchor has chain_tx_id set exactly when its pre-broadcast intent is persisted",
      formula: forall("Anchors", "a",
        or(
          not(eq(index(status, param("a")), lit("BROADCASTING"))),
          or(
            and(
              eq(index(chainTxId, param("a")), lit("has_tx")),
              index(intentPersisted, param("a"))
            ),
            and(
              eq(index(chainTxId, param("a")), lit(null)),
              not(index(intentPersisted, param("a")))
            )
          )
        )
      )
    },

    // S3-P0: the intent flag exists only during BROADCASTING — finalize,
    // definitive-reject, and supersede all consume it. No other status may
    // carry a live intent (a SUBMITTED/SECURED row's chain_tx_id is a
    // broadcast fact, not an intent).
    intentOnlyWhileBroadcasting: {
      description: "A persisted pre-broadcast intent exists only while the anchor is BROADCASTING",
      formula: forall("Anchors", "a",
        or(
          not(index(intentPersisted, param("a"))),
          eq(index(status, param("a")), lit("BROADCASTING"))
        )
      )
    },

    // S3-P0: only the worker persists intents (service_role-only writes,
    // Constitution 1.4 — mirrors onlyWorkerSecures).
    intentRequiresWorkerActor: {
      description: "A persisted pre-broadcast intent implies the worker actor",
      formula: forall("Anchors", "a",
        or(
          not(index(intentPersisted, param("a"))),
          eq(index(actor, param("a")), lit("worker"))
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
        // S3-P0: intentPersisted adds a 6th per-anchor bool → raw per-anchor
        // combos 6 statuses × 2^5 bools × 2 chainTxId × 2 actors = 768;
        // size=2 → 768^2 = 589,824 raw states (reachable set is far smaller,
        // but the estimator budgets against the raw product). Budget raised
        // from 200k accordingly. graphEquivalence stays off (pre-existing:
        // the raw product exceeds the 100k equivalence cap).
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 1_000_000,
          maxEstimatedBranching: 10_000
        }
      },
      nightly: {
        domains: {
          Anchors: ids({ prefix: "a", size: 3 })
        },
        graphEquivalence: false,
        budgets: {
          // size=3 → 768^3 = 452,984,832 raw states with the S3-P0
          // intentPersisted bool; bump from 50M to 500M for nightly.
          maxEstimatedStates: 500_000_000,
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
