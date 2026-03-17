/**
 * DeleteAccountDialog Tests — PII-02
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteAccountDialog } from './DeleteAccountDialog';

// Mock workerFetch
vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn(),
}));

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('DeleteAccountDialog', () => {
  it('renders the delete button', () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    expect(screen.getByText('Delete Account')).toBeInTheDocument();
  });

  it('opens dialog when button is clicked', () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));
    expect(screen.getByText('Delete Your Account')).toBeInTheDocument();
  });

  it('shows user email in dialog', () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('disables confirm button until DELETE is typed', () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));

    const confirmBtn = screen.getByText('Permanently Delete Account');
    expect(confirmBtn).toBeDisabled();

    const input = screen.getByPlaceholderText('DELETE');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('shows consequences list', () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));
    expect(screen.getByText(/Anonymize all your audit trail records/)).toBeInTheDocument();
    expect(screen.getByText(/Remove your profile/)).toBeInTheDocument();
  });

  it('has cancel button that closes dialog', async () => {
    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));
    expect(screen.getByText('Delete Your Account')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText('Delete Your Account')).not.toBeInTheDocument();
    });
  });

  it('shows error when deletion fails', async () => {
    const { workerFetch } = await import('@/lib/workerClient');
    (workerFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));

    const input = screen.getByPlaceholderText('DELETE');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByText('Permanently Delete Account'));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  it('calls workerFetch with DELETE method on confirm', async () => {
    const { workerFetch } = await import('@/lib/workerClient');
    (workerFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    render(<DeleteAccountDialog userEmail="test@example.com" />);
    fireEvent.click(screen.getByText('Delete Account'));

    const input = screen.getByPlaceholderText('DELETE');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByText('Permanently Delete Account'));

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith('/api/account', { method: 'DELETE' });
    });
  });
});
