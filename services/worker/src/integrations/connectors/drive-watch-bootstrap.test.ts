/**
 * DRIVE-02 (SCRUM-2367) — folder-watch bootstrap tests.
 *
 * Bootstrapping stores: initial page token, watched folder id, channel id +
 * expiry, owner scope (my_drive vs shared_drive), and lifecycle status. Folder
 * permission failures land as status='permission_denied' (no throw-with-bytes).
 * folder_path + owner_email are sensitive → never passed to a logger.
 *
 * Pure/injectable: no real Drive, no real Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../oauth/drive.js', () => ({
  DriveApiError: class DriveApiError extends Error {
    status: number;
    detail?: string;
    constructor(msg: string, status: number, detail?: string) {
      super(msg);
      this.name = 'DriveApiError';
      this.status = status;
      if (detail !== undefined) this.detail = detail;
    }
  },
  getFileMetadata: vi.fn(),
  createChangesWatch: vi.fn(),
}));

import { getFileMetadata, createChangesWatch, DriveApiError } from '../oauth/drive.js';
import { bootstrapDriveWatch, type DriveBootstrapDb } from './drive-watch-bootstrap.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMeta = getFileMetadata as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWatch = createChangesWatch as any;

beforeEach(() => {
  vi.clearAllMocks();
});

const ORG = 'org-1';
const INTEGRATION = 'int-1';
const USER = 'user-1';
const FOLDER = 'folder-abc';

function makeDb(overrides: Partial<Record<keyof DriveBootstrapDb, unknown>> = {}): {
  db: DriveBootstrapDb;
  upsertCalls: unknown[];
} {
  const upsertCalls: unknown[] = [];
  const db: DriveBootstrapDb = {
    upsertWatchState: vi.fn(async (row) => {
      upsertCalls.push(row);
      return { id: 'watch-1', error: false };
    }),
    ...(overrides as Partial<DriveBootstrapDb>),
  };
  return { db, upsertCalls };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('bootstrapDriveWatch — happy path (My Drive)', () => {
  it('stores page token, watched folder, channel id + expiry, owner scope=my_drive, status=active', async () => {
    mockMeta.mockResolvedValue({ id: FOLDER, name: 'Contracts', parents: ['root'] });
    mockWatch.mockResolvedValue({
      resourceId: 'res-1',
      expiration: '2026-07-08T00:00:00.000Z',
      startPageToken: 'ptok-1',
    });
    const { db, upsertCalls } = makeDb();

    const result = await bootstrapDriveWatch({
      orgId: ORG,
      integrationId: INTEGRATION,
      userId: USER,
      userEmail: 'owner@example.com',
      folderId: FOLDER,
      accessToken: 'at',
      webhookAddress: 'https://w/api/v1/webhooks/google_drive',
      channelToken: ORG,
      db,
    });

    expect(result.status).toBe('active');
    expect(result.watchStateId).toBe('watch-1');
    const row = upsertCalls[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      p_org_id: ORG,
      p_integration_id: INTEGRATION,
      p_watched_folder_id: FOLDER,
      p_initial_page_token: 'ptok-1',
      p_owner_scope: 'my_drive',
      p_drive_id: null,
      p_status: 'active',
      p_owner_user_id: USER,
      p_owner_email: 'owner@example.com',
      p_created_by: USER,
    });
    expect(typeof (row as { p_channel_id: string }).p_channel_id).toBe('string');
    expect((row as { p_channel_expires_at: string }).p_channel_expires_at).toBe('2026-07-08T00:00:00.000Z');
    // A successful (re-)bootstrap forwards p_last_renewal_error=null so the RPC's
    // `last_renewal_error = EXCLUDED.last_renewal_error` UPDATE clears any stale
    // error left by a prior degraded renewal (P2: re-bootstrap must not keep a
    // dangling reason).
    expect('p_last_renewal_error' in row).toBe(true);
    expect((row as { p_last_renewal_error: string | null }).p_last_renewal_error).toBeNull();
  });
});

describe('bootstrapDriveWatch — shared drive', () => {
  it('records owner_scope=shared_drive and the drive_id when the folder lives on a shared drive', async () => {
    mockMeta.mockResolvedValue({ id: FOLDER, name: 'Team', parents: ['shared-root'], driveId: 'sd-9' });
    mockWatch.mockResolvedValue({ resourceId: 'res', expiration: '2026-07-08T00:00:00.000Z', startPageToken: 'p' });
    const { db, upsertCalls } = makeDb();

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db,
    });

    expect(result.status).toBe('active');
    const row = upsertCalls[0] as Record<string, unknown>;
    expect(row).toMatchObject({ p_owner_scope: 'shared_drive', p_drive_id: 'sd-9' });
  });
});

describe('bootstrapDriveWatch — folder permission failure', () => {
  it('records status=permission_denied WITHOUT registering a watch, and never throws', async () => {
    mockMeta.mockRejectedValue(new DriveApiError('Drive files.get failed', 403, 'insufficientFilePermissions'));
    const { db, upsertCalls } = makeDb();
    const logger = makeLogger();

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db, logger,
    });

    expect(result.status).toBe('permission_denied');
    expect(mockWatch).not.toHaveBeenCalled();
    const row = upsertCalls[0] as Record<string, unknown>;
    expect(row).toMatchObject({ p_status: 'permission_denied' });
  });

  it('never passes the sensitive folder path or owner email into any logger call', async () => {
    mockMeta.mockRejectedValue(new DriveApiError('Drive files.get failed', 403));
    const { db } = makeDb();
    const logger = makeLogger();

    await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER,
      userEmail: 'secret-owner@example.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db, logger,
    });

    const allLogArgs = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(allLogArgs).not.toContain('secret-owner@example.com');
    expect(allLogArgs).not.toContain('Contracts'); // no folder name/path
  });
});

describe('bootstrapDriveWatch — expired / failed watch registration', () => {
  it('surfaces status=failed with a bounded error and does NOT throw when changes.watch fails', async () => {
    mockMeta.mockResolvedValue({ id: FOLDER, name: 'F', parents: ['root'] });
    mockWatch.mockRejectedValue(new DriveApiError('Drive changes.watch failed', 401, 'invalid token'));
    const { db, upsertCalls } = makeDb();

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db,
    });

    expect(result.status).toBe('failed');
    const row = upsertCalls[0] as Record<string, unknown>;
    expect(row).toMatchObject({ p_status: 'failed' });
    // last_renewal_error is bounded + scrubbed, never raw bytes.
    expect((row as { p_last_renewal_error?: string }).p_last_renewal_error).toBeTruthy();
  });

  it('§1.6A byte-safety: a multi-MB binary-looking metadata error is redacted+bounded, never leaked into the persisted row', async () => {
    // Simulate a non-DriveApiError failure whose message carries ~4 MB of raw
    // bytes (invalid-UTF-8 replacement chars + a long low-entropy fill) — the
    // exact shape §1.6A forbids reaching a sink. The failed path builds the
    // persisted reason via boundedErrorDetail, which must collapse it.
    const megaBytes = '�'.repeat(4 * 1024 * 1024) + 'A'.repeat(1024);
    mockMeta.mockRejectedValue(new Error(megaBytes));
    const { db, upsertCalls } = makeDb();
    const logger = makeLogger();

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db, logger,
    });

    expect(result.status).toBe('failed');
    const row = upsertCalls[0] as Record<string, unknown>;
    const persisted = (row as { p_last_renewal_error?: string }).p_last_renewal_error ?? '';
    // Bounded (never the 4 MB blob) and byte-redacted (no raw replacement-char run).
    expect(persisted.length).toBeLessThanOrEqual(500);
    expect(persisted).not.toContain('�'.repeat(8));
    // Nothing byte-like reached the logger either.
    const allLogArgs = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(allLogArgs).not.toContain('�'.repeat(8));
  });
});

describe('bootstrapDriveWatch — scope mismatch guard', () => {
  it('rejects a folder that does not belong to the requesting org context (folder id mismatch)', async () => {
    // Drive returns a DIFFERENT id than the folder we asked to watch — a
    // proxy/spoofed metadata response. We must not bootstrap a watch on it.
    mockMeta.mockResolvedValue({ id: 'other-folder', name: 'X', parents: ['root'] });
    const { db, upsertCalls } = makeDb();

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db,
    });

    expect(result.status).toBe('failed');
    expect(mockWatch).not.toHaveBeenCalled();
    const row = upsertCalls[0] as Record<string, unknown>;
    expect(row).toMatchObject({ p_status: 'failed' });
  });

  it('propagates an upsert DB error as ok=false without throwing', async () => {
    mockMeta.mockResolvedValue({ id: FOLDER, name: 'F', parents: ['root'] });
    mockWatch.mockResolvedValue({ resourceId: 'r', expiration: '2026-07-08T00:00:00.000Z', startPageToken: 'p' });
    const db: DriveBootstrapDb = {
      upsertWatchState: vi.fn(async () => ({ id: null, error: true })),
    };

    const result = await bootstrapDriveWatch({
      orgId: ORG, integrationId: INTEGRATION, userId: USER, userEmail: 'o@e.com',
      folderId: FOLDER, accessToken: 'at', webhookAddress: 'https://w/x', channelToken: ORG, db,
    });

    expect(result.ok).toBe(false);
    expect(result.watchStateId).toBeNull();
  });
});
