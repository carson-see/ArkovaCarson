/**
 * SCRUM-TBD — eager Drive-folder mirroring at connect/rule-save time.
 *
 * THE GAP: migration 0462 already mirrors a connector-sourced Drive folder
 * into `public.folders` LAZILY — the first time a document from that folder
 * is actually materialized as an anchor (`resolve_connector_destination_folder`,
 * called from the `trg_00_route_connector_anchor_to_folder` / connector_artifact
 * triggers). Until a document lands, no folder ever appears — which
 * contradicts the founder's ask: "duplicate connected folders in Arkova
 * automatically upon setup." This module adds the EAGER half: mirror the
 * folder the moment an org connects/saves a Drive-folder watch rule, using
 * the exact same dedupe key (`owner_scope='ORG', org_id, connector_provider,
 * connector_source_id`) the lazy DB path already uses, so the two paths can
 * never create two rows for the same connected folder — whichever runs
 * first wins, the other finds-and-reuses.
 *
 * No new migration: this reuses the `public.folders` table and the unique
 * index `idx_folders_connector_destination_unique` shipped in migration 0462
 * (already on origin/main). The worker's service-role client does a
 * select-then-insert (with a unique-violation race fallback) directly
 * against `folders`, exactly mirroring what `resolve_connector_destination_folder`
 * does in SQL — deliberately NOT the `folder_api_create`/`folder_api_update`
 * RPCs, because `folder_api_administers_org()` authorizes off `org_members`
 * alone and has none of the "owner linked only via `profiles.org_id`"
 * fallback that `rules-crud.ts`'s own `requireOrgAdmin()` already correctly
 * implements (see `api/v1/integrations/drive-folders.ts`'s doc comment on
 * exactly this landmine) — the caller here has ALREADY been authorized by
 * the time this module runs, so re-deriving authorization through a
 * narrower check would silently drop mirroring for those orgs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  mirrorConnectedDriveFolders,
  extractDriveFoldersToMirror,
  shouldMirrorDriveFoldersForRule,
  type DriveFolderToMirror,
} from './drive-folder-mirror.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface FolderRow {
  id: string;
  owner_scope: string;
  org_id: string | null;
  connector_provider: string | null;
  connector_source_id: string | null;
  connector_connection_id: string | null;
  name: string;
  created_by: string;
  is_system_managed: boolean;
}

interface IntegrationRow {
  id: string;
  org_id: string;
  provider: string;
  revoked_at: string | null;
  connected_at: string;
}

/**
 * A small, faithful in-memory model of the two tables this module touches —
 * not a generic chain stub. Real enough to prove idempotency, the race
 * fallback, and tenant isolation, without a live Postgres connection (hard
 * rule: no staging/prod access from this session).
 */
