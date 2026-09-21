import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
  or,
  not,
  isin,
  setOf,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
} from "tla-precheck";

// Variable references
const cursorState = variable("cursorState");
const lockHeld = variable("lockHeld");
const pendingPush = variable("pendingPush");
const walkProgress = variable("walkProgress");
const ledgerHasEntry = variable("ledgerHasEntry");
const jobEnqueued = variable("jobEnqueued");
const cursorAdvancedThisWalk = variable("cursorAdvancedThisWalk");
const problemObservable = variable("problemObservable");
// Fix-round item 4A/B (independent TLA + simplify pass on head 7ddf6294b —
// verifier's real counterexample, see module doc comment).
const lostLeaseWhileWalking = variable("lostLeaseWhileWalking");
// Round-3 fix (see module doc comment's "ROUND-3 FIX" paragraph): an
// unconditional witness written by the REAL `beginRunSkippedLocked` action
// every time it fires, cleared only by the REAL `beginRun` action's
// legitimate consumption of `pendingPush`. Structurally identical to how
// `lostLeaseWhileWalking` already achieves real teeth in this same file —
// NOT a second, disconnected canary action/toggle (that was round 2's
// mistake, corrected here).
const justSkippedLocked = variable("justSkippedLocked");
// Fix-round item 4A CAS sub-model (advancePageToken's compare-and-swap).
const persistedGen = variable("persistedGen");
const startedFromGen = variable("startedFromGen");
const secondWalkerStartedFromGen = variable("secondWalkerStartedFromGen");
const everReachedG2 = variable("everReachedG2");

