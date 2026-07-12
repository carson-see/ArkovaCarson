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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookSettings, AVAILABLE_EVENTS } from './WebhookSettings';
import { WEBHOOK_LABELS } from '@/lib/copy';

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
    events: ['anchor.expired'],
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
      expect(screen.getByText('anchor.expired')).toBeInTheDocument();
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

      expect(screen.getByLabelText(/Anchor Submitted/i)).not.toBeChecked();
      expect(screen.getByLabelText(/Anchor Secured/i)).toBeChecked();
      expect(screen.getByLabelText(/Anchor Revoked/i)).toBeChecked();
      expect(screen.getByLabelText(/Anchor Expired/i)).not.toBeChecked();
      expect(screen.getByLabelText(/Anchor Batch Secured/i)).not.toBeChecked();
      expect(screen.getByLabelText(/Credential Issued/i)).not.toBeChecked();
      expect(screen.getByLabelText(/Credential Verified/i)).not.toBeChecked();
      expect(screen.getByLabelText(/Credential Status Changed/i)).not.toBeChecked();
    });

    it('validates URL must start with https://', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const urlInput = screen.getByPlaceholderText('https://your-server.com/webhooks');
      await userEvent.type(urlInput, 'http://insecure.com/hooks'); // NOSONAR — intentional: testing that HTTP is rejected

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

      await userEvent.click(screen.getByLabelText(/Anchor Secured/i));
      await userEvent.click(screen.getByLabelText(/Anchor Revoked/i));

      const submitButtons = screen.getAllByText('Add Endpoint');
      const submitButton = submitButtons[submitButtons.length - 1];
      await userEvent.click(submitButton);

      expect(screen.getByText('Select at least one event')).toBeInTheDocument();
      expect(defaultProps.onAdd).not.toHaveBeenCalled();
    });

    it('allows toggling event checkboxes', async () => {
      render(<WebhookSettings {...defaultProps} />);

      await userEvent.click(screen.getByText('Add Endpoint'));

      const expired = screen.getByLabelText(/Anchor Expired/i);
      await userEvent.click(expired);
      expect(expired).toBeChecked();

      const secured = screen.getByLabelText(/Anchor Secured/i);
      await userEvent.click(secured);
      expect(secured).not.toBeChecked();

      const submitted = screen.getByLabelText(/Anchor Submitted/i);
      await userEvent.click(submitted);
      expect(submitted).toBeChecked();

      const credIssued = screen.getByLabelText(/Credential Issued/i);
      await userEvent.click(credIssued);
      expect(credIssued).toBeChecked();
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

    // BUG-D: deleting a webhook endpoint is destructive (the event feed stops)
    // and must NOT fire on a single click. The Trash button opens a confirm
    // AlertDialog (mirrors RevokeDialog / ApiKeySettings); onDelete is only
    // called after the user confirms.

    /** Click the first row's Trash (delete) button. */
    async function clickFirstDeleteButton(container: HTMLElement) {
      const deleteButtons = container.querySelectorAll('.text-destructive');
      expect(deleteButtons.length).toBe(2);
      const firstDeleteBtn = deleteButtons[0].closest('button');
      expect(firstDeleteBtn).not.toBeNull();
      await userEvent.click(firstDeleteBtn as HTMLButtonElement);
    }

    it('opens a confirm dialog (does not delete immediately) when delete clicked', async () => {
      const { container } = render(<WebhookSettings {...defaultProps} />);

      await clickFirstDeleteButton(container);

      // Confirmation dialog appears and names the endpoint (scoped to the
      // dialog — the URL also appears in the list row).
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(WEBHOOK_LABELS.DELETE_CONFIRM_TITLE)).toBeInTheDocument();
      expect(within(dialog).getByText(/https:\/\/example\.com\/webhooks/)).toBeInTheDocument();
      // …and the destructive action has NOT been performed yet.
      expect(defaultProps.onDelete).not.toHaveBeenCalled();
    });

    it('calls onDelete exactly once after the confirm action', async () => {
      const { container } = render(<WebhookSettings {...defaultProps} />);

      await clickFirstDeleteButton(container);

      const confirmButton = await screen.findByRole('button', {
        name: WEBHOOK_LABELS.DELETE_CONFIRM_ACTION,
      });
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(defaultProps.onDelete).toHaveBeenCalledWith('ep-1');
      });
      expect(defaultProps.onDelete).toHaveBeenCalledTimes(1);
    });

    it('does not call onDelete when the confirm dialog is cancelled', async () => {
      const { container } = render(<WebhookSettings {...defaultProps} />);

      await clickFirstDeleteButton(container);

      const cancelButton = await screen.findByRole('button', {
        name: WEBHOOK_LABELS.DELETE_CONFIRM_CANCEL,
      });
      await userEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByText(WEBHOOK_LABELS.DELETE_CONFIRM_TITLE)).not.toBeInTheDocument();
      });
      expect(defaultProps.onDelete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // WH-02 (SCRUM-2397): signed test ping
  // =========================================================================

  describe('signed test ping', () => {
    it('shows the test button only on ACTIVE endpoints when onTestPing is provided', () => {
      const onTestPing = vi.fn().mockResolvedValue({ success: true, status_code: 200, event_id: 'evt-1' });
      render(<WebhookSettings {...defaultProps} onTestPing={onTestPing} />);

      const buttons = screen.getAllByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) });
      // ep-1 is active, ep-2 is inactive → exactly one test button.
      expect(buttons).toHaveLength(1);
    });

    it('does not render test buttons when onTestPing is not provided', () => {
      render(<WebhookSettings {...defaultProps} />);
      expect(
        screen.queryByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) }),
      ).not.toBeInTheDocument();
    });

    it('calls onTestPing and shows the delivered/accepted result with the response code', async () => {
      const onTestPing = vi.fn().mockResolvedValue({ success: true, status_code: 200, event_id: 'evt-1' });
      render(<WebhookSettings {...defaultProps} onTestPing={onTestPing} />);

      await userEvent.click(screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) }));

      await waitFor(() => {
        expect(onTestPing).toHaveBeenCalledWith('ep-1');
      });
      // Success copy interpolates {status}.
      const expected = WEBHOOK_LABELS.TEST_PING_SUCCESS.replace('{status}', '200');
      expect(await screen.findByText(expected)).toBeInTheDocument();
    });

    it('shows the not-accepted result when the receiver returns non-2xx', async () => {
      const onTestPing = vi.fn().mockResolvedValue({ success: false, status_code: 500, event_id: 'evt-1' });
      render(<WebhookSettings {...defaultProps} onTestPing={onTestPing} />);

      await userEvent.click(screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) }));

      const expected = WEBHOOK_LABELS.TEST_PING_FAILURE.replace('{status}', '500');
      expect(await screen.findByText(expected)).toBeInTheDocument();
    });

    it('shows a friendly error when the ping call itself fails', async () => {
      const onTestPing = vi.fn().mockRejectedValue(new Error(WEBHOOK_LABELS.TEST_PING_ERROR));
      render(<WebhookSettings {...defaultProps} onTestPing={onTestPing} />);

      await userEvent.click(screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) }));

      expect(await screen.findByText(WEBHOOK_LABELS.TEST_PING_ERROR)).toBeInTheDocument();
    });

    it('disables the test button while a ping is in flight (double-click guard)', async () => {
      let resolvePing: (v: { success: boolean; status_code: number; event_id: string }) => void = () => {};
      const onTestPing = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePing = resolve;
          }),
      );
      render(<WebhookSettings {...defaultProps} onTestPing={onTestPing} />);

      const button = screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) });
      await userEvent.click(button);

      const inFlight = screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_SENDING) });
      expect(inFlight).toBeDisabled();
      await userEvent.click(inFlight);
      expect(onTestPing).toHaveBeenCalledTimes(1);

      resolvePing({ success: true, status_code: 200, event_id: 'evt-1' });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: new RegExp(WEBHOOK_LABELS.TEST_PING_ACTION) })).not.toBeDisabled();
      });
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

  // Drift guard: when a new event type is added to the worker's
  // PAYLOAD_SCHEMAS_BY_EVENT_TYPE (and therefore VALID_WEBHOOK_EVENTS,
  // and therefore the SDK WebhookEventType union), the UI dropdown must
  // be extended in lockstep. The UI lives in a separate workspace and
  // can't direct-import the worker constant, so the next-best guard is
  // pinning the expected set here. A new event type fails this test
  // until AVAILABLE_EVENTS is updated.
  describe('AVAILABLE_EVENTS drift guard', () => {
    it('matches the worker VALID_WEBHOOK_EVENTS allowlist', () => {
      const EXPECTED_EVENT_IDS = [
        'anchor.submitted',
        'anchor.secured',
        'anchor.revoked',
        'anchor.expired',
        'anchor.batch_secured',
        'credential.issued',
        'credential.verified',
        'credential.status_changed',
      ];
      const actualIds = AVAILABLE_EVENTS.map((e) => e.id);
      expect(actualIds).toEqual(EXPECTED_EVENT_IDS);
    });
  });
});