function makeFakeDb(opts: {
  folders?: FolderRow[];
  integrations?: IntegrationRow[];
  /** Forces the NEXT `folders` insert to look like a concurrent-commit race:
   * returns 23505 without recording the attempted row, but ALSO seeds a
   * "winner" row directly (as if another transaction committed it between
   * this call's SELECT and INSERT) so the re-select recovers it. */
  forceInsertConflictOnce?: FolderRow;
  /** Simulates a genuine driver-level exception (a network blip, a dropped
   * connection) rather than a Supabase `{data,error}` return — the
   * `folders` SELECT for this one `connector_source_id` throws synchronously
   * instead of resolving. Models the DB-layer failure mode `upsertOne`
   * itself cannot convert into a returned error, because nothing was
   * returned at all. */
  throwOnSelectSourceId?: string;
  /** Forces the `org_integrations` lookup (the active-connection check) to
   * return a genuine `{data:null, error}` Supabase response — a transient DB
   * failure, distinct from "no active connection" (`{data:null, error:null}`,
   * a legitimate, non-retryable state meaning the org never connected Drive). */
  orgIntegrationsSelectError?: { message: string };
  /** Returns a transient error from the next matching `folders` UPDATE.
   * The row must remain unchanged so a later reconciliation pass can retry. */
  foldersUpdateErrorOnce?: { message: string };
  foldersUpdateZeroRowsOnce?: boolean;
}) {
  const folders: FolderRow[] = opts.folders ? [...opts.folders] : [];
  const integrations: IntegrationRow[] = opts.integrations ?? [];
  let conflictArmed = Boolean(opts.forceInsertConflictOnce);
  let updateErrorArmed = Boolean(opts.foldersUpdateErrorOnce);
  let updateZeroArmed = Boolean(opts.foldersUpdateZeroRowsOnce);
  let nextId = 1;
  const calls: Array<{ table: string; op: string; filters: Record<string, unknown>; payload?: unknown }> = [];

  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(key: string, val: unknown) {
        filters[key] = val;
        return chain;
      },
      is(key: string, val: unknown) {
        filters[key] = val;
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      async maybeSingle() {
        calls.push({ table, op: 'select', filters: { ...filters } });
        if (
          table === 'folders' &&
          opts.throwOnSelectSourceId !== undefined &&
          filters.connector_source_id === opts.throwOnSelectSourceId
        ) {
          throw new Error(`simulated driver exception selecting folders for ${String(filters.connector_source_id)}`);
        }
        if (table === 'org_integrations' && opts.orgIntegrationsSelectError) {
          return { data: null, error: opts.orgIntegrationsSelectError };
        }
        const rows = table === 'folders' ? folders : integrations;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = (rows as any[]).find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }

  function insertChain(table: string, payload: Record<string, unknown>) {
    const chain = {
      select() {
        return chain;
      },
      async single() {
        calls.push({ table, op: 'insert', filters: {}, payload });
        if (table !== 'folders') throw new Error(`unexpected insert table ${table}`);

        if (conflictArmed) {
          conflictArmed = false;
          folders.push({ ...opts.forceInsertConflictOnce! });
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_folders_connector_destination_unique"' },
          };
        }
        const dupe = folders.find(
          (r) =>
            r.owner_scope === payload.owner_scope &&
            r.org_id === payload.org_id &&
            r.connector_provider === payload.connector_provider &&
            r.connector_source_id === payload.connector_source_id,
        );
        if (dupe) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_folders_connector_destination_unique"' },
          };
        }
        const row = { id: `folder-${nextId++}`, ...payload } as FolderRow;
        folders.push(row);
        return { data: { id: row.id }, error: null };
      },
    };
    return chain;
  }

  function updateChain(table: string, payload: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(key: string, val: unknown) {
        filters[key] = val;
        return chain;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op: 'update', filters: { ...filters }, payload });
        if (table === 'folders' && updateErrorArmed) {
          updateErrorArmed = false;
          return Promise.resolve({ data: null, error: opts.foldersUpdateErrorOnce, count: null }).then(resolve, reject);
        }
        if (table === 'folders' && updateZeroArmed) {
          updateZeroArmed = false;
          return Promise.resolve({ data: null, error: null, count: 0 }).then(resolve, reject);
        }
        let count = 0;
        if (table === 'folders') {
          const row = folders.find((r) => Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
          if (row) { Object.assign(row, payload); count = 1; }
        }
        return Promise.resolve({ data: null, error: null, count }).then(resolve, reject);
      },
    };
    return chain;
  }

  const db = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        insert: (payload: Record<string, unknown>) => insertChain(table, payload),
        update: (payload: Record<string, unknown>) => updateChain(table, payload),
      };
    },
  };

  return { db, folders, integrations, calls };
}

const logger = { warn: vi.fn(), error: vi.fn() };

