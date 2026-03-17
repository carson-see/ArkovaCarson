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
});
