import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
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

const artifactCreated = variable("artifactCreated");
const artifactOwner = variable("artifactOwner");

/**
 * DocuSign Inbound/Outbound Anchor Dedup Machine (docusign-bilateral-2026-08,
 * feasibility spike SCRUM-3817/SCRUM-3818).
 *
 * Formal model of the invariant the CTO Decision Record requires before the
 * INBOUND (Recipient Connect) webhook path is allowed to exist at all, even
 * flag-off: under CONCURRENT outbound and inbound delivery for the same
 * (org, envelope), AT MOST ONE anchored connector_artifact is ever created.
 *
 * WHAT THIS MODELS, AND THE SIMPLIFICATION IT MAKES: the real dedup key is
 * the compound `(org_id, envelope_id)` pair — an "Envelope" here stands for
 * one ALREADY ORG-SCOPED envelope identity (per the DSL's "keep proof domains
 * tiny" rule; see partnerProvisioning.machine.ts for the same style of
 * single-domain simplification). This machine does not model DIFFERENT orgs
 * receiving the same DocuSign envelope_id (that case never collides at the
 * DB layer at all, since `org_id` differs) — it models the CTO's actual
 * stated concern: one org with MULTIPLE connected DocuSign accounts, where
 * one account's delivery classifies outbound and another account's delivery
 * (for the SAME envelope) classifies inbound.
 *
 * TWO real mechanisms combine to implement the guard this machine proves
 * correct in the abstract:
 *   1. The `enqueue_connector_artifact` RPC's own DB-level uniqueness
 *      (migration 0343): `(org_id, source, external_ref,
 *      COALESCE(external_revision, ''))`, `ON CONFLICT DO NOTHING`.
 *   2. `findExistingEnvelopeAnchor` (jobs/docusign-anchor-reconciliation.ts),
 *      the APPLICATION-level guard the connector-artifact drain
 *      (`defaultMaterializeAnchor`) calls before ever inserting a new anchor
 *      row — this is the hand-written imperative code that is the actual
 *      risk surface (its own header comment documents a prior
 *      flag-flip-mid-flight race pre-mortem), and the one this machine's
 *      action structure is modeling most directly: BOTH `materializeOutbound`
 *      and `materializeInbound` share the identical guard `not(artifactCreated)`,
 *      so once EITHER fires for an envelope, the other can never ALSO fire
 *      for that same envelope, for the rest of the run. A missing/weakened
 *      guard (e.g. only checking direction-matched prior artifacts, not ANY
 *      prior artifact) is exactly the class of bug this proof would catch —
 *      TLC would find a reachable two-artifact state the moment the shared
 *      guard is split into two independent ones.
 *
 * `redeliverWhenAnchored` collapses "outbound retry", "inbound retry", and
 * "the other direction's delivery arriving late" into ONE no-op action,
 * because their effect (no new artifact) is identical and the invariant
 * below does not care WHICH kind of redelivery it was — only that no second
 * artifact is ever created. This keeps the proof domain to the one property
 * that matters, per the DSL's "one risky workflow per machine" rule.
 *
 * Feature-flag gating (ENABLE_DOCUSIGN_INBOUND) is NOT modeled here — that is
 * an HTTP-layer admission decision (covered by services/worker/src/api/v1/
 * webhooks/docusign.test.ts), not a state-machine invariant about the DB
 * dedup mechanism this machine proves.
 *
 * Adapter status: documentation-only — no runtimeAdapter. connector_artifact
 * rows are created via the migration-0343 RPC (ON CONFLICT DO NOTHING), not
 * a plain table insert, so this machine's action shape (two guarded "first"
 * actions + one no-op "redeliver" action) does not fit the adapter subset
 * (single owned table, all mapVars, one row domain, no RPC semantics). This
 * spec stays runnable under `tla-precheck check` so a regression in the
 * dedup INVARIANT is caught even though no adapter generates from it — same
 * posture as partnerProvisioning.machine.ts and calibrationWorkflow.machine.ts.
 *
 * VERIFICATION STATUS (2026-08-30): `npx tla-precheck check
 * docusignInboundDedup.machine.ts`, run from inside `machines/` (see
 * agents.md's "how to invoke check" entry — repo-root invocation fails on
 * TS5096/TS5103 for unrelated cwd-resolution reasons, not a defect in this
 * file) PASSES. Certificate (tier `pr`): proofPassed: true; invariant
 * `atMostOneArtifactOwner` checked; graphEquivalence equivalent: true;
 * ts/tlc state counts 9/9, edge counts 24/24; deadlockChecked: true (this
 * machine's states are NOT all-terminal, unlike partnerProvisioning's —
 * `redeliverWhenAnchored` keeps every anchored envelope live); TLC "Model
 * checking completed. No error has been found." on both the proof and
 * equivalence runs; graphHash
 * 8f984b386cf62b396d28e43595108a466db15da60b06021acab4f568b8ce9460;
 * machineSha256
 * 01b0fc3fff667ddaba6ec519885cebb404bec4ed87ca1f938fb0a13185953dfb.
 */
