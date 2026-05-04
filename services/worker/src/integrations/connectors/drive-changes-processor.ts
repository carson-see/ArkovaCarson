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

    for (const change of response.changes) {
      result.changesProcessed += 1;

      // Skip removed/trashed changes — they don't carry a fingerprintable
      // file revision. (We don't anchor deletions; the verification API
      // handles tombstoned credentials separately.)
      if (change.removed === true || change.file?.trashed === true) continue;

      const fileId = change.file?.id ?? change.fileId ?? null;
      const revisionId = resolveRevisionId(change);
      if (!fileId || !revisionId) {
        log?.warn?.({ change, integrationId: args.integration.id }, 'drive change missing fileId or revisionId — skipping');
        continue;
      }

      const parents = change.file?.parents ?? [];
      const matches = parentMatches(parents, args.integration.watched_folder_ids);
      const actorEmail = change.file?.lastModifyingUser?.emailAddress ?? null;
      const modifiedTime = change.file?.modifiedTime ?? null;
      const filename = change.file?.name ?? null;

      // GD-07 dedupe: the ledger UNIQUE(integration, file, revision)
      // refuses a second insert. We probe with the *intended* outcome so a
      // future operator can read the ledger and see "this revision was
      // queued / dropped because parents didn't match" without needing
      // engineering to replay logs.
      const ledgerOutcome = classifyLedgerOutcome(matches, parents.length);

      // Reserve-then-confirm ordering: insert ledger row BEFORE enqueue so the
      // UNIQUE(integration, file, revision) constraint dedupes against an at-
      // least-once Drive redelivery. If the matching path's enqueue then
      // fails (returns null OR throws), we COMPENSATE by deleting the ledger
      // row so the next pass can retry — without this, a transient queue
      // failure would silently lose the rule event forever.
      const ledgerResult = await args.db.insertRevisionLedger({
        integration_id: args.integration.id,
        org_id: args.integration.org_id,
        file_id: fileId,
        revision_id: revisionId,
        parent_ids: parents,
        modified_time: modifiedTime,
        actor_email: actorEmail,
        outcome: ledgerOutcome,
        rule_event_id: null,
      });

      if (ledgerResult.conflict) {
        result.duplicates += 1;
        continue;
      }

      if (!matches) {
        // CodeRabbit nit (PR #689): only count true parent-mismatches; the
        // `unrelated_change` ledger outcome (parents.length === 0) is a
        // distinct telemetry class and would inflate the mismatch metric.
        if (parents.length > 0) result.parentMismatch += 1;
        continue;
      }

      // GD-04 + GD-05 + GD-06: matching change → enqueue exactly one rule
      // event, attribution preserved where Google permits.
      let ruleEventId: string | null = null;
      try {
        ruleEventId = await args.db.enqueueRuleEvent({
          org_id: args.integration.org_id,
          file_id: fileId,
          parent_ids: parents,
          actor_email: actorEmail,
          revision_id: revisionId,
          integration_id: args.integration.id,
          filename,
        });
      } catch (err) {
        // Compensate: roll back the ledger reservation so retry isn't blocked.
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: fileId,
          revision_id: revisionId,
        });
        log?.error?.({ err, integrationId: args.integration.id, fileId, revisionId }, 'drive enqueueRuleEvent threw — ledger rolled back, page abort');
        throw err;
      }
      if (ruleEventId === null) {
        // Same compensation for null-return failures.
        await args.db.deleteRevisionLedgerEntry({
          integration_id: args.integration.id,
          file_id: fileId,
          revision_id: revisionId,
        });
        log?.warn?.({ integrationId: args.integration.id, fileId, revisionId }, 'drive enqueueRuleEvent returned null — ledger rolled back');
        continue;
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

  // CodeRabbit Critical (PR #689): persist the checkpoint when the cap is
  // hit — otherwise a backlog spanning >25 pages would replay the same 25
  // pages forever because the next invocation reads the unchanged token
  // from the DB.
  log?.warn?.({ integrationId: args.integration.id, pages: SAFE_PAGE_LIMIT }, 'drive changes.list page cap reached — partial drain, advancing token');
  await args.db.advancePageToken({
    integration_id: args.integration.id,
    new_page_token: pageToken,
  });
  result.newPageToken = pageToken;
  return result;
}
