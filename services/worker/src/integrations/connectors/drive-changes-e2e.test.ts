/**
 * Downstream dry-read: `runDriveChanges` → `drive-changes-processor.ts` →
 * `enqueueFileChangedJob` → `jobs/drive-file-changed.ts` (Task 3, orchestrator
 * review of the SCRUM-2903/3661/5094/2330 changes.list fields-mask fix).
 *
 * Because `changes.list` has NEVER once succeeded in prod for the flagged
 * organization (the incident this PR fixes), EVERYTHING downstream of it —
 * folder-rule match, revision ledger, rule-event enqueue, file-changed job
 * enqueue — has never run against a real Google response. The atomic unit
 * tests in `drive-changes-processor.test.ts` each pin ONE behavior with a
 * minimal fixture; this file instead walks ONE realistic, multi-page,
 * multi-scenario `changes.list` response — built from Google's DOCUMENTED
 * `changes.list` v3 response schema
 * (https://developers.google.com/drive/api/reference/rest/v3/changes/list) —
 * through the real `processDriveChanges` orchestrator, and closes the loop to
 * the consumer side by validating every enqueued job payload against the
 * REAL `DriveFileChangedJobPayload` Zod contract `jobs/drive-file-changed.ts`
 * parses on drain (that file's own SHA-256/fetch/connector_artifact
 * internals are covered separately in `drive-file-changed.test.ts` and are
 * out of scope for a fields-mask fix).
 *
 * The fixture carries one change of each documented shape Task 3 calls out:
 *   - a file inside a watched folder (must enqueue)
 *   - a file outside every watched folder (must NOT enqueue — parent_mismatch)
 *   - a removed file (must NOT enqueue — no ledger write at all)
 *   - a Google-native Doc with no headRevisionId (must enqueue, revision_kind
 *     'modified_time')
 *   - a change with `parents` ABSENT entirely, as Google documents can happen
 *     for some shared-drive items (must NOT enqueue — Drive gave us nothing
 *     to match against, so this is 'unrelated_change', not a mismatch)
 * across a two-page walk that ends in `newStartPageToken`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  processDriveChanges,
  type DriveProcessorIntegration,
} from './drive-changes-processor.js';
import { DriveFileChangedJobPayload } from './drive-artifact-producer.js';
import type { DriveChangesListResponseT } from '../oauth/drive.js';
import { createFakeDriveProcessorDb } from './__test-helpers__/drive-processor-db.js';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INTEGRATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WATCHED_FOLDER = 'folder-watched';
const UNWATCHED_FOLDER = 'folder-elsewhere';

/**
 * Fix-round item D (simplify): this used to be a hand-rolled
 * `DriveProcessorDb` double, near-duplicate of
 * `drive-changes-processor.test.ts`'s own fake. Both now share
 * `__test-helpers__/drive-processor-db.ts`. `makeRealisticDb` is kept as a
 * thin wrapper — with `persistedPageToken` matching `makeIntegration`'s
 * default `'cursor-0'`, so the shared fake's CAS-based `advancePageToken`
 * (fix-round item 4A) behaves correctly against this file's fixtures — so
 * the call sites below don't need renaming, and to re-expose the fields
 * this file's assertions read under their existing names.
 */
function makeRealisticDb() {
  const fake = createFakeDriveProcessorDb({ persistedPageToken: 'cursor-0' });
  return {
    db: fake,
    // `ledgerInserts` carries `{file_id, revision_id, outcome, ...}` per row
    // — the shared fake's real ledger record, not a reconstruction.
    ledgerRows: fake.ledgerInserts,
    enqueuedRuleEvents: fake.enqueueCalls as unknown as Array<Record<string, unknown>>,
    enqueuedFileChangedJobs: fake.fileChangedJobPayloads,
    advancedPageTokens: fake.advancedPageTokens,
    fake,
  };
}

function makeIntegration(overrides: Partial<DriveProcessorIntegration> = {}): DriveProcessorIntegration {
  return {
    id: INTEGRATION_ID,
    org_id: ORG_ID,
    last_page_token: 'cursor-0',
    watched_folder_ids: [WATCHED_FOLDER],
    last_token_advanced_at: null,
    ...overrides,
  };
}