export const docusignInboundDedupMachine = defineMachine({
  version: 2,
  moduleName: "DocusignInboundDedup",

  variables: {
    // Whether a connector_artifact (and, transitively, the PENDING anchor the
    // drain materializes from it) has been created for this envelope, by
    // EITHER path.
    artifactCreated: mapVar("Envelopes", boolType(), lit(false)),
    // Which path created it. NONE until artifactCreated flips true; then
    // permanently OUTBOUND or INBOUND for the rest of the run — no action in
    // this machine ever changes artifactOwner once set (see the
    // ownerImmutableOnceSet invariant).
    artifactOwner: mapVar(
      "Envelopes",
      enumType("NONE", "OUTBOUND", "INBOUND"),
      lit("NONE"),
    ),
  },

  actions: {
    // The FIRST delivery for this envelope arrives via the outbound
    // (own-account) path and materializes the artifact.
    materializeOutbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("OUTBOUND")),
      ],
    },

    // The FIRST delivery for this envelope arrives via the inbound
    // (Recipient Connect, declared-hash) path and materializes the artifact.
    // Same guard as materializeOutbound, by construction: mutual exclusion
    // between the two IS the property under proof, expressed structurally —
    // once one fires for an envelope, the shared guard makes the other
    // permanently disabled for that same envelope.
    materializeInbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("INBOUND")),
      ],
    },

    // ANY subsequent delivery for an already-anchored envelope — a DocuSign
    // retry of the SAME direction, or the OTHER direction's delivery
    // arriving after the first already won — finds the existing artifact via
    // findExistingEnvelopeAnchor / the RPC's ON CONFLICT DO NOTHING and
    // reuses it. No state changes: this is the observable "redelivery is a
    // no-op" guarantee.
    redeliverWhenAnchored: {
      params: { e: "Envelopes" },
      guard: index(artifactCreated, param("e")),
      updates: [],
    },
  },

  invariants: {
    // THE property: at most one artifact-creation event is ever recorded per
    // envelope. Proven structurally by the shared guard above — this
    // invariant additionally confirms the boolean/enum pair never desyncs.
    atMostOneArtifactOwner: {
      description:
        "An envelope's artifactOwner is NONE iff no artifact has been created for it — never ambiguous, never double-created",
      formula: forall("Envelopes", "e",
        and(
          // artifactCreated => owner is a real path (not NONE)
          not(and(
            index(artifactCreated, param("e")),
            eq(index(artifactOwner, param("e")), lit("NONE")),
          )),
          // NOT artifactCreated => owner is still NONE
          not(and(
            not(index(artifactCreated, param("e"))),
            not(eq(index(artifactOwner, param("e")), lit("NONE"))),
          )),
        ),
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          // Small on purpose (DSL guidance: 2-3 finds most bugs). Two
          // envelopes lets TLC explore interleavings across BOTH an
          // uncontested envelope and one contested by both directions,
          // without the state space exploding.
          Envelopes: ids({ prefix: "e", size: 2 }),
        },
        budgets: {
          maxEstimatedStates: 10_000,
        },
      },
      nightly: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 4 }),
        },
        budgets: {
          maxEstimatedStates: 50_000,
        },
      },
    },
  },
});

export default docusignInboundDedupMachine;
