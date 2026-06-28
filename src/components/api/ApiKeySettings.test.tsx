/**
 * ApiKeySettings Component Tests (P4.5-TS-09)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiKeySettings } from './ApiKeySettings';
import type { ApiKeyMasked, ApiKeyCreated } from '@/hooks/useApiKeys';

const mockKey: ApiKeyMasked = {
  id: 'key-1',
  key_prefix: 'ak_live_abc1',
  name: 'Production',
  scopes: ['verify', 'batch'],
  rate_limit_tier: 'standard',
  is_active: true,
  created_at: '2026-03-10T00:00:00Z',
  expires_at: null,
  last_used_at: '2026-03-14T12:00:00Z',
};

const revokedKey: ApiKeyMasked = {
  ...mockKey,
  id: 'key-2',
  name: 'Old Key',
  is_active: false,
};

const defaultProps = {
  keys: [mockKey, revokedKey],
  onCreate: vi.fn().mockResolvedValue({} as ApiKeyCreated) as unknown as (name: string, scopes: string[], expiresInDays?: number) => Promise<ApiKeyCreated>,
  onRevoke: vi.fn().mockResolvedValue(undefined) as unknown as (keyId: string) => Promise<void>,
  onDelete: vi.fn().mockResolvedValue(undefined) as unknown as (keyId: string) => Promise<void>,
};

describe('ApiKeySettings', () => {
  it('renders key list with names', () => {
    render(<ApiKeySettings {...defaultProps} />);
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.getByText('Old Key')).toBeInTheDocument();
  });

  it('shows Active and Revoked badges', () => {
    render(<ApiKeySettings {...defaultProps} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('shows masked key prefix', () => {
    render(<ApiKeySettings {...defaultProps} />);
    expect(screen.getAllByText(/ak_live_abc1/).length).toBeGreaterThan(0);
  });

  it('shows empty state when no keys', () => {
    render(<ApiKeySettings {...defaultProps} keys={[]} />);
    expect(screen.getByText(/No API keys yet/)).toBeInTheDocument();
  });

  it('shows loading spinner', () => {
    render(<ApiKeySettings {...defaultProps} keys={[]} loading={true} />);
    // Loader2 renders as an SVG with animate-spin
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('opens create dialog on button click', async () => {
    render(<ApiKeySettings {...defaultProps} />);
    fireEvent.click(screen.getByText('Create API Key'));
    await waitFor(() => {
      expect(screen.getByText('Key Name')).toBeInTheDocument();
    });
  });

  it('defaults new keys to the Search scope', async () => {
    const onCreate = vi.fn().mockResolvedValue({ key: 'ak_live_test' } as ApiKeyCreated);
    render(<ApiKeySettings {...defaultProps} onCreate={onCreate} />);

    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(await screen.findByLabelText('Key Name'), { target: { value: 'Search Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API Key' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith('Search Key', ['read:search'], undefined);
    });
  });

  it('lets admins select API v2 scopes on key creation', async () => {
    const onCreate = vi.fn().mockResolvedValue({ key: 'ak_live_test' } as ApiKeyCreated);
    render(<ApiKeySettings {...defaultProps} onCreate={onCreate} />);

    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(await screen.findByLabelText('Key Name'), { target: { value: 'Records Key' } });
    fireEvent.click(screen.getByLabelText('Records'));
    fireEvent.click(screen.getByRole('button', { name: 'Create API Key' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith('Records Key', ['read:search', 'read:records'], undefined);
    });
  });

  it('shows scope badges on key cards', () => {
    render(<ApiKeySettings {...defaultProps} />);
    expect(screen.getAllByText('Verify').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Batch').length).toBeGreaterThan(0);
  });

  it('shows revoke button only for active keys', () => {
    render(<ApiKeySettings {...defaultProps} />);
    // Only one Revoke button (for the active key)
    const revokeButtons = screen.getAllByText('Revoke');
    expect(revokeButtons).toHaveLength(1);
  });

  it('shows fetch error alert when fetchError is provided', () => {
    render(<ApiKeySettings {...defaultProps} keys={[]} fetchError="Failed to fetch" />);
    expect(screen.getByText(/Unable to load API keys/)).toBeInTheDocument();
    expect(screen.getByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it('does not show error alert when fetchError is null', () => {
    render(<ApiKeySettings {...defaultProps} fetchError={null} />);
    expect(screen.queryByText(/Unable to load API keys/)).not.toBeInTheDocument();
  });

  // Regression: a failed revoke used to be swallowed by an empty catch
  // ("Error handled by parent"), so the dialog closed and the key looked
  // revoked even though the call rejected. It must surface the failure and
  // keep the key shown as active.
  describe('revoke/delete error handling', () => {
    // Open the confirm dialog for the single active key and click the
    // destructive confirm button.
    const confirmRevoke = async () => {
      // The card action button and the dialog confirm button share the
      // "Revoke" label; the card button is the only one until the dialog opens.
      fireEvent.click(screen.getByRole('button', { name: /Revoke/ }));
      const confirmButton = await screen.findByRole('button', { name: 'Revoke' });
      fireEvent.click(confirmButton);
    };

    it('surfaces an error and keeps the key active when revoke fails', async () => {
      const onRevoke = vi.fn().mockRejectedValue(new Error('row-level security'));
      render(<ApiKeySettings {...defaultProps} onRevoke={onRevoke} />);

      await confirmRevoke();

      // (AC1) error message is shown to the user
      await waitFor(() => {
        expect(screen.getByText(/Failed to revoke key/i)).toBeInTheDocument();
      });
      expect(onRevoke).toHaveBeenCalledWith('key-1');

      // (AC1) the key remains shown as active — exactly one Active badge
      // (key-1) and exactly one Revoked badge (key-2, the pre-existing
      // revoked key). The active key was NOT flipped to revoked.
      expect(screen.getAllByText('Active')).toHaveLength(1);
      expect(screen.getAllByText('Revoked')).toHaveLength(1);

      // (AC1) the confirm dialog stays open (does not imply success by
      // closing) — its destructive confirm button is still present.
      expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('closes the dialog with no error when revoke succeeds', async () => {
      const onRevoke = vi.fn().mockResolvedValue(undefined);
      render(<ApiKeySettings {...defaultProps} onRevoke={onRevoke} />);

      await confirmRevoke();

      await waitFor(() => {
        expect(onRevoke).toHaveBeenCalledWith('key-1');
      });
      // (AC2) no error surfaced
      expect(screen.queryByText(/Failed to revoke key/i)).not.toBeInTheDocument();
      // (AC2) confirm dialog closed — its title is gone
      await waitFor(() => {
        expect(screen.queryByText('Revoke API Key')).not.toBeInTheDocument();
      });
    });

    it('surfaces an error when delete fails', async () => {
      const onDelete = vi.fn().mockRejectedValue(new Error('network'));
      render(<ApiKeySettings {...defaultProps} onDelete={onDelete} />);

      // Delete buttons are icon-only (Trash2); the active key's is first.
      const deleteButtons = screen
        .getAllByRole('button')
        .filter((b) => b.className.includes('text-destructive'));
      fireEvent.click(deleteButtons[0]);

      const confirmButton = await screen.findByRole('button', { name: 'Delete' });
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText(/Failed to delete key/i)).toBeInTheDocument();
      });
      expect(onDelete).toHaveBeenCalledWith('key-1');
    });
  });
});
