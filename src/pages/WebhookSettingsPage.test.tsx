/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * WebhookSettingsPage Integration Tests
 *
 * Tests Supabase RPC integration for webhook endpoint CRUD.
 * Verifies server-side secret generation flow (create_webhook_endpoint RPC),
 * delete via RPC, toggle via direct update, and data fetching.
 *
 * @see P7-TS-09
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { WebhookSettingsPage } from './WebhookSettingsPage';
import { WEBHOOK_LABELS } from '@/lib/copy';

// =========================================================================
// Mocks
// =========================================================================

// Mock sonner toast — assert the toggle surfaces RLS/permission failures.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'test-user-id', email: 'admin@test.com' },
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: {
      id: 'test-user-id',
      org_id: 'org-123',
      role: 'ORG_ADMIN',
      email: 'admin@test.com',
      full_name: 'Test Admin',
    },
    loading: false,
  }),
}));

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

const mockEndpoints = [
  {
    id: 'ep-1',
    url: 'https://example.com/webhooks',
    events: ['anchor.secured', 'anchor.revoked'],
    is_active: true,
    created_at: '2026-03-10T12:00:00Z',
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <WebhookSettingsPage />
    </MemoryRouter>
  );
}

// =========================================================================
// Setup
// =========================================================================

function setupDefaultMocks() {
  // Default: from('webhook_endpoints').select().eq().order() → returns endpoints
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: mockEndpoints }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  });

  // Default: rpc calls succeed
  mockRpc.mockResolvedValue({
    data: { id: 'new-ep-id', secret: 'whsec_generated_secret_xyz' },
    error: null,
  });
}