describe('extractDriveFoldersToMirror', () => {
  it('reads {folder_id, folder_name} pairs from trigger_config.drive_folders', () => {
    const result = extractDriveFoldersToMirror({
      vendors: ['google_drive'],
      drive_folders: [
        { type: 'drive_folder', folder_id: 'drv-1', folder_name: 'Invoices' },
        { type: 'drive_folder', folder_id: 'drv-2' },
      ],
    });
    expect(result).toEqual<DriveFolderToMirror[]>([
      { folderId: 'drv-1', folderName: 'Invoices' },
      { folderId: 'drv-2', folderName: null },
    ]);
  });

  it('returns [] for a rule with no drive_folders (e.g. a DocuSign ESIGN_COMPLETED trigger_config) — non-Drive rules are unaffected', () => {
    expect(extractDriveFoldersToMirror({ vendors: ['docusign'] })).toEqual([]);
    expect(extractDriveFoldersToMirror(undefined)).toEqual([]);
    expect(extractDriveFoldersToMirror(null)).toEqual([]);
  });

  it('supports the valid legacy singular binding and de-duplicates it against the array form', () => {
    expect(extractDriveFoldersToMirror({ type: 'drive_folder', folder_id: 'legacy-only' })).toEqual([
      { folderId: 'legacy-only', folderName: null },
    ]);
    expect(extractDriveFoldersToMirror({
      type: 'drive_folder', folder_id: 'same',
      drive_folders: [
        { type: 'drive_folder', folder_id: 'same', folder_name: 'duplicate' },
        { type: 'drive_folder', folder_id: 'second', folder_name: 'Second' },
      ],
    })).toEqual([
      { folderId: 'same', folderName: 'duplicate' },
      { folderId: 'second', folderName: 'Second' },
    ]);
  });

  it('ignores a legacy folder_id unless its type is drive_folder, without displacing three array selections', () => {
    expect(extractDriveFoldersToMirror({
      type: 'workspace_file_modified', folder_id: 'irrelevant',
      drive_folders: [1, 2, 3].map((n) => ({ folder_id: `array-${n}`, folder_name: `Folder ${n}` })),
    })).toEqual([1, 2, 3].map((n) => ({ folderId: `array-${n}`, folderName: `Folder ${n}` })));
  });

  it('returns four for three array selections plus a distinct valid legacy binding so the caller cap rejects it', () => {
    expect(extractDriveFoldersToMirror({
      type: 'drive_folder', folder_id: 'legacy',
      drive_folders: [1, 2, 3].map((n) => ({ folder_id: `array-${n}` })),
    })).toHaveLength(4);
  });

  it('drops duplicate folder ids and malformed entries', () => {
    const result = extractDriveFoldersToMirror({
      drive_folders: [
        { folder_id: 'drv-1', folder_name: 'A' },
        { folder_id: 'drv-1', folder_name: 'A-again' },
        { folder_id: '' },
        { not_a_folder: true },
        null,
      ],
    });
    expect(result).toEqual([{ folderId: 'drv-1', folderName: 'A' }]);
  });
});

describe('shouldMirrorDriveFoldersForRule', () => {
  it('is true only for WORKSPACE_FILE_MODIFIED + a connector-google_drive tagged action_config', () => {
    expect(shouldMirrorDriveFoldersForRule('WORKSPACE_FILE_MODIFIED', { tag: 'connector-google_drive' })).toBe(true);
  });
  it('is false for an untagged WORKSPACE_FILE_MODIFIED rule (a hand-built RulesPage rule, not the Connectors page)', () => {
    expect(shouldMirrorDriveFoldersForRule('WORKSPACE_FILE_MODIFIED', { tag: 'ds' })).toBe(false);
    expect(shouldMirrorDriveFoldersForRule('WORKSPACE_FILE_MODIFIED', {})).toBe(false);
  });
  it('is false for a non-Drive trigger_type even if tagged connector-google_drive', () => {
    expect(shouldMirrorDriveFoldersForRule('ESIGN_COMPLETED', { tag: 'connector-google_drive' })).toBe(false);
  });
  it('is false for a different connector (docusign) tag', () => {
    expect(shouldMirrorDriveFoldersForRule('WORKSPACE_FILE_MODIFIED', { tag: 'connector-docusign' })).toBe(false);
  });
});

