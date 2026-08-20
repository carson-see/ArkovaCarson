/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT; these tests exist precisely to pin how the UI reacts to RLS outcomes (zero-row denial, 42501) */
/**
 * RecordDetailPage — honest rename tests (founder-reported)
 *
 * `handleRenameFile` previously checked only `updateError`. PostgREST returns
 * HTTP 204 with `error: null` for an UPDATE whose RLS USING clause matches
 * zero rows, so a non-owner rename fired toast.success('Document renamed')
 * while the row was unchanged — a silent false success. RLS reality:
 * `anchors_update_own` (user_id = auth.uid()) plus `anchors_update_org_admin`
 * (0393), which trigger `restrict_org_admin_folder_update` narrows to
 * folder_id-only — so an ORG_ADMIN rename of a teammate's record raises 42501
 * and any other non-owner rename is a zero-row no-op.
 *
 * The fix mirrors useFolders.assignRecord (`.select('id')` + row-count check)
 * and routes all toast copy through RECORD_DETAIL_LABELS (§1.3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { toast } from 'sonner';
import { RECORD_DETAIL_LABELS } from '@/lib/copy';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseAnchor = vi.hoisted(() => vi.fn());
const capturedProps = vi.hoisted(
  () => ({ current: null as Record<string, unknown> | null }),
);
/**
 * Response the mocked `.update().eq().select()` chain resolves with. The bare
 * `.update().eq()` await (the pre-fix shape) resolves with PostgREST's
 * update-without-select shape: `{ data: null, error }` — never row data.
 */
const mockUpdateResponse = vi.hoisted(() => ({
  current: { data: null as { id: string }[] | null, error: null as { code?: string; message?: string } | null },
}));
const mockFrom = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockEq = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', email: 'owner@test.dev' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({
  useHasCredentialImportEntitlement: () => false,
}));
vi.mock('@/hooks/useAnchor', () => ({ useAnchor: mockUseAnchor }));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/anchor', () => ({
  // Capture the props RecordDetailPage passes so tests can drive
  // onRenameFile directly and assert the canRename ownership gate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AssetDetailView: (props: any) => {
    capturedProps.current = props;
    return null;
  },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'anchor-1' }),
  useNavigate: () => mockNavigate,
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom } }));

const baseAnchor = {
  id: 'anchor-1',
  user_id: 'owner-1',
  org_id: null,
  public_id: 'ARK-2026-00001',
  filename: 'doc.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED',
  created_at: '2026-01-01T00:00:00Z',
  chain_timestamp: null,
  issued_at: null,
  revoked_at: null,
  revocation_reason: null,
  expires_at: null,
  file_size: 1024,
  file_mime: 'application/pdf',
  credential_type: null,
  chain_tx_id: null,
  chain_block_height: null,
  metadata: null,
  cpe_metadata: null,
  description: null,
  version_number: 1,
  parent_anchor_id: null,
  deleted_at: null,
};

let refreshAnchor: ReturnType<typeof vi.fn>;

function mockAnchorReturn(anchor: typeof baseAnchor) {
  refreshAnchor = vi.fn().mockResolvedValue(undefined);
  mockUseAnchor.mockReturnValue({ anchor, loading: false, error: null, refreshAnchor });
}

async function renderPage() {
  const { RecordDetailPage } = await import('./RecordDetailPage');
  return render(<RecordDetailPage />);
}

/** Drives the captured onRenameFile, swallowing an (expected) rejection. */
async function invokeRename(newName: string): Promise<unknown> {
  const onRenameFile = capturedProps.current?.onRenameFile as
    | ((name: string) => Promise<void>)
    | undefined;
  expect(onRenameFile).toBeTypeOf('function');
  try {
    await onRenameFile!(newName);
    return null;
  } catch (err) {
    return err;
  }
}

describe('RecordDetailPage — handleRenameFile honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProps.current = null;
    mockUpdateResponse.current = { data: null, error: null };
    mockAnchorReturn(baseAnchor);

    // supabase.from('anchors').update({...}).eq('id', ...) resolves like a
    // select-less PostgREST update ({ data: null }); chaining .select('id')
    // resolves with mockUpdateResponse.current (row data or error).
    mockFrom.mockImplementation(() => ({ update: mockUpdate }));
    mockUpdate.mockImplementation(() => ({ eq: mockEq }));
    mockEq.mockImplementation(() => {
      const legacy = { data: null, error: mockUpdateResponse.current.error };
      return {
        select: vi.fn(() => Promise.resolve(mockUpdateResponse.current)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (res: any, rej: any) => Promise.resolve(legacy).then(res, rej),
      };
    });
  });

  it('zero-row RLS-denied update shows the permission error toast and NO success toast', async () => {
    // Neither RLS policy matched: PostgREST performs a zero-row UPDATE and
    // returns error: null. The old code read that as success.
    mockUpdateResponse.current = { data: [], error: null };
    await renderPage();

    const err = await invokeRename('renamed.pdf');

    // The UPDATE targets exactly this anchor row; RLS decides visibility.
    expect(mockFrom).toHaveBeenCalledWith('anchors');
    expect(mockUpdate).toHaveBeenCalledWith({ filename: 'renamed.pdf' });
    expect(mockEq).toHaveBeenCalledWith('id', 'anchor-1');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN);
  });

  it('42501 (0393 trigger: org-admin update narrowed to folder_id) shows the permission error toast', async () => {
    mockUpdateResponse.current = {
      data: null,
      error: { code: '42501', message: 'permission denied' },
    };
    await renderPage();

    const err = await invokeRename('renamed.pdf');

    expect((err as { code?: string }).code).toBe('42501');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN);
  });

  it('other update errors show the generic rename error toast', async () => {
    mockUpdateResponse.current = {
      data: null,
      error: { code: 'XX000', message: 'internal error' },
    };
    await renderPage();

    const err = await invokeRename('renamed.pdf');

    expect((err as { code?: string }).code).toBe('XX000');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(RECORD_DETAIL_LABELS.ERR_RENAME);
  });

  it('owner rename (row returned) shows the success toast and refreshes the anchor', async () => {
    mockUpdateResponse.current = { data: [{ id: 'anchor-1' }], error: null };
    await renderPage();

    const err = await invokeRename('renamed.pdf');

    expect(err).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(RECORD_DETAIL_LABELS.TOAST_RENAMED);
    expect(refreshAnchor).toHaveBeenCalled();
  });
});

describe('RecordDetailPage — canRename ownership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProps.current = null;
    mockUpdateResponse.current = { data: null, error: null };
    mockFrom.mockImplementation(() => ({ update: mockUpdate }));
    mockUpdate.mockImplementation(() => ({ eq: mockEq }));
    mockEq.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('passes canRename=true when the viewer owns the record', async () => {
    mockAnchorReturn(baseAnchor);
    await renderPage();

    expect(capturedProps.current?.canRename).toBe(true);
  });

  it('passes canRename=false when the viewer does not own the record', async () => {
    mockAnchorReturn({ ...baseAnchor, user_id: 'someone-else' });
    await renderPage();

    expect(capturedProps.current?.canRename).toBe(false);
  });
});
