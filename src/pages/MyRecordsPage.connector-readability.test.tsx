/**
 * MyRecordsPage.connector-readability.test.tsx
 *
 * TDD red-first (coordinator scope addition, 2026-09-29): the /records table
 * row titled itself with the raw connector-internal filename and gave no
 * version indication.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Record } from '@/components/records';

const mockUseAnchors = vi.hoisted(() => vi.fn());
const mockUsePrivateAnchorList = vi.hoisted(() => vi.fn());
const mockUseFolders = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@test.com' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useActiveOrg', () => ({ useActiveOrg: () => ({ orgId: null, loading: false }) }));
vi.mock('@/hooks/useUserOrgs', () => ({ useUserOrgs: () => ({ orgs: [], loading: false }) }));
vi.mock('@/hooks/useAnchors', () => ({ useAnchors: mockUseAnchors }));
vi.mock('@/hooks/usePrivateAnchorList', () => ({ usePrivateAnchorList: mockUsePrivateAnchorList }));
vi.mock('@/hooks/useFolders', () => ({ useFolders: mockUseFolders }));
vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({ revokeAnchor: vi.fn(), error: null, clearError: vi.fn() }),
}));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/anchor', () => ({ SecureDocumentDialog: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

const DRIVE_INTERNAL_FILENAME = 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8';

const records: Record[] = [
  {
    id: 'anchor-1',
    filename: DRIVE_INTERNAL_FILENAME,
    fingerprint: 'a'.repeat(64),
    status: 'SUPERSEDED',
    createdAt: '2026-09-01T00:00:00Z',
    fileSize: 0,
    versionNumber: 1,
    metadata: { connector_source: 'google_drive', _drive_folder_path: '/Legal/Q3 Vendor Agreement.gsheet' },
  },
];

async function renderPage() {
  const { MyRecordsPage } = await import('./MyRecordsPage');
  return render(<MyRecordsPage />);
}

describe('MyRecordsPage — connector record readability (2026-09-29)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePrivateAnchorList.mockReturnValue({ data: undefined, isLoading: false, error: null, refetch: vi.fn() });
    mockUseAnchors.mockReturnValue({ records, loading: false, refreshAnchors: vi.fn() });
    mockUseFolders.mockReturnValue({
      folders: [],
      loading: false,
      error: null,
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      deleteFolder: vi.fn(),
      assignRecord: vi.fn(),
      assignRecords: vi.fn(),
    });
  });

  it('derives the row title from the Drive folder path instead of the raw internal id', async () => {
    await renderPage();
    expect(await screen.findByText('Q3 Vendor Agreement.gsheet')).toBeInTheDocument();
    expect(screen.queryByText(DRIVE_INTERNAL_FILENAME)).not.toBeInTheDocument();
  });

  it('shows a "replaced by newer version" chip for a superseded record without hiding the row', async () => {
    await renderPage();
    expect(await screen.findByTestId('record-superseded-chip')).toBeInTheDocument();
    // Still visible — superseded records remain valid evidence.
    expect(screen.getByText('Q3 Vendor Agreement.gsheet')).toBeInTheDocument();
  });
});
