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

const artifactCreated = variable("artifactCreated");
const artifactOwner = variable("artifactOwner");
const fingerprintClass = variable("fingerprintClass");
const conflictDetected = variable("conflictDetected");
const outboundHasActed = variable("outboundHasActed");

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
 *      action structure is modeling most directly: `materializeOutbound`,
 *      `materializeInbound`, and `forgeInbound` all share the identical guard
 *      `not(artifactCreated)`, so once ANY ONE fires for an envelope, the
 *      others can never ALSO fire for that same envelope, for the rest of the
 *      run. A missing/weakened guard (e.g. only checking direction-matched
 *      prior artifacts, not ANY prior artifact) is exactly the class of bug
 *      this proof would catch — TLC would find a reachable two-artifact state
 *      the moment the shared guard is split into two independent ones.
 *
 * F1 EXTENSION (security review of PR #2476, 2026-08-30): the ORIGINAL model
 * above proved "at most one owner" but — as the review correctly noted — that
 * is NECESSARY, not SUFFICIENT. It proves ONE artifact exists; it says
 * nothing about WHETHER the surviving one is the VERIFIED (server-measured)
 * one. The real vulnerability: `enqueue_connector_artifact` is
 * `ON CONFLICT DO NOTHING`, so whichever writer's INSERT reaches Postgres
 * FIRST wins — including a same-tenant attacker who self-POSTs a forged
 * INBOUND event (HMAC only proves "signed by this org's key," never "this
 * envelope is really foreign-owned") with an ATTACKER-CHOSEN fingerprint for
 * an envelope that is ACTUALLY this org's own real outbound envelope. If that
 * forged write wins the race, the real outbound job's later, genuinely
 * server-fetched-and-measured write is discarded by DO NOTHING, and — before
 * this fix — the code trusted "the RPC returned a non-null id" as "my write
 * succeeded" with no verification.
 *
 * This extension adds:
 *   - `forgeInbound` — an ADVERSARIAL action, distinguishable from the
 *     legitimate `materializeInbound` (both set `artifactOwner := INBOUND`,
 *     but only `forgeInbound` sets `fingerprintClass := FORGED`).
 *   - `outboundLosesRace` — models the OUTBOUND code path's own read-back-
 *     and-compare (services/worker/src/jobs/docusign-envelope-completed.ts,
 *     `enqueueSignedDocument`) discovering it did NOT win the slot, and
 *     unconditionally flagging that fact.
 *   - `outboundRedeliversOwnSuccess` — the harmless case: outbound's own
 *     retry finds ITS OWN prior real write, nothing to detect.
 *
 * The invariant `outboundNeverSilentlyAcceptsForgery` is deliberately an OR,
 * not a bare "the real fingerprint always survives": the code's actual floor
 * guarantee is DETECTION, not auto-heal. `ON CONFLICT DO NOTHING` means the
 * RPC structurally CANNOT UPDATE-supersede a pre-existing forged row from
 * inside `enqueueSignedDocument` — automatic outbound-supersedes-inbound
 * reconciliation is separate, go-live-gated follow-up work (tracked outside
 * this PR). A NAIVE invariant asserting "fingerprintClass is never FORGED
 * once artifactCreated" (or "always instantly detected the moment forged")
 * WOULD fail here — there is a real, legitimate window between `forgeInbound`
 * landing and the outbound side's own subsequent action running, since they
 * are modeled (correctly, matching reality: the outbound job's async fetch
 * takes real wall-clock time) as SEPARATE, independently-scheduled actions,
 * not one atomic step. The invariant is therefore gated on
 * `outboundHasActed[e]` — it makes NO claim about states where the outbound
 * side hasn't tried yet (that's just realistic timing, not a bug), and
 * asserts the real guarantee only once it has: the persisted fingerprint is
 * either outbound's own REAL one, or the conflict was flagged. Never neither.
 *
 * `outboundHasActed` intentionally has no "un-set" transition and
 * `outboundLosesRace` remains enabled after first firing (setting an
 * already-true variable to `true` again is a valid, harmless transition) —
 * this matches reality: a retried/redelivered outbound job independently
 * re-verifies and re-flags the SAME conflict on every attempt, which is the
 * intended "loud, repeated, cannot be silently missed" behavior.
 *
 * Feature-flag gating (ENABLE_DOCUSIGN_INBOUND) is NOT modeled here — that is
 * an HTTP-layer admission decision (covered by services/worker/src/api/v1/
 * webhooks/docusign.test.ts), not a state-machine invariant about the DB
 * dedup mechanism this machine proves.
 *
 * FUTURE WORK (explicitly out of scope for this PR, tracked separately):
 * automatic outbound-supersedes-inbound reconciliation — an actual UPDATE
 * that lets the verified outbound fingerprint WIN after the fact once
 * detected, rather than merely being flagged for manual/automated follow-up.
 * When that ships, this machine should gain a `reconcileForgery` action
 * (guarded on `conflictDetected`) that transitions `artifactOwner := OUTBOUND`
 * / `fingerprintClass := REAL`, and the invariant above can be strengthened
 * to drop the `conflictDetected` disjunct in favor of asserting the real
 * fingerprint always eventually wins.
 *
 * Adapter status: documentation-only — no runtimeAdapter. connector_artifact
 * rows are created via the migration-0343 RPC (ON CONFLICT DO NOTHING), not
 * a plain table insert, so this machine's action shape does not fit the
 * adapter subset (single owned table, all mapVars, one row domain, no RPC
 * semantics). This spec stays runnable under `tla-precheck check` so a
 * regression in either invariant is caught even though no adapter generates
 * from it — same posture as partnerProvisioning.machine.ts and
 * calibrationWorkflow.machine.ts.
 *
 * VERIFICATION STATUS (2026-08-30, F1 extension): `npx tla-precheck check
 * docusignInboundDedup.machine.ts`, run from inside `machines/` (see
 * agents.md's "how to invoke check" entry — repo-root invocation fails on
 * TS5096/TS5103 for unrelated cwd-resolution reasons, not a defect in this
 * file) PASSES. Certificate (tier `pr`): proofPassed: true; BOTH invariants
 * checked (`atMostOneArtifactOwner`, `outboundNeverSilentlyAcceptsForgery`);
 * graphEquivalence equivalent: true; ts/tlc state counts 36/36, edge counts
 * 96/96 (up from the pre-F1 9/9 states, 24/24 edges — the richer
 * fingerprintClass/conflictDetected/outboundHasActed state space); deadlock
 * checked: true; TLC "Model checking completed. No error has been found." on
 * both the proof and equivalence runs; machineSha256
 * 3c18ea4e0ef0b63ebb31449b5c49d78ded51f0114fbaa5ee9e28db9a83cb5f93; graphHash
 * 2c4922ad591af170e06caf8fb9289da26c66e9d3025a4c2d86f516d3ccc9105c.
 */
export const docusignInboundDedupMachine = defineMachine({
  version: 2,
  moduleName: "DocusignInboundDedup",

  variables: {
    // Whether a connector_artifact (and, transitively, the PENDING anchor the
    // drain materializes from it) has been created for this envelope, by
    // ANY path (real outbound, legitimate inbound, or a forged inbound).
    artifactCreated: mapVar("Envelopes", boolType(), lit(false)),
    // Which path created it. NONE until artifactCreated flips true; then
    // permanently OUTBOUND or INBOUND for the rest of the run — no action in
    // this machine ever changes artifactOwner once set (see the
    // atMostOneArtifactOwner invariant). Both legitimate INBOUND and FORGED
    // INBOUND set this to the same "INBOUND" value — direction alone cannot
    // distinguish them; `fingerprintClass` below is what does.
    artifactOwner: mapVar(
      "Envelopes",
      enumType("NONE", "OUTBOUND", "INBOUND"),
      lit("NONE"),
    ),
    // F1: the evidence class of the PERSISTED fingerprint. NONE until
    // artifactCreated; REAL for a genuinely server-measured (outbound) or
    // genuinely declared-and-honest (legitimate inbound) value; FORGED for an
    // attacker-chosen value from `forgeInbound`. This is the axis
    // `artifactOwner` alone cannot express.
    fingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
    // F1: has the outbound side's own detection logic (the read-back-and-
    // compare in `enqueueSignedDocument`) flagged a provenance conflict for
    // this envelope at least once. Never reset — see the header note on why
    // re-firing is intended, not a modeling gap.
    conflictDetected: mapVar("Envelopes", boolType(), lit(false)),
    // F1: has an outbound-side action (win or lose) run for this envelope at
    // least once. Gates the invariant below — see header for why a bare,
    // ungated invariant would be wrong (and would fail TLC) here.
    outboundHasActed: mapVar("Envelopes", boolType(), lit(false)),
  },

  actions: {
    // The FIRST delivery for this envelope arrives via the outbound
    // (own-account) path and materializes the artifact with the REAL,
    // server-measured fingerprint. No conflict — outbound simply won.
    materializeOutbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("OUTBOUND")),
        setMap("fingerprintClass", param("e"), lit("REAL")),
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },

    // The FIRST delivery for this envelope arrives via the LEGITIMATE inbound
    // (Recipient Connect, genuinely-foreign-owned envelope) path — a real
    // declared hash for a real foreign envelope, not an attacker. Same guard
    // as materializeOutbound: mutual exclusion is the property under proof,
    // expressed structurally.
    materializeInbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("INBOUND")),
        setMap("fingerprintClass", param("e"), lit("REAL")),
      ],
    },

    // F1 ADVERSARIAL ACTION: a same-tenant attacker self-POSTs a forged
    // inbound event for THIS org's own envelope, with an attacker-chosen
    // fingerprint, racing the real outbound fetch. Same guard as the two
    // legitimate "first" actions above — from the DB's perspective, an
    // INSERT is an INSERT; ON CONFLICT DO NOTHING cannot distinguish a
    // legitimate writer from a forger. Distinguishable from
    // materializeInbound ONLY by `fingerprintClass`, exactly mirroring how
    // the real vulnerability is invisible at the artifactOwner/dedup layer
    // and only visible once you ask "is this fingerprint the one I measured".
    forgeInbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("INBOUND")),
        setMap("fingerprintClass", param("e"), lit("FORGED")),
      ],
    },

    // F1: the outbound side's own write attempt arrives AFTER the slot is
    // already owned by an inbound row (legitimate OR forged — the code's
    // real guard, `metadata._direction === 'inbound'`, is deliberately
    // over-inclusive and does not try to distinguish the two at this layer
    // either, matching this action firing for BOTH materializeInbound's and
    // forgeInbound's outcomes). Models `enqueueSignedDocument`'s read-back-
    // and-compare: it ALWAYS runs, unconditionally, on this exact code path
    // — there is no branch where a non-owned row is read back and silently
    // treated as success. Detection only: DO NOTHING means this action
    // cannot also flip ownership/fingerprintClass back to OUTBOUND/REAL.
    outboundLosesRace: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(eq(index(artifactOwner, param("e")), lit("OUTBOUND"))),
      ),
      updates: [
        setMap("conflictDetected", param("e"), lit(true)),
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },

    // The harmless case: an outbound retry (job redelivery) finds ITS OWN
    // prior real write already in place. Nothing to detect, nothing changes
    // — recorded only so `outboundHasActed` reflects reality on this branch
    // too (it was already true from materializeOutbound; this is a re-fire).
    outboundRedeliversOwnSuccess: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        eq(index(artifactOwner, param("e")), lit("OUTBOUND")),
      ),
      updates: [
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },
  },

  invariants: {
    // THE ORIGINAL property: at most one artifact-creation event is ever
    // recorded per envelope. Proven structurally by the shared "first" guard
    // above — this invariant additionally confirms the boolean/enum pair
    // never desyncs. Necessary but — per the F1 review — NOT sufficient on
    // its own; see outboundNeverSilentlyAcceptsForgery below for the other
    // half.
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

    // F1 property: once the outbound side has acted for an envelope (either
    // branch — won outright, or lost and ran its detection check), the
    // persisted fingerprint is EITHER outbound's own REAL one OR the
    // conflict has been flagged. Never neither — that "neither" state is
    // exactly "a forged fingerprint was silently accepted as if it were the
    // real outbound success," the vulnerability this extension exists to
    // rule out.
    //
    // Deliberately gated on outboundHasActed[e] (see header: an UNGATED
    // "fingerprintClass is never FORGED" or "always instantly detected"
    // invariant would incorrectly flag the legitimate, realistic window
    // between forgeInbound landing and the outbound side's own later action
    // running — those are independently-scheduled actions here, matching
    // real async timing, not one atomic step). This is the code's actual
    // DETECTION-FLOOR guarantee, not an auto-heal claim: DO NOTHING means the
    // real fingerprint cannot un-forge the persisted row from inside this
    // code path.
    outboundNeverSilentlyAcceptsForgery: {
      description:
        "Once the outbound side has acted for an envelope, its own real fingerprint persisted OR the conflict was flagged — never silently neither",
      formula: forall("Envelopes", "e",
        or(
          not(index(outboundHasActed, param("e"))),
          not(eq(index(fingerprintClass, param("e")), lit("FORGED"))),
          index(conflictDetected, param("e")),
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
          // uncontested envelope and one contested by outbound vs a forger,
          // without the state space exploding.
          Envelopes: ids({ prefix: "e", size: 2 }),
        },
        budgets: {
          // Raised from 10_000 (pre-F1) — two new enum/bool variables per
          // envelope widen the raw state space.
          maxEstimatedStates: 30_000,
        },
      },
      nightly: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 4 }),
        },
        // Raw product at 4 envelopes (72 per-envelope combos ^ 4) is well
        // over the tool's 100_000 graph-equivalence cap — same shape as the
        // pre-existing fix documented in agents.md for
        // drainRunAccounting/calibrationWorkflow/partnerProvisioning's
        // nightly tiers: disable graph-equivalence and budget against the
        // real raw product instead. `pr` tier above keeps equivalence on.
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 30_000_000,
        },
      },
    },
  },
});

export default docusignInboundDedupMachine;
