/**
 * Drive folder-watch processing loop (SCRUM-1650 / SCRUM-1660 [Implement]).
 *
 * Consumes Drive's changes feed page-by-page from a persisted page token,
 * deduplicates at the (integration, file_id, revision_id) level, matches
 * each change's parent folders against the integration's watched folders,
 * and emits one canonical `WORKSPACE_FILE_MODIFIED` rule event per matching
 * change. Page-token advance is durable across worker restart.
 *
 * Pure orchestrator — the Drive HTTP boundary is `listChanges` in
 * oauth/drive.ts; the DB boundary is the injected `db`. This makes the
 * processor straightforwardly unit-testable without touching real Drive
 * or Postgres.
 *
 * Covers PRD 3 ACs:
 *   GD-03 — process changes.list with durable page token
 *   GD-04 — folder match (changes outside watched folders ignored, counted)
 *   GD-05 — multi-user attribution where Google metadata permits
 *   GD-06 — multi-file burst handling without drops
 *   GD-07 — revision-level dedupe via drive_revision_ledger UNIQUE
 *
 * CONCURRENCY SAFETY (SCRUM-2903/3661/5094/2330 fix-round, items 4A/C):
 *
 *   - The caller (`drive-changes-runner.ts`) holds a per-integration
 *     single-flight lease for the whole call, heartbeat-renewed. But a
 *     heartbeat that stops renewing (definitive loss — another instance won
 *     the lease) does NOT reach back into an in-flight body to stop it —
 *     see `RunLeaseContext`'s doc comment in `jobs/run-lease.ts`. So this
 *     loop independently re-verifies ownership (`deps.stillHoldsLease`,
 *     when injected) before starting each page, and aborts WITHOUT
 *     advancing the cursor the instant it reads back "no longer held" —
 *     see `result.leaseLost`.
 *   - `advancePageToken` is a COMPARE-AND-SWAP keyed on the token value this
 *     run started from (`expected_page_token`), not an unconditional write.
 *     If another run already advanced past that point — the exact
 *     scenario a lease race that slips past the check above would produce —
 *     the CAS reports `advanced: false` and this loop stops without
 *     rewinding the cursor; see `result.cursorAdvanceLost`.
 *
 * KNOWN LIMITATION, NOT FIXED BY THIS PR (documented per fix-round item C
 * — flagged for its own follow-up ticket rather than half-done here): a
 * hard process kill BETWEEN `insertRevisionLedger` (the reserve) and the
 * paired `enqueueRuleEvent`/`enqueueFileChangedJob` (the confirm) leaves an
 * ORPHANED ledger row — reserved, never enqueued, and with no compensating
 * delete, because the code that would have run it never got the chance.
 * That row then permanently blocks a legitimate retry of the SAME
 * (integration, file, revision) from ever re-queuing (the UNIQUE
 * constraint reads it as "already handled"). This is a pre-existing
 * property of the reserve-then-confirm design, not introduced by this PR.
 * A full remediation (periodic detection of ledger rows older than N
 * minutes with `rule_event_id IS NULL` and no matching queued/completed
 * job, then re-drive or release) needs its own migration-free detection
 * query design, its own soak, and its own review — out of scope here.
 */
import {
  listChanges,
  getStartPageToken,
  DriveApiError,
  type DriveChangesListEntry,
  type DriveChangesListResponseT,
} from '../oauth/drive.js';
// SCRUM-4507: the revision-kind vocabulary is owned by the job-payload
// contract module so the producer, the queue schema and the record page all
// read one declaration. Type-only import — no runtime edge added here.
import type { DriveRevisionKind } from './drive-artifact-producer.js';
import { reportDriveProcessingFailure } from './drive-connect-health.js';

