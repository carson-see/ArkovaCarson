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
 */
import {
  listChanges,
  type DriveChangesListEntry,
  type DriveChangesListResponseT,
} from '../oauth/drive.js';

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
  /** Atomically update the integration's last_page_token + last_token_advanced_at. */
  advancePageToken(args: {
    integration_id: string;
    new_page_token: string;
  }): Promise<void>;
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
  }): Promise<string | null>;
}

export interface DriveProcessorIntegration {
  id: string;
  org_id: string;
  last_page_token: string | null;
  watched_folder_ids: string[];
}

export interface DriveProcessorDeps {
  /** Network boundary: `listChanges` from oauth/drive.ts by default. Swapped
   *  in tests for a mocked async function returning fixture pages. */
  listChanges?: typeof listChanges;
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
}

export interface ProcessChangesResult {
  changesProcessed: number;
  queued: number;
  parentMismatch: number;
  duplicates: number;
  pagesProcessed: number;
  newPageToken: string | null;
}

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
 * Resolve the revision identifier for a Drive change.
 *
 * Prefer `headRevisionId` (Drive's monotonic revision token, available for
 * binary file types). Fall back to `modifiedTime` for native Google
 * Workspace files (Docs / Sheets) which don't expose a head revision —
 * Drive guarantees `modifiedTime` advances on every meaningful change so
 * this still discriminates revisions. Last resort: synthesize from `time`
 * + file id so dedupe still functions for transient `removed` events.
 */
function resolveRevisionId(change: DriveChangesListEntry): string | null {
  const headRev = change.file?.headRevisionId;
  if (headRev) return headRev;
  const mtime = change.file?.modifiedTime;
  if (mtime) return `mtime:${mtime}`;
  if (change.time && change.fileId) return `evt:${change.time}:${change.fileId}`;
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
  parents: string[];
  matches: boolean;
  actorEmail: string | null;
  modifiedTime: string | null;
  filename: string | null;
  mimeType: string | null;
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
    const revisionId = resolveRevisionId(change);
    if (!fileId || !revisionId) {
      onSkip(change);
      continue;
    }

    const parents = change.file?.parents ?? [];
    descriptors.push({
      fileId,
      revisionId,
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

  // Bounded page walk. Drive guarantees a finite changes list per call but
  // a misconfigured rule could in theory loop forever; the cap is
  // defensive. SAFE_PAGE_LIMIT × ~50 changes = ~1250 changes per webhook,
  // which exceeds GD-09's 1000/day stress target.
  for (let page = 0; page < SAFE_PAGE_LIMIT; page += 1) {
    let response: DriveChangesListResponseT;
    try {
      response = await list({ accessToken: args.accessToken, pageToken });
    } catch (err) {
      // Bubble up; webhook handler decides whether to 200-ack or retry.
      log?.error?.({ err, integrationId: args.integration.id, pageToken }, 'drive changes.list failed');
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
          });
      } catch (err) {
        // Compensate: roll back the ledger reservation so retry isn't blocked.
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: d.fileId,
          revision_id: d.revisionId,
        });
        log?.error?.({ err, integrationId: args.integration.id, fileId: d.fileId, revisionId: d.revisionId }, 'drive enqueueRuleEvent/enqueueFileChangedJob threw — ledger rolled back, page abort');
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
        throw new Error('drive enqueueRuleEvent returned null');
      }
      if (fileChangedJobId === null) {
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: d.fileId,
          revision_id: d.revisionId,
        });
        log?.warn?.({ integrationId: args.integration.id, fileId: d.fileId, revisionId: d.revisionId, ruleEventId }, 'drive enqueueFileChangedJob returned null — ledger rolled back, page abort');
        throw new Error('drive enqueueFileChangedJob returned null');
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
    await args.db.advancePageToken({
      integration_id: args.integration.id,
      new_page_token: advance,
    });
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
  await args.db.advancePageToken({
    integration_id: args.integration.id,
    new_page_token: pageToken,
  });
  result.newPageToken = pageToken;
  return result;
}