/**
 * Drive changes-feed cursor lifecycle — SCRUM-2903/3661/5094/2330 (orchestrator
 * TLA PreCheck requirement on the changes.list fields-mask fix PR).
 *
 * Models ONE integration's per-integration state as driven by
 * `services/worker/src/api/v1/webhooks/drive.ts` (push ingress) →
 * `integrations/connectors/drive-changes-runner.ts` (`runDriveChanges`: single-
 * flight lease + token load) → `integrations/connectors/drive-changes-processor.ts`
 * (`processDriveChanges`: the bounded page walk, the revision ledger reserve/
 * enqueue/compensate sequence, and the 410/404 re-bootstrap this PR adds).
 *
 * ONE domain element = one integration. Concurrency (duplicate AND overlapping
 * push notifications for the SAME integration) is modeled NOT via a second
 * domain but by making `pushArrives` independently re-firable at any time —
 * Drive's push protocol is itself content-free ("something changed"; it never
 * says how many things or which), so two, three, or ten pushes for the same
 * integration collapse to the same `pendingPush` boolean in reality, and TLC
 * explores every interleaving of "another push lands while a run is already in
 * flight" for free by re-firing that action between the other actions below.
 * This mirrors `docusignInboundDedup.machine.ts`'s treatment of "one shared
 * mutable row, many independently-schedulable actors."
 *
 * CODE ↔ MODEL MAP (fix-round update — `pendingPush` now corresponds to a
 * REAL persisted marker, not a modeling fiction):
 *
 *   | Model variable/action              | Real code (drive-changes-runner.ts unless noted) |
 *   |-------------------------------------|----------------------------------------------------|
 *   | `pendingPush`                       | `job_queue.attempts` on the SAME lease row (the dirty/rerun-requested marker, fix-round item 3) — `markLeaseDirty`/`checkAndClearLeaseDirty` |
 *   | `beginRunSkippedLocked`             | the `{skipped:'locked'}` branch — now calls `markLeaseDirty` instead of dropping the push |
 *   | `lockHeld`                          | the `withRunLease` per-integration lease (`job_queue` row, `driveChangesRunLeaseSpec`) |
 *   | `leaseTtlExpiresWhileWalking`       | heartbeat renewal failing / TTL lapsing despite an active walk (`RunLeaseContext` doc comment, jobs/run-lease.ts) |
 *   | `beginRunWhileAlreadyWalking`       | a fresh `withRunLease` acquire winning the now-free lock while the OLD holder is still logically mid-walk |
 *   | `leaseCheckCatchesLoss`             | `processDriveChanges`'s per-page `deps.stillHoldsLease()` check (`stillHoldsRunLease`, jobs/run-lease.ts) |
 *   | `persistedGen`/`startedFromGen`     | `org_integrations.last_page_token` / the `expected_page_token` `advancePageToken`'s CAS captured at run start |
 *   | `runDriveReconciliationSweep`       | NOT separately modeled here — it is bounded, best-effort, and outside this machine's per-integration scope; see PR body |
 *
 * WHAT THIS DOES NOT PROVE (read before citing this machine as covering more
 * than it does):
 *
 *   - No wall-clock or counting. The DSL has no arithmetic (see
 *     `machines/agents.md`'s `aiCreditsPeriodProvision` entry), so `WALKING(page
 *     n)` from the task description is abstracted to a 3-valued `walkProgress`
 *     (NONE / PARTIAL / AT_CAP) rather than a real page counter, and
 *     connector-health's 6-hour `cursor_stale` threshold has no time variable
 *     here at all — `problemObservable` is a structural stand-in for "a real
 *     failure exists and is flagged," not a proof that the dashboard actually
 *     lights up within any particular number of hours.
 *   - No temporal/liveness operators exist in this DSL at all (confirmed
 *     against `references/dsl-cheatsheet.md`: 13 expression kinds, all
 *     state-predicate/safety-style — no `eventually`/`leadsTo`/fairness).
 *     Requirement 3's "a backlog larger than the per-run cap is eventually
 *     drained" is therefore NOT provable here as a genuine liveness property.
 *     The closest SOUND abstraction: (a) `capReleasesResources` is a SAFETY
 *     invariant proving the cap-reached state always frees the lock and exits
 *     WALKING, so a later push CAN always start a fresh draining run — it does
 *     not prove one ever will; and (b) `check`'s deadlock check (left ON, not
 *     disabled) independently confirms the full reachable state graph never
 *     reaches a world with zero enabled actions, which is the standard TLC
 *     proxy for "the model can't get permanently stuck," short of true
 *     fairness-based liveness.
 *   - The revision ledger's real backing is a Postgres UNIQUE(integration,
 *     file, revision) constraint — an atomic, storage-level guarantee.
 *     `ledgerHasEntry`/`reserveLedgerEntry`'s guard model the OBSERVABLE
 *     CONSEQUENCE of that constraint (mutual exclusion on the reservation),
 *     not the constraint's own atomicity, which is a database property no
 *     application-level model can un-prove or re-prove.
 *   - Google's actual `changes.list` semantics (what a 410 truly discards,
 *     whether a given push maps to one or many underlying file revisions) are
 *     taken as given per Google's documented contract — see the fields-mask
 *     fix PR body for the citations (developers.google.com WebFetch, since the
 *     google-developer-knowledge MCP returned an invalid-API-key error this
 *     session). This machine does not model Drive's own internals.
 *   - `persistedGen`/`startedFromGen`/`secondWalkerStartedFromGen`/
 *     `everReachedG2` are a DELIBERATELY STANDALONE 3-generation (G0→G1→G2)
 *     sub-model of `advancePageToken`'s compare-and-swap, decoupled from the
 *     main `cursorState` lifecycle — the two walkers' commit actions
 *     (`walkerABegins`/`walkerBBegins`/`commitG0toG1ForA`/`commitG0toG1ForB`/
 *     `commitG1toG2ForB`) do NOT require `lockHeld`, because the CAS is a
 *     SEPARATE, DB-level defense-in-depth layer that must hold even if the
 *     lease layer had a bug — that is the whole point of defense-in-depth,
 *     and coupling the two sub-models would only prove the CAS works GIVEN
 *     the lease already works, which is a weaker and less honest claim.
 *
 * FIX-ROUND FINDING (independent TLA pass on head 7ddf6294b): the SHIPPED
 * lease design at that head — `acquireRunLease`/`releaseRunLease` with a
 * flat, un-renewed TTL — was PROVEN UNSAFE by this exact machine once
 * extended with `leaseTtlExpiresWhileWalking` + `beginRunWhileAlreadyWalking`
 * (7-step counterexample: bootstrapCursor → pushArrives → beginRun →
 * leaseTtlExpiresWhileWalking → pushArrives → beginRunWhileAlreadyWalking →
 * a commit action firing without re-checking lock ownership). The fix
 * (`withRunLease` heartbeat + `stillHoldsRunLease` per-page re-check +
 * CAS'd `advancePageToken`) is what closes it — see `noConcurrentWalkers`
 * and `cursorNeverRewinds` below, and the mutation-test results recorded in
 * `machines/agents.md`.
 *
 * ROUND-2 FIX, THEN CORRECTED AGAIN BY ROUND-3 (both rounds found
 * `pendingPushNeverDroppedWhileLocked` unbacked — read this before trusting
 * ANY earlier claim about this invariant in git history or the PR body):
 *
 * Round 2 found `pendingPushNeverDroppedWhileLocked` VACUOUS at head
 * `bc6c84c80` — its subject variable was declared and read by the invariant
 * but never assigned `true` by any action in the model's actual action set.
 * Round 2's "fix" added a second, gated canary action
 * (`beginRunSkippedLockedRegressionDropsPush`, gated on a
 * `pushDropRegressionEnabled` toggle) parallel to the REAL
 * `beginRunSkippedLocked` action, and mutation-tested by flipping the
 * toggle. Round 3 found that this "fix" was STILL a defect: mutating the
 * REAL `beginRunSkippedLocked` action (dropping `pendingPush` there, with
 * the toggle left at its shipped `false`) produced a clean
 * `proofPassed: true` with IDENTICAL state counts — the invariant and the
 * deadlock check reacted to neither, because they only ever observed the
 * parallel, permanently-disabled canary, never the real action it was
 * supposed to stand in for. A constant-false toggle proves only that the
 * toggle is false.
 *
 * THE REAL FIX (round 3): deleted `beginRunSkippedLockedRegressionDropsPush`
 * and `pushDropRegressionEnabled` entirely — no second code path, no gate.
 * `justSkippedLocked` is a witness written UNCONDITIONALLY by the ONE real
 * `beginRunSkippedLocked` action every time it fires, and cleared ONLY by
 * the ONE real `beginRun` action's legitimate consumption of `pendingPush`
 * — the exact same pattern `lostLeaseWhileWalking` already uses elsewhere
 * in this file (set by the real `leaseTtlExpiresWhileWalking` action,
 * cleared by the real recovery/handoff actions). The invariant is
 * redefined over this real state: `justSkippedLocked[i] ⇒ pendingPush[i]`
 * — whenever the locked-skip handler has fired and its legitimate consumer
 * (`beginRun`) hasn't run since, the push must still be pending. Because
 * `justSkippedLocked` is written by the SAME action, in the SAME update
 * list, as the `pendingPush` line under mutation test, a single-line
 * mutation to `beginRunSkippedLocked`'s `pendingPush` value now decouples
 * the two writes immediately, visible in the very next state — no second
 * action, no toggle, no canary. See `machines/agents.md`'s round-3 entry
 * for the real RED trace this produces.
 */
