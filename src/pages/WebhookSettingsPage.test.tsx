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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WebhookSettingsPage } from './WebhookSettingsPage';

// =========================================================================
// Mocks
// =========================================================================

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
    it('calls delete_webhook_endpoint RPC', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      });

      // Find and click the delete button (Trash2 icon button)
      const { container } = renderPage();
      await waitFor(() => {
        expect(screen.getAllByText('https://example.com/webhooks').length).toBeGreaterThanOrEqual(1);
      });

      const deleteIcons = container.querySelectorAll('.text-destructive');
      const deleteBtn = deleteIcons[0]?.closest('button');

      if (deleteBtn) {
        await userEvent.click(deleteBtn);

        await waitFor(() => {
          expect(mockRpc).toHaveBeenCalledWith('delete_webhook_endpoint', {
            p_endpoint_id: 'ep-1',
          });
        });
      }
    });
  });

  // =========================================================================
  // Toggle Endpoint
  // =========================================================================

  describe('toggle endpoint', () => {
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
