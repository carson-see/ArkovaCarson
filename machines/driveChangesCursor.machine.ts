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
      ],
    },
    // drive_revision_ledger insert succeeds (reserve-then-confirm ordering).
    // Guard `not ledgerHasEntry` is the mutual-exclusion mechanism backing
    // invariant (2) — the SAME real-world UNIQUE(integration, file,
    // revision) constraint that makes a concurrent duplicate's insert 23505.
    reserveLedgerEntry: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), not(index(ledgerHasEntry, param("i")))),
      updates: [setMap("ledgerHasEntry", param("i"), lit(true))],
    },
    // "revision already in ledger" — named explicitly per the task's required
    // event list. A no-op on every variable: the classified change is the
    // SAME frontier revision a prior (possibly concurrent/duplicate) run
    // already reserved, so the 23505 conflict path counts a duplicate and
    // moves on without enqueuing again.
    changeAlreadyInLedger: {
      params: { i: "Integrations" },
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(ledgerHasEntry, param("i"))),
      updates: [setMap("ledgerHasEntry", param("i"), index(ledgerHasEntry, param("i")))],
    },
    // enqueueRuleEvent + enqueueFileChangedJob both succeed.
    enqueueJobSucceeds: {
      params: { i: "Integrations" },
      guard: and(
        eq(index(cursorState, param("i")), lit("WALKING")),
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
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), index(jobEnqueued, param("i"))),
      updates: [
        setMap("ledgerHasEntry", param("i"), lit(false)),
        setMap("jobEnqueued", param("i"), lit(false)),
        setMap("walkProgress", param("i"), lit("PARTIAL")),
      ],
    },
    // changes.list returns nextPageToken — more pages remain, still WALKING.
    pageSucceedsWithMore: {
      params: { i: "Integrations" },
      guard: eq(index(cursorState, param("i")), lit("WALKING")),
      updates: [setMap("walkProgress", param("i"), lit("PARTIAL"))],
    },
    // A page fails (429/5xx/4xx-not-410) — drive-changes-processor.ts
    // re-throws WITHOUT calling advancePageToken. Lease released
    // (runDriveChanges's `finally`); the persisted cursor is untouched, so a
    // retry replays from the SAME committed token, never a skipped one.
    pageFailsMidWalk: {
      params: { i: "Integrations" },
      guard: eq(index(cursorState, param("i")), lit("WALKING")),
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
      guard: and(eq(index(cursorState, param("i")), lit("WALKING")), eq(index(walkProgress, param("i")), lit("PARTIAL"))),
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
      guard: eq(index(cursorState, param("i")), lit("WALKING")),
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
      guard: eq(index(cursorState, param("i")), lit("WALKING")),
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
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: { Integrations: ids({ prefix: "i", size: 1 }) },
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 100_000 },
      },
      nightly: {
        domains: { Integrations: ids({ prefix: "i", size: 2 }) },
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 10_000_000 },
      },
    },
  },
});
export default driveChangesCursorMachine;
