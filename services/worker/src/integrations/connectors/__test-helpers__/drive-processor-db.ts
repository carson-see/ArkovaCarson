/**
 * Shared `DriveProcessorDb` test double for `drive-changes-processor.test.ts`
 * and `drive-changes-e2e.test.ts` (fix-round item D, SCRUM-2903/3661/5094/2330
 * — the two files previously carried near-duplicate hand-rolled fakes).
 *
 * Behaves like real Postgres for the properties these tests care about:
 * the `drive_revision_ledger` UNIQUE(integration, file, revision) constraint
 * (dedupe/idempotency, via a real `Map`, not a stub), and — since fix-round
 * item 4A — a genuine compare-and-swap on `advancePageToken`, keyed on
 * `expected_page_token`, exactly like the real adapter in
 * `drive-changes-runner.ts`'s `createProcessorDbAdapter`.
 */
import { vi } from 'vitest';
import type { DriveProcessorDb } from '../drive-changes-processor.js';

export interface FakeDriveProcessorDbOptions {
  /** Pre-seed the ledger as if these (file_id, revision_id) pairs already exist. */
  duplicateKeys?: string[];
  /** Result `enqueueRuleEvent` resolves to when not overridden per-call. Defaults to `'evt-out'`. */
  enqueueResult?: string | null;
  enqueueImpl?: (payload: { file_id: string; revision_id: string }) => Promise<string | null>;
  /** Result `enqueueFileChangedJob` resolves to when not overridden per-call. Defaults to `'job-out'`. */
  fileChangedJobResult?: string | null;
  fileChangedJobImpl?: (payload: { file_id: string; rule_event_id: string }) => Promise<string | null>;
  /**
   * Seed the persisted cursor CAS anchors to something other than the
   * default `'token-1'` — must match whatever `last_page_token` the test's
   * `DriveProcessorIntegration` fixture uses, or every `advancePageToken`
   * call will (correctly) report a CAS miss.
   */
  persistedPageToken?: string;
}

export interface FakeDriveProcessorDb extends DriveProcessorDb {
  ledgerInserts: Array<{
    file_id: string;
    revision_id: string;
    outcome: string;
    parent_ids: string[];
    actor_email: string | null;
  }>;
  ledgerDeletes: Array<{ file_id: string; revision_id: string }>;
  enqueueCalls: Array<{
    file_id: string;
    parent_ids: string[];
    actor_email: string | null;
    revision_id: string;
    folder_path: string | null;
  }>;
  fileChangedJobCalls: Array<{
    file_id: string;
    revision_id: string | null;
    mime_type: string | null;
    modified_time: string | null;
    rule_event_id: string;
  }>;
  /**
   * SCRUM-4507: the FULL payload, captured verbatim. `fileChangedJobCalls`
   * above is a deliberately narrow projection several tests assert with
   * `toEqual`; widening it would break them for no reason. Link-back fields
   * are asserted against this raw capture instead.
   */
  fileChangedJobPayloads: Array<Record<string, unknown>>;
  /** Every `new_page_token` value a SUCCESSFUL `advancePageToken` call persisted, in order. */
  advancedPageTokens: string[];
  /** Every `advancePageToken` call attempted, successful or not — for CAS-miss assertions. */
  advancePageTokenCalls: Array<{ integration_id: string; new_page_token: string; expected_page_token: string }>;
  /** Every `recordCursorGap` call, in order — fix-round item 2 (gap visibility). */
  cursorGapRecords: Array<{ integration_id: string; org_id: string; gap_start: string | null; gap_end: string }>;
  /** Current CAS anchor — what the next `advancePageToken` must match to succeed. Mutates as advances land. */
  currentPersistedPageToken: () => string;
  duplicateKeys: Set<string>;
  enqueueResult: string | null;
  fileChangedJobResult: string | null;
}

