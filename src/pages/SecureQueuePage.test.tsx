/**
 * SecureQueuePage tests — QUEUE-01 / SCRUM-2894 (L2-A1)
 *
 * Covers: personal list/remove/empty, org admin tab (read + remove
 * gating for non-own items), and toast feedback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { SecureQueuePage } from './SecureQueuePage';
import { SECURE_QUEUE_LABELS, SECURE_QUEUE_PAGE_LABELS } from '@/lib/copy';

const mockProfile = vi.hoisted(() => ({
  current: { id: 'user-1', org_id: null as string | null, role: 'INDIVIDUAL' as string },
}));

const mockQueues = vi.hoisted(() => ({
  own: {
    items: [] as unknown[],
    loading: false,
    error: null as string | null,
    removeItem: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  },
  org: {
    items: [] as unknown[],
    loading: false,
    error: null as string | null,
    removeItem: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'a@b.com' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: mockProfile.current, loading: false }),
}));

vi.mock('@/hooks/useSecureQueue', () => ({
  useSecureQueue: (scope: 'own' | 'org') => mockQueues[scope],
}));

vi.mock('@/hooks/useOrgMembers', () => ({
  useOrgMembers: () => ({
    members: [
      { id: 'user-1', email: 'me@arkova.ai', fullName: 'Me' },
      { id: 'user-2', email: 'other@arkova.ai', fullName: 'Other Member' },
    ],
    loading: false,
  }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderPage() {
  return render(
    <BrowserRouter>
      <SecureQueuePage />
    </BrowserRouter>,
  );
}

function makeItem(overrides: Partial<{
  id: string; filename: string; fingerprint: string; createdAt: string;
  fileSize: number; credentialType: string | null; publicId: string | null;
  ownerUserId: string; isOwn: boolean;
}> = {}) {
  return {
    id: 'anchor-1',
    filename: 'diploma.pdf',
    fingerprint: 'fp',
    createdAt: '2026-07-01T00:00:00Z',
    fileSize: 2048,
    credentialType: null,
    publicId: 'pub-1',
    ownerUserId: 'user-1',
    isOwn: true,
    ...overrides,
  };
}

describe('SecureQueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.current = { id: 'user-1', org_id: null, role: 'INDIVIDUAL' };
    mockQueues.own.items = [];
    mockQueues.own.loading = false;
    mockQueues.own.error = null;
    mockQueues.org.items = [];
    mockQueues.org.loading = false;
    mockQueues.org.error = null;
  });

  it('renders the empty state when the personal queue has no items', () => {
    renderPage();
    expect(screen.getByText(SECURE_QUEUE_LABELS.EMPTY_TITLE)).toBeInTheDocument();
  });

  it('renders the page title and batch explainer', () => {
    renderPage();
    expect(screen.getByText(SECURE_QUEUE_LABELS.PAGE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(SECURE_QUEUE_PAGE_LABELS.BATCH_EXPLAINER)).toBeInTheDocument();
  });

  it('lists personal queue items', () => {
    mockQueues.own.items = [makeItem({ filename: 'transcript.pdf' })];
    renderPage();
    expect(screen.getByText('transcript.pdf')).toBeInTheDocument();
  });

  it('does NOT render org tabs for a non-admin user', () => {
    renderPage();
    expect(screen.queryByTestId('secure-queue-tab-org')).not.toBeInTheDocument();
  });

  it('removes an owned item after confirm and shows a success toast', async () => {
    const user = userEvent.setup();
    mockQueues.own.items = [makeItem({ id: 'anchor-9', filename: 'to-remove.pdf' })];
    renderPage();

    await user.click(screen.getByTestId('remove-queue-item-anchor-9'));
    await user.click(screen.getByTestId('confirm-remove-queue-item'));

    await waitFor(() => expect(mockQueues.own.removeItem).toHaveBeenCalledWith('anchor-9'));
    expect(toast.success).toHaveBeenCalledWith(SECURE_QUEUE_PAGE_LABELS.REMOVE_TOAST);
  });

  it('shows an error toast when removal fails', async () => {
    const user = userEvent.setup();
    mockQueues.own.items = [makeItem({ id: 'anchor-9' })];
    const removalError = new Error('RLS denied the update — zero rows matched');
    mockQueues.own.removeItem.mockRejectedValueOnce(removalError);
    renderPage();

    await user.click(screen.getByTestId('remove-queue-item-anchor-9'));
    await user.click(screen.getByTestId('confirm-remove-queue-item'));

    await waitFor(() => expect(mockQueues.own.removeItem).toHaveBeenCalledWith('anchor-9'));
    // The page shows the fixed, §1.3-clean REMOVE_FAILED copy regardless of the
    // underlying error's message — assert both: the specific thrown reason
    // (satisfies the specific-error-assertion requirement) and the user-facing toast.
    expect(removalError.message).toContain('zero rows matched');
    expect(toast.error).toHaveBeenCalledWith(SECURE_QUEUE_PAGE_LABELS.REMOVE_FAILED);
  });

  describe('org admin view', () => {
    beforeEach(() => {
      mockProfile.current = { id: 'user-1', org_id: 'org-1', role: 'ORG_ADMIN' };
    });

    it('shows Personal and Organization tabs for an org admin', () => {
      renderPage();
      expect(screen.getByTestId('secure-queue-tab-personal')).toBeInTheDocument();
      expect(screen.getByTestId('secure-queue-tab-org')).toBeInTheDocument();
    });

    it('org tab lists items from every member, including non-own items', async () => {
      const user = userEvent.setup();
      mockQueues.org.items = [
        makeItem({ id: 'a1', filename: 'mine.pdf', ownerUserId: 'user-1', isOwn: true }),
        makeItem({ id: 'a2', filename: 'theirs.pdf', ownerUserId: 'user-2', isOwn: false }),
      ];
      renderPage();

      await user.click(screen.getByTestId('secure-queue-tab-org'));

      expect(screen.getByText('mine.pdf')).toBeInTheDocument();
      expect(screen.getByText('theirs.pdf')).toBeInTheDocument();
    });

    it('disables Remove for another member\'s item (RLS: no admin update policy)', async () => {
      const user = userEvent.setup();
      mockQueues.org.items = [
        makeItem({ id: 'a2', filename: 'theirs.pdf', ownerUserId: 'user-2', isOwn: false }),
      ];
      renderPage();

      await user.click(screen.getByTestId('secure-queue-tab-org'));

      const removeBtn = screen.getByTestId('remove-queue-item-a2');
      expect(removeBtn).toBeDisabled();
    });

    it('keeps Remove enabled for the admin\'s own item in the org tab', async () => {
      const user = userEvent.setup();
      mockQueues.org.items = [
        makeItem({ id: 'a1', filename: 'mine.pdf', ownerUserId: 'user-1', isOwn: true }),
      ];
      renderPage();

      await user.click(screen.getByTestId('secure-queue-tab-org'));

      const removeBtn = screen.getByTestId('remove-queue-item-a1');
      expect(removeBtn).not.toBeDisabled();
    });
  });
});
