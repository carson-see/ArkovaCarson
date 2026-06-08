/**
 * RevokeDialog Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RevokeDialog } from './RevokeDialog';

describe('RevokeDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    recordName: 'test-document.pdf',
    onConfirm: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render dialog with record name', () => {
    render(<RevokeDialog {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Revoke Record' })).toBeInTheDocument();
    expect(screen.getByText('test-document.pdf')).toBeInTheDocument();
  });

  it('should render reason textarea', () => {
    render(<RevokeDialog {...defaultProps} />);

    expect(screen.getByLabelText(/reason for revocation/i)).toBeInTheDocument();
  });

  it('should disable confirm button until "revoke" is typed', () => {
    render(<RevokeDialog {...defaultProps} />);

    const confirmButton = screen.getByRole('button', { name: /revoke record/i });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByPlaceholderText('revoke');
    fireEvent.change(input, { target: { value: 'revoke' } });

    expect(confirmButton).not.toBeDisabled();
  });

  it('should accept case-insensitive confirmation', () => {
    render(<RevokeDialog {...defaultProps} />);

    const input = screen.getByPlaceholderText('revoke');
    fireEvent.change(input, { target: { value: 'REVOKE' } });

    const confirmButton = screen.getByRole('button', { name: /revoke record/i });
    expect(confirmButton).not.toBeDisabled();
  });

  it('should call onConfirm with reason and close dialog on confirm', async () => {
    render(<RevokeDialog {...defaultProps} />);

    // Enter a reason
    const reasonTextarea = screen.getByLabelText(/reason for revocation/i);
    fireEvent.change(reasonTextarea, { target: { value: 'Credential expired' } });

    // Type confirmation
    const input = screen.getByPlaceholderText('revoke');
    fireEvent.change(input, { target: { value: 'revoke' } });

    const confirmButton = screen.getByRole('button', { name: /revoke record/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(defaultProps.onConfirm).toHaveBeenCalledWith('Credential expired');
    });

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should call onConfirm with empty string when no reason provided', async () => {
    render(<RevokeDialog {...defaultProps} />);

    const input = screen.getByPlaceholderText('revoke');
    fireEvent.change(input, { target: { value: 'revoke' } });

    const confirmButton = screen.getByRole('button', { name: /revoke record/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(defaultProps.onConfirm).toHaveBeenCalledWith('');
    });
  });

  it('should show loading state during confirmation', async () => {
    let resolveConfirm: () => void = () => {};
    const confirmPromise = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const slowConfirm = vi.fn().mockImplementation(() => confirmPromise);

    render(<RevokeDialog {...defaultProps} onConfirm={slowConfirm} />);

    const input = screen.getByPlaceholderText('revoke');
    fireEvent.change(input, { target: { value: 'revoke' } });

    const confirmButton = screen.getByRole('button', { name: /revoke record/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText('Revoking...')).toBeInTheDocument();
    });

    await act(async () => {
      resolveConfirm();
      await confirmPromise;
    });

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should call onOpenChange when cancel is clicked', () => {
    render(<RevokeDialog {...defaultProps} />);

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });
});
