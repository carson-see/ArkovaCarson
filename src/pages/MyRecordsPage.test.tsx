/**
 * MyRecordsPage — Folders UI Tests (SCRUM-2940)
 *
 * PR #1657 shipped the folders DATA LAYER (`useFolders`, `folders` table,
 * `anchors.folder_id`) with zero UI — `useFolders` had no importers outside
 * its own file. These tests cover the missing surface wired into
 * MyRecordsPage: the folder sidebar/filter, create/rename/delete, and
 * per-record move-to-folder / remove-from-folder actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Record } from '@/components/records';
import type { Folder } from '@/hooks/useFolders';

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
vi.mock('@/components/anchor', () => ({
  SecureDocumentDialog: () => null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

const folders: Folder[] = [
  { id: 'folder-1', name: 'Invoices', ownerScope: 'USER', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'folder-2', name: 'Certificates', ownerScope: 'USER', createdAt: '2026-01-02T00:00:00Z' },
];

const records: Record[] = [
  {
    id: 'anchor-1',
    filename: 'invoice.pdf',
    fingerprint: 'aaaa1111',
    status: 'SECURED',
    createdAt: '2026-03-01T00:00:00Z',
    fileSize: 100,
    folderId: 'folder-1',
  },
  {
    id: 'anchor-2',
    filename: 'loose-record.pdf',
    fingerprint: 'bbbb2222',
    status: 'SECURED',
    createdAt: '2026-03-02T00:00:00Z',
    fileSize: 200,
    folderId: null,
  },
];

async function renderPage() {
  const { MyRecordsPage } = await import('./MyRecordsPage');
  return render(<MyRecordsPage />);
}

describe('MyRecordsPage — Folders UI', () => {
  it('does not inherit a profile admin role into an active member organization', async () => {
    const { resolveActiveAnchorRole } = await import('./MyRecordsPage');
    expect(resolveActiveAnchorRole('org-1','member','ORG_ADMIN')).toBe('INDIVIDUAL');
    expect(resolveActiveAnchorRole('org-1','admin','INDIVIDUAL')).toBe('ORG_ADMIN');
  });
  it('exposes a generic private-tag filter and forwards the selected scope to the RLS hook', async () => {
    await renderPage();
    const initialCalls = mockUsePrivateAnchorList.mock.calls.length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Private tag' }), { target: { value: 'internal-review' } });
    expect(mockUsePrivateAnchorList.mock.calls.slice(initialCalls)).not.toEqual(
      expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ tag: 'internal-review' })])]),
    );
    await waitFor(() => expect(mockUsePrivateAnchorList).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 'internal-review', scope: 'user', page: 0 })));
    expect(screen.getByRole('combobox', { name: 'Private tag scope' })).toBeInTheDocument();
  });
  let createFolder: ReturnType<typeof vi.fn>;
  let renameFolder: ReturnType<typeof vi.fn>;
  let deleteFolder: ReturnType<typeof vi.fn>;
  let assignRecord: ReturnType<typeof vi.fn>;
  let assignRecords: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePrivateAnchorList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    createFolder = vi.fn().mockResolvedValue(undefined);
    renameFolder = vi.fn().mockResolvedValue(undefined);
    deleteFolder = vi.fn().mockResolvedValue(undefined);
    assignRecord = vi.fn().mockResolvedValue(undefined);
    assignRecords = vi.fn().mockResolvedValue({ moved: [], failed: [] });

    mockUseAnchors.mockReturnValue({
      records,
      loading: false,
      refreshAnchors: vi.fn(),
    });
    mockUseFolders.mockReturnValue({
      folders,
      loading: false,
      error: null,
      createFolder,
      renameFolder,
      deleteFolder,
      assignRecord,
      assignRecords,
    });
  });

  it('renders the folder sidebar with All Records, Unfiled, and every folder', async () => {
    await renderPage();

    expect(screen.getByRole('navigation', { name: 'Folders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Records' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unfiled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Certificates' })).toBeInTheDocument();
  });

  it('offers a working retry and identifies filters as current-page only', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    mockUsePrivateAnchorList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('unavailable'),
      refetch,
    });
    await renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: 'Private tag' }), 'internal-review');
    expect(await screen.findByText('Folder, status, and filename filters apply to the current private-tag page.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('shows all records by default', async () => {
    await renderPage();

    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('loose-record.pdf')).toBeInTheDocument();
  });

  it('filters to only the records in the selected folder', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: 'Invoices' }));

    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.queryByText('loose-record.pdf')).not.toBeInTheDocument();
  });

  it('includes records in nested descendants when a parent folder is selected', async () => {
    const user = userEvent.setup();
    mockUseFolders.mockReturnValue({
      folders: [...folders, { id: 'child', name: '2026', ownerScope: 'USER', parentFolderId: 'folder-1', createdAt: '2026-01-03T00:00:00Z' }],
      loading: false, error: null, createFolder, renameFolder, deleteFolder, assignRecord, assignRecords,
    });
    mockUseAnchors.mockReturnValue({
      records: [...records, { ...records[0], id: 'anchor-child', filename: 'nested.pdf', folderId: 'child' }],
      loading: false, refreshAnchors: vi.fn(),
    });
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Invoices' }));
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('nested.pdf')).toBeInTheDocument();
  });

  it('filters to Unfiled records', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: 'Unfiled' }));

    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('loose-record.pdf')).toBeInTheDocument();
  });

  it('creates a folder via the New Folder dialog', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: 'New Folder' }));
    expect(screen.getByText('Only you can access this global personal folder.')).toBeVisible();
    await user.type(await screen.findByLabelText('Folder name'), 'Diplomas');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createFolder).toHaveBeenCalledWith('Diplomas', {
      contextOrgId: null, ownerScope: 'USER', parentFolderId: null,
    });
  });

  it.each([
    [{ id: 'context-parent', name: 'Context', ownerScope: 'USER' as const, contextOrgId: 'org-1', createdAt: '2026-01-01' }, 'You and authorized organization or platform administrators can access this folder.'],
    [{ id: 'global-parent', name: 'Global', ownerScope: 'USER' as const, contextOrgId: null, createdAt: '2026-01-01' }, 'Only you can access this global personal folder.'],
    [{ id: 'org-parent', name: 'Organization', ownerScope: 'ORG' as const, contextOrgId: 'org-1', createdAt: '2026-01-01' }, 'Organization members can access this organization folder according to their role.'],
  ])('discloses the inherited privacy of a child under $name', async (parent, disclosure) => {
    const user = userEvent.setup();
    mockUseFolders.mockReturnValue({
      folders: [parent], loading: false, error: null, createFolder, renameFolder, deleteFolder, assignRecord, assignRecords,
    });
    await renderPage();
    await user.click(screen.getByRole('button', { name: `${parent.name} actions` }));
    await user.click(await screen.findByText('New subfolder'));
    expect(await screen.findByText(disclosure)).toBeVisible();
    await user.type(screen.getByLabelText('Folder name'), 'Child');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(createFolder).toHaveBeenCalledWith('Child', {
      ownerScope: parent.ownerScope, parentFolderId: parent.id, contextOrgId: parent.contextOrgId,
    });
  });

  it('renames a folder via the sidebar actions menu', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: 'Invoices actions' }));
    await user.click(await screen.findByText('Rename Folder'));

    const nameInput = await screen.findByLabelText('Folder name');
    expect(nameInput).toHaveValue('Invoices');
    await user.clear(nameInput);
    await user.type(nameInput, 'Receipts');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(renameFolder).toHaveBeenCalledWith('folder-1', 'Receipts');
  });

  it('deletes a folder via the sidebar actions menu and warns records fall back to Unfiled', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: 'Certificates actions' }));
    await user.click(await screen.findByText('Delete Folder'));

    expect(
      await screen.findByText(
        'Delete the folder "Certificates"? Records inside it move to Unfiled — they are not deleted.',
      ),
    ).toBeInTheDocument();

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete Folder' }));

    expect(deleteFolder).toHaveBeenCalledWith('folder-2');
  });

  it('moves a record into a folder via the per-record action menu', async () => {
    const user = userEvent.setup();
    await renderPage();

    const row = screen.getByText('loose-record.pdf').closest('div[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByText('Move to folder'));
    await user.click(await screen.findByRole('button', { name: /Invoices/ }));

    expect(assignRecords).toHaveBeenCalledWith(['anchor-2'], 'folder-1');
  });

  it('keeps only failed records selected and the dialog open for an actionable retry', async () => {
    const user = userEvent.setup();
    assignRecords.mockResolvedValueOnce({
      moved: ['anchor-1'], failed: [{ anchor_id: 'anchor-2', code: 'move_failed' }],
    }).mockResolvedValueOnce({ moved: ['anchor-2'], failed: [] });
    await renderPage();
    await user.click(screen.getByRole('checkbox', { name: 'Select invoice.pdf' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select loose-record.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Move 2' }));
    await user.click(await screen.findByRole('button', { name: /Invoices/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Certificates/ }));
    expect(assignRecords).toHaveBeenLastCalledWith(['anchor-2'], 'folder-2');
    expect(screen.getByRole('checkbox', { name: 'Select invoice.pdf' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select loose-record.pdf' })).not.toBeChecked();
  });

  it('removes a filed record from its folder directly from the action menu', async () => {
    const user = userEvent.setup();
    await renderPage();

    const row = screen.getByText('invoice.pdf').closest('div[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByText('Remove from folder'));

    expect(assignRecord).toHaveBeenCalledWith('anchor-1', null);
  });

  it('refreshes active private-tag results after a successful record mutation', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    mockUsePrivateAnchorList.mockReturnValue({
      data: { records, hasMore: false },
      isLoading: false,
      error: null,
      refetch,
    });
    const user = userEvent.setup();
    await renderPage();
    await user.type(screen.getByRole('textbox', { name: 'Private tag' }), 'internal-review');
    await screen.findByText('Folder, status, and filename filters apply to the current private-tag page.');

    const row = screen.getByText('invoice.pdf').closest('div[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByText('Remove from folder'));

    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  });
});