describe('WebhookSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  // =========================================================================
  // Data Fetching
  // =========================================================================

  describe('data fetching', () => {
    it('fetches endpoints on mount', async () => {
      renderPage();

      await waitFor(() => {
        expect(mockFrom).toHaveBeenCalledWith('webhook_endpoints');
      });
    });

    it('renders fetched endpoints', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });
    });

    it('shows loading state initially', () => {
      // Delay the response to keep loading state visible
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
          }),
        }),
      });

      const { container } = renderPage();

      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Create Endpoint (RPC)
  // =========================================================================

  describe('create endpoint via RPC', () => {
    it('calls create_webhook_endpoint RPC with correct params', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://new-endpoint.com/hooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(mockRpc).toHaveBeenCalledWith('create_webhook_endpoint', {
          p_url: 'https://new-endpoint.com/hooks',
          p_events: ['anchor.secured', 'anchor.revoked'],
        });
      });
    });

    it('shows server-generated secret after creation', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://new-endpoint.com/hooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Endpoint Created')).toBeInTheDocument();
        expect(screen.getByText('whsec_generated_secret_xyz')).toBeInTheDocument();
      });
    });

    it('shows error when RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Only ORG_ADMIN can create webhook endpoints' },
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://new-endpoint.com/hooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Only ORG_ADMIN can create webhook endpoints')).toBeInTheDocument();
      });
    });

    it('refetches endpoints after successful creation', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      // Clear call count after initial fetch
      const initialCallCount = mockFrom.mock.calls.length;

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://new-endpoint.com/hooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        // Should have re-fetched after creation
        const webhookCalls = mockFrom.mock.calls.filter(
          (call: unknown[]) => call[0] === 'webhook_endpoints'
        );
        expect(webhookCalls.length).toBeGreaterThan(initialCallCount);
      });
    });
  });

  // =========================================================================
  // Delete Endpoint (RPC)
  // =========================================================================

  describe('delete endpoint via RPC', () => {
    // BUG-D: the Trash button now opens a confirm dialog; the RPC fires only
    // after the user confirms (mirrors RevokeDialog). A single click must NOT
    // call the delete RPC.
    it('calls delete_webhook_endpoint RPC after confirming the dialog', async () => {
      const { container } = renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      // Click the row's Trash (delete) button.
      const deleteIcons = container.querySelectorAll('.text-destructive');
      const deleteBtn = deleteIcons[0]?.closest('button');
      expect(deleteBtn).toBeTruthy();
      await userEvent.click(deleteBtn as HTMLButtonElement);

      // No RPC yet — the confirm dialog is open.
      expect(mockRpc).not.toHaveBeenCalledWith('delete_webhook_endpoint', {
        p_endpoint_id: 'ep-1',
      });

      // Confirm, then the RPC fires.
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.click(
        within(dialog).getByRole('button', { name: WEBHOOK_LABELS.DELETE_CONFIRM_ACTION }),
      );

      await waitFor(() => {
        expect(mockRpc).toHaveBeenCalledWith('delete_webhook_endpoint', {
          p_endpoint_id: 'ep-1',
        });
      });
    });
  });

  // =========================================================================
  // Toggle Endpoint
  // =========================================================================

  describe('toggle endpoint', () => {
    /**
     * Wire `from('webhook_endpoints')` so that `.update().eq()` resolves the
     * supplied `updateResult`, and `.select().eq().order()` returns `rows`.
     * Lets a test deny the toggle update while the refetch returns the
     * *unchanged* (old) row — so a visible revert is observable.
     */
    function wireToggleMocks(opts: {
      updateResult: { error: { message: string } | null };
      rowsAfterToggle: typeof mockEndpoints;
    }) {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: opts.rowsAfterToggle }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue(opts.updateResult),
        }),
      });
    }

    it('calls direct update for toggle', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Disable')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Disable'));

      await waitFor(() => {
        expect(mockFrom).toHaveBeenCalledWith('webhook_endpoints');
      });
    });

    // AC2: a successful toggle persists the new state and shows no error.
    // eslint-disable-next-line arkova/require-error-code-assertion -- happy-path test: asserts NO error toast + persisted state; there is no error code to assert.
    it('persists the new state on success without surfacing an error', async () => {
      // Mount fetch returns the row active ("Disable" shown); the post-toggle
      // refetch returns it inactive ("Enable" shown) — a successful persist.
      const order = vi
        .fn()
        .mockResolvedValueOnce({ data: mockEndpoints }) // mount
        .mockResolvedValue({ data: [{ ...mockEndpoints[0], is_active: false }] }); // refetch
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ order }) }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Disable')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Disable'));

      // State persists: the button now reads "Enable".
      await waitFor(() => {
        expect(screen.getByText('Enable')).toBeInTheDocument();
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    // AC1: an RLS/permission-denied toggle shows an error toast AND the toggle
    // reverts visibly (button label returns to its original state).
    it('surfaces an error toast and reverts the toggle when the update is denied', async () => {
      // Update is denied by RLS; the refetch returns the row UNCHANGED (still
      // active), so the toggle must snap back to "Disable" — visibly reverted.
      wireToggleMocks({
        updateResult: {
          error: { message: 'new row violates row-level security policy for table "webhook_endpoints"' },
        },
        rowsAfterToggle: mockEndpoints, // unchanged: still is_active: true
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Disable')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Disable'));

      // An error toast is shown with the user-facing copy — and it must NOT
      // leak the raw RLS/Postgres message ("row-level security policy …").
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(WEBHOOK_LABELS.TOGGLE_ERROR);
      });
      const toastArgs = (toast.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(toastArgs.join(' ')).not.toContain('row-level security');

      // The toggle reverts visibly — the button reads "Disable" again
      // (endpoint is still active), never silently sticking on the new label.
      await waitFor(() => {
        expect(screen.getByText('Disable')).toBeInTheDocument();
      });
      expect(screen.queryByText('Enable')).not.toBeInTheDocument();
    });

    // AC3: the optimistic update feels responsive — the button flips to the new
    // label immediately (before the denied update's refetch reverts it).
    it('optimistically flips the toggle immediately before the server responds', async () => {
      // Keep the update pending so the optimistic state is observable.
      let resolveUpdate: (v: { error: null }) => void = () => {};
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockEndpoints }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue(
            new Promise<{ error: null }>((resolve) => {
              resolveUpdate = resolve;
            }),
          ),
        }),
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Disable')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Disable'));

      // Optimistic: the label flips to "Enable" while the update is still in
      // flight (no await on the server round-trip).
      await waitFor(() => {
        expect(screen.getByText('Enable')).toBeInTheDocument();
      });

      resolveUpdate({ error: null });
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles empty endpoint list gracefully', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [] }),
          }),
        }),
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('No webhook endpoints configured')).toBeInTheDocument();
      });
    });

    it('handles null data response', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null }),
          }),
        }),
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('No webhook endpoints configured')).toBeInTheDocument();
      });
    });
  });
});
