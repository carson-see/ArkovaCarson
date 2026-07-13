/**
 * WebhookDeliveryLog tests (WH-03 / SCRUM-2398).
 *
 * Covers: delivery history rendering (metadata only), failed-delivery (DLQ)
 * section, replay action (incl. in-flight double-click guard — the UI half
 * of idempotent replay), dismiss action, empty/loading/error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookDeliveryLog } from './WebhookDeliveryLog';
import { WEBHOOK_LABELS } from '@/lib/copy';
import type { WebhookDelivery, WebhookDlqEntry } from '@/hooks/useWebhookDeliveries';

const DELIVERIES: WebhookDelivery[] = [
  {
    id: 'log-1',
    event_type: 'anchor.secured',
    status: 'failed',
    response_status: 503,
    attempt_number: 5,
    created_at: '2026-07-01T10:00:00Z',
    delivered_at: null,
    endpoint_url: 'https://hooks.example.com/in',
  },
  {
    id: 'log-2',
    event_type: 'anchor.submitted',
    status: 'success',
    response_status: 200,
    attempt_number: 1,
    created_at: '2026-07-01T09:00:00Z',
    delivered_at: '2026-07-01T09:00:01Z',
    endpoint_url: 'https://hooks.example.com/in',
  },
  {
    id: 'log-3',
    event_type: 'anchor.revoked',
    status: 'retrying',
    response_status: null,
    attempt_number: 2,
    created_at: '2026-07-01T08:00:00Z',
    delivered_at: null,
    endpoint_url: 'https://other.example.com/hooks',
  },
];

const DLQ_ENTRIES: WebhookDlqEntry[] = [
  {
    id: 'dlq-1',
    endpoint_url: 'https://hooks.example.com/in',
    event_type: 'anchor.secured',
    event_id: 'evt-1',
    error_message: 'HTTP 503',
    last_attempt: 5,
    failed_at: '2026-07-01T10:05:00Z',
  },
];

describe('WebhookDeliveryLog', () => {
  const defaultProps = {
    deliveries: DELIVERIES,
    dlqEntries: DLQ_ENTRIES,
    loading: false,
    dlqLoading: false,
    error: null as string | null,
    dlqError: null as string | null,
    onReplay: vi.fn().mockResolvedValue(undefined),
    onDismiss: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('delivery history', () => {
    it('renders delivery rows with metadata: event, endpoint, status label, response code, attempt', () => {
      render(<WebhookDeliveryLog {...defaultProps} />);

      expect(screen.getByText(WEBHOOK_LABELS.DELIVERIES_TITLE)).toBeInTheDocument();

      const failedRow = screen.getByTestId('delivery-row-log-1');
      expect(within(failedRow).getByText('anchor.secured')).toBeInTheDocument();
      expect(within(failedRow).getByText(WEBHOOK_LABELS.DELIVERY_STATUS_FAILED)).toBeInTheDocument();
      expect(within(failedRow).getByText('503')).toBeInTheDocument();
      expect(within(failedRow).getByText('5')).toBeInTheDocument(); // attempt count cell

      const successRow = screen.getByTestId('delivery-row-log-2');
      expect(within(successRow).getByText(WEBHOOK_LABELS.DELIVERY_STATUS_SUCCESS)).toBeInTheDocument();

      const retryingRow = screen.getByTestId('delivery-row-log-3');
      expect(within(retryingRow).getByText(WEBHOOK_LABELS.DELIVERY_STATUS_RETRYING)).toBeInTheDocument();
    });

    it('never renders a raw status enum — statuses go through display labels', () => {
      render(<WebhookDeliveryLog {...defaultProps} />);
      // Raw lowercase enum values must not appear as visible status text.
      expect(screen.queryByText(/^success$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^retrying$/)).not.toBeInTheDocument();
    });

    it('shows the empty state when there are no deliveries', () => {
      render(<WebhookDeliveryLog {...defaultProps} deliveries={[]} dlqEntries={[]} />);
      expect(screen.getByText(WEBHOOK_LABELS.DELIVERIES_EMPTY)).toBeInTheDocument();
    });

    it('shows the error state', () => {
      render(
        <WebhookDeliveryLog
          {...defaultProps}
          deliveries={[]}
          error={WEBHOOK_LABELS.DELIVERIES_ERROR}
        />,
      );
      expect(screen.getByText(WEBHOOK_LABELS.DELIVERIES_ERROR)).toBeInTheDocument();
    });
  });

  describe('replay action', () => {
    it('shows Resend only on failed deliveries', () => {
      render(<WebhookDeliveryLog {...defaultProps} />);

      const failedRow = screen.getByTestId('delivery-row-log-1');
      expect(within(failedRow).getByRole('button', { name: new RegExp(WEBHOOK_LABELS.REPLAY_ACTION) })).toBeInTheDocument();

      const successRow = screen.getByTestId('delivery-row-log-2');
      expect(within(successRow).queryByRole('button', { name: new RegExp(WEBHOOK_LABELS.REPLAY_ACTION) })).not.toBeInTheDocument();
    });

    it('calls onReplay with the delivery id', async () => {
      render(<WebhookDeliveryLog {...defaultProps} />);

      const failedRow = screen.getByTestId('delivery-row-log-1');
      await userEvent.click(within(failedRow).getByRole('button', { name: new RegExp(WEBHOOK_LABELS.REPLAY_ACTION) }));

      await waitFor(() => {
        expect(defaultProps.onReplay).toHaveBeenCalledWith('log-1');
      });
      expect(defaultProps.onReplay).toHaveBeenCalledTimes(1);
    });

    it('disables the Resend button while a replay is in flight (double-click guard)', async () => {
      let resolveReplay: () => void = () => {};
      const slowReplay = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveReplay = resolve;
          }),
      );

      render(<WebhookDeliveryLog {...defaultProps} onReplay={slowReplay} />);

      const failedRow = screen.getByTestId('delivery-row-log-1');
      const button = within(failedRow).getByRole('button', { name: new RegExp(WEBHOOK_LABELS.REPLAY_ACTION) });

      await userEvent.click(button);
      // While in flight the button is disabled — a second click cannot fire
      // a duplicate replay from the UI.
      const inFlightButton = within(failedRow).getByRole('button');
      expect(inFlightButton).toBeDisabled();
      await userEvent.click(inFlightButton);
      expect(slowReplay).toHaveBeenCalledTimes(1);

      resolveReplay();
      await waitFor(() => {
        expect(within(failedRow).getByRole('button')).not.toBeDisabled();
      });
    });
  });

  describe('failed deliveries (DLQ)', () => {
    it('renders DLQ entries with error metadata and dismiss action', () => {
      render(<WebhookDeliveryLog {...defaultProps} />);

      expect(screen.getByText(WEBHOOK_LABELS.FAILED_TITLE)).toBeInTheDocument();
      const entry = screen.getByTestId('dlq-entry-dlq-1');
      expect(within(entry).getByText('anchor.secured')).toBeInTheDocument();
      expect(within(entry).getByText(/HTTP 503/)).toBeInTheDocument();
      expect(within(entry).getByRole('button', { name: new RegExp(WEBHOOK_LABELS.DISMISS_ACTION) })).toBeInTheDocument();
    });

    it('calls onDismiss with the entry id', async () => {
      render(<WebhookDeliveryLog {...defaultProps} />);

      const entry = screen.getByTestId('dlq-entry-dlq-1');
      await userEvent.click(within(entry).getByRole('button', { name: new RegExp(WEBHOOK_LABELS.DISMISS_ACTION) }));

      await waitFor(() => {
        expect(defaultProps.onDismiss).toHaveBeenCalledWith('dlq-1');
      });
    });

    it('shows the DLQ empty state when there are no failed entries', () => {
      render(<WebhookDeliveryLog {...defaultProps} dlqEntries={[]} />);
      expect(screen.getByText(WEBHOOK_LABELS.FAILED_EMPTY)).toBeInTheDocument();
    });
  });
});