export const driveChangesCursorMachine = defineMachine({
  version: 2,
  moduleName: "DriveChangesCursor",
  variables: {
    cursorState: mapVar(
      "Integrations",
      enumType("NO_CURSOR", "BOOTSTRAPPED", "WALKING", "FAILED_PAGE", "TOKEN_EXPIRED", "ADVANCED"),
      lit("NO_CURSOR"),
    ),
    // Single-flight guard (drive-changes-runner.ts's job_queue-backed
    // per-integration run lease, this PR).
    lockHeld: mapVar("Integrations", boolType(), lit(false)),
    // A push notification is outstanding and wants a run. Re-firable —
    // models duplicate AND concurrent notifications (see module doc comment).
    pendingPush: mapVar("Integrations", boolType(), lit(false)),
    // Bounded per-run page-walk progress (SAFE_PAGE_LIMIT abstraction — no
    // arithmetic available, so NONE/PARTIAL/AT_CAP stands in for "0 extra
    // pages seen" / "more pages known, under the cap" / "hit the cap with
    // backlog still remaining").
    walkProgress: mapVar("Integrations", enumType("NONE", "PARTIAL", "AT_CAP"), lit("NONE")),
    // The CURRENT frontier change's drive_revision_ledger reservation.
    ledgerHasEntry: mapVar("Integrations", boolType(), lit(false)),
    // The CURRENT frontier change's google_drive.file_changed job enqueue.
    jobEnqueued: mapVar("Integrations", boolType(), lit(false)),
    // Whether THIS walk's progress has been durably committed to the
    // persisted cursor (advancePageToken actually called) — invariant (1)'s
    // subject.
    cursorAdvancedThisWalk: mapVar("Integrations", boolType(), lit(false)),
    // Whether a currently-real failure/expiry is flagged somewhere an
    // operator can see it (Sentry via reportDriveProcessingFailure and/or
    // connector-health.ts) — invariant (5)'s subject.
    problemObservable: mapVar("Integrations", boolType(), lit(false)),
    // Fix-round item 4A: set true the instant a walk's lease is lost while
    // it is still (as far as its own local state knows) WALKING; cleared
    // only by a clean recovery (leaseCheckCatchesLoss) or a legitimate new
    // holder taking over (beginRunWhileAlreadyWalking). `noConcurrentWalkers`
    // reads this.
    lostLeaseWhileWalking: mapVar("Integrations", boolType(), lit(false)),
    // Round-3 fix (see module doc comment's "ROUND-3 FIX" paragraph, and
    // the corrected `pendingPushNeverDroppedWhileLocked` invariant below).
    // Written UNCONDITIONALLY by the ONE real `beginRunSkippedLocked`
    // action every time it fires; cleared ONLY by the ONE real `beginRun`
    // action's legitimate consumption of `pendingPush`. Exactly the same
    // set/clear pattern `lostLeaseWhileWalking` already uses two variables
    // up — no second action, no gate, no toggle.
    justSkippedLocked: mapVar("Integrations", boolType(), lit(false)),
    // Fix-round item 4A CAS sub-model — see the module doc comment's
    // "DELIBERATELY STANDALONE" paragraph. Three symbolic generations of
    // the persisted page token; G0 is the initial value.
    persistedGen: mapVar("Integrations", enumType("G0", "G1", "G2"), lit("G0")),
    // Captured by walkerABegins = persistedGen at that instant (mirrors
    // `expected_page_token` in the real `advancePageToken` call).
    startedFromGen: mapVar("Integrations", enumType("G0", "G1", "G2"), lit("G0")),
    // The SAME capture for a second, independently-schedulable walker.
    secondWalkerStartedFromGen: mapVar("Integrations", enumType("G0", "G1", "G2"), lit("G0")),
    // One-way ratchet: true forever once G2 has ever been the persisted
    // value. `cursorNeverRewinds` checks that persistedGen can never
    // un-reach G2 once this is true.
    everReachedG2: mapVar("Integrations", boolType(), lit(false)),
  },
  actions: {
    // OAuth-callback-time bootstrap (api/v1/integrations/drive-oauth.ts).
    bootstrapCursor: {
      params: { i: "Integrations" },
      guard: eq(index(cursorState, param("i")), lit("NO_CURSOR")),
      updates: [setMap("cursorState", param("i"), lit("BOOTSTRAPPED"))],
    },
    // Hourly renewal-sweep bootstrap (drive-subscription-renewal.ts) — same
    // modeled effect as bootstrapCursor, kept as a separately-named action
    // per the orchestrator's explicit ask to include "channel renewal" as a
    // distinct modeled event; the real code path is genuinely different
    // (a different cron vs. the OAuth callback) even though this machine's
    // cursor-state variables land in the same place either way.
    channelRenewalBootstraps: {
      params: { i: "Integrations" },
      guard: eq(index(cursorState, param("i")), lit("NO_CURSOR")),
      updates: [setMap("cursorState", param("i"), lit("BOOTSTRAPPED"))],
    },
    // Drive push notification arrives (webhooks/drive.ts). Always enabled —
    // re-firing while already pending models a DUPLICATE or CONCURRENT
    // notification; both collapse into the same outstanding-work signal.
    pushArrives: {
      params: { i: "Integrations" },
      guard: lit(true),
      updates: [setMap("pendingPush", param("i"), lit(true))],
    },
    // runDriveChanges: single-flight lease acquired, walk begins. Guarded on
    // a bootstrapped-or-recoverable cursor AND the lock being free — a
    // concurrent beginRun for the SAME integration is simply NOT ENABLED
    // while lockHeld is true (this is how "another run holds the lease,
    // return skipped:'locked'" is expressed: as a disabled transition, not a
    // reachable bad state).
    beginRun: {
      params: { i: "Integrations" },
      guard: and(
        index(pendingPush, param("i")),
        not(index(lockHeld, param("i"))),
        isin(index(cursorState, param("i")), setOf(lit("BOOTSTRAPPED"), lit("ADVANCED"), lit("FAILED_PAGE"))),
      ),
      updates: [
        setMap("lockHeld", param("i"), lit(true)),
        setMap("pendingPush", param("i"), lit(false)),
        setMap("cursorState", param("i"), lit("WALKING")),
        setMap("walkProgress", param("i"), lit("NONE")),
        setMap("cursorAdvancedThisWalk", param("i"), lit(false)),
        // Round-3 fix: this is the ONE legitimate consumer of `pendingPush`
        // — clearing the witness here (and ONLY here) is what lets
        // `pendingPushNeverDroppedWhileLocked` distinguish "consumed
        // legitimately" from "dropped by the locked-skip handler" using
        // real state, not a parallel canary.
        setMap("justSkippedLocked", param("i"), lit(false)),
      ],
    },
    // Fix-round item 3: a push arrives while ANOTHER run already holds the
    // lease. Named explicitly (rather than left as a silently-disabled
    // `beginRun`) so its update list can express the REAL fix precisely —
    // `pendingPush` is deliberately left `lit(true)` (unconsumed, matching
    // `markLeaseDirty`'s real unconditional write) rather than reset to
    // false. Round-3 fix: ALSO sets `justSkippedLocked` unconditionally,
    // in the SAME update list as the `pendingPush` line — this is the
    // real witness `pendingPushNeverDroppedWhileLocked` now checks. A
    // single-line mutation to the `pendingPush` value below (the realistic
    // pre-item-3 regression) decouples the two writes immediately, visible
    // in the very next state; no second action or toggle is needed or
    // present (round 2's `beginRunSkippedLockedRegressionDropsPush`/
    // `pushDropRegressionEnabled` canary was deleted — see the module doc
    // comment's "ROUND-3 FIX" paragraph for why it didn't work).
    beginRunSkippedLocked: {
      params: { i: "Integrations" },
      guard: and(index(pendingPush, param("i")), index(lockHeld, param("i"))),
      updates: [
        setMap("pendingPush", param("i"), lit(true)), // <- the line under mutation test
        setMap("justSkippedLocked", param("i"), lit(true)), // unconditional witness that THIS action fired
      ],
    },
    // Fix-round item 4A (verifier finding on head 7ddf6294b): heartbeat
    // renewal fails / the TTL lapses despite the walk still being alive —
    // see `RunLeaseContext`'s doc comment in jobs/run-lease.ts. A real,
    // reachable event (a persistently-failing renewal, not a hypothetical).
    leaseTtlExpiresWhileWalking: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(lockHeld, param("i"))),
      updates: [
        setMap("lockHeld", param("i"), lit(false)),
        setMap("lostLeaseWhileWalking", param("i"), lit(true)),
      ],
    },
    // Fix-round item 4A: `processDriveChanges`'s per-page `stillHoldsLease()`
    // check, called before every page including the first. The ONLY
    // transition available to a walker once `lockHeld` drops while it is
    // still (as far as ITS OWN state knows) WALKING — every page-
    // continuation/commit action above now also requires `lockHeld`, so
    // this is structurally the sole way forward from that state. Aborts
    // cleanly: no advance, no further Drive call.
    leaseCheckCatchesLoss: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), not(index(lockHeld, param("i")))),
      updates: [
        setMap("cursorState", param("i"), lit("BOOTSTRAPPED")),
        setMap("walkProgress", param("i"), lit("NONE")),
        setMap("lostLeaseWhileWalking", param("i"), lit(false)),
      ],
    },
    // Fix-round item 4A: a FRESH acquire wins the now-free lock while the
    // OLD holder is still (locally) WALKING — a legitimate new holder
    // taking over after the old lease genuinely lapsed (exactly what a TTL
    // lease is FOR), racing against `leaseCheckCatchesLoss` above. Resets
    // `lostLeaseWhileWalking` — the NEW holder's own session is not tainted
    // by the PREVIOUS holder's staleness; it is protected by its own
    // `lockHeld`-gated actions and its own CAS (see the standalone
    // generation sub-model below).
    beginRunWhileAlreadyWalking: {
      params: { i: "Integrations" },
      guard: and(
        index(pendingPush, param("i")),
        not(index(lockHeld, param("i"))),
        eq(index(cursorState, param("i")), lit("WALKING")),
      ),
      updates: [
        setMap("lockHeld", param("i"), lit(true)),
        setMap("pendingPush", param("i"), lit(false)),
        setMap("lostLeaseWhileWalking", param("i"), lit(false)),
        // Round-3 fix: this is the SECOND real acquire path that
        // legitimately consumes `pendingPush` (the first is `beginRun`) —
        // a fresh `withRunLease` win is a genuine new holder starting
        // processing, not a dropped push, so it clears the witness the
        // same way `beginRun` does. Without this, a push skipped while
        // locked (`beginRunSkippedLocked`) that is later legitimately
        // picked up via THIS path (rather than plain `beginRun`) would
        // false-positive `pendingPushNeverDroppedWhileLocked`.
        setMap("justSkippedLocked", param("i"), lit(false)),
      ],
    },
    // drive_revision_ledger insert succeeds (reserve-then-confirm ordering).
    // Guard `not ledgerHasEntry` is the mutual-exclusion mechanism backing
    // invariant (2) — the SAME real-world UNIQUE(integration, file,
    // revision) constraint that makes a concurrent duplicate's insert 23505.
    reserveLedgerEntry: {
      params: { i: "Integrations" },
      // Fix-round item 4A: `lockHeld` added to every page-continuation/
      // commit-class guard below — a stale walker (lockHeld=false) can take
      // NO further action except `leaseCheckCatchesLoss`, matching
      // `processDriveChanges`'s per-page `stillHoldsLease()` re-check.
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        not(index(ledgerHasEntry, param("i"))),
      ),
      updates: [setMap("ledgerHasEntry", param("i"), lit(true))],
    },
    // "revision already in ledger" — named explicitly per the task's required
    // event list. A no-op on every variable: the classified change is the
    // SAME frontier revision a prior (possibly concurrent/duplicate) run
    // already reserved, so the 23505 conflict path counts a duplicate and
    // moves on without enqueuing again.
    changeAlreadyInLedger: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        index(ledgerHasEntry, param("i")),
      ),
      updates: [setMap("ledgerHasEntry", param("i"), index(ledgerHasEntry, param("i")))],
    },
    // enqueueRuleEvent + enqueueFileChangedJob both succeed.
    enqueueJobSucceeds: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        index(ledgerHasEntry, param("i")),
        not(index(jobEnqueued, param("i"))),
      ),
      updates: [setMap("jobEnqueued", param("i"), lit(true))],
    },
    // Either enqueue call fails/throws/returns null — processor's
    // compensating `deleteRevisionLedgerEntry` rolls the reservation back so
    // a retry is not permanently blocked by its own half-finished attempt.
    enqueueJobFailsCompensates: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        index(ledgerHasEntry, param("i")),
        not(index(jobEnqueued, param("i"))),
      ),
      updates: [setMap("ledgerHasEntry", param("i"), lit(false))],
    },
    // A DIFFERENT file/revision is classified later in the same walk, once
    // the prior frontier has been durably enqueued — frees the per-
    // integration reservation slot for the next one.
    newRevisionAppears: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        index(jobEnqueued, param("i")),
      ),
      updates: [
        setMap("ledgerHasEntry", param("i"), lit(false)),
        setMap("jobEnqueued", param("i"), lit(false)),
        setMap("walkProgress", param("i"), lit("PARTIAL")),
      ],
    },
    // changes.list returns nextPageToken — more pages remain, still WALKING.
    pageSucceedsWithMore: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(lockHeld, param("i"))),
      updates: [setMap("walkProgress", param("i"), lit("PARTIAL"))],
    },
    // A page fails (429/5xx/4xx-not-410) — drive-changes-processor.ts
    // re-throws WITHOUT calling advancePageToken. Lease released
    // (runDriveChanges's `finally`); the persisted cursor is untouched, so a
    // retry replays from the SAME committed token, never a skipped one.
    pageFailsMidWalk: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(lockHeld, param("i"))),
      updates: [
        setMap("cursorState", param("i"), lit("FAILED_PAGE")),
        setMap("lockHeld", param("i"), lit(false)),
        setMap("problemObservable", param("i"), lit(true)),
      ],
    },
    // SAFE_PAGE_LIMIT reached with backlog still remaining (the "first-run
    // flood" scenario) — the processor persists a PARTIAL commit (advances
    // to the last successfully-consumed token) rather than either losing
    // progress or looping unboundedly inside one webhook request.
    pageCapReached: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
        index(lockHeld, param("i")),
        eq(index(walkProgress, param("i")), lit("PARTIAL")),
      ),
      updates: [
        setMap("walkProgress", param("i"), lit("AT_CAP")),
        setMap("cursorAdvancedThisWalk", param("i"), lit(true)),
        setMap("lockHeld", param("i"), lit(false)),
        setMap("cursorState", param("i"), lit("BOOTSTRAPPED")),
        setMap("problemObservable", param("i"), lit(false)),
      ],
    },
    // Final page: no nextPageToken — advance to newStartPageToken.
    pageSucceedsFinal: {
      params: { i: "Integrations" },
      // Fix-round item 4A: `lockHeld` here is THE guard the verifier's
      // counterexample exploits when absent — see the module doc comment's
      // "FIX-ROUND FINDING" paragraph and the mutation-test record in
      // machines/agents.md.
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(lockHeld, param("i"))),
      updates: [
        setMap("cursorAdvancedThisWalk", param("i"), lit(true)),
        setMap("cursorState", param("i"), lit("ADVANCED")),
        setMap("lockHeld", param("i"), lit(false)),
        setMap("walkProgress", param("i"), lit("NONE")),
        setMap("problemObservable", param("i"), lit(false)),
      ],
    },
    // changes.list returns 410/404 "pageToken invalid/expired" — this PR's
    // new recovery path. Old cursor is abandoned as unrecoverable; lease
    // released so re-bootstrap can proceed on the NEXT push/run.
    tokenExpiresMidWalk: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(lockHeld, param("i"))),
      updates: [
        setMap("cursorState", param("i"), lit("TOKEN_EXPIRED")),
        setMap("lockHeld", param("i"), lit(false)),
        setMap("problemObservable", param("i"), lit(true)),
      ],
    },
    // changes.getStartPageToken succeeds; advancePageToken persists the
    // fresh token. This DOES commit a cursor value (a gap-accepting one —
    // changes made in the expired window are unrecoverable by definition,
    // see drive-changes-processor.ts's doc comment) — modeled as a genuine
    // commit, distinct from the "walk completed" commits above.
    rebootstrapAfterExpiry: {
      params: { i: "Integrations" },
      guard: eq(index(cursorState, param("i")), lit("TOKEN_EXPIRED")),
      updates: [
        setMap("cursorState", param("i"), lit("BOOTSTRAPPED")),
        setMap("cursorAdvancedThisWalk", param("i"), lit(true)),
        setMap("problemObservable", param("i"), lit(false)),
      ],
    },

    // ── CAS sub-model (fix-round item 4A part 2) ──────────────────────────
    // Standalone, decoupled from cursorState/lockHeld on purpose — see the
    // module doc comment. Directly models `DriveProcessorDb.advancePageToken`'s
    // compare-and-swap: `WHERE last_page_token = expected_page_token`.
    walkerABegins: {
      params: { i: "Integrations" },
      guard: lit(true),
      updates: [setMap("startedFromGen", param("i"), index(persistedGen, param("i")))],
    },
    walkerBBegins: {
      params: { i: "Integrations" },
      guard: lit(true),
      updates: [setMap("secondWalkerStartedFromGen", param("i"), index(persistedGen, param("i")))],
    },
    // Walker A's commit attempt from G0. The CAS conjunct
    // (`persistedGen[i] = 'G0'`) is THE line the mutation test removes to
    // demonstrate a real rewind — see machines/agents.md for the recorded
    // counterexample and restored-GREEN result.
    commitG0toG1ForA: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(startedFromGen, param("i")), lit("G0")),
        eq(index(persistedGen, param("i")), lit("G0")),
      ),
      updates: [setMap("persistedGen", param("i"), lit("G1"))],
    },
    // Walker B's first hop (G0 -> G1) — B tracks its OWN advancing position,
    // the same way the real code's local `pageToken` variable walks forward
    // page by page while `expected_page_token` stays pinned to the run's
    // ORIGINAL starting value.
    commitG0toG1ForB: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(secondWalkerStartedFromGen, param("i")), lit("G0")),
        eq(index(persistedGen, param("i")), lit("G0")),
      ),
      updates: [
        setMap("persistedGen", param("i"), lit("G1")),
        setMap("secondWalkerStartedFromGen", param("i"), lit("G1")),
      ],
    },
    // Walker B's second hop (G1 -> G2) — this is the commit whose result a
    // stale walker A (still holding `startedFromGen = G0`) would REWIND if
    // `commitG0toG1ForA` were allowed to fire without its own CAS conjunct.
    commitG1toG2ForB: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(secondWalkerStartedFromGen, param("i")), lit("G1")),
        eq(index(persistedGen, param("i")), lit("G1")),
      ),
      updates: [
        setMap("persistedGen", param("i"), lit("G2")),
        setMap("everReachedG2", param("i"), lit(true)),
      ],
    },
  },
  invariants: {
    // (1) The persisted cursor never advances past a page that was not
    // fully processed — a failed or expired page is never simultaneously
    // marked as having committed a cursor advance.
    noRegressionOnFailure: {
      description:
        "A page in FAILED_PAGE or TOKEN_EXPIRED is never simultaneously marked cursorAdvancedThisWalk — a failed/expired page never advances the persisted cursor",
      formula: forall(
        "Integrations",
        "i",
        or(
          not(isin(index(cursorState, param("i")), setOf(lit("FAILED_PAGE"), lit("TOKEN_EXPIRED")))),
          not(index(cursorAdvancedThisWalk, param("i"))),
        ),
      ),
    },
    // (2) A given file revision enqueues at most one google_drive.file_changed
    // job across duplicates/concurrency — a job can only ever be marked
    // enqueued while its ledger reservation is held, and that reservation's
    // own guard (reserveLedgerEntry: not already held) is the real-world
    // UNIQUE(integration, file, revision) constraint's mutual exclusion.
    jobNeverEnqueuedWithoutReservation: {
      description:
        "jobEnqueued implies ledgerHasEntry for every integration — a file-changed job is never enqueued outside its ledger reservation, so no interleaving (including two racing runs) can double-enqueue the same revision",
      formula: forall(
        "Integrations",
        "i",
        or(not(index(jobEnqueued, param("i"))), index(ledgerHasEntry, param("i"))),
      ),
    },
    // (3) Closest SOUND abstraction of "a backlog larger than the per-run cap
    // is eventually drained ... without an unbounded walk inside one webhook
    // request" — see the module doc comment for why true liveness is outside
    // this DSL's expressiveness. This proves the SAFETY half: hitting the cap
    // always frees the lock and exits WALKING, so a later push can always
    // start a fresh run to keep draining; it does not prove one always will.
    capReleasesResources: {
      description:
        "walkProgress=AT_CAP implies the lock is released and the walk has exited WALKING — the per-run cap bounds ONE run's work and never leaves the integration stuck mid-walk with resources held",
      formula: forall(
        "Integrations",
        "i",
        or(
          not(eq(index(walkProgress, param("i")), lit("AT_CAP"))),
          and(not(index(lockHeld, param("i"))), not(eq(index(cursorState, param("i")), lit("WALKING")))),
        ),
      ),
    },
    // (4) An expired/invalid page token leads to re-bootstrap, never a
    // permanent stuck state — TOKEN_EXPIRED always releases the lock, so
    // rebootstrapAfterExpiry (guarded only on cursorState=TOKEN_EXPIRED)
    // stays reachable from it.
    tokenExpiryReleasesLock: {
      description:
        "cursorState=TOKEN_EXPIRED implies the lock is released — an expired token can never leave the integration stuck holding its single-flight lease with no path back to re-bootstrap",
      formula: forall(
        "Integrations",
        "i",
        or(not(eq(index(cursorState, param("i")), lit("TOKEN_EXPIRED"))), not(index(lockHeld, param("i")))),
      ),
    },
    // (5) No state in which a push is acked (unconditional in the real
    // webhook handler — every delivery 200s, success or failure) while the
    // cursor is both un-advanced AND the failure is invisible. FAILED_PAGE
    // and TOKEN_EXPIRED are the two real-failure states; both must carry
    // problemObservable=true for as long as they persist.
    failureAlwaysObservable: {
      description:
        "cursorState in {FAILED_PAGE, TOKEN_EXPIRED} implies problemObservable — a real failure or token-expiry is never silently swallowed behind the webhook's unconditional 200 ack",
      formula: forall(
        "Integrations",
        "i",
        or(
          not(isin(index(cursorState, param("i")), setOf(lit("FAILED_PAGE"), lit("TOKEN_EXPIRED")))),
          index(problemObservable, param("i")),
        ),
      ),
    },
    // (6, fix-round item 4A) A walker that lost its lease mid-walk can
    // NEVER reach ADVANCED (a full, successful drain) while still carrying
    // that staleness — it must pass through `leaseCheckCatchesLoss` (clean
    // abort, clears the flag) first, or be superseded by a legitimate new
    // holder (`beginRunWhileAlreadyWalking`, which ALSO clears the flag for
    // its own fresh session). MUTATION-TESTED: removing `lockHeld` from
    // `pageSucceedsFinal`'s guard (the pre-fix shape) lets a stale walker
    // reach ADVANCED while `lostLeaseWhileWalking` is still true — see
    // machines/agents.md for the recorded counterexample.
    noConcurrentWalkers: {
      description:
        "lostLeaseWhileWalking implies the integration never simultaneously reads cursorState=ADVANCED — a walker that lost its lease mid-flight cannot silently complete as if it still held it",
      formula: forall(
        "Integrations",
        "i",
        or(
          not(index(lostLeaseWhileWalking, param("i"))),
          not(eq(index(cursorState, param("i")), lit("ADVANCED"))),
        ),
      ),
    },
    // (7, fix-round item 4A part 2) The persisted cursor (CAS sub-model)
    // never rewinds: once G2 has ever been reached, it stays G2 — a stale
    // walker's out-of-order commit (targeting an EARLIER generation) can
    // never overwrite a later one. Directly models `advancePageToken`'s
    // `WHERE last_page_token = expected_page_token` compare-and-swap.
    cursorNeverRewinds: {
      description:
        "everReachedG2 implies persistedGen still equals G2 — the persisted page-token generation is monotonic; a stale/out-of-order commit can never rewind it once a later generation has been reached",
      formula: forall(
        "Integrations",
        "i",
        or(
          not(index(everReachedG2, param("i"))),
          eq(index(persistedGen, param("i")), lit("G2")),
        ),
      ),
    },
    // (8, fix-round item 3) Closest SOUND abstraction of "a push that
    // arrives while the lease is held is eventually processed" — see the
    // module doc comment for why true liveness is outside this DSL. This
    // is the SAFETY half: the push is never DROPPED while locked (the
    // shipped `beginRunSkippedLocked` preserves `pendingPush`, matching
    // `markLeaseDirty`'s real unconditional write). Combined with `check`'s
    // own deadlock-freedom guarantee (a live `pendingPush=true` always
    // leaves `beginRun` reachable once the lock frees), this is the
    // strongest claim provable without temporal operators.
    //
    // REDEFINED IN ROUND 3 — read the module doc comment's "ROUND-2 FIX,
    // THEN CORRECTED AGAIN BY ROUND-3" paragraph before trusting any older
    // version of this invariant in git history. Rounds 1 AND 2 both shipped
    // an unbacked certificate for this specific property (round 1: no
    // witness wired at all; round 2: a witness wired ONLY to a parallel,
    // permanently-gated canary action, never to the real
    // `beginRunSkippedLocked` action it was supposed to stand in for — a
    // constant-false toggle proved only that the toggle was false). This
    // version is stated over REAL state written by the REAL actions:
    // `justSkippedLocked` is set unconditionally by `beginRunSkippedLocked`
    // (the SAME update list as the `pendingPush` line under mutation test)
    // and cleared only by `beginRun`/`beginRunWhileAlreadyWalking`'s
    // legitimate consumption — no second action, no gate.
    //
    // MUTATION-TESTED (round 3, the real test): editing ONLY
    // `beginRunSkippedLocked`'s `pendingPush` line from `lit(true)` to
    // `lit(false)` — the realistic single-line pre-item-3 regression,
    // reintroduced in the actual modeled code path — now fails this
    // invariant directly, with no toggle to flip. See machines/agents.md
    // for the real recorded counterexample trace.
    pendingPushNeverDroppedWhileLocked: {
      description:
        "whenever the locked-skip handler has fired and its legitimate consumer (beginRun / beginRunWhileAlreadyWalking) hasn't run since, the push must still be pending — justSkippedLocked[i] implies pendingPush[i]; a mutation that drops pendingPush in beginRunSkippedLocked without ALSO decoupling justSkippedLocked's own write (i.e. any realistic single-line regression) is caught directly, over real state, not a parallel canary",
      formula: forall(
        "Integrations",
        "i",
        or(not(index(justSkippedLocked, param("i"))), index(pendingPush, param("i"))),
      ),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: { Integrations: ids({ prefix: "i", size: 1 }) },
        graphEquivalence: false,
        // Fix-round item 4A/B raised the raw variable product from 1,152 to
        // 248,832 (lockHeld-gating + lease-race + CAS sub-model variables);
        // budget raised proportionally.
        budgets: { maxEstimatedStates: 2_000_000 },
      },
      nightly: {
        domains: { Integrations: ids({ prefix: "i", size: 2 }) },
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 500_000_000_000 },
      },
    },
  },
});
export default driveChangesCursorMachine;