/** Page 1 of the documented-shape fixture: the five required scenarios. */
function pageOne(): DriveChangesListResponseT {
  return {
    changes: [
      // 1. In watched folder — must enqueue.
      {
        fileId: 'file-in-folder',
        removed: false,
        changeType: 'file',
        time: '2026-09-20T10:00:00.000Z',
        file: {
          id: 'file-in-folder',
          name: 'Signed Agreement.pdf',
          parents: [WATCHED_FOLDER],
          driveId: undefined,
          modifiedTime: '2026-09-20T10:00:00.000Z',
          headRevisionId: 'rev-abc123',
          trashed: false,
          mimeType: 'application/pdf',
          lastModifyingUser: { emailAddress: 'counsel@example.com', displayName: 'Counsel' },
        },
      },
      // 2. Outside every watched folder — must NOT enqueue (parent_mismatch).
      {
        fileId: 'file-elsewhere',
        removed: false,
        changeType: 'file',
        time: '2026-09-20T10:05:00.000Z',
        file: {
          id: 'file-elsewhere',
          name: 'Unrelated.docx',
          parents: [UNWATCHED_FOLDER],
          modifiedTime: '2026-09-20T10:05:00.000Z',
          headRevisionId: 'rev-xyz789',
          trashed: false,
          mimeType: 'application/vnd.google-apps.document',
        },
      },
      // 3. Removed — must NOT enqueue, no ledger write at all.
      {
        fileId: 'file-removed',
        removed: true,
        changeType: 'file',
        time: '2026-09-20T10:10:00.000Z',
      },
    ],
    nextPageToken: 'cursor-1',
  };
}

/** Page 2: Google-native Doc + a shared-drive item with `parents` absent. */
function pageTwo(): DriveChangesListResponseT {
  return {
    changes: [
      // 4. Google-native Doc — no headRevisionId, falls back to modifiedTime.
      // In the watched folder — must enqueue with revision_kind 'modified_time'.
      {
        fileId: 'file-native-doc',
        removed: false,
        changeType: 'file',
        time: '2026-09-20T11:00:00.000Z',
        file: {
          id: 'file-native-doc',
          name: 'Board Resolution',
          parents: [WATCHED_FOLDER],
          modifiedTime: '2026-09-20T11:00:00.000Z',
          // No headRevisionId — Workspace-native files never expose one.
          trashed: false,
          mimeType: 'application/vnd.google-apps.document',
        },
      },
      // 5. `parents` ABSENT entirely — Google documents this can happen for
      // some shared-drive items. Must NOT enqueue: nothing to match against.
      {
        fileId: 'file-shared-drive-no-parents',
        removed: false,
        changeType: 'file',
        time: '2026-09-20T11:05:00.000Z',
        file: {
          id: 'file-shared-drive-no-parents',
          name: 'Shared drive item.pdf',
          // `parents` key omitted entirely (not even an empty array).
          driveId: 'shared-drive-1',
          modifiedTime: '2026-09-20T11:05:00.000Z',
          headRevisionId: 'rev-shared-1',
          trashed: false,
          mimeType: 'application/pdf',
        },
      },
    ],
    newStartPageToken: 'cursor-final',
  };
}

