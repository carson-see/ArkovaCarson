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
const anchorMaterialized = variable("anchorMaterialized");

/**
 * DocuSign Inbound/Outbound Anchor Dedup Machine (docusign-bilateral-2026-08,
 * feasibility spike SCRUM-3817/SCRUM-3818).
 *
 * Formal model of the invariant the CTO Decision Record requires before the
 * INBOUND (Recipient Connect) webhook path is allowed to exist at all, even
 * flag-off: under CONCURRENT outbound and inbound delivery for the same
 * (org, envelope), AT MOST ONE anchored connector_artifact is ever created —
 * and (F1-heal extension, below) the fingerprint that SURVIVES is never a
 * forged one left unchallenged.
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
 * PR #2476 — the code trusted "the RPC returned a non-null id" as "my write
 * succeeded" with no verification.
 *
 * PR #2476 shipped:
 *   - `forgeInbound` — an ADVERSARIAL action, distinguishable from the
 *     legitimate `materializeInbound` (both set `artifactOwner := INBOUND`,
 *     but only `forgeInbound` sets `fingerprintClass := FORGED`).
 *   - `outboundRedeliversOwnSuccess` — the harmless case: outbound's own
 *     retry finds ITS OWN prior real write, nothing to detect.
 *   - a floor invariant proving DETECTION only ("the code's actual floor
 *     guarantee is DETECTION, not auto-heal" — that PR's own words) via a
 *     bare `outboundLosesRace` action that only ever set `conflictDetected`,
 *     never touching `fingerprintClass`/`artifactOwner`.
 *
 * F1-HEAL EXTENSION (this file, SCRUM-3818 go-live gate — closes the
 * auto-heal item PR #2476's own header named as follow-up work): the CTO
 * precedence ruling is that a fingerprint Arkova MEASURED from fetched
 * document bytes ALWAYS supersedes one merely DECLARED by a notification,
 * never the reverse — UNLESS the declared row has already materialized a
 * live anchor, in which case rewriting it is a SEPARATE integrity event, not
 * an auto-heal (services/worker/src/jobs/docusign-envelope-completed.ts,
 * `enqueueSignedDocument`'s F1-heal block implements exactly this: ONE
 * atomic `UPDATE connector_artifact ... WHERE id = :id AND anchor_id IS
 * NULL`). This adds:
 *   - `anchorMaterialized` — a new per-envelope variable modeling
 *     `connector_artifact.anchor_id` becoming non-null: the
 *     connector-artifact drain (jobs/connector-artifact-drain.ts) has
 *     materialized a LIVE anchor from this artifact. `markStatus` sets
 *     `status='materialized'` and `anchor_id` together, atomically, in the
 *     SAME UPDATE — never independently — so there is no intermediate state
 *     to model beyond a single boolean.
 *   - `materializeAnchorFromArtifact` — the drain's own independently-
 *     scheduled action: any created artifact (outbound, legitimate inbound,
 *     or forged — the drain does not know or care which) can be materialized
 *     into a live anchor at any time after creation. This is what creates
 *     the race the heal's WHERE-clause guard must survive.
 *   - `outboundHealsForgery` REPLACES the OLD bare `outboundLosesRace` for
 *     the not-yet-materialized case: the outbound job's read-back-and-
 *     compare (`enqueueSignedDocument`) finds it does not own the slot, and
 *     — because `anchorMaterialized[e]` is still false — its ONE atomic
 *     conditional UPDATE succeeds: `fingerprintClass := REAL`,
 *     `artifactOwner := OUTBOUND`, exactly as if the outbound write had won
 *     outright.
 *   - `outboundLosesRaceUnhealed` covers the OTHER case: the same read-back-
 *     and-compare, but `anchorMaterialized[e]` is ALREADY true — the
 *     conditional UPDATE's WHERE clause matches zero rows (the real code's
 *     `supersedeRow == null` branch), so the row is left exactly as-is
 *     (`fingerprintClass`/`artifactOwner` UNCHANGED) and only
 *     `conflictDetected`/`outboundHasActed` are set — the loud,
 *     never-auto-healed integrity event PR #2476's floor already guaranteed
 *     for this sub-case, preserved unchanged here.
 *   These two actions are DELIBERATELY modeled as ONE atomic decision point
 *   (mutually exclusive on `anchorMaterialized[e]`'s value, not two
 *   separately-schedulable steps with a pending-heal window in between) —
 *   this matches the real code exactly: detection and the heal-or-refuse
 *   decision happen inside the SAME synchronous function call
 *   (`enqueueSignedDocument`), so there is no observable intermediate state
 *   where a conflict is "detected but heal not yet attempted". Modeling them
 *   as two separately-timed actions (as originally speculated in this file's
 *   pre-F1-heal header) would introduce a FALSE positive on the strengthened
 *   invariant below — a real transient state the real code never has.
 *   `outboundHealsForgery`/`outboundLosesRaceUnhealed` both inherit
 *   `outboundLosesRace`'s original OVER-INCLUSIVE guard on purpose: like the
 *   code's own `metadata._direction === 'inbound'` check, this model cannot
 *   structurally distinguish a genuinely-foreign legitimate inbound row from
 *   a forged one at this layer, and — in reality — that distinction is moot
 *   here anyway, because a DocuSign `envelope_id` is globally unique, so an
 *   outbound job legitimately processing envelope `e` proves `e` IS this
 *   org's own envelope; any inbound-marked row already occupying `e`'s slot
 *   is therefore forged or buggy by construction, never genuinely foreign.
 *
 * The invariant `outboundNeverSilentlyAcceptsForgery` is STRENGTHENED from
 * PR #2476's detection-only form. The OLD form's trailing disjunct was a bare
 * `conflictDetected[e]` — true the instant a conflict was merely NOTICED,
 * regardless of outcome, which is why that PR's own header speculated the
 * follow-up could "drop the `conflictDetected` disjunct in favor of
 * asserting the real fingerprint always eventually wins." This file does
 * NOT go that far, because the CTO ruling carves out a real exception: an
 * ALREADY-MATERIALIZED declared row must NOT be silently rewritten. So
 * instead of dropping the disjunct, it is NARROWED to
 * `conflictDetected[e] AND anchorMaterialized[e]` — a forged/mismatched
 * fingerprint is now permitted to permanently stand ONLY when it is
 * EXPLAINED by a live anchor already existing (the documented, operator-
 * reconciliation carve-out), never merely because detection happened and
 * nothing followed up. Every OTHER reachable post-`outboundHasActed` state
 * now requires `fingerprintClass[e] = REAL` — the real, auto-healed
 * guarantee this PR ships, not merely a detection floor.
 *
 * Adapter status: documentation-only — no runtimeAdapter. connector_artifact
 * rows are created via the migration-0343 RPC (ON CONFLICT DO NOTHING) and
 * superseded via a hand-written conditional UPDATE, not a plain table
 * insert/update the adapter subset understands (single owned table, all
 * mapVars, one row domain, no RPC/conditional-UPDATE semantics). This spec
 * stays runnable under `tla-precheck check` so a regression in either
 * invariant is caught even though no adapter generates from it — same
 * posture as partnerProvisioning.machine.ts and calibrationWorkflow.machine.ts.
 *
 * VERIFICATION STATUS (2026-08-31, F1-heal extension): `npx tla-precheck
 * check docusignInboundDedup.machine.ts`, run from inside `machines/` (see
 * agents.md's "how to invoke check" entry — repo-root invocation fails on
 * TS5096/TS5103 for unrelated cwd-resolution reasons, not a defect in this
 * file) PASSES. Certificate (tier `pr`): proofPassed: true; BOTH invariants
 * checked (`atMostOneArtifactOwner`, `outboundNeverSilentlyAcceptsForgery`);
 * graphEquivalence equivalent: true; ts/tlc state counts 121/121, edge counts
 * 374/374 (up from the F1 extension's 36/36 states, 96/96 edges — the new
 * `anchorMaterialized` boolean plus the `outboundHealsForgery` /
 * `outboundLosesRaceUnhealed` / `materializeAnchorFromArtifact` actions widen
 * the reachable state space); deadlock checked: true; TLC "Model checking
 * completed. No error has been found." on both the proof and equivalence
 * runs; machineSha256
 * f56a95d54929e4525c51751b18547b935752ed65d5cde2ddaa2e467b1841edec; graphHash
 * 2341f3943367221a90f3dc11b0a4d34acc2b61528ddad04c74633e6926eb2d47.
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
    // this machine ever changes artifactOwner back to NONE once set (see the
    // atMostOneArtifactOwner invariant). Both legitimate INBOUND and FORGED
    // INBOUND set this to the same "INBOUND" value — direction alone cannot
    // distinguish them; `fingerprintClass` below is what does. F1-heal:
    // `outboundHealsForgery` is the ONE action that ever flips this from
    // INBOUND back to OUTBOUND (the supersession).
    artifactOwner: mapVar(
      "Envelopes",
      enumType("NONE", "OUTBOUND", "INBOUND"),
      lit("NONE"),
    ),
    // The evidence class of the PERSISTED fingerprint. NONE until
    // artifactCreated; REAL for a genuinely server-measured (outbound) or
    // genuinely declared-and-honest (legitimate inbound) value, OR — F1-heal
    // — a FORGED row that has since been superseded; FORGED for an
    // attacker-chosen value from `forgeInbound` that has NOT (yet, or ever)
    // been healed.
    fingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
    // Has the outbound side's own detection logic (the read-back-and-
    // compare in `enqueueSignedDocument`) flagged a provenance conflict for
    // this envelope at least once. Never reset — a healed row's later
    // redelivery takes `outboundRedeliversOwnSuccess` instead (artifactOwner
    // is now OUTBOUND), so `conflictDetected` correctly stays true forever
    // once any conflict was ever seen, healed or not.
    conflictDetected: mapVar("Envelopes", boolType(), lit(false)),
    // Has an outbound-side action (clean win, heal, or unhealed-refusal) run
    // for this envelope at least once. Gates the invariant below — see
    // header for why an ungated invariant would be wrong (and would fail
    // TLC) here: it would flag the legitimate window between `forgeInbound`
    // landing and the outbound side's own later action ever running at all.
    outboundHasActed: mapVar("Envelopes", boolType(), lit(false)),
    // F1-heal: has the connector-artifact drain materialized a LIVE anchor
    // from this envelope's artifact (`connector_artifact.anchor_id` non-
    // null). Never reset. This is the SOLE guard the heal's atomic
    // conditional UPDATE checks (`WHERE anchor_id IS NULL`) — once true, a
    // forged/mismatched row can never again be healed, only flagged.
    anchorMaterialized: mapVar("Envelopes", boolType(), lit(false)),
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

    // ADVERSARIAL ACTION: a same-tenant attacker self-POSTs a forged
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

    // F1-heal: the connector-artifact drain (jobs/connector-artifact-
    // drain.ts) materializes a LIVE anchor from this envelope's artifact —
    // independently of which path created it, and independently of the
    // outbound job's own timing. This is the action that can race ahead of
    // `outboundHealsForgery` and flip which of the two mutually-exclusive
    // "outbound loses the race" outcomes below is enabled.
    materializeAnchorFromArtifact: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap("anchorMaterialized", param("e"), lit(true)),
      ],
    },

    // F1-heal: the outbound side's own write attempt arrives AFTER the slot
    // is already owned by an inbound row (legitimate OR forged — see header
    // on the deliberate, inherited over-inclusiveness), and the row has NOT
    // yet materialized a live anchor. Models `enqueueSignedDocument`'s
    // read-back-and-compare PLUS its ONE atomic conditional
    // `UPDATE ... WHERE anchor_id IS NULL` succeeding: the verified fetched
    // fingerprint supersedes the declared one, exactly as if outbound had
    // won outright. Mutually exclusive with `outboundLosesRaceUnhealed`
    // below on `anchorMaterialized[e]`'s current value — never both enabled
    // for the same envelope at the same time.
    outboundHealsForgery: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(eq(index(artifactOwner, param("e")), lit("OUTBOUND"))),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap("conflictDetected", param("e"), lit(true)),
        setMap("outboundHasActed", param("e"), lit(true)),
        setMap("fingerprintClass", param("e"), lit("REAL")),
        setMap("artifactOwner", param("e"), lit("OUTBOUND")),
      ],
    },

    // F1-heal: the same read-back-and-compare, but the row's live anchor was
    // ALREADY materialized (by `materializeAnchorFromArtifact`, which fired
    // before this could). The atomic conditional UPDATE's WHERE clause
    // matches zero rows — `supersedeRow == null` in the real code — so the
    // row is left EXACTLY as-is (no fingerprintClass/artifactOwner change):
    // never silently rewrite a live anchor's fingerprint. Only the loud
    // detection signal fires — PR #2476's original floor, preserved
    // unchanged for this sub-case.
    outboundLosesRaceUnhealed: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(eq(index(artifactOwner, param("e")), lit("OUTBOUND"))),
        index(anchorMaterialized, param("e")),
      ),
      updates: [
        setMap("conflictDetected", param("e"), lit(true)),
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },

    // The harmless case: an outbound retry (job redelivery) finds ITS OWN
    // prior real write already in place — whether that write is the
    // ORIGINAL `materializeOutbound` win or a PRIOR `outboundHealsForgery`
    // supersession makes no difference here; both leave artifactOwner =
    // OUTBOUND / fingerprintClass = REAL, which this action's guard reads.
    // Nothing to detect, nothing changes — recorded only so `outboundHasActed`
    // reflects reality on this branch too.
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

    // F1-heal STRENGTHENED property (was `outboundNeverSilentlyAcceptsForgery`
    // in PR #2476's detection-only form — same name, real guarantee upgraded
    // in place). Once the outbound side has acted for an envelope (a clean
    // win, a heal, or an unhealed refusal), the persisted fingerprint is
    // EITHER real (outbound's own measured value, whether it won outright or
    // was superseded by the heal) OR the row is a documented, EXPLAINED
    // exception: a conflict was detected AND a live anchor had already
    // materialized before the heal could run — the ONE case the CTO ruling
    // carves out as a separate integrity event rather than an auto-heal
    // target. Every other combination — in particular "conflict detected,
    // NOT healed, NOT because of materialization" — is now UNREACHABLE, and
    // TLC proves it: a forged declared hash never permanently stands
    // unchallenged for any reason other than that documented exception.
    //
    // Deliberately still gated on outboundHasActed[e] (see header: this is
    // NOT a claim about the legitimate window before the outbound side has
    // even tried yet — `forgeInbound` landing and no outbound action having
    // run for that envelope is realistic timing, not a bug).
    outboundNeverSilentlyAcceptsForgery: {
      description:
        "Once the outbound side has acted for an envelope, its own real fingerprint persisted (won outright or healed) OR the row is the documented already-materialized exception (conflict detected AND anchor already live) — never any other unhealed-forgery state",
      formula: forall("Envelopes", "e",
        or(
          not(index(outboundHasActed, param("e"))),
          eq(index(fingerprintClass, param("e")), lit("REAL")),
          and(
            index(conflictDetected, param("e")),
            index(anchorMaterialized, param("e")),
          ),
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
          // F1-heal added a THIRD per-envelope boolean (anchorMaterialized)
          // on top of the F1 extension's two — raised again from the F1
          // extension's 30_000.
          maxEstimatedStates: 100_000,
        },
      },
      nightly: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 4 }),
        },
        // Raw product at 4 envelopes is well over the tool's 100_000
        // graph-equivalence cap — same shape as the pre-existing fix
        // documented in agents.md for
        // drainRunAccounting/calibrationWorkflow/partnerProvisioning's
        // nightly tiers: disable graph-equivalence and budget against the
        // real raw product instead. `pr` tier above keeps equivalence on.
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 100_000_000,
        },
      },
    },
  },
});

export default docusignInboundDedupMachine;