export interface DriveProcessorDb {
  /** Insert a row into drive_revision_ledger; resolve to true on success,
   *  false on unique-violation (duplicate revision). Never throws on dupe. */
  insertRevisionLedger(row: {
    integration_id: string;
    org_id: string;
    file_id: string;
    revision_id: string;
    parent_ids: string[];
    modified_time: string | null;
    actor_email: string | null;
    outcome: 'queued' | 'parent_mismatch' | 'unrelated_change';
    rule_event_id: string | null;
  }): Promise<{ inserted: boolean; conflict: boolean }>;
  /**
   * Compensating delete on the (integration, file, revision) ledger row.
   * Called when we reserved a dedupe slot via insertRevisionLedger but the
   * follow-up enqueue failed — without this, the next pass would treat the
   * revision as already-processed and the rule event would be permanently
   * lost. Idempotent: must be safe when the row no longer exists.
   */
  deleteRevisionLedgerEntry(key: {
    integration_id: string;
    file_id: string;
    revision_id: string;
  }): Promise<void>;
  /**
   * Compare-and-swap update of the integration's last_page_token +
   * last_token_advanced_at (fix-round item 4A). `expected_page_token` MUST
   * be the value this run's own `last_page_token` started from (never an
   * intermediate walked-through `nextPageToken`, which is never persisted
   * mid-walk) — the write only lands `WHERE last_page_token =
   * expected_page_token`. Returns `{ advanced: false }` on a CAS miss
   * (another run already advanced past this point) rather than throwing —
   * that is an EXPECTED outcome under a lease race, not an error; the
   * caller decides how to respond (stop without rewinding, never retry the
   * write with a different expectation).
   */
  advancePageToken(args: {
    integration_id: string;
    new_page_token: string;
    expected_page_token: string;
  }): Promise<{ advanced: boolean }>;
  /** Enqueue a canonical rule event (returns the new event id, null on failure). */
  enqueueRuleEvent(payload: {
    org_id: string;
    file_id: string;
    parent_ids: string[];
    actor_email: string | null;
    revision_id: string;
    integration_id: string;
    filename: string | null;
    /**
     * SCRUM-1837: resolved human folder path (e.g. `/HR/2026-Q2/file.pdf`),
     * or null when unresolvable / no resolver was injected. Required so
     * `folder_path_starts_with` rule conditions can ever fire — see
     * drive-folder-resolver.ts.
     */
    folder_path: string | null;
  }): Promise<string | null>;
  /**
   * SCRUM-2903 (GD-PROD): enqueue the `google_drive.file_changed` job — the
   * durable hand-off that lets `jobs/drive-file-changed.ts` fetch the
   * document, SHA-256 it (§1.6A), and write a `connector_artifact` for the
   * existing drain to anchor. Drive twin of the DocuSign webhook's
   * `enqueueFetchJob` (called right after `enqueueRuleEvent`, same
   * fire-both-or-roll-back-the-ledger shape). Returns the new job id, null
   * on failure.
   */
  enqueueFileChangedJob(payload: {
    org_id: string;
    integration_id: string;
    file_id: string;
    revision_id: string | null;
    mime_type: string | null;
    modified_time: string | null;
    rule_event_id: string;
    /**
     * SCRUM-4507 source link-back — the identifiers a record owner needs to
     * get back to the file this anchor was made from. Derived here, at the
     * one point the raw Drive change is in hand; every later hop just carries
     * them. `null` where Drive gave us nothing (My Drive has no shared drive
     * id; a change can have no parents; folder_path needs a resolver).
     */
    shared_drive_id: string | null;
    folder_id: string | null;
    folder_path: string | null;
    revision_kind: DriveRevisionKind;
  }): Promise<string | null>;
  /**
   * Gap-visibility record for a 410/404-style cursor re-bootstrap (orchestrator
   * fix-round item 2, SCRUM-2903/3661/5094/2330 follow-up). A re-bootstrap
   * jumps the cursor to "now" and DISCARDS whatever changed between
   * `gap_start` (the integration's `last_token_advanced_at` BEFORE this
   * reset — the last point we know we were caught up) and `gap_end` (when
   * the fresh token was minted) — Drive offers no way to enumerate that
   * window once the expired token is gone. Silently overwriting
   * `last_token_advanced_at` to "now" (which `advancePageToken` does
   * unconditionally) would erase the only evidence that gap ever existed by
   * the time anything reads the row back. This is the durable record —
   * real implementations persist it as an `audit_events` row (no migration:
   * that table already exists and is exactly "append-only record of a
   * notable thing that happened"), which `connector-health.ts` separately
   * reads to surface `changes_gap`. NEVER throws — a failed write here is
   * logged (adapter-layer concern) but must not itself fail an otherwise-
   * successful recovery; the processor ALSO logs both bounds directly
   * (see `processDriveChanges`), independent of whether this call lands.
   */
  recordCursorGap(args: {
    integration_id: string;
    org_id: string;
    gap_start: string | null;
    gap_end: string;
  }): Promise<void>;
}

export interface DriveProcessorIntegration {
  id: string;
  org_id: string;
  last_page_token: string | null;
  watched_folder_ids: string[];
  /**
   * Orchestrator fix-round item 2: the LAST KNOWN-GOOD cursor-advance
   * timestamp, read BEFORE a 410/404 recovery would overwrite it. `null`
   * for an integration whose cursor has never advanced (its own,
   * pre-existing degraded state — see `connector-health.ts`'s
   * `changes_list_never_succeeded`, a DIFFERENT signal).
   */
  last_token_advanced_at: string | null;
}