export function createFakeDriveProcessorDb(opts: FakeDriveProcessorDbOptions = {}): FakeDriveProcessorDb {
  const ledgerInserts: FakeDriveProcessorDb['ledgerInserts'] = [];
  const ledgerDeletes: FakeDriveProcessorDb['ledgerDeletes'] = [];
  const enqueueCalls: FakeDriveProcessorDb['enqueueCalls'] = [];
  const fileChangedJobCalls: FakeDriveProcessorDb['fileChangedJobCalls'] = [];
  const fileChangedJobPayloads: FakeDriveProcessorDb['fileChangedJobPayloads'] = [];
  const advancedPageTokens: string[] = [];
  const advancePageTokenCalls: FakeDriveProcessorDb['advancePageTokenCalls'] = [];
  const cursorGapRecords: FakeDriveProcessorDb['cursorGapRecords'] = [];
  const duplicateKeys = new Set(opts.duplicateKeys ?? []);
  const enqueueResult = opts.enqueueResult === undefined ? 'evt-out' : opts.enqueueResult;
  const fileChangedJobResult = opts.fileChangedJobResult === undefined ? 'job-out' : opts.fileChangedJobResult;
  let persistedPageToken = opts.persistedPageToken ?? 'token-1';

  return {
    ledgerInserts,
    ledgerDeletes,
    enqueueCalls,
    fileChangedJobCalls,
    fileChangedJobPayloads,
    advancedPageTokens,
    advancePageTokenCalls,
    cursorGapRecords,
    currentPersistedPageToken: () => persistedPageToken,
    duplicateKeys,
    enqueueResult,
    fileChangedJobResult,
    insertRevisionLedger: vi.fn(async (row) => {
      const key = `${row.file_id}::${row.revision_id}`;
      if (duplicateKeys.has(key)) {
        return { inserted: false, conflict: true };
      }
      duplicateKeys.add(key);
      ledgerInserts.push({
        file_id: row.file_id,
        revision_id: row.revision_id,
        outcome: row.outcome,
        parent_ids: row.parent_ids,
        actor_email: row.actor_email,
      });
      return { inserted: true, conflict: false };
    }),
    deleteRevisionLedgerEntry: vi.fn(async ({ file_id, revision_id }) => {
      const key = `${file_id}::${revision_id}`;
      duplicateKeys.delete(key);
      const idx = ledgerInserts.findIndex((r) => r.file_id === file_id && r.revision_id === revision_id);
      if (idx >= 0) ledgerInserts.splice(idx, 1);
      ledgerDeletes.push({ file_id, revision_id });
    }),
    advancePageToken: vi.fn(async ({ integration_id, new_page_token, expected_page_token }) => {
      advancePageTokenCalls.push({ integration_id, new_page_token, expected_page_token });
      if (expected_page_token !== persistedPageToken) {
        return { advanced: false };
      }
      persistedPageToken = new_page_token;
      advancedPageTokens.push(new_page_token);
      return { advanced: true };
    }),
    recordCursorGap: vi.fn(async (args) => {
      cursorGapRecords.push(args);
    }),
    enqueueRuleEvent: vi.fn(async (payload) => {
      enqueueCalls.push({
        file_id: payload.file_id,
        parent_ids: payload.parent_ids,
        actor_email: payload.actor_email,
        revision_id: payload.revision_id,
        folder_path: payload.folder_path,
      });
      if (opts.enqueueImpl) return opts.enqueueImpl(payload);
      return enqueueResult;
    }),
    // SCRUM-2903 (GD-PROD): default fake mirrors production's happy path —
    // every enqueueRuleEvent success is immediately followed by a file-changed
    // job enqueue. Tests that want to exercise the failure/rollback path pass
    // fileChangedJobResult: null or fileChangedJobImpl.
    enqueueFileChangedJob: vi.fn(async (payload) => {
      fileChangedJobPayloads.push({ ...payload } as Record<string, unknown>);
      fileChangedJobCalls.push({
        file_id: payload.file_id,
        revision_id: payload.revision_id,
        mime_type: payload.mime_type,
        modified_time: payload.modified_time,
        rule_event_id: payload.rule_event_id,
      });
      if (opts.fileChangedJobImpl) return opts.fileChangedJobImpl(payload);
      return fileChangedJobResult;
    }),
  };
}
