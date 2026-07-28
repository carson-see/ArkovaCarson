/**
 * FolderFormDialog Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderFormDialog } from './FolderFormDialog';

describe('FolderFormDialog', () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the create title and empty input in create mode', () => {
    render(<FolderFormDialog {...baseProps} mode="create" />);

    expect(screen.getByRole('heading', { name: 'Create Folder' })).toBeInTheDocument();
    expect(screen.getByLabelText('Folder name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('renders the rename title pre-filled with the current name in rename mode', () => {
    render(<FolderFormDialog {...baseProps} mode="rename" initialName="Invoices" />);

    expect(screen.getByRole('heading', { name: 'Rename Folder' })).toBeInTheDocument();
    expect(screen.getByLabelText('Folder name')).toHaveValue('Invoices');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('disables submit while the name is empty', () => {
    render(<FolderFormDialog {...baseProps} mode="create" />);

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Certs' } });
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('disables submit in rename mode when the name is unchanged', () => {
    render(<FolderFormDialog {...baseProps} mode="rename" initialName="Invoices" />);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Receipts' } });
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('calls onSubmit with the trimmed name and closes on success', async () => {
    render(<FolderFormDialog {...baseProps} mode="create" />);

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: '  Certs  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(baseProps.onSubmit).toHaveBeenCalledWith('Certs');
    });
    await waitFor(() => {
      expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows a duplicate-name error and keeps the dialog open on a unique-constraint failure', async () => {
    const onSubmit = vi.fn().mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' });
    render(<FolderFormDialog {...baseProps} mode="create" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Invoices' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('A folder with that name already exists.')).toBeInTheDocument();
    });
    expect(baseProps.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows a generic error on non-duplicate failures', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('network down'));
    render(<FolderFormDialog {...baseProps} mode="create" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Certs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Could not create the folder. Please try again.')).toBeInTheDocument();
    });
  });

  it('calls onOpenChange(false) when cancel is clicked', () => {
    render(<FolderFormDialog {...baseProps} mode="create" />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
  });
});
