/**
 * FolderSidebar Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderSidebar } from './FolderSidebar';
import type { Folder } from '@/hooks/useFolders';

const folders: Folder[] = [
  { id: 'folder-1', name: 'Invoices', ownerScope: 'USER', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'folder-2', name: 'Certificates', ownerScope: 'USER', createdAt: '2026-01-02T00:00:00Z' },
];

describe('FolderSidebar', () => {
  const defaultProps = {
    folders,
    loading: false,
    selected: 'ALL' as const,
    onSelect: vi.fn(),
    onNewFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders All Records, Unfiled, and every folder', () => {
    render(<FolderSidebar {...defaultProps} />);

    expect(screen.getByRole('navigation', { name: 'Folders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Records' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unfiled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Certificates' })).toBeInTheDocument();
  });

  it('marks the selected item with aria-current', () => {
    render(<FolderSidebar {...defaultProps} selected="folder-1" />);

    expect(screen.getByRole('button', { name: 'Invoices' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'All Records' })).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect with ALL, UNFILED, or the folder id', () => {
    render(<FolderSidebar {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unfiled' }));
    expect(defaultProps.onSelect).toHaveBeenCalledWith('UNFILED');

    fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
    expect(defaultProps.onSelect).toHaveBeenCalledWith('folder-1');

    fireEvent.click(screen.getByRole('button', { name: 'All Records' }));
    expect(defaultProps.onSelect).toHaveBeenCalledWith('ALL');
  });

  it('calls onNewFolder when the New Folder button is clicked', () => {
    render(<FolderSidebar {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
    expect(defaultProps.onNewFolder).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there are no folders', () => {
    render(<FolderSidebar {...defaultProps} folders={[]} />);

    expect(screen.getByText('No folders yet')).toBeInTheDocument();
  });

  it('shows loading skeletons instead of folder rows while loading', () => {
    render(<FolderSidebar {...defaultProps} loading folders={[]} />);

    expect(screen.queryByRole('button', { name: 'Invoices' })).not.toBeInTheDocument();
    expect(screen.getByTestId('folder-sidebar-loading')).toBeInTheDocument();
  });

  it('exposes rename and delete actions per folder via its actions menu', async () => {
    const user = userEvent.setup();
    render(<FolderSidebar {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Invoices actions' }));
    await user.click(await screen.findByText('Rename Folder'));
    expect(defaultProps.onRename).toHaveBeenCalledWith(folders[0]);

    await user.click(screen.getByRole('button', { name: 'Certificates actions' }));
    await user.click(await screen.findByText('Delete Folder'));
    expect(defaultProps.onDelete).toHaveBeenCalledWith(folders[1]);
  });
});