describe('Drive changes pipeline — realistic multi-scenario, multi-page dry-read (Task 3)', () => {
  it('walks both pages, enqueues ONLY the two in-folder changes, and advances the cursor to newStartPageToken exactly once', async () => {
    let call = 0;
    const listMock = vi.fn().mockImplementation(async ({ pageToken }: { pageToken: string }) => {
      call += 1;
      if (call === 1) {
        expect(pageToken).toBe('cursor-0');
        return pageOne();
      }
      expect(pageToken).toBe('cursor-1');
      return pageTwo();
    });

    const { db, enqueuedRuleEvents, enqueuedFileChangedJobs, advancedPageTokens, ledgerRows } = makeRealisticDb();

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'access-tok',
      db,
      deps: { listChanges: listMock },
    });

    // Pagination: exactly 2 pages, 5 changes total.
    expect(result.pagesProcessed).toBe(2);
    expect(result.changesProcessed).toBe(5);

    // Only the two IN-FOLDER, non-removed, revision-resolvable changes
    // enqueue: file-in-folder (head_revision) and file-native-doc
    // (modified_time fallback).
    expect(result.queued).toBe(2);
    expect(enqueuedRuleEvents.map((e) => e.file_id)).toEqual(['file-in-folder', 'file-native-doc']);
    expect(enqueuedFileChangedJobs.map((j) => j.file_id)).toEqual(['file-in-folder', 'file-native-doc']);

    // parent_mismatch counted for file-elsewhere (has parents, none watched).
    expect(result.parentMismatch).toBe(1);

    // Removed change never reached the ledger at all.
    expect(ledgerRows.some((r) => r.file_id === 'file-removed')).toBe(false);

    // The absent-`parents` shared-drive item is neither queued nor counted
    // as a parent_mismatch — Drive gave nothing to match against, so it is
    // ledgered as 'unrelated_change' (parents.length === 0), same as any
    // change with zero parents.
    const sharedDriveLedgerEntry = ledgerRows.find((r) => r.file_id === 'file-shared-drive-no-parents');
    expect(sharedDriveLedgerEntry?.outcome).toBe('unrelated_change');

    // Cursor: advanced to newStartPageToken exactly ONCE, at the end of the
    // walk — never to the intermediate nextPageToken.
    expect(advancedPageTokens).toEqual(['cursor-final']);
    expect(result.newPageToken).toBe('cursor-final');

    // §1.6A: no document bytes anywhere in what got enqueued. Every payload
    // field is a bounded string/id/boolean — assert none is a Buffer/typed
    // array and every value that IS a string is short (a byte payload would
    // be large; ids/emails/paths are not).
    for (const job of enqueuedFileChangedJobs) {
      for (const [key, value] of Object.entries(job)) {
        expect(Buffer.isBuffer(value), `job field ${key} must never be a Buffer`).toBe(false);
        expect(value instanceof Uint8Array, `job field ${key} must never be a typed array`).toBe(false);
        if (typeof value === 'string') {
          expect(value.length, `job field ${key} must be a bounded id/string, not document content`).toBeLessThan(500);
        }
      }
    }
  });

  it('every enqueued file-changed job payload parses against the REAL DriveFileChangedJobPayload contract jobs/drive-file-changed.ts consumes', async () => {
    const listMock = vi.fn()
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(pageTwo());
    const { db, enqueuedFileChangedJobs } = makeRealisticDb();

    await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'access-tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(enqueuedFileChangedJobs.length).toBeGreaterThan(0);
    for (const job of enqueuedFileChangedJobs) {
      // The adapter (drive-changes-runner.ts's createProcessorDbAdapter)
      // converts `null` -> `undefined` before this validation in production;
      // this test calls the processor directly (below the adapter), so we
      // apply the same, documented conversion here to validate the SAME
      // contract the real consumer parses, not a stricter/looser one.
      const forConsumer = Object.fromEntries(
        Object.entries(job).filter(([k]) => k !== 'id').map(([k, v]) => [k, v === null ? undefined : v]),
      );
      expect(() => DriveFileChangedJobPayload.parse(forConsumer)).not.toThrow();
    }
  });

  it('a mid-walk (page 2) changes.list failure does not advance the cursor — page 1\'s enqueue is preserved, retry resumes from the ORIGINAL cursor', async () => {
    const listMock = vi.fn()
      .mockResolvedValueOnce(pageOne())
      .mockRejectedValueOnce(new Error('Drive changes.list failed: 503'));
    const { db, enqueuedFileChangedJobs, advancedPageTokens } = makeRealisticDb();

    await expect(
      processDriveChanges({
        integration: makeIntegration(),
        accessToken: 'access-tok',
        db,
        deps: { listChanges: listMock },
      }),
    ).rejects.toThrow('Drive changes.list failed: 503');

    // Page 1's genuine match still enqueued — that work is not lost.
    expect(enqueuedFileChangedJobs.map((j) => j.file_id)).toEqual(['file-in-folder']);
    // But the cursor never moved — a retry replays from `cursor-0` exactly,
    // not from the unpersisted `cursor-1` the failed page would have used.
    expect(advancedPageTokens).toEqual([]);
  });

  it('replaying the SAME two-page response is idempotent: zero new enqueues, everything counted as duplicates, ledger dedupe key holds', async () => {
    const { db, enqueuedFileChangedJobs, ledgerRows, advancedPageTokens } = makeRealisticDb();
    const integration = makeIntegration();

    const firstRun = await processDriveChanges({
      integration,
      accessToken: 'access-tok',
      db,
      deps: { listChanges: vi.fn().mockResolvedValueOnce(pageOne()).mockResolvedValueOnce(pageTwo()) },
    });
    expect(firstRun.queued).toBe(2);
    expect(enqueuedFileChangedJobs).toHaveLength(2);
    const ledgerSizeAfterFirstRun = ledgerRows.length;

    // Second run: SAME cursor (Drive redelivered the identical webhook, or a
    // retry replayed the same window), SAME response shape.
    const secondRun = await processDriveChanges({
      integration,
      accessToken: 'access-tok',
      db,
      deps: { listChanges: vi.fn().mockResolvedValueOnce(pageOne()).mockResolvedValueOnce(pageTwo()) },
    });

    // No new work queued — every (integration, file, revision) already
    // exists in the ledger, so every insert attempt 23505s (simulated by the
    // Map-keyed double) and is counted as a duplicate. That includes the
    // NON-matching changes too — the ledger records every classified
    // outcome (queued / parent_mismatch / unrelated_change), not just
    // matches, so all 4 non-removed changes replay as duplicates (the
    // removed change never reaches the ledger at all, on either run).
    expect(secondRun.queued).toBe(0);
    expect(secondRun.duplicates).toBe(4);
    expect(enqueuedFileChangedJobs).toHaveLength(2); // unchanged — no new jobs.
    expect(ledgerRows.length).toBe(ledgerSizeAfterFirstRun); // no new rows either.

    // Fix-round item 4A: `advancePageToken` is now a CAS keyed on the token
    // this run STARTED from. Both runs share the same (stale, unmutated)
    // `integration` snapshot — `last_page_token: 'cursor-0'` — so the
    // SECOND run's CAS correctly reports a miss (run 1 already advanced the
    // persisted cursor to 'cursor-final') rather than blindly re-writing
    // the same value a second time. This is the intended behavior change:
    // a true duplicate/concurrent delivery now detects staleness via CAS,
    // not just via the ledger.
    expect(secondRun.cursorAdvanceLost).toBe(true);
    expect(advancedPageTokens).toEqual(['cursor-final']);
  });
});
