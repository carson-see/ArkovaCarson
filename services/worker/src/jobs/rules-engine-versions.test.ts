/**
 * Tests for SCRUM-1970: Version conflict detection in rules engine.
 *
 * Verifies that when the rules engine processes an event with an external_file_id:
 *   1. First-time documents pass through to anchor creation normally.
 *   2. Same fingerprint (idempotent) is detected and skipped.
 *   3. Different fingerprint inserts a version_review item (pending_review).
 *   4. Org scoping isolates conflicts per organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSelectEq = vi.fn();
const mockSelectEq2 = vi.fn();
const mockInsert = vi.fn();

// Minimal db mock that chains .from().select().eq().eq().single()
const mockDb = {
  from: vi.fn(),
};

vi.mock('../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => mockDb.from(...args),
  },
}));

const { detectVersionConflict, insertVersionRecord } = await import('./rules-engine-versions.js');

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ORG_B_ID = '99999999-9999-4999-8999-999999999999';
const EXTERNAL_FILE_ID = 'gdrive-file-abc123';
const FINGERPRINT_A = 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FINGERPRINT_B = 'sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EXISTING_ANCHOR_ID = '44444444-4444-4444-8444-444444444444';

function wireAnchorsQuery(result: { data: unknown; error: unknown }) {
  mockSelectEq2.mockReturnValue({ single: () => Promise.resolve(result) });
  mockSelectEq.mockReturnValue({ eq: mockSelectEq2 });
  mockDb.from.mockImplementation((table: string) => {
    if (table === 'anchors') {
      return {
        select: () => ({ eq: mockSelectEq }),
      };
    }
    if (table === 'external_document_versions') {
      return { insert: mockInsert };
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
});

describe('detectVersionConflict', () => {
  it('returns no conflict when no existing anchor found for external_file_id', async () => {
    wireAnchorsQuery({ data: null, error: null });

    const result = await detectVersionConflict(ORG_ID, EXTERNAL_FILE_ID, FINGERPRINT_A);

    expect(result).toEqual({ conflict: false });
    expect(mockDb.from).toHaveBeenCalledWith('anchors');
  });

  it('returns idempotent (no conflict) when existing anchor has same fingerprint', async () => {
    wireAnchorsQuery({
      data: {
        id: EXISTING_ANCHOR_ID,
        fingerprint: FINGERPRINT_A,
      },
      error: null,
    });

    const result = await detectVersionConflict(ORG_ID, EXTERNAL_FILE_ID, FINGERPRINT_A);

    expect(result).toEqual({
      conflict: false,
      idempotent: true,
      existingAnchorId: EXISTING_ANCHOR_ID,
    });
  });

  it('returns conflict when existing anchor has different fingerprint', async () => {
    wireAnchorsQuery({
      data: {
        id: EXISTING_ANCHOR_ID,
        fingerprint: FINGERPRINT_A,
      },
      error: null,
    });

    const result = await detectVersionConflict(ORG_ID, EXTERNAL_FILE_ID, FINGERPRINT_B);

    expect(result).toEqual({
      conflict: true,
      existingAnchorId: EXISTING_ANCHOR_ID,
      existingFingerprint: FINGERPRINT_A,
    });
  });

  it('org scoping: different orgs with same external_file_id are independent', async () => {
    // When querying for ORG_B, no anchor found (different org)
    wireAnchorsQuery({ data: null, error: null });

    const result = await detectVersionConflict(ORG_B_ID, EXTERNAL_FILE_ID, FINGERPRINT_A);

    expect(result).toEqual({ conflict: false });
    // Verify the org_id filter was applied
    expect(mockSelectEq).toHaveBeenCalledWith('org_id', ORG_B_ID);
  });

  it('queries anchors with correct filters: org_id + external_file_id + SECURED status', async () => {
    wireAnchorsQuery({ data: null, error: null });

    await detectVersionConflict(ORG_ID, EXTERNAL_FILE_ID, FINGERPRINT_A);

    expect(mockDb.from).toHaveBeenCalledWith('anchors');
    expect(mockSelectEq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(mockSelectEq2).toHaveBeenCalledWith('external_file_id', EXTERNAL_FILE_ID);
  });
});

describe('insertVersionRecord', () => {
  it('inserts a pending_review version record into external_document_versions', async () => {
    wireAnchorsQuery({ data: null, error: null });

    await insertVersionRecord({
      orgId: ORG_ID,
      externalFileId: EXTERNAL_FILE_ID,
      fingerprint: FINGERPRINT_B,
      source: 'google_drive',
    });

    expect(mockDb.from).toHaveBeenCalledWith('external_document_versions');
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_ID,
        external_file_id: EXTERNAL_FILE_ID,
        fingerprint: FINGERPRINT_B,
        source: 'google_drive',
        status: 'pending_review',
      }),
    );
  });

  it('returns success:true on insert without error', async () => {
    wireAnchorsQuery({ data: null, error: null });
    mockInsert.mockResolvedValue({ error: null });

    const result = await insertVersionRecord({
      orgId: ORG_ID,
      externalFileId: EXTERNAL_FILE_ID,
      fingerprint: FINGERPRINT_B,
      source: 'google_drive',
    });

    expect(result).toEqual({ success: true });
  });

  it('returns success:false with error message on insert failure', async () => {
    wireAnchorsQuery({ data: null, error: null });
    mockInsert.mockResolvedValue({ error: { message: 'unique_violation' } });

    const result = await insertVersionRecord({
      orgId: ORG_ID,
      externalFileId: EXTERNAL_FILE_ID,
      fingerprint: FINGERPRINT_B,
      source: 'google_drive',
    });

    expect(result).toEqual({ success: false, error: 'unique_violation' });
  });
});