export interface DriveProcessorDeps {
  /** Network boundary: `listChanges` from oauth/drive.ts by default. Swapped
   *  in tests for a mocked async function returning fixture pages. */
  listChanges?: typeof listChanges;
  /**
   * Network boundary: `getStartPageToken` from oauth/drive.ts by default.
   * Used ONLY for 410/404 "pageToken invalid/expired" recovery — see the
   * doc comment above the catch block in `processDriveChanges`. Swapped in
   * tests so the recovery path never needs a real Drive credential.
   */
  getStartPageToken?: typeof getStartPageToken;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  /**
   * SCRUM-1837: resolve a Drive file's human-readable folder path so
   * `folder_path_starts_with` rule conditions can match. Injected — production
   * wiring (drive-changes-runner.ts) binds this to `resolveDriveFolderPath`
   * (drive-folder-resolver.ts) over a real `drive_folder_path_cache`-backed
   * store. Called ONLY for a change that already matched a watched folder
   * binding (the only case the resolved value can ever be used for) — never
   * for a mismatched/unrelated change, so a folder nobody scoped a rule to
   * never burns a Drive API round-trip. Omitted (undefined) -> folder_path
   * stays null, matching the prior hardcoded-null behavior.
   */
  resolveFolderPath?: (args: {
    orgId: string;
    fileId: string;
    accessToken: string;
  }) => Promise<string | null>;
  /**
   * Fix-round item 4A: on-demand lease-ownership re-check. Production
   * wiring (`drive-changes-runner.ts`) binds this to
   * `stillHoldsRunLease(client, spec, holder)` from `jobs/run-lease.ts`.
   * Called before EVERY page (including the first) when injected; omitted
   * in tests that don't exercise the lease-race path, which then behaves
   * exactly as before this fix-round (no lease re-check at all).
   */
  stillHoldsLease?: () => Promise<boolean>;
}

export interface ProcessChangesResult {
  changesProcessed: number;
  queued: number;
  parentMismatch: number;
  duplicates: number;
  pagesProcessed: number;
  newPageToken: string | null;
  /**
   * True when this pass recovered from a 410/404 "pageToken invalid/expired"
   * `changes.list` error by re-bootstrapping the cursor via
   * `changes.getStartPageToken` rather than failing the pass outright. Any
   * changes that occurred in the gap between the expired token and the fresh
   * one are NOT recovered (Google does not offer a way to — the expired
   * token is why) — this only stops the integration from failing FOREVER on
   * every subsequent webhook. Absent/false on every other path.
   */
  cursorReset?: true;
  /**
   * Fix-round item 4A: this pass detected (via `deps.stillHoldsLease`) that
   * it no longer holds the single-flight lease and stopped BEFORE starting
   * the next page — no `changes.list` call was made for that page, no
   * cursor advance was attempted. The lease's new holder (or the periodic
   * reconciliation sweep) is responsible for the remaining backlog.
   */
  leaseLost?: true;
  /**
   * Fix-round item 4A: `advancePageToken`'s compare-and-swap reported
   * `advanced: false` — another run already moved the persisted cursor past
   * the token this run started from. This pass's OWN work up to that point
   * (ledger rows, enqueued jobs) is unaffected and stands; it simply did
   * NOT get to record its own cursor position, because doing so would have
   * REWOUND whatever the other run already committed.
   */
  cursorAdvanceLost?: true;
}

/**
 * "This pageToken is no longer valid" detection lives in `oauth/drive.ts`
 * (`DriveApiError.pageTokenInvalid` / `isInvalidPageTokenError`), NOT here —
 * that is the ONE call site that still has Google's parsed error body in
 * hand. https://developers.google.com/drive/api/guides/manage-changes
 * documents 410 Gone as the primary case; Google's issue tracker 196413673
 * additionally reports a 400 `invalidPageToken` shape on some accounts for
 * the identical underlying condition, so `listChanges` also matches a 400
 * whose parsed body explicitly names `pageToken` as invalid. 404 is treated
 * the same as 410 defensively (observed from other Google list APIs for an
 * unrecognized/expired opaque token). Any OTHER 400 (including THIS
 * incident's own fields-mask bug — its Google error names the `fields`
 * parameter, not `pageToken`) and every other status (401, 403, 429, 5xx) is
 * a different failure class and must keep failing loud — recovering from
 * those by discarding the cursor would silently skip real changes for
 * reasons that have nothing to do with token validity.
 */

const SAFE_PAGE_LIMIT = 25;

/**
 * FINDING 1 (PR #1944 review round 3, perf): bounded fan-out for folder-path
 * resolution across ONE page's matching changes. A cold cache walks up to 20
 * SEQUENTIAL `files.get` calls per file (inherently serial — that part is
 * unavoidable), but nothing previously parallelized ACROSS different files
 * in the same page: a 20-file burst at ~5 levels deep could add ~20s of
 * inline latency to a single webhook/cron drain. Bounded (not
 * `Promise.all` over the whole page unbounded) for the same reason
 * `drive-subscription-renewal.ts`'s `RENEWAL_CONCURRENCY` is bounded — Drive
 * pages run up to ~50 changes, and an unbounded burst of `files.get` calls
 * risks vendor throttling.
 */
const FOLDER_PATH_RESOLUTION_CONCURRENCY = 8;

/**
 * Resolve the revision identifier for a Drive change, AND which kind of token
 * it turned out to be.
 *
 * Prefer `headRevisionId` (Drive's monotonic revision token, available for
 * binary file types). Fall back to `modifiedTime` for native Google
 * Workspace files (Docs / Sheets) which don't expose a head revision —
 * Drive guarantees `modifiedTime` advances on every meaningful change so
 * this still discriminates revisions. Last resort: synthesize from `time`
 * + file id so dedupe still functions for transient `removed` events.
 *
 * SCRUM-4507: the precedence and the emitted id strings are UNCHANGED — the
 * `mtime:` / `evt:` prefixes are part of the 0343 `connector_artifact` dedupe
 * key, so altering them would re-anchor every Workspace-native file. The only
 * addition is the `kind`, which travels alongside so a rendering surface never
 * has to infer the answer from the string's prefix (a caller that parsed
 * `mtime:` out of the id would be re-deriving a fact the producer already
 * knew, and would silently misread any future id shape).
 */
