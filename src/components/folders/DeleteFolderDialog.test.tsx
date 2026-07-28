/**
 * DeleteFolderDialog Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { DeleteFolderDialog } from './DeleteFolderDialog';

describe('DeleteFolderDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    folderName: 'Invoices',
    onConfirm: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the folder name and the un-filing (not deletion) copy', () => {
    render(<DeleteFolderDialog {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Delete Folder' })).toBeInTheDocument();
    expect(
      screen.getByText('Delete the folder "Invoices"? Records inside it move to Unfiled — they are not deleted.'),
    ).toBeInTheDocument();
  });

  it('calls onConfirm and closes the dialog when the delete action is confirmed', async () => {
    render(<DeleteFolderDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Folder' }));

    await waitFor(() => {
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows a loading state while deleting', async () => {
    let resolveConfirm: () => void = () => {};
    const confirmPromise = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const slowConfirm = vi.fn().mockImplementation(() => confirmPromise);

    render(<DeleteFolderDialog {...defaultProps} onConfirm={slowConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Folder' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Folder' })).toBeDisabled();
    });

    await act(async () => {
      resolveConfirm();
      await confirmPromise;
    });

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('calls onOpenChange(false) when cancel is clicked', () => {
    render(<DeleteFolderDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });
});
