/**
 * ConfirmAnchorModal Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmAnchorModal } from './ConfirmAnchorModal';

// Mock react-router-dom (needed by UpgradePrompt)
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(),
        })),
      })),
    })),
  },
}));

// Mock hooks
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'test-user-id' },
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { org_id: null },
  }),
}));

const mockCanCreateAnchor = vi.hoisted(() => ({ current: true }));

vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    canCreateAnchor: mockCanCreateAnchor.current,
    recordsUsed: mockCanCreateAnchor.current ? 0 : 3,
    recordsLimit: 3,
    remaining: mockCanCreateAnchor.current ? 3 : 0,
    percentUsed: mockCanCreateAnchor.current ? 0 : 100,
    isNearLimit: !mockCanCreateAnchor.current,
    planName: 'Free',
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    canCreateCount: vi.fn().mockReturnValue(mockCanCreateAnchor.current),
  }),
}));

describe('ConfirmAnchorModal', () => {
  const mockFile = new File(['test content'], 'test.pdf', {
    type: 'application/pdf',
  });
  const mockFingerprint = 'a'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display file info and fingerprint', () => {
    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={mockFingerprint}
      />
    );

    expect(getByText('test.pdf')).toBeInTheDocument();
    expect(getByText(/Document Fingerprint/i)).toBeInTheDocument();
    expect(getByText(mockFingerprint)).toBeInTheDocument();
  });

  it('should show Pending status notice', () => {
    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={mockFingerprint}
      />
    );

    expect(getByText(/Pending/i)).toBeInTheDocument();
  });

  it('should call onOpenChange when cancel clicked', () => {
    const onOpenChange = vi.fn();

    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={onOpenChange}
        file={mockFile}
        fingerprint={mockFingerprint}
      />
    );

    getByText('Cancel').click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should not render if file is null', () => {
    const { queryByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={null}
        fingerprint={mockFingerprint}
      />
    );

    expect(queryByText('Confirm Anchor')).not.toBeInTheDocument();
  });

  it('should not render if fingerprint is null', () => {
    const { queryByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={null}
      />
    );

    expect(queryByText('Confirm Anchor')).not.toBeInTheDocument();
  });

  it('should show upgrade prompt when quota exhausted', async () => {
    mockCanCreateAnchor.current = false;

    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={mockFingerprint}
      />
    );

    // Click create — should trigger upgrade prompt instead of insert
    fireEvent.click(getByText('Create Anchor'));

    // UpgradePrompt renders "Monthly Limit Reached"
    await waitFor(() => {
      expect(getByText('Monthly Limit Reached')).toBeInTheDocument();
    });

    // Reset for other tests
    mockCanCreateAnchor.current = true;
  });

  // DH-06: Server-side quota error handling
  it('should show upgrade prompt on server-side P0002 quota error', async () => {
    // Mock supabase to return P0002 error
    const { supabase } = await import('@/lib/supabase');
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { code: 'P0002', message: 'Quota exceeded: 0 records remaining but 1 requested' },
          }),
        })),
      })),
    });

    const onError = vi.fn();

    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={mockFingerprint}
        onError={onError}
      />
    );

    fireEvent.click(getByText('Create Anchor'));

    // Should show upgrade prompt, not call onError
    await waitFor(() => {
      expect(getByText('Monthly Limit Reached')).toBeInTheDocument();
    });

    // onError should NOT have been called for quota errors
    expect(onError).not.toHaveBeenCalled();
  });

  it('should call onError for non-quota server errors', async () => {
    const { supabase } = await import('@/lib/supabase');
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { code: '23505', message: 'Duplicate key violation' },
          }),
        })),
      })),
    });

    const onError = vi.fn();

    const { getByText } = render(
      <ConfirmAnchorModal
        open={true}
        onOpenChange={() => {}}
        file={mockFile}
        fingerprint={mockFingerprint}
        onError={onError}
      />
    );

    fireEvent.click(getByText('Create Anchor'));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Duplicate key violation');
    });
  });
});