interface ResolvedDriveRevision {
  revisionId: string;
  kind: DriveRevisionKind;
}

function resolveRevision(change: DriveChangesListEntry): ResolvedDriveRevision | null {
  const headRev = change.file?.headRevisionId;
  if (headRev) return { revisionId: headRev, kind: 'head_revision' };
  const mtime = change.file?.modifiedTime;
  if (mtime) return { revisionId: `mtime:${mtime}`, kind: 'modified_time' };
  if (change.time && change.fileId) {
    return { revisionId: `evt:${change.time}:${change.fileId}`, kind: 'event_time' };
  }
  return null;
}

/**
 * GD-04 folder match — does any of `parents` overlap `watched`? Drive
 * surfaces parents as drive folder IDs (opaque strings); the rule binding
 * stores the same ID shape, so straight set membership is sufficient.
 */
function parentMatches(parents: string[], watched: string[]): boolean {
  if (watched.length === 0 || parents.length === 0) return false;
  const watchedSet = new Set(watched);
  for (const p of parents) {
    if (watchedSet.has(p)) return true;
  }
  return false;
}

type LedgerOutcome = 'queued' | 'parent_mismatch' | 'unrelated_change';

function classifyLedgerOutcome(matches: boolean, parentCount: number): LedgerOutcome {
  if (matches) return 'queued';
  if (parentCount > 0) return 'parent_mismatch';
  return 'unrelated_change';
}

/**
 * FINDING 1: one page's worth of sync classification, computed up front so
 * folder-path resolution (I/O) can run concurrently across changes BEFORE
 * the strictly-sequential ledger-insert/enqueue commit phase — see
 * `processDriveChanges`'s two-phase structure below.
 */
interface ChangeDescriptor {
  fileId: string;
  revisionId: string;
  /** SCRUM-4507: which fallback `resolveRevision` landed on for `revisionId`. */
  revisionKind: DriveRevisionKind;
  parents: string[];
  matches: boolean;
  actorEmail: string | null;
  modifiedTime: string | null;
  filename: string | null;
  mimeType: string | null;
  /**
   * SCRUM-4507: the Shared Drive this file lives on, or null for My Drive.
   * `listChanges` has always requested `driveId` in its field mask and the Zod
   * entry has always parsed it — nothing read it until now.
   */
  sharedDriveId: string | null;
  /** SCRUM-4507: first parent folder id, or null when the change has no parents. */
  folderId: string | null;
}

/** Sync-only pass: classify every change in a page. No I/O. */
function classifyPage(
  changes: DriveChangesListEntry[],
  watchedFolderIds: string[],
  onCount: () => void,
  onSkip: (change: DriveChangesListEntry) => void,
): ChangeDescriptor[] {
  const descriptors: ChangeDescriptor[] = [];
  for (const change of changes) {
    onCount();

    // Skip removed/trashed changes — they don't carry a fingerprintable
    // file revision. (We don't anchor deletions; the verification API
    // handles tombstoned credentials separately.)
    if (change.removed === true || change.file?.trashed === true) continue;

    const fileId = change.file?.id ?? change.fileId ?? null;
    const revision = resolveRevision(change);
    if (!fileId || !revision) {
      onSkip(change);
      continue;
    }

    const parents = change.file?.parents ?? [];
    descriptors.push({
      fileId,
      revisionId: revision.revisionId,
      revisionKind: revision.kind,
      sharedDriveId: change.file?.driveId ?? null,
      // The FIRST parent, deliberately: Drive allows multiple parents, and the
      // watched-folder match already treats the array as a set. Picking one is
      // a display choice, so it picks the same element a reader sees first
      // rather than searching for the watched one — which would make the link
      // depend on the org's rule configuration rather than on the file.
      folderId: parents[0] ?? null,
      parents,
      matches: parentMatches(parents, watchedFolderIds),
      actorEmail: change.file?.lastModifyingUser?.emailAddress ?? null,
      modifiedTime: change.file?.modifiedTime ?? null,
      filename: change.file?.name ?? null,
      mimeType: change.file?.mimeType ?? null,
    });
  }
  return descriptors;
}

/**
 * FINDING 1: resolve `folder_path` for every MATCHING descriptor's fileId,
 * bounded-concurrently, deduplicated by fileId (a burst can carry multiple
 * changes — e.g. two revisions — for the same file within one page; a
 * file's folder path does not depend on which revision triggered the
 * resolution, so resolving once and sharing is strictly better than the
 * pre-fix per-change behavior, not just faster). Never resolves for a
 * non-matching change — resolving a path nobody will use would be a wasted
 * Drive API round-trip, the same rule the pre-fix per-change resolution
 * already followed.
 */
