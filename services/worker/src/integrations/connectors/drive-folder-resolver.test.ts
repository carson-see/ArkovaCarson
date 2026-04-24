/**
 * drive-folder-resolver tests (SCRUM-1169)
 *
 * Mocks the Drive client's `getFileMetadata` / `getSharedDriveName` so tests
 * don't touch the real API. Covers cache hit, cache miss → walk, shared
 * drive, permission-denial, deleted parent, and MAX_DEPTH truncation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../oauth/drive.js', () => ({
  DriveApiError: class DriveApiError extends Error {
    status: number;
    body: unknown;
    constructor(msg: string, status: number, body: unknown) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  },
  getFileMetadata: vi.fn(),
  getSharedDriveName: vi.fn(),
}));

import { getFileMetadata, getSharedDriveName, DriveApiError } from '../oauth/drive.js';
import { resolveDriveFolderPath } from './drive-folder-resolver.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGet = getFileMetadata as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDriveName = getSharedDriveName as any;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCache(initial: Record<string, { folder_path: string | null; cached_at: string }> = {}) {
  const store = { ...initial };
  const get = vi.fn(async ({ orgId, fileId }: { orgId: string; fileId: string }) => {
    return store[`${orgId}:${fileId}`] ?? null;
  });
  const put = vi.fn(
    async ({ orgId, fileId, folderPath }: { orgId: string; fileId: string; folderPath: string | null }) => {
      store[`${orgId}:${fileId}`] = { folder_path: folderPath, cached_at: new Date().toISOString() };
    },
  );
  return { store, get, put };
}

const ORG = '00000000-0000-0000-0000-000000000001';

describe('resolveDriveFolderPath', () => {
  it('returns cached value on warm cache', async () => {
    const cache = makeCache({
      [`${ORG}:file-1`]: { folder_path: '/HR/file.pdf', cached_at: new Date().toISOString() },
    });
    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'file-1',
      accessToken: 'at',
      cache,
    });
    expect(path).toBe('/HR/file.pdf');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('walks the parent chain on cache miss', async () => {
    mockGet
      .mockResolvedValueOnce({ id: 'file-1', name: 'candidate-notes.pdf', parents: ['folder-hr-q2'] })
      .mockResolvedValueOnce({ id: 'folder-hr-q2', name: '2026-Q2', parents: ['folder-hr'] })
      .mockResolvedValueOnce({ id: 'folder-hr', name: 'HR', parents: [] });

    const cache = makeCache();
    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'file-1',
      accessToken: 'at',
      cache,
    });
    expect(path).toBe('/HR/2026-Q2/candidate-notes.pdf');
    expect(cache.put).toHaveBeenCalled();
  });

  it('resolves shared-drive root by name', async () => {
    mockGet
      .mockResolvedValueOnce({
        id: 'file-1',
        name: 'doc.pdf',
        parents: ['shared-folder'],
        driveId: 'shared-drive-123',
      })
      .mockResolvedValueOnce({
        id: 'shared-folder',
        name: 'HR',
        parents: [],
        driveId: 'shared-drive-123',
      });
    mockDriveName.mockResolvedValueOnce('Acme Team Drive');

    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'file-1',
      accessToken: 'at',
      cache: makeCache(),
    });
    expect(path).toBe('/Acme Team Drive/HR/doc.pdf');
  });

  it('returns null on DriveApiError (permission / deleted)', async () => {
    mockGet.mockRejectedValueOnce(new DriveApiError('forbidden', 403, null));
    const cache = makeCache();
    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'file-x',
      accessToken: 'at',
      cache,
    });
    expect(path).toBeNull();
    // Cache the null briefly.
    expect(cache.put).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, fileId: 'file-x', folderPath: null }),
    );
  });

  it('refreshes on stale cache', async () => {
    const oldDate = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m old → stale
    const cache = makeCache({
      [`${ORG}:file-1`]: { folder_path: '/old.pdf', cached_at: oldDate },
    });
    mockGet.mockResolvedValueOnce({ id: 'file-1', name: 'fresh.pdf', parents: [] });

    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'file-1',
      accessToken: 'at',
      cache,
    });
    expect(path).toBe('/fresh.pdf');
  });

  it('caps at MAX_DEPTH without throwing', async () => {
    // 25 levels > MAX_DEPTH (20). Resolver should stop at 20.
    for (let i = 0; i < 25; i++) {
      mockGet.mockResolvedValueOnce({
        id: `f-${i}`,
        name: `L${i}`,
        parents: i < 24 ? [`f-${i + 1}`] : [],
      });
    }
    const path = await resolveDriveFolderPath({
      orgId: ORG,
      fileId: 'f-0',
      accessToken: 'at',
      cache: makeCache(),
    });
    expect(path).toBeTruthy();
    expect(mockGet).toHaveBeenCalledTimes(20);
  });
});
