/**
 * SCRUM-1970 — Version Conflict Detection Tests
 *
 * Verifies three paths:
 * 1. First-time document → pass through (no conflict)
 * 2. Same fingerprint re-event → skip (idempotent)
 * 3. Different fingerprint → create version record + notify
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbFrom, mockDbRpc } = vi.hoisted(() => {
  const mockDbFrom = vi.fn();
  const mockDbRpc = vi.fn();
  return { mockDbFrom, mockDbRpc };
});

const mockEmitNotifications = vi.hoisted(() => vi.fn());

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom, rpc: mockDbRpc },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: mockEmitNotifications,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeChainable(result: { data?: unknown; error?: unknown; count?: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return vi.fn(() => proxy);
    },
  });
  return proxy;
}

import { checkVersionConflict } from './version-conflict-detector.js';

describe('SCRUM-1970: checkVersionConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "no_conflict" for events without external_file_id', async () => {
    const result = await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: undefined,
      fingerprint: 'a'.repeat(64),
      filename: 'test.pdf',
      source: 'google_drive',
    });

    expect(result.outcome).toBe('no_conflict');
    expect(mockDbFrom).not.toHaveBeenCalled();
  });

  it('returns "no_conflict" for first-time documents (no existing anchor)', async () => {
    const selectChain = makeChainable({ data: [], error: null });
    mockDbFrom.mockReturnValue(selectChain);

    const result = await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: 'gdrive:file123',
      fingerprint: 'a'.repeat(64),
      filename: 'contract.pdf',
      source: 'google_drive',
    });

    expect(result.outcome).toBe('no_conflict');
    expect(mockDbFrom).toHaveBeenCalledWith('anchors');
  });

  it('returns "same_fingerprint" when existing anchor has same fingerprint (idempotent skip)', async () => {
    const fingerprint = 'b'.repeat(64);
    const selectChain = makeChainable({
      data: [{ id: 'anchor-1', fingerprint, status: 'SECURED' }],
      error: null,
    });
    mockDbFrom.mockReturnValue(selectChain);

    const result = await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: 'gdrive:file123',
      fingerprint,
      filename: 'contract.pdf',
      source: 'google_drive',
    });

    expect(result.outcome).toBe('same_fingerprint');
  });

  it('returns "version_conflict" and creates version record when fingerprint differs', async () => {
    const existingFingerprint = 'c'.repeat(64);
    const newFingerprint = 'd'.repeat(64);

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return makeChainable({
          data: [{ id: 'anchor-1', fingerprint: existingFingerprint, status: 'SECURED' }],
          error: null,
        });
      }
      if (table === 'external_document_versions') {
        return makeChainable({ data: { id: 'version-1' }, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const result = await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: 'gdrive:file123',
      fingerprint: newFingerprint,
      filename: 'contract-v2.pdf',
      source: 'google_drive',
    });

    expect(result.outcome).toBe('version_conflict');
    expect(result.version_id).toBe('version-1');
    expect(mockDbFrom).toHaveBeenCalledWith('external_document_versions');
  });

  it('emits document.version_conflict notification on conflict', async () => {
    const existingFingerprint = 'e'.repeat(64);
    const newFingerprint = 'f'.repeat(64);

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return makeChainable({
          data: [{ id: 'anchor-1', fingerprint: existingFingerprint, status: 'SECURED' }],
          error: null,
        });
      }
      if (table === 'external_document_versions') {
        return makeChainable({ data: { id: 'version-new' }, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: 'gdrive:file123',
      fingerprint: newFingerprint,
      filename: 'contract-v2.pdf',
      source: 'google_drive',
    });

    expect(mockEmitNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.version_conflict',
        organizationId: 'org-1',
      }),
    );
  });

  it('still returns "no_conflict" if anchor query fails (fail-open for first-time docs)', async () => {
    mockDbFrom.mockReturnValue(makeChainable({ data: null, error: { message: 'db error' } }));

    const result = await checkVersionConflict({
      org_id: 'org-1',
      external_file_id: 'gdrive:file123',
      fingerprint: 'a'.repeat(64),
      filename: 'test.pdf',
      source: 'google_drive',
    });

    expect(result.outcome).toBe('no_conflict');
  });
});
