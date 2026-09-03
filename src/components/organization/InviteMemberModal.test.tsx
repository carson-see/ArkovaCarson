/**
 * InviteMemberModal Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TOAST } from '@/lib/copy';
import { InviteMemberModal } from './InviteMemberModal';

describe('InviteMemberModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    // onInvite reports success/failure via its boolean result (SCRUM-3524);
    // useInviteMember never rethrows (SCRUM-1979 toast-safety contract).
    onInvite: vi.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render modal with form elements', () => {
    render(<InviteMemberModal {...defaultProps} />);

    expect(screen.getByText('Invite Team Member')).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/role/i)).toBeInTheDocument();
  });

  it('should disable send button when email is empty', () => {
    render(<InviteMemberModal {...defaultProps} />);

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    expect(submitButton).toBeDisabled();
  });

  it('should enable send button when email is entered', () => {
    render(<InviteMemberModal {...defaultProps} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    expect(submitButton).not.toBeDisabled();
  });

  it('should validate email before submitting', async () => {
    render(<InviteMemberModal {...defaultProps} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'invalid-email' } });

    const form = screen.getByRole('dialog').querySelector('form')!;
    fireEvent.submit(form);

    // Wait a bit and verify onInvite was not called
    await waitFor(() => {
      expect(defaultProps.onInvite).not.toHaveBeenCalled();
    });
  });

  it('should call onInvite with email and role', async () => {
    render(<InviteMemberModal {...defaultProps} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(defaultProps.onInvite).toHaveBeenCalledWith(
        'test@example.com',
        'INDIVIDUAL'
      );
    });
  });

  it('should close modal after successful invite', async () => {
    render(<InviteMemberModal {...defaultProps} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should show loading state during invite', async () => {
    const slowInvite = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))
    );

    render(<InviteMemberModal {...defaultProps} onInvite={slowInvite} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Sending...')).toBeInTheDocument();
    });
  });

  it('should reset the form after a successful invite', async () => {
    render(<InviteMemberModal {...defaultProps} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(screen.getByPlaceholderText('colleague@company.com')).toHaveValue('');
  });

  // SCRUM-3524: useInviteMember NEVER rethrows — it toasts and resolves false.
  // The modal must act on that boolean instead of closing unconditionally.
  it('should keep the modal open and show the inline Alert when onInvite reports failure', async () => {
    const failedInvite = vi.fn().mockResolvedValue(false);

    render(<InviteMemberModal {...defaultProps} onInvite={failedInvite} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => {
      expect(screen.getByText(TOAST.MEMBER_INVITE_FAILED)).toBeInTheDocument();
    });

    // The modal must NOT close and the typed email must survive for a retry.
    expect(defaultProps.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('colleague@company.com')).toHaveValue('test@example.com');
  });

  it('should handle invite error', async () => {
    const failingInvite = vi.fn().mockRejectedValue(new Error('User already exists'));

    render(<InviteMemberModal {...defaultProps} onInvite={failingInvite} />);

    const emailInput = screen.getByPlaceholderText('colleague@company.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByRole('button', { name: /send invitation/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('User already exists')).toBeInTheDocument();
    });

    // Modal content should still be visible (error doesn't close it)
    expect(screen.getByText('Invite Team Member')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('colleague@company.com')).toBeInTheDocument();
  });
});