async function resolveFolderPathsForPage(
  descriptors: ChangeDescriptor[],
  args: {
    orgId: string;
    accessToken: string;
    integrationId: string;
    resolveFolderPath: NonNullable<DriveProcessorDeps['resolveFolderPath']>;
    log?: DriveProcessorDeps['logger'];
  },
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const uniqueFileIds = [...new Set(descriptors.filter((d) => d.matches).map((d) => d.fileId))];

  for (let i = 0; i < uniqueFileIds.length; i += FOLDER_PATH_RESOLUTION_CONCURRENCY) {
    const chunk = uniqueFileIds.slice(i, i + FOLDER_PATH_RESOLUTION_CONCURRENCY);
    await Promise.all(chunk.map(async (fileId) => {
      // `resolveFolderPath`'s production implementation
      // (drive-folder-resolver.ts) already never throws, but we guard here
      // too so a misbehaving test double or future implementation can never
      // abort an otherwise-valid change over a folder-path lookup failure.
      try {
        const path = await args.resolveFolderPath({ orgId: args.orgId, fileId, accessToken: args.accessToken });
        results.set(fileId, path);
      } catch (err) {
        args.log?.warn?.(
          { err, integrationId: args.integrationId, fileId },
          'drive folder-path resolution failed — proceeding with null',
        );
        results.set(fileId, null);
      }
    }));
  }
  return results;
}

