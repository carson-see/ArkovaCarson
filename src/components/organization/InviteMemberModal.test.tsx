/**
 * InviteMemberModal Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteMemberModal } from './InviteMemberModal';

describe('InviteMemberModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onInvite: vi.fn().mockResolvedValue(undefined),
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
      () => new Promise((resolve) => setTimeout(resolve, 100))
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
