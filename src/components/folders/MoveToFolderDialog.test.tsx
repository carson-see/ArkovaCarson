/**
 * MoveToFolderDialog Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MoveToFolderDialog } from './MoveToFolderDialog';
import type { Folder } from '@/hooks/useFolders';

const folders: Folder[] = [
  { id: 'folder-1', name: 'Invoices', ownerScope: 'USER', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'folder-2', name: 'Certificates', ownerScope: 'USER', createdAt: '2026-01-02T00:00:00Z' },
];

describe('MoveToFolderDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    folders,
    currentFolderId: null as string | null,
    onSelect: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog title and every folder plus Unfiled', () => {
    render(<MoveToFolderDialog {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Move to Folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unfiled/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invoices/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Certificates/ })).toBeInTheDocument();
  });

  it('calls onSelect with the folder id when a folder row is clicked', async () => {
    render(<MoveToFolderDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Invoices/ }));

    await waitFor(() => {
      expect(defaultProps.onSelect).toHaveBeenCalledWith('folder-1');
    });
    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('calls onSelect with null when Unfiled is clicked', async () => {
    render(<MoveToFolderDialog {...defaultProps} currentFolderId="folder-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Unfiled/ }));

    await waitFor(() => {
      expect(defaultProps.onSelect).toHaveBeenCalledWith(null);
    });
  });

  it('shows an empty state with no folders yet', () => {
    render(<MoveToFolderDialog {...defaultProps} folders={[]} />);

    expect(screen.getByText('No folders yet')).toBeInTheDocument();
  });

  it('marks the currently-assigned folder as selected', () => {
    render(<MoveToFolderDialog {...defaultProps} currentFolderId="folder-2" />);

    const row = screen.getByRole('button', { name: /Certificates/ });
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });
});
