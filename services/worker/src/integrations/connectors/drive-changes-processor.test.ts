/**
 * SCRUM-1650 GD-AUTO-01 — Drive folder-watch processing loop tests.
 *
 * Pins the GD-03..07 acceptance criteria from the May 1 PRD. The processor
 * is dependency-injected so these tests touch neither real Drive nor real
 * Postgres — `listChanges` is replaced with a mock returning fixture pages,
 * and `db` is a plain object capturing every call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processDriveChanges,
  type DriveProcessorDb,
  type DriveProcessorIntegration,
} from './drive-changes-processor.js';
import type { DriveChangesListResponseT } from '../oauth/drive.js';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTEGRATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WATCHED_FOLDER_A = 'folder-watched-A';
const WATCHED_FOLDER_B = 'folder-watched-B';
const UNWATCHED_FOLDER = 'folder-not-watched';

function makeIntegration(overrides: Partial<DriveProcessorIntegration> = {}): DriveProcessorIntegration {
  return {
    id: INTEGRATION_ID,
    org_id: ORG_ID,
    last_page_token: 'token-1',
    watched_folder_ids: [WATCHED_FOLDER_A, WATCHED_FOLDER_B],
    ...overrides,
  };
}

interface FakeDb extends DriveProcessorDb {
  ledgerInserts: Array<{ file_id: string; revision_id: string; outcome: string; parent_ids: string[]; actor_email: string | null }>;
  ledgerDeletes: Array<{ file_id: string; revision_id: string }>;
  enqueueCalls: Array<{ file_id: string; parent_ids: string[]; actor_email: string | null; revision_id: string }>;
  advancedPageTokens: string[];
  duplicateKeys: Set<string>;
  enqueueResult: string | null;
}

function makeFakeDb(opts: {
  duplicateKeys?: string[];
  enqueueResult?: string | null;
  enqueueImpl?: (payload: { file_id: string; revision_id: string }) => Promise<string | null>;
} = {}): FakeDb {
  const ledgerInserts: FakeDb['ledgerInserts'] = [];
  const ledgerDeletes: FakeDb['ledgerDeletes'] = [];
  const enqueueCalls: FakeDb['enqueueCalls'] = [];
  const advancedPageTokens: string[] = [];
  const duplicateKeys = new Set(opts.duplicateKeys ?? []);
  const enqueueResult = opts.enqueueResult === undefined ? 'evt-out' : opts.enqueueResult;

  return {
    ledgerInserts,
    ledgerDeletes,
    enqueueCalls,
    advancedPageTokens,
    duplicateKeys,
    enqueueResult,
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
    advancePageToken: vi.fn(async ({ new_page_token }) => {
      advancedPageTokens.push(new_page_token);
    }),
    enqueueRuleEvent: vi.fn(async (payload) => {
      enqueueCalls.push({
        file_id: payload.file_id,
        parent_ids: payload.parent_ids,
        actor_email: payload.actor_email,
        revision_id: payload.revision_id,
      });
      if (opts.enqueueImpl) return opts.enqueueImpl(payload);
      return enqueueResult;
    }),
  };
}

function pageOf(changes: Array<unknown>, opts: { newStartPageToken?: string; nextPageToken?: string } = {}): DriveChangesListResponseT {
  return {
    changes: changes as DriveChangesListResponseT['changes'],
    newStartPageToken: opts.newStartPageToken,
    nextPageToken: opts.nextPageToken,
  };
}

describe('processDriveChanges (SCRUM-1650 GD-03..07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GD-03: walks one page, advances persisted page token to newStartPageToken', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf([
        {
          file: {
            id: 'file-1',
            name: 'msa.pdf',
            parents: [WATCHED_FOLDER_A],
            modifiedTime: '2026-05-04T01:00:00Z',
            headRevisionId: 'rev-1',
          },
        },
      ], { newStartPageToken: 'token-2' }),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'access-token',
      db,
      deps: { listChanges: listMock },
    });

    expect(listMock).toHaveBeenCalledWith({ accessToken: 'access-token', pageToken: 'token-1' });
    expect(db.advancedPageTokens).toEqual(['token-2']);
    expect(result.newPageToken).toBe('token-2');
    expect(result.pagesProcessed).toBe(1);
    expect(result.changesProcessed).toBe(1);
    expect(result.queued).toBe(1);
  });

  it('GD-04: changes outside watched folders write parent_mismatch ledger row but do not enqueue', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf([
        {
          file: { id: 'file-out', name: 'unrelated.pdf', parents: [UNWATCHED_FOLDER], headRevisionId: 'rev-out' },
        },
        {
          file: { id: 'file-in', name: 'partnership.pdf', parents: [WATCHED_FOLDER_A], headRevisionId: 'rev-in' },
        },
      ], { newStartPageToken: 'token-2' }),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(result.queued).toBe(1);
    expect(result.parentMismatch).toBe(1);
    expect(db.enqueueCalls).toHaveLength(1);
    expect(db.enqueueCalls[0].file_id).toBe('file-in');
    expect(db.ledgerInserts).toHaveLength(2);
    expect(db.ledgerInserts.find((r) => r.file_id === 'file-out')!.outcome).toBe('parent_mismatch');
    expect(db.ledgerInserts.find((r) => r.file_id === 'file-in')!.outcome).toBe('queued');
  });

  it('GD-05: multi-user attribution — actor_email passed to enqueue per change', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf([
        {
          file: {
            id: 'file-mercy',
            name: 'a.pdf',
            parents: [WATCHED_FOLDER_A],
            headRevisionId: 'rev-m',
            lastModifyingUser: { emailAddress: 'mercy@example.com' },
          },
        },
        {
          file: {
            id: 'file-kevin',
            name: 'b.pdf',
            parents: [WATCHED_FOLDER_A],
            headRevisionId: 'rev-k',
            lastModifyingUser: { emailAddress: 'kevin@example.com' },
          },
        },
      ], { newStartPageToken: 'token-2' }),
    );

    await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    const actors = db.enqueueCalls
      .map((c) => c.actor_email)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(actors).toEqual(['kevin@example.com', 'mercy@example.com']);
  });

  it('GD-06: multi-file burst on a single page — all matching files enqueue, none dropped', async () => {
    const db = makeFakeDb();
    const burst = Array.from({ length: 12 }, (_, i) => ({
      file: { id: `file-${i}`, name: `f${i}.pdf`, parents: [WATCHED_FOLDER_B], headRevisionId: `rev-${i}` },
    }));
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf(burst, { newStartPageToken: 'token-2' }),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(result.changesProcessed).toBe(12);
    expect(result.queued).toBe(12);
    expect(db.enqueueCalls).toHaveLength(12);
  });

  it('GD-07: revision dedupe — a repeat revision ledger conflict skips enqueue and counts duplicate', async () => {
    const db = makeFakeDb({
      duplicateKeys: ['file-already::rev-already'],
    });
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf([
        {
          file: { id: 'file-already', name: 'a.pdf', parents: [WATCHED_FOLDER_A], headRevisionId: 'rev-already' },
        },
        {
          file: { id: 'file-fresh', name: 'b.pdf', parents: [WATCHED_FOLDER_A], headRevisionId: 'rev-fresh' },
        },
      ], { newStartPageToken: 'token-2' }),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(result.duplicates).toBe(1);
    expect(result.queued).toBe(1);
    expect(db.enqueueCalls).toHaveLength(1);
    expect(db.enqueueCalls[0].file_id).toBe('file-fresh');
  });

  it('paginates: nextPageToken triggers a second list call before advancing', async () => {
    const db = makeFakeDb();
    const listMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageOf(
          [{ file: { id: 'f1', parents: [WATCHED_FOLDER_A], headRevisionId: 'r1' } }],
          { nextPageToken: 'token-2' },
        ),
      )
      .mockResolvedValueOnce(
        pageOf(
          [{ file: { id: 'f2', parents: [WATCHED_FOLDER_A], headRevisionId: 'r2' } }],
          { newStartPageToken: 'token-3' },
        ),
      );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock.mock.calls[0][0].pageToken).toBe('token-1');
    expect(listMock.mock.calls[1][0].pageToken).toBe('token-2');
    expect(result.pagesProcessed).toBe(2);
    expect(result.queued).toBe(2);
    expect(db.advancedPageTokens).toEqual(['token-3']);
  });

  it('skips removed/trashed changes without ledger writes', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf([
        { fileId: 'gone', removed: true },
        { file: { id: 'trash', parents: [WATCHED_FOLDER_A], headRevisionId: 'r-trash', trashed: true } },
        { file: { id: 'alive', parents: [WATCHED_FOLDER_A], headRevisionId: 'r-alive' } },
      ], { newStartPageToken: 'token-2' }),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(result.changesProcessed).toBe(3);
    expect(result.queued).toBe(1);
    expect(db.ledgerInserts).toHaveLength(1);
    expect(db.ledgerInserts[0].file_id).toBe('alive');
  });

  it('falls back to modifiedTime as revision when headRevisionId absent (Docs/Sheets)', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf(
        [{ file: { id: 'doc-1', parents: [WATCHED_FOLDER_A], modifiedTime: '2026-05-04T01:23:00Z' } }],
        { newStartPageToken: 'token-2' },
      ),
    );

    await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(db.ledgerInserts[0].revision_id).toBe('mtime:2026-05-04T01:23:00Z');
  });

  it('Codex P1 (no-drop): enqueue returning null rolls back the ledger reservation and aborts the page', async () => {
    const db = makeFakeDb({ enqueueResult: null });
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf(
        [{ file: { id: 'file-fail', parents: [WATCHED_FOLDER_A], headRevisionId: 'rev-fail' } }],
        { newStartPageToken: 'token-2' },
      ),
    );

    await expect(
      processDriveChanges({
        integration: makeIntegration(),
        accessToken: 'tok',
        db,
        deps: { listChanges: listMock },
      }),
    ).rejects.toThrow(/enqueueRuleEvent returned null/);

    // Compensating delete fired so the (integration, file, revision) slot
    // is free for the next pass to retry. Without this, the row would
    // persist and dedupe-block all future attempts on this revision.
    expect(db.ledgerDeletes).toEqual([{ file_id: 'file-fail', revision_id: 'rev-fail' }]);
    expect(db.duplicateKeys.has('file-fail::rev-fail')).toBe(false);
    expect(db.advancedPageTokens).toEqual([]);
  });

  it('Codex P1 (no-drop): enqueue throwing rolls back the ledger reservation and re-throws', async () => {
    const db = makeFakeDb({
      enqueueImpl: async () => {
        throw new Error('queue offline');
      },
    });
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf(
        [{ file: { id: 'file-throw', parents: [WATCHED_FOLDER_A], headRevisionId: 'rev-throw' } }],
        { newStartPageToken: 'token-2' },
      ),
    );

    await expect(
      processDriveChanges({
        integration: makeIntegration(),
        accessToken: 'tok',
        db,
        deps: { listChanges: listMock },
      }),
    ).rejects.toThrow(/queue offline/);

    expect(db.ledgerDeletes).toEqual([{ file_id: 'file-throw', revision_id: 'rev-throw' }]);
    expect(db.duplicateKeys.has('file-throw::rev-throw')).toBe(false);
  });

  it('SCRUM-1647 follow-up (no-stuck-backlog): SAFE_PAGE_LIMIT cap-exit persists the page token', async () => {
    // Drive's at-least-once delivery + nextPageToken chains: if the cap is
    // hit because there's a backlog of >SAFE_PAGE_LIMIT pages, we MUST
    // still advance the persisted token. Otherwise the next invocation
    // reads the unchanged token from the DB and replays the same window
    // forever.
    const db = makeFakeDb();
    // Build a chain that always returns nextPageToken — never reaches a
    // final page (no newStartPageToken). The processor will hit
    // SAFE_PAGE_LIMIT.
    const listMock = vi.fn().mockImplementation(async ({ pageToken }: { pageToken: string }) => {
      const next = `token-after-${pageToken}`;
      return pageOf(
        [{ file: { id: `file-${pageToken}`, parents: [WATCHED_FOLDER_A], headRevisionId: `rev-${pageToken}` } }],
        { nextPageToken: next },
      );
    });

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    let expectedToken = 'token-1';
    for (let i = 0; i < 25; i += 1) {
      expectedToken = `token-after-${expectedToken}`;
    }

    // Hit the cap and persist the exact token for the next unread page.
    expect(result.pagesProcessed).toBe(25);
    expect(db.advancedPageTokens).toEqual([expectedToken]);
    expect(result.newPageToken).toBe(expectedToken);
  });

  it('SCRUM-1647 follow-up (telemetry hygiene): parentMismatch counter excludes unrelated_change rows', async () => {
    // GD-04 telemetry: only true folder mismatches inflate the counter.
    // A change with no parents at all is `unrelated_change` and is its
    // own ledger outcome — it must not be double-counted as a mismatch.
    const db = makeFakeDb();
    const listMock = vi.fn().mockResolvedValueOnce(
      pageOf(
        [
          { file: { id: 'no-parents', headRevisionId: 'rev-np' } }, // unrelated_change
          { file: { id: 'wrong-folder', parents: [UNWATCHED_FOLDER], headRevisionId: 'rev-wf' } }, // parent_mismatch
        ],
        { newStartPageToken: 'token-2' },
      ),
    );

    const result = await processDriveChanges({
      integration: makeIntegration(),
      accessToken: 'tok',
      db,
      deps: { listChanges: listMock },
    });

    expect(result.parentMismatch).toBe(1);
    expect(db.enqueueCalls).toHaveLength(0);
    expect(db.ledgerInserts.find((r) => r.file_id === 'no-parents')!.outcome).toBe('unrelated_change');
    expect(db.ledgerInserts.find((r) => r.file_id === 'wrong-folder')!.outcome).toBe('parent_mismatch');
  });

  it('throws when integration has no last_page_token (misconfiguration, fail loud)', async () => {
    const db = makeFakeDb();
    const listMock = vi.fn();
    await expect(
      processDriveChanges({
        integration: makeIntegration({ last_page_token: null }),
        accessToken: 'tok',
        db,
        deps: { listChanges: listMock },
      }),
    ).rejects.toThrow(/no last_page_token/);
    expect(listMock).not.toHaveBeenCalled();
  });
});
