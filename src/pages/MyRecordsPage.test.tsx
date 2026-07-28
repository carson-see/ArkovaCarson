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
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Record } from '@/components/records';
import type { Folder } from '@/hooks/useFolders';

const mockUseAnchors = vi.hoisted(() => vi.fn());
const mockUseFolders = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@test.com' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useAnchors', () => ({ useAnchors: mockUseAnchors }));
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  let createFolder: ReturnType<typeof vi.fn>;
  let renameFolder: ReturnType<typeof vi.fn>;
  let deleteFolder: ReturnType<typeof vi.fn>;
  let assignRecord: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createFolder = vi.fn().mockResolvedValue(undefined);
    renameFolder = vi.fn().mockResolvedValue(undefined);
    deleteFolder = vi.fn().mockResolvedValue(undefined);
    assignRecord = vi.fn().mockResolvedValue(undefined);

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
    await user.type(await screen.findByLabelText('Folder name'), 'Diplomas');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createFolder).toHaveBeenCalledWith('Diplomas');
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

    expect(assignRecord).toHaveBeenCalledWith('anchor-2', 'folder-1');
  });

  it('removes a filed record from its folder directly from the action menu', async () => {
    const user = userEvent.setup();
    await renderPage();

    const row = screen.getByText('invoice.pdf').closest('div[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByText('Remove from folder'));

    expect(assignRecord).toHaveBeenCalledWith('anchor-1', null);
  });
});
