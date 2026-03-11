/**
 * WebhookSettings Component Tests
 *
 * Tests the two-phase dialog (creation form → secret display),
 * URL validation, event selection, copy secret, endpoint list rendering,
 * and enable/disable/delete actions.
 *
 * @see P7-TS-09
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookSettings } from './WebhookSettings';

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

const mockEndpoints = [
  {
    id: 'ep-1',
    url: 'https://example.com/webhooks',
    events: ['anchor.secured', 'anchor.revoked'],
    is_active: true,
    created_at: '2026-03-10T12:00:00Z',
  },
  {
    id: 'ep-2',
    url: 'https://other.com/hooks',
    events: ['anchor.created'],
    is_active: false,
    created_at: '2026-03-09T12:00:00Z',
  },
];

describe('WebhookSettings', () => {
  const defaultProps = {
    endpoints: mockEndpoints,
    onAdd: vi.fn().mockResolvedValue('whsec_test_secret_abc123def456'),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onToggle: vi.fn().mockResolvedValue(undefined),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Endpoint List Rendering
  // =========================================================================

  describe('endpoint list rendering', () => {
    it('renders all endpoints with URLs and event badges', () => {
      render(<WebhookSettings {...defaultProps} />);

      expect(screen.getByText('https://example.com/webhooks')).toBeInTheDocument();
      expect(screen.getByText('https://other.com/hooks')).toBeInTheDocument();
      expect(screen.getByText('anchor.secured')).toBeInTheDocument();
      expect(screen.getByText('anchor.revoked')).toBeInTheDocument();
      expect(screen.getByText('anchor.created')).toBeInTheDocument();
    });

    it('shows active/inactive status icons', () => {
      const { container } = render(<WebhookSettings {...defaultProps} />);

      // Active endpoint has green icon, inactive has muted
      const greenIcons = container.querySelectorAll('.text-green-500');
      const mutedIcons = container.querySelectorAll('.text-muted-foreground');

      expect(greenIcons.length).toBeGreaterThanOrEqual(1);
      expect(mutedIcons.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Enable button for inactive endpoints', () => {
      render(<WebhookSettings {...defaultProps} />);

      expect(screen.getByText('Enable')).toBeInTheDocument();
      expect(screen.getByText('Disable')).toBeInTheDocument();
    });

    it('shows empty state when no endpoints', () => {
      render(<WebhookSettings {...defaultProps} endpoints={[]} />);

      expect(screen.getByText('No webhook endpoints configured')).toBeInTheDocument();
      expect(screen.getByText('Add an endpoint to receive event notifications')).toBeInTheDocument();
    });

    it('shows loading spinner when loading', () => {
      const { container } = render(<WebhookSettings {...defaultProps} loading={true} />);

      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Add Endpoint Dialog — Creation Form
  // =========================================================================

  describe('add endpoint dialog', () => {
    it('opens dialog when Add Endpoint button clicked', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      expect(screen.getByText('Add Webhook Endpoint')).toBeInTheDocument();
      expect(screen.getByText(/Configure a new endpoint/)).toBeInTheDocument();
    });

    it('has default events pre-selected', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const checkboxes = screen.getAllByRole('checkbox');
      // anchor.secured and anchor.revoked should be checked by default
      expect(checkboxes[0]).toBeChecked(); // anchor.secured
      expect(checkboxes[1]).toBeChecked(); // anchor.revoked
      expect(checkboxes[2]).not.toBeChecked(); // anchor.created
    });

    it('validates URL must start with https://', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'http://insecure.com/hooks');

      // Submit the form
      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      expect(screen.getByText('URL must start with https://')).toBeInTheDocument();
      expect(defaultProps.onAdd).not.toHaveBeenCalled();
    });

    it('validates at least one event is selected', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://valid.com/hooks');

      // Uncheck default events
      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]); // uncheck anchor.secured
      await userEvent.click(checkboxes[1]); // uncheck anchor.revoked

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      expect(screen.getByText('Select at least one event')).toBeInTheDocument();
      expect(defaultProps.onAdd).not.toHaveBeenCalled();
    });

    it('allows toggling event checkboxes', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const checkboxes = screen.getAllByRole('checkbox');

      // Toggle anchor.created on
      await userEvent.click(checkboxes[2]);
      expect(checkboxes[2]).toBeChecked();

      // Toggle anchor.secured off
      await userEvent.click(checkboxes[0]);
      expect(checkboxes[0]).not.toBeChecked();
    });

    it('calls onAdd with URL and events on valid submission', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(defaultProps.onAdd).toHaveBeenCalledWith(
          'https://myapp.com/webhooks',
          ['anchor.secured', 'anchor.revoked']
        );
      });
    });

    it('shows error when onAdd rejects', async () => {
      const failingProps = {
        ...defaultProps,
        onAdd: vi.fn().mockRejectedValue(new Error('Endpoint limit reached')),
      };

      render(<WebhookSettings {...failingProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Endpoint limit reached')).toBeInTheDocument();
      });
    });

    it('shows generic error for non-Error rejections', async () => {
      const failingProps = {
        ...defaultProps,
        onAdd: vi.fn().mockRejectedValue('unknown'),
      };

      render(<WebhookSettings {...failingProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Failed to add endpoint')).toBeInTheDocument();
      });
    });

    it('closes dialog on Cancel', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));
      expect(screen.getByText('Add Webhook Endpoint')).toBeInTheDocument();

      await userEvent.click(screen.getByText('Cancel'));

      await waitFor(() => {
        expect(screen.queryByText('Add Webhook Endpoint')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Secret Display (One-Time)
  // =========================================================================

  describe('secret display after creation', () => {
    it('shows secret display after successful creation', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Endpoint Created')).toBeInTheDocument();
        expect(screen.getByText('Copy your signing secret now. It will not be shown again.')).toBeInTheDocument();
        expect(screen.getByText('whsec_test_secret_abc123def456')).toBeInTheDocument();
      });
    });

    it('copies secret to clipboard when copy button clicked', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('whsec_test_secret_abc123def456')).toBeInTheDocument();
      });

      // Find and click the copy button (icon button next to the secret)
      const copyButtons = screen.getAllByRole('button');
      const copyButton = copyButtons.find(btn => btn.querySelector('.lucide-copy') || btn.querySelector('[class*="copy"]'));

      // If we can't find by icon, find by the outline variant button near the secret
      if (copyButton) {
        await userEvent.click(copyButton);
      } else {
        // Click the small icon button next to the code block
        const codeBlock = screen.getByText('whsec_test_secret_abc123def456');
        const iconButton = codeBlock.parentElement?.querySelector('button');
        if (iconButton) {
          await userEvent.click(iconButton);
        }
      }

      expect(mockClipboard.writeText).toHaveBeenCalledWith('whsec_test_secret_abc123def456');
    });

    it('closes secret dialog and resets state on Done', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Endpoint Created')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Done'));

      await waitFor(() => {
        expect(screen.queryByText('Endpoint Created')).not.toBeInTheDocument();
        expect(screen.queryByText('whsec_test_secret_abc123def456')).not.toBeInTheDocument();
      });
    });

    it('shows security warning about one-time display', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'https://myapp.com/webhooks');

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Save this secret securely/)).toBeInTheDocument();
        expect(screen.getByText(/only time it will be displayed/)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Endpoint Actions (Toggle, Delete)
  // =========================================================================

  describe('endpoint actions', () => {
    it('calls onToggle with correct args when Disable clicked', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Disable'));

      expect(defaultProps.onToggle).toHaveBeenCalledWith('ep-1', false);
    });

    it('calls onToggle with correct args when Enable clicked', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Enable'));

      expect(defaultProps.onToggle).toHaveBeenCalledWith('ep-2', true);
    });

    it('calls onDelete when delete button clicked', async () => {
      const { container } = render(<WebhookSettings {...defaultProps} />);

      // Delete buttons are ghost buttons with Trash2 icon
      const deleteButtons = container.querySelectorAll('.text-destructive');
      expect(deleteButtons.length).toBe(2);

      // Click the first delete button's parent
      const firstDeleteBtn = deleteButtons[0].closest('button');
      if (firstDeleteBtn) {
        await userEvent.click(firstDeleteBtn);
      }

      expect(defaultProps.onDelete).toHaveBeenCalledWith('ep-1');
    });
  });

  // =========================================================================
  // Header & Metadata
  // =========================================================================

  describe('header and metadata', () => {
    it('renders card title and description', () => {
      render(<WebhookSettings {...defaultProps} />);

      expect(screen.getByText('Webhook Endpoints')).toBeInTheDocument();
      expect(screen.getByText('Receive notifications when events occur in your organization')).toBeInTheDocument();
    });

    it('renders Add Endpoint button in header', () => {
      render(<WebhookSettings {...defaultProps} />);

      const addButton = screen.getByText('Add Endpoint');
      expect(addButton).toBeInTheDocument();
    });
  });
});