export async function processDriveChanges(args: {
  integration: DriveProcessorIntegration;
  accessToken: string;
  db: DriveProcessorDb;
  deps?: DriveProcessorDeps;
}): Promise<ProcessChangesResult> {
  const list = args.deps?.listChanges ?? listChanges;
  const log = args.deps?.logger;
  const result: ProcessChangesResult = {
    changesProcessed: 0,
    queued: 0,
    parentMismatch: 0,
    duplicates: 0,
    pagesProcessed: 0,
    newPageToken: null,
  };
  let pageToken = args.integration.last_page_token;
  if (!pageToken) {
    // The page-token bootstrap (changes.getStartPageToken) is the
    // responsibility of `createChangesWatch` at integration setup time.
    // If we land here without a token the integration is misconfigured —
    // bail loudly so the operator notices instead of silently no-op'ing.
    throw new Error(`drive integration ${args.integration.id} has no last_page_token`);
  }
  // Fix-round item 4A: the CAS anchor for every `advancePageToken` call this
  // pass makes — the token value the DB row held when THIS run started.
  // Never reassigned; `pageToken` (below) walks forward through intermediate
  // `nextPageToken` values that are never persisted mid-walk, but the CAS
  // must always check against what was actually committed before we began.
  const startingPageToken = pageToken;

  // Bounded page walk. Drive guarantees a finite changes list per call but
  // a misconfigured rule could in theory loop forever; the cap is
  // defensive. SAFE_PAGE_LIMIT × ~50 changes = ~1250 changes per webhook,
  // which exceeds GD-09's 1000/day stress target.
  for (let page = 0; page < SAFE_PAGE_LIMIT; page += 1) {
    // Fix-round item 4A: re-verify lease ownership before EVERY page,
    // including the first. Independent of the heartbeat (see
    // `RunLeaseContext`'s doc comment in jobs/run-lease.ts for why the
    // heartbeat alone cannot stop an in-flight walk that already lost the
    // lease) — abort cleanly, without advancing the cursor or making
    // another Drive call, the instant ownership cannot be verified.
    if (args.deps?.stillHoldsLease) {
      const stillHeld = await args.deps.stillHoldsLease();
      if (!stillHeld) {
        log?.warn?.(
          { integrationId: args.integration.id, orgId: args.integration.org_id, page },
          'drive changes walk: lease ownership could not be verified — aborting without advancing the cursor',
        );
        result.leaseLost = true;
        return result;
      }
    }
    let response: DriveChangesListResponseT;
    try {
      response = await list({ accessToken: args.accessToken, pageToken });
    } catch (err) {
      // "pageToken invalid/expired" recovery (410/404 always; a 400 only
      // when `oauth/drive.ts` positively identified it as this specific
      // condition — see `DriveApiError.pageTokenInvalid`'s doc comment).
      // Google's documented response to an expired changes.list page token
      // is to call changes.getStartPageToken and resume from "now" —
      // retrying changes.list with the SAME stale token just fails again
      // forever, which before this fix meant a page-token could fail an
      // integration PERMANENTLY with no operator-visible recovery path
      // (every future webhook would hit this same throw). Any changes made
      // in the gap between the expired token and the fresh one are
      // unrecoverable by definition — Drive does not offer a way to
      // enumerate them once the token backing them has expired — so this
      // trades silent permanent failure for a bounded, LOUD gap (see
      // `cursorReset` + the gap-visibility handling below) and a working
      // cursor going forward. Every OTHER failure (a bare 400 — including
      // this incident's own bug shape — 401/403, 429, 5xx) keeps failing
      // loud below; "recovering" from those by discarding the cursor would
      // silently fast-forward past real, still-retrievable changes for
      // reasons that have nothing to do with token validity.
      if (err instanceof DriveApiError && err.pageTokenInvalid) {
        const getToken = args.deps?.getStartPageToken ?? getStartPageToken;
        log?.warn?.(
          { err, integrationId: args.integration.id, pageToken, status: err.status },
          'drive changes.list: pageToken invalid/expired — re-bootstrapping cursor via changes.getStartPageToken',
        );
        let freshToken: string;
        try {
          freshToken = await getToken({ accessToken: args.accessToken });
        } catch (bootstrapErr) {
          // Recovery itself failed — this IS a genuine, non-recoverable
          // failure now. Bubble up exactly like any other changes.list error
          // (webhook handler decides whether to 200-ack or retry; the OLD
          // cursor is left untouched, so a later successful attempt is not
          // blocked by anything this catch did).
          log?.error?.(
            { err: bootstrapErr, integrationId: args.integration.id },
            'drive changes.getStartPageToken (410/404 recovery) failed',
          );
          reportDriveProcessingFailure(bootstrapErr, {
            stage: 'changes_list',
            orgId: args.integration.org_id,
            integrationId: args.integration.id,
          });
          throw bootstrapErr;
        }
        // Gap visibility (fix-round item 2): compute and LOG both bounds
        // BEFORE persisting anything — this must be true regardless of
        // whether the persist below succeeds. `gapStart` is read from the
        // integration snapshot this call started with, i.e. BEFORE
        // `advancePageToken` overwrites `last_token_advanced_at` to "now".
        const gapStart = args.integration.last_token_advanced_at;
        const gapEnd = new Date().toISOString();
        log?.warn?.(
          { integrationId: args.integration.id, orgId: args.integration.org_id, gapStart, gapEnd },
          'drive changes cursor gap: re-bootstrap will jump the cursor forward — changes between gapStart and gapEnd are unrecoverable',
        );

        // The actual cursor-jump write. Wrapped explicitly (rather than
        // letting a throw here fall through to the outer catch) so a
        // failed persist is logged WITH the gap bounds it would otherwise
        // silently widen — every retry against the SAME still-invalid old
        // token re-hits this exact 410/404 branch and recomputes a LATER
        // gapEnd each time, so a persist failure here is not a one-off
        // blip, it is the gap growing on every subsequent webhook until it
        // succeeds.
        let persisted: { advanced: boolean };
        try {
          persisted = await args.db.advancePageToken({
            integration_id: args.integration.id,
            new_page_token: freshToken,
            expected_page_token: startingPageToken,
          });
        } catch (persistErr) {
          log?.error?.(
            { err: persistErr, integrationId: args.integration.id, orgId: args.integration.org_id, gapStart, gapEnd },
            'drive changes cursor gap: advancePageToken (post-bootstrap persist) failed — the gap is WIDENING, not just unrecorded, until this succeeds',
          );
          reportDriveProcessingFailure(persistErr, {
            stage: 'changes_list',
            orgId: args.integration.org_id,
            integrationId: args.integration.id,
          });
          throw persistErr;
        }
        if (!persisted.advanced) {
          // CAS miss: another run already moved the cursor past
          // `startingPageToken` — meaning it did NOT hit this 410/404 (or
          // recovered from it first). Our own reset is stale; the real
          // cursor is already in a good state, so there is no gap to
          // record on our behalf. Stop cleanly, without rewinding.
          log?.warn?.(
            { integrationId: args.integration.id, orgId: args.integration.org_id, gapStart, gapEnd },
            'drive changes cursor gap: CAS miss on the post-bootstrap persist — another run already advanced the cursor; standing down without recording a gap',
          );
          result.cursorAdvanceLost = true;
          return result;
        }

        // Best-effort durable record — see recordCursorGap's doc comment.
        // Never allowed to fail the recovery itself (the cursor IS fixed
        // regardless of whether this write lands); the adapter logs its
        // own failure.
        await args.db.recordCursorGap({
          integration_id: args.integration.id,
          org_id: args.integration.org_id,
          gap_start: gapStart,
          gap_end: gapEnd,
        });

        // Still reported — an expired token is a real operational event an
        // operator should see, even though the pipeline recovered from it.
        reportDriveProcessingFailure(err, {
          stage: 'changes_list',
          orgId: args.integration.org_id,
          integrationId: args.integration.id,
        });
        result.newPageToken = freshToken;
        result.cursorReset = true;
        return result;
      }

      // Bubble up; webhook handler decides whether to 200-ack or retry. The
      // page token is NOT advanced — the next attempt retries from the SAME
      // `pageToken` this call read from `args.integration.last_page_token`
      // (or the prior page's `nextPageToken`, held only in the LOCAL
      // `pageToken` variable, never persisted mid-walk), so a transient
      // failure costs redundant re-processing of already-seen pages, never a
      // skipped change — the ledger's UNIQUE(integration, file, revision)
      // constraint makes that redundant re-processing idempotent.
      log?.error?.({ err, integrationId: args.integration.id, pageToken }, 'drive changes.list failed');
      // P0-2: this is exactly the class of failure (a stuck/410/429/5xx
      // changes.list call) the hardening audit found invisible — reported
      // here with integration-level context, before the webhook's generic
      // catch-all.
      reportDriveProcessingFailure(err, {
        stage: 'changes_list',
        orgId: args.integration.org_id,
        integrationId: args.integration.id,
      });
      throw err;
    }
    result.pagesProcessed += 1;

    // PHASE 1 (sync, no I/O): classify every change in this page.
    const descriptors = classifyPage(
      response.changes,
      args.integration.watched_folder_ids,
      () => { result.changesProcessed += 1; },
      (change) => log?.warn?.({ change, integrationId: args.integration.id }, 'drive change missing fileId or revisionId — skipping'),
    );

    // PHASE 2 (FINDING 1, concurrent I/O): resolve folder_path for every
    // matching change's fileId up front, bounded-concurrently, BEFORE any
    // ledger-insert/enqueue work starts. This is the part that did NOT need
    // to be sequential — see the module-level FOLDER_PATH_RESOLUTION_CONCURRENCY
    // doc comment.
    const folderPaths = args.deps?.resolveFolderPath
      ? await resolveFolderPathsForPage(descriptors, {
        orgId: args.integration.org_id,
        accessToken: args.accessToken,
        integrationId: args.integration.id,
        resolveFolderPath: args.deps.resolveFolderPath,
        log,
      })
      : new Map<string, string | null>();

    // PHASE 3 (sequential, UNCHANGED semantics): ledger-insert +
    // enqueue + compensation, strictly per-change and in page order. This
    // is the part that MUST stay sequential — the UNIQUE(integration, file,
    // revision) reservation ordering and the first-failure page-abort
    // contract both depend on it.
    for (const d of descriptors) {
      // GD-07 dedupe: the ledger UNIQUE(integration, file, revision)
      // refuses a second insert. We probe with the *intended* outcome so a
      // future operator can read the ledger and see "this revision was
      // queued / dropped because parents didn't match" without needing
      // engineering to replay logs.
      const ledgerOutcome = classifyLedgerOutcome(d.matches, d.parents.length);

      // Reserve-then-confirm ordering: insert ledger row BEFORE enqueue so the
      // UNIQUE(integration, file, revision) constraint dedupes against an at-
      // least-once Drive redelivery. If the matching path's enqueue then
      // fails (returns null OR throws), we COMPENSATE by deleting the ledger
      // row so the next pass can retry — without this, a transient queue
      // failure would silently lose the rule event forever.
      const ledgerResult = await args.db.insertRevisionLedger({
        integration_id: args.integration.id,
        org_id: args.integration.org_id,
        file_id: d.fileId,
        revision_id: d.revisionId,
        parent_ids: d.parents,
        modified_time: d.modifiedTime,
        actor_email: d.actorEmail,
        outcome: ledgerOutcome,
        rule_event_id: null,
      });

      if (ledgerResult.conflict) {
        result.duplicates += 1;
        continue;
      }

      if (!d.matches) {
        // SCRUM-1647 follow-up: only count true parent-mismatches; the
        // `unrelated_change` ledger outcome (parents.length === 0) is a
        // distinct telemetry class and would inflate the mismatch metric
        // if mixed in here.
        if (d.parents.length > 0) result.parentMismatch += 1;
        continue;
      }

      // GD-04 + GD-05 + GD-06: matching change → enqueue exactly one rule
      // event, attribution preserved where Google permits.
      //
      // SCRUM-2903 (GD-PROD): immediately followed by enqueueing the
      // `google_drive.file_changed` job — the Drive twin of the DocuSign
      // webhook's enqueueRuleEvent + enqueueFetchJob pair. Without this
      // second enqueue the rule event fires but nothing ever fetches +
      // fingerprints the document, so the change has no path to anchoring.
      // Both enqueues share one compensation: any failure rolls back the
      // ledger reservation so the next pass retries the whole change.
      const folderPath = folderPaths.get(d.fileId) ?? null;

      let ruleEventId: string | null;
      let fileChangedJobId: string | null;
      try {
        ruleEventId = await args.db.enqueueRuleEvent({
          org_id: args.integration.org_id,
          file_id: d.fileId,
          parent_ids: d.parents,
          actor_email: d.actorEmail,
          revision_id: d.revisionId,
          integration_id: args.integration.id,
          filename: d.filename,
          folder_path: folderPath,
        });
        fileChangedJobId = ruleEventId === null
          ? null
          : await args.db.enqueueFileChangedJob({
            org_id: args.integration.org_id,
            integration_id: args.integration.id,
            file_id: d.fileId,
            // MUST be the RESOLVED revisionId, not the raw headRevisionId.
            // Google Workspace-native files (Docs/Sheets/Slides) have no
            // headRevisionId at all — that is why resolveRevisionId() falls back
            // to `mtime:<modifiedTime>`. Passing the raw field here sent null for
            // every Doc, and `connector_artifact`'s unique index keys on
            // COALESCE(external_revision,'') (migration 0343), so every revision
            // after the first collided with the same '' key, hit ON CONFLICT DO
            // NOTHING, and was recorded as a `success` integration_event that
            // anchored nothing. The ledger row (which uses the resolved id)
            // still advanced, so the failure was completely silent.
            revision_id: d.revisionId,
            mime_type: d.mimeType,
            modified_time: d.modifiedTime,
            rule_event_id: ruleEventId,
            // SCRUM-4507 source link-back. `folderPath` is the value already
            // resolved for this file in PHASE 2 — no extra Drive round-trip.
            shared_drive_id: d.sharedDriveId,
            folder_id: d.folderId,
            folder_path: folderPath,
            revision_kind: d.revisionKind,
          });
      } catch (err) {
        // Compensate: roll back the ledger reservation so retry isn't blocked.
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: d.fileId,
          revision_id: d.revisionId,
        });
        log?.error?.({ err, integrationId: args.integration.id, fileId: d.fileId, revisionId: d.revisionId }, 'drive enqueueRuleEvent/enqueueFileChangedJob threw — ledger rolled back, page abort');
        // P0-2: the richest-context report in the whole chain — this is the
        // exact "rule event dispatched, fetch job never enqueued" split the
        // audit flagged (organization_rule_executions can read success while
        // this call, immediately after, still fails).
        reportDriveProcessingFailure(err, {
          stage: 'enqueue',
          orgId: args.integration.org_id,
          integrationId: args.integration.id,
          fileId: d.fileId,
          revisionId: d.revisionId,
        });
        throw err;
      }
      if (ruleEventId === null) {
        // Same compensation for null-return failures.
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: d.fileId,
          revision_id: d.revisionId,
        });
        log?.warn?.({ integrationId: args.integration.id, fileId: d.fileId, revisionId: d.revisionId }, 'drive enqueueRuleEvent returned null — ledger rolled back, page abort');
        const nullEnqueueError = new Error('drive enqueueRuleEvent returned null');
        reportDriveProcessingFailure(nullEnqueueError, {
          stage: 'enqueue',
          orgId: args.integration.org_id,
          integrationId: args.integration.id,
          fileId: d.fileId,
          revisionId: d.revisionId,
        });
        throw nullEnqueueError;
      }
      if (fileChangedJobId === null) {
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: d.fileId,
          revision_id: d.revisionId,
        });
        log?.warn?.({ integrationId: args.integration.id, fileId: d.fileId, revisionId: d.revisionId, ruleEventId }, 'drive enqueueFileChangedJob returned null — ledger rolled back, page abort');
        // P0-2: this is the SINGLE most direct hit on the audit's headline
        // scenario — the rule event (ruleEventId) enqueued successfully but
        // the file-fetch job did not, so organization_rule_executions will
        // read success while the document never gets fetched/fingerprinted.
        const nullFileChangedJobError = new Error('drive enqueueFileChangedJob returned null');
        reportDriveProcessingFailure(nullFileChangedJobError, {
          stage: 'enqueue',
          orgId: args.integration.org_id,
          integrationId: args.integration.id,
          fileId: d.fileId,
          revisionId: d.revisionId,
        });
        throw nullFileChangedJobError;
      }
      result.queued += 1;
    }

    if (response.nextPageToken) {
      pageToken = response.nextPageToken;
      continue;
    }
    // Final page: advance the persisted cursor to newStartPageToken (or
    // the last seen pageToken if the response didn't carry one — that
    // means Drive currently has no further changes).
    const advance = response.newStartPageToken ?? pageToken;
    const finalPersist = await args.db.advancePageToken({
      integration_id: args.integration.id,
      new_page_token: advance,
      expected_page_token: startingPageToken,
    });
    if (!finalPersist.advanced) {
      // CAS miss: another run already advanced the cursor past our
      // starting point while we were walking. Our OWN work in this pass
      // (ledger rows, enqueues) already landed and stands — only the final
      // cursor write is skipped, so we never rewind whatever the other run
      // committed.
      log?.warn?.(
        { integrationId: args.integration.id, orgId: args.integration.org_id },
        'drive changes walk: CAS miss on final-page advancePageToken — another run already advanced the cursor; standing down without rewinding',
      );
      result.cursorAdvanceLost = true;
      return result;
    }
    result.newPageToken = advance;
    return result;
  }

  // SCRUM-1647 follow-up (CodeRabbit Critical): persist the checkpoint when
  // the cap is hit. Otherwise a backlog of >SAFE_PAGE_LIMIT pages would
  // replay the same window forever — every invocation reads the unchanged
  // last_page_token from the DB, processes the same 25 pages, and exits
  // without advancing. Persist the latest token we successfully consumed
  // so the next pass picks up where this one left off.
  log?.warn?.({ integrationId: args.integration.id, pages: SAFE_PAGE_LIMIT }, 'drive changes.list page cap reached — partial drain, advancing token');
  const capPersist = await args.db.advancePageToken({
    integration_id: args.integration.id,
    new_page_token: pageToken,
    expected_page_token: startingPageToken,
  });
  if (!capPersist.advanced) {
    log?.warn?.(
      { integrationId: args.integration.id, orgId: args.integration.org_id },
      'drive changes walk: CAS miss on cap-reached advancePageToken — another run already advanced the cursor; standing down without rewinding',
    );
    result.cursorAdvanceLost = true;
    return result;
  }
  result.newPageToken = pageToken;
  return result;
}
