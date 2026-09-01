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
const capturedFingerprintClass = variable("capturedFingerprintClass");
const anchorFingerprintClass = variable("anchorFingerprintClass");

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
 * TOCTOU EXTENSION (code review of `jobs/connector-artifact-drain.ts`,
 * 2026-09-01 — closes the modelling gap that hid the bug this same review
 * found): everything above modeled `materializeAnchorFromArtifact` as ONE
 * atomic action reading CURRENT state (`fingerprintClass[e]` at the moment
 * it fires) — which is exactly why a 121-state, fully-verified proof still
 * could not see a real bug in the actual TypeScript: the drain's batch-read
 * `row` object was captured ONCE, then handed unchanged through
 * `resolveOrgActorUserId`/`findExistingEnvelopeAnchor` (real awaited DB
 * round trips) into the `anchors` INSERT — a snapshot-then-act shape this
 * machine had no variables to express. The code fix (this same PR) makes
 * the CLAIM itself the point of truth (`claimRow`'s `UPDATE ... RETURNING`
 * replaces the batch-read snapshot), which closes the LARGEST instance of
 * this window (up to `DRAIN_LIMIT_MAX`=200 earlier rows' worth of awaited
 * work in the same batch). It does NOT make materialization atomic end to
 * end: `claimRow`'s capture and the eventual `anchors` INSERT are still two
 * separate statements, separated by `resolveOrgActorUserId` and
 * `findExistingEnvelopeAnchor`, and the heal's own guard
 * (`WHERE anchor_id IS NULL`) has no notion of "this row was already
 * claimed/captured" — only of whether an anchor exists yet.
 *
 * This extension makes that two-step shape modelable: `captureArtifactFingerprint`
 * (models `claimRow`'s `RETURNING`) and `mintAnchorFromCapture` (models the
 * `anchors` INSERT, using the CAPTURED value) REPLACE the single
 * `materializeAnchorFromArtifact` action. `outboundHealsForgery` /
 * `outboundLosesRaceUnhealed` are UNCHANGED — still gated only on
 * `anchorMaterialized[e]`, exactly matching the real `anchor_id IS NULL`
 * guard — so both remain independently schedulable in the gap between
 * capture and mint. New invariant `anchorNeverMintedFromSupersededFingerprint`
 * asserts what actually matters: no anchor is ever minted holding a FORGED
 * fingerprint class.
 *
 * RESULT — see VERIFICATION STATUS below. If the check fails, that
 * counterexample is a real, disclosed residual finding, not a defect to
 * paper over: it says the code fix in this PR closes the batch-order-
 * dependent window (the one the attack this PR fixes actually depends on)
 * but a SMALLER window — bounded by `resolveOrgActorUserId` +
 * `findExistingEnvelopeAnchor` alone, with no batch-of-up-to-200-rows
 * multiplier — remains open as a distinct, smaller-magnitude follow-up. The
 * invariant is NOT weakened to force a pass either way.
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
 * VERIFICATION STATUS (2026-09-01, TOCTOU extension) — FAILS, and this is a
 * disclosed, real finding, NOT weakened away. `npx tla-precheck check
 * docusignInboundDedup.machine.ts`, run from inside `machines/` (see
 * agents.md's "how to invoke check" entry — repo-root invocation fails on
 * TS5096/TS5103 for unrelated cwd-resolution reasons, not a defect in this
 * file):
 *
 *   certificateVersion: 2; machine: DocusignInboundDedup; tier: pr;
 *   proofPassed: FALSE; invariantsChecked: [atMostOneArtifactOwner,
 *   outboundNeverSilentlyAcceptsForgery,
 *   anchorNeverMintedFromSupersededFingerprint]; deadlockChecked: true;
 *   graphEquivalenceAttempted: false (pr tier now budgets against the raw
 *   product — see proof.tiers.pr comment); machineSha256
 *   e4b22f11a4d55979d3ad977964738d78b80b06c8d6c167513eeff7846cd9ff47.
 *   TLC halts on the FIRST violation it finds (not full exploration): 506
 *   states generated, 200 distinct states found, 55 left on queue, search
 *   depth 8, "Finished in 00s".
 *
 *   Error: Invariant anchorNeverMintedFromSupersededFingerprint is violated.
 *   Counterexample trace (envelope e2; e1 is an uncontested envelope present
 *   only to confirm the violation is NOT a cross-envelope leak):
 *     1. materializeOutbound(e1)      — unrelated envelope, real fingerprint.
 *     2. forgeInbound(e2)             — attacker wins the race: artifactOwner
 *                                        =INBOUND, fingerprintClass=FORGED.
 *     3. captureArtifactFingerprint(e2) — the drain's claim captures the
 *                                        CURRENTLY-forged value:
 *                                        capturedFingerprintClass=FORGED.
 *     4. outboundHealsForgery(e2)     — the outbound job's heal fires
 *                                        (anchorMaterialized[e2] is still
 *                                        false, so its guard is satisfied):
 *                                        fingerprintClass:=REAL,
 *                                        artifactOwner:=OUTBOUND. The
 *                                        CAPTURED value is untouched by this
 *                                        — it is a snapshot in the drain's
 *                                        memory, not a live read.
 *     5. mintAnchorFromCapture(e2)    — the drain mints the anchor from the
 *                                        STALE capture: anchorMaterialized
 *                                        :=true, anchorFingerprintClass:=
 *                                        FORGED. Now fingerprintClass[e2]=
 *                                        REAL but anchorFingerprintClass[e2]
 *                                        =FORGED — VIOLATION.
 *
 *   This is the SAME bug class the code review found in
 *   `jobs/connector-artifact-drain.ts`, formally reproduced with the
 *   BATCH-ORDER-DEPENDENT portion of the window removed by this PR's
 *   `claimRow` fix (step 3 above models `claimRow`'s `RETURNING`, already
 *   the fresh-at-claim-time read) — the counterexample only needs the
 *   SMALLER residual window between capture (claim) and mint (the `anchors`
 *   INSERT), bounded by `resolveOrgActorUserId` + `findExistingEnvelopeAnchor`
 *   in the real code, with no batch-of-up-to-200-rows multiplier. TLC proves
 *   that residual window is still sufficient in principle: if
 *   `outboundHealsForgery` (real code: the F1-heal `UPDATE ...  WHERE
 *   anchor_id IS NULL`) executes strictly between `claimRow`'s `RETURNING`
 *   and the `anchors` INSERT for the SAME row, the minted anchor still
 *   carries the pre-heal (forged) value. Disclosed, unresolved, tracked as a
 *   follow-up — NOT fixed by this PR, whose scope was closing the
 *   batch-read-snapshot window per the code review's explicit "FIX
 *   (primary)". A full fix needs either a freshness re-check immediately
 *   before the `anchors` INSERT or folding claim+materialize+mark into one
 *   atomic DB operation (a genuinely bigger, separate change).
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
    // TOCTOU EXTENSION (code review, 2026-09-01 — closes the modelling gap
    // that hid the drain's stale-snapshot bug; see the header section below).
    // What the drain's own CAS claim (`claimRow`'s `UPDATE ... RETURNING`)
    // read as this envelope's fingerprint class AT CAPTURE TIME. NONE until
    // captured; never reset once set (a row is captured at most once per
    // materialization attempt — the same "first guard" pattern as
    // `artifactCreated` above).
    capturedFingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
    // TOCTOU EXTENSION: the fingerprint class ACTUALLY baked into the
    // materialized anchor — copied from `capturedFingerprintClass` at mint
    // time, NOT re-read from the (possibly since-healed) live
    // `fingerprintClass`. This is the variable that makes the bug
    // observable: `fingerprintClass[e]` can move on after capture (the heal
    // can still fire — its guard is `anchor_id IS NULL`, i.e.
    // `not(anchorMaterialized[e])`, which says nothing about whether this
    // envelope's row content has already been captured into someone's
    // memory), while `anchorFingerprintClass[e]` is frozen at whatever was
    // true at capture time.
    anchorFingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
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

    // TOCTOU EXTENSION (code review, 2026-09-01): the connector-artifact
    // drain's CLAIM step (`claimRow`'s `UPDATE ... RETURNING`) — the drain
    // reads this envelope's CURRENT fingerprint class into memory ("captures"
    // it). This is now a SEPARATE, independently-schedulable action from
    // minting the anchor below — see `mintAnchorFromCapture`'s comment for
    // why splitting this in two is the entire point of the extension.
    captureArtifactFingerprint: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        eq(index(capturedFingerprintClass, param("e")), lit("NONE")),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap(
          "capturedFingerprintClass",
          param("e"),
          index(fingerprintClass, param("e")),
        ),
      ],
    },

    // TOCTOU EXTENSION: the connector-artifact drain (jobs/connector-
    // artifact-drain.ts) mints the anchor from the CAPTURED value — never a
    // fresh re-read of `fingerprintClass[e]` — mirroring
    // `defaultMaterializeAnchor`'s real signature: it receives the row
    // object `drainOneClaimedRow` handed it (frozen at claim time) and never
    // queries `connector_artifact` again before the `anchors` INSERT.
    // Real wall-clock time separates capture from mint
    // (`resolveOrgActorUserId`, `findExistingEnvelopeAnchor` — both awaited
    // DB round trips), during which `outboundHealsForgery` /
    // `outboundLosesRaceUnhealed` remain independently enabled (their guard
    // is `not(anchorMaterialized[e])`, i.e. the heal's real `anchor_id IS
    // NULL` WHERE clause — it has no notion of "someone already captured a
    // snapshot"). THIS is the modelling gap the original single atomic
    // `materializeAnchorFromArtifact` action (removed by this extension)
    // could not express: reading current state and minting were ONE
    // indivisible step, so no interleaving — and therefore no staleness —
    // was ever reachable.
    mintAnchorFromCapture: {
      params: { e: "Envelopes" },
      guard: and(
        not(eq(index(capturedFingerprintClass, param("e")), lit("NONE"))),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap("anchorMaterialized", param("e"), lit(true)),
        setMap(
          "anchorFingerprintClass",
          param("e"),
          index(capturedFingerprintClass, param("e")),
        ),
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

    // TOCTOU EXTENSION invariant (code review, 2026-09-01). Deliberately NOT
    // "an anchor is never materialized holding a FORGED fingerprint class" —
    // that formula is TOO STRONG: a forged row that wins the enqueue race
    // and gets captured-and-minted before the outbound job's heal ever gets
    // a chance to run is the PRE-EXISTING, DOCUMENTED "already-materialized"
    // exception (`outboundLosesRaceUnhealed` — an accepted operator-
    // reconciliation case, not this bug). The property actually violated by
    // a stale snapshot is a RELATIONSHIP: what got baked into the anchor
    // must still match what is CURRENTLY true of the artifact. Because
    // `fingerprintClass[e]` can only change (via `outboundHealsForgery`)
    // BEFORE `anchorMaterialized[e]` becomes true — both heal actions guard
    // on `anchorMaterialized[e]` in opposite directions — this comparison is
    // stable for the rest of the run once it holds; a violation ONLY becomes
    // reachable when a heal lands strictly between `captureArtifactFingerprint`
    // and `mintAnchorFromCapture` for the SAME envelope, i.e. exactly the
    // TOCTOU window this extension exists to make modelable.
    anchorNeverMintedFromSupersededFingerprint: {
      description:
        "Once an anchor is materialized for an envelope, its baked-in fingerprint class must equal the artifact's CURRENT fingerprint class — a heal that lands between capture and mint must never leave the anchor holding a value the artifact itself has since moved past",
      formula: forall("Envelopes", "e",
        or(
          not(index(anchorMaterialized, param("e"))),
          eq(
            index(anchorFingerprintClass, param("e")),
            index(fingerprintClass, param("e")),
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
        // TOCTOU EXTENSION (code review, 2026-09-01): the two new 3-valued
        // per-envelope variables (`capturedFingerprintClass`,
        // `anchorFingerprintClass`) raise the per-envelope raw combo count
        // from the F1-heal extension's 2*3*3*2*2*2=144 to 144*3*3=1,296.
        // Raw product at 2 envelopes is 1,296^2 = 1,679,616 — over the
        // tool's 100,000 graph-equivalence cap, so — same shape as the
        // pre-existing fix documented in agents.md for
        // drainRunAccounting/calibrationWorkflow/partnerProvisioning's
        // nightly tiers — `pr` now disables graph-equivalence too and
        // budgets against the real raw product. This is a real, disclosed
        // trade-off (this machine's `pr` tier previously ran WITH
        // equivalence checking; it no longer does), not an attempt to dodge
        // the cap — reducing `Envelopes` below 2 would remove the
        // uncontested-vs-contested interleaving the header above explains
        // this domain size exists to cover.
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 2_000_000,
        },
      },
      nightly: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 4 }),
        },
        // Raw product at 4 envelopes (1,296^4 ≈ 2.82e12) is far over the
        // tool's 100,000 graph-equivalence cap — same shape as the
        // pre-existing fix documented in agents.md for
        // drainRunAccounting/calibrationWorkflow/partnerProvisioning's
        // nightly tiers: disable graph-equivalence and budget against the
        // real raw product instead.
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 3_000_000_000_000,
        },
      },
    },
  },
});

export default docusignInboundDedupMachine;