describe('mirrorConnectedDriveFolders', () => {
  it('creates exactly one Arkova folder for a newly connected Drive folder', async () => {
    const { db, folders } = makeFakeDb({
      integrations: [{ id: 'conn-1', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' }],
    });

    const results = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] },
    );

    expect(results).toEqual([{ folderId: expect.any(String), driveFolderId: 'drive-folder-1', outcome: 'created' }]);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      owner_scope: 'ORG',
      org_id: ORG_A,
      connector_provider: 'google_drive',
      connector_source_id: 'drive-folder-1',
      connector_connection_id: 'conn-1',
      is_system_managed: true,
      created_by: USER_ID,
    });
    expect(folders[0].name).toContain('Invoices');
  });

  it('reconnecting / re-saving the SAME Drive folder does not create a second folder — idempotent', async () => {
    const { db, folders } = makeFakeDb({
      integrations: [{ id: 'conn-1', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' }],
    });
    const input = { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] };

    const first = await mirrorConnectedDriveFolders({ db, logger }, input);
    const second = await mirrorConnectedDriveFolders({ db, logger }, input);

    expect(first[0]!.outcome).toBe('created');
    expect(second[0]!.outcome).toBe('existing');
    expect(second[0]!.folderId).toBe(first[0]!.folderId);
    expect(folders).toHaveLength(1);
  });

  it('reports a transient stale-connection refresh failure truthfully, then an automatic reconciliation retry repairs it idempotently', async () => {
    const existing: FolderRow = {
      id: 'folder-existing',
      owner_scope: 'ORG',
      org_id: ORG_A,
      connector_provider: 'google_drive',
      connector_source_id: 'drive-folder-1',
      connector_connection_id: 'conn-old',
      name: 'Invoices · ABCDEF01',
      created_by: USER_ID,
      is_system_managed: true,
    };
    const { db, folders } = makeFakeDb({
      folders: [existing],
      integrations: [{ id: 'conn-new', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-02T00:00:00Z' }],
      foldersUpdateErrorOnce: { message: 'connection reset by peer' },
    });
    const input = { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] };

    const failedAttempt = await mirrorConnectedDriveFolders({ db, logger }, input);

    expect(failedAttempt).toEqual([{
      folderId: 'folder-existing',
      driveFolderId: 'drive-folder-1',
      outcome: 'error',
      error: expect.stringContaining('connection reset by peer'),
    }]);
    expect(folders[0]!.connector_connection_id).toBe('conn-old');

    // This second call models the hourly source-of-truth reconciliation pass
    // retrying the persisted selection. It is deliberately not another save.
    const retry = await mirrorConnectedDriveFolders({ db, logger }, input);
    expect(retry).toEqual([{ folderId: 'folder-existing', driveFolderId: 'drive-folder-1', outcome: 'existing' }]);
    expect(folders).toHaveLength(1);
    expect(folders[0]!.connector_connection_id).toBe('conn-new');
  });

  it('does not report existing when a concurrent disappearance makes the refresh affect zero rows', async () => {
    const { db } = makeFakeDb({
      folders: [{
        id: 'folder-gone', owner_scope: 'ORG', org_id: ORG_A, connector_provider: 'google_drive',
        connector_source_id: 'drive-folder-1', connector_connection_id: 'conn-old', name: 'Evidence',
        created_by: USER_ID, is_system_managed: true,
      }],
      integrations: [{ id: 'conn-new', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-02T00:00:00Z' }],
      foldersUpdateZeroRowsOnce: true,
    });
    const result = await mirrorConnectedDriveFolders({ db, logger }, {
      orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Evidence' }],
    });
    expect(result).toEqual([expect.objectContaining({ folderId: 'folder-gone', outcome: 'error' })]);
  });

  it('recovers from a concurrent-insert race (two simultaneous saves) without creating a duplicate', async () => {
    const winner: FolderRow = {
      id: 'folder-winner',
      owner_scope: 'ORG',
      org_id: ORG_A,
      connector_provider: 'google_drive',
      connector_source_id: 'drive-folder-1',
      connector_connection_id: 'conn-1',
      name: 'Invoices · ABCDEF01',
      created_by: USER_ID,
      is_system_managed: true,
    };
    const { db, folders } = makeFakeDb({
      integrations: [{ id: 'conn-1', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' }],
      forceInsertConflictOnce: winner,
    });

    const result = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] },
    );

    expect(result[0]!.outcome).toBe('existing');
    expect(result[0]!.folderId).toBe('folder-winner');
    // The loser's own row never landed — exactly the winner's single row exists.
    expect(folders).toHaveLength(1);
  });

  it('refreshes a concurrent-insert winner that belongs to the previous Drive connection', async () => {
    const winner: FolderRow = {
      id: 'folder-winner-old', owner_scope: 'ORG', org_id: ORG_A, connector_provider: 'google_drive',
      connector_source_id: 'drive-folder-1', connector_connection_id: 'conn-old', name: 'Evidence',
      created_by: USER_ID, is_system_managed: true,
    };
    const { db, folders } = makeFakeDb({
      integrations: [{ id: 'conn-new', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-02T00:00:00Z' }],
      forceInsertConflictOnce: winner,
    });
    const result = await mirrorConnectedDriveFolders({ db, logger }, {
      orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Evidence' }],
    });
    expect(result).toEqual([{ folderId: 'folder-winner-old', driveFolderId: 'drive-folder-1', outcome: 'existing' }]);
    expect(folders[0]?.connector_connection_id).toBe('conn-new');
  });

  it('a genuine exception on one folder does not suppress mirroring of later folders in the same rule save', async () => {
    // Regression for the review finding: `upsertOne` converts DB-layer
    // `{data,error}` failures into a returned `outcome: 'error'`, but a real
    // JS exception (network blip, dropped connection — not a Supabase error
    // return) is a different failure mode entirely. Without a per-iteration
    // try/catch around the loop in `mirrorConnectedDriveFolders`, that throw
    // unwinds the whole `for` loop and the function itself rejects, so EVERY
    // folder after the throwing one is silently never attempted — the
    // opposite of "one bad folder shouldn't cost the others."
    const { db, folders } = makeFakeDb({
      integrations: [{ id: 'conn-1', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' }],
      throwOnSelectSourceId: 'drive-folder-throws',
    });

    const results = await mirrorConnectedDriveFolders(
      { db, logger },
      {
        orgId: ORG_A,
        actorUserId: USER_ID,
        folders: [
          { folderId: 'drive-folder-throws', folderName: 'Broken' },
          { folderId: 'drive-folder-2', folderName: 'Invoices' },
        ],
      },
    );

    // Both folders get a result entry — the throw on folder 1 must not
    // suppress folder 2.
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ driveFolderId: 'drive-folder-throws', outcome: 'error' });
    expect(results[1]).toMatchObject({ driveFolderId: 'drive-folder-2', outcome: 'created' });
    // Folder 2 actually got mirrored despite folder 1's exception.
    expect(folders).toHaveLength(1);
    expect(folders[0]!.connector_source_id).toBe('drive-folder-2');
  });

  it('an unconnected/unmirrored call — no folders passed — touches neither table and mirrors nothing', async () => {
    const { db, calls } = makeFakeDb({});
    const results = await mirrorConnectedDriveFolders({ db, logger }, { orgId: ORG_A, actorUserId: USER_ID, folders: [] });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('skips (does not throw) when the org has no active Drive connection', async () => {
    const { db, folders } = makeFakeDb({ integrations: [] });
    const results = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] },
    );
    expect(results).toEqual([{ folderId: '', driveFolderId: 'drive-folder-1', outcome: 'skipped_no_connection' }]);
    expect(folders).toHaveLength(0);
  });

  it('review P2 (feat/mirror-connected-drive-folders): a DB error loading the active connection is retryable ("error"), NOT the same as no connection ("skipped_no_connection")', async () => {
    const { db, folders } = makeFakeDb({ orgIntegrationsSelectError: { message: 'connection reset by peer' } });
    const results = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-folder-1', folderName: 'Invoices' }] },
    );
    expect(results).toEqual([
      { folderId: '', driveFolderId: 'drive-folder-1', outcome: 'error', error: expect.any(String) },
    ]);
    // A legitimate "org never connected Drive" state must never be conflated
    // with a transient DB failure — retrying a skip is pointless, retrying an
    // error is exactly what should happen on the next save.
    expect(results[0]!.outcome).not.toBe('skipped_no_connection');
    expect(folders).toHaveLength(0);
  });

  it('tenant isolation fails closed: two orgs picking a Drive folder with the SAME display name never share or collide on a mirror folder', async () => {
    const { db, folders, calls } = makeFakeDb({
      integrations: [
        { id: 'conn-a', org_id: ORG_A, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' },
        { id: 'conn-b', org_id: ORG_B, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' },
      ],
    });

    const resA = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_A, actorUserId: USER_ID, folders: [{ folderId: 'drive-A-1', folderName: 'Invoices' }] },
    );
    const resB = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_B, actorUserId: USER_ID, folders: [{ folderId: 'drive-B-1', folderName: 'Invoices' }] },
    );

    expect(resA[0]!.outcome).toBe('created');
    expect(resB[0]!.outcome).toBe('created');
    expect(resA[0]!.folderId).not.toBe(resB[0]!.folderId);
    expect(folders).toHaveLength(2);
    expect(folders.find((f) => f.id === resA[0]!.folderId)!.org_id).toBe(ORG_A);
    expect(folders.find((f) => f.id === resB[0]!.folderId)!.org_id).toBe(ORG_B);
    // Every `folders` lookup this module issued was explicitly org-scoped —
    // proves isolation is enforced in the query, not an accident of the fixture.
    const folderSelects = calls.filter((c) => c.table === 'folders' && c.op === 'select');
    expect(folderSelects.length).toBeGreaterThan(0);
    for (const call of folderSelects) {
      expect(call.filters).toHaveProperty('org_id');
    }
  });

  it('tenant isolation fails closed even under an adversarial same connector_source_id across two orgs', async () => {
    // Hypothetical: some other bug or a Drive id collision hands two DIFFERENT
    // orgs the identical connector_source_id string. Org B's lookup MUST NOT
    // return org A's pre-existing row — it must create its OWN, org-scoped row.
    const existingForOrgA: FolderRow = {
      id: 'folder-org-a',
      owner_scope: 'ORG',
      org_id: ORG_A,
      connector_provider: 'google_drive',
      connector_source_id: 'shared-id',
      connector_connection_id: 'conn-a',
      name: 'Invoices · SHARED01',
      created_by: USER_ID,
      is_system_managed: true,
    };
    const { db, folders } = makeFakeDb({
      folders: [existingForOrgA],
      integrations: [{ id: 'conn-b', org_id: ORG_B, provider: 'google_drive', revoked_at: null, connected_at: '2026-09-01T00:00:00Z' }],
    });

    const resB = await mirrorConnectedDriveFolders(
      { db, logger },
      { orgId: ORG_B, actorUserId: USER_ID, folders: [{ folderId: 'shared-id', folderName: 'Invoices' }] },
    );

    expect(resB[0]!.outcome).toBe('created');
    expect(resB[0]!.folderId).not.toBe('folder-org-a');
    expect(folders).toHaveLength(2);
  });
});
