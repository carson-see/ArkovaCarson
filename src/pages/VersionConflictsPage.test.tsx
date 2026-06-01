import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionConflictsPage } from './VersionConflictsPage';

const mockUseVersionResolution = vi.fn();

vi.mock('@/hooks/useVersionResolution', () => ({
  useVersionResolution: () => mockUseVersionResolution(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'admin@example.com' }, signOut: vi.fn() }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/auth/OrgRequiredGate', () => ({
  OrgRequiredGate: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/formatters', () => ({
  formatAge: () => 'today',
}));

describe('VersionConflictsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the specific error message when loading conflicts fails', () => {
    mockUseVersionResolution.mockReturnValue({
      items: [],
      loading: false,
      error: 'Request failed (401)',
      fetchPending: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn(),
    });

    render(<VersionConflictsPage />);

    expect(screen.getByTestId('version-conflicts-error')).toHaveTextContent('Request failed (401)');
  });

  it('reenables approve buttons when resolve rejects', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('network down'));
    mockUseVersionResolution.mockReturnValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          external_file_id: 'file-1',
          filename: 'contract.pdf',
          fingerprint: 'abcdef1234567890',
          created_at: '2026-05-15T10:00:00Z',
          sibling_count: 0,
          source: 'google_drive',
          status: 'pending_review',
          version_number: 2,
        },
      ],
      loading: false,
      error: null,
      fetchPending: vi.fn().mockResolvedValue(undefined),
      resolve,
    });

    render(<VersionConflictsPage />);

    const approveButton = screen.getByRole('button', { name: /select as canonical/i });
    fireEvent.click(approveButton);

    await waitFor(() => expect(resolve).toHaveBeenCalled());
    await waitFor(() => expect(approveButton).not.toBeDisabled());
  });
});
