/**
 * ConnectorCardStatusRow tests
 *
 * The connector cards' status line and connect/disconnect control pair were
 * copy-pasted per card (SonarCloud flagged the DocuSign/Member DocuSign and
 * Drive/Member DocuSign pairs as duplicated blocks on PR #2912). This component
 * owns that chrome. The tests pin the rendered contract each card previously
 * asserted inline: the badge text per state, that Disconnect is never disabled
 * by the entitlement gate, and that the action buttons keep their busy copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectorCardStatusRow } from './ConnectorCardStatusRow';
import { CONNECTIONS_LABELS, CONNECTORS_LABELS } from '@/lib/copy';

const onConnect = vi.fn();
const onDisconnect = vi.fn();

function renderRow(props: Partial<React.ComponentProps<typeof ConnectorCardStatusRow>> = {}) {
  return render(
    <ConnectorCardStatusRow
      statusLoading={false}
      connected={false}
      actionLoading={false}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      {...props}
    />,
  );
}

describe('ConnectorCardStatusRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the checking badge and a disabled Connect button while status loads', () => {
    renderRow({ statusLoading: true });

    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_CHECKING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeDisabled();
  });

  it('shows Connect when disconnected and calls onConnect', () => {
    renderRow();

    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_NOT_CONNECTED)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('shows Disconnect when connected and calls onDisconnect', () => {
    renderRow({ connected: true });

    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_CONNECTED)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('renders the busy copy on whichever action is in flight', () => {
    const { rerender } = renderRow({ actionLoading: true });
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECTING })).toBeDisabled();

    rerender(
      <ConnectorCardStatusRow
        statusLoading={false}
        connected
        actionLoading
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />,
    );
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECTING })).toBeDisabled();
  });

  it('disables Connect when the entitlement gate blocks, but never Disconnect', () => {
    const { rerender } = renderRow({ connectDisabled: true });
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeDisabled();

    rerender(
      <ConnectorCardStatusRow
        statusLoading={false}
        connected
        actionLoading={false}
        connectDisabled
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />,
    );
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeEnabled();
  });

  it('renders card-specific detail under the badge', () => {
    renderRow({ connected: true, children: <p>Account: signer@example.test</p> });

    expect(screen.getByText('Account: signer@example.test')).toBeInTheDocument();
  });

  // Connector health surface (closes the gap behind the #3054 Drive incident —
  // services/worker/src/api/connector-health.ts computed `degraded` states
  // for months with no UI reading them).
  describe('health prop', () => {
    it('renders nothing extra for a healthy connector — the existing connected state is unchanged', () => {
      renderRow({ connected: true });

      expect(screen.queryByText(CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION)).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('renders nothing extra when health is explicitly passed as connected/no reason', () => {
      renderRow({ connected: true, health: { kind: 'connected' } });

      expect(screen.queryByText(CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION)).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('renders a degraded row with its reason, not color-only — an accessible status role announces it', () => {
      renderRow({
        connected: true,
        health: { kind: 'degraded', reasonText: 'This connector has stopped picking up new file changes.' },
      });

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION);
      expect(status).toHaveTextContent('This connector has stopped picking up new file changes.');
    });

    it('renders the grant_exceeds_requested reason without crashing (TRUE in prod for the one connected org)', () => {
      renderRow({
        connected: true,
        health: {
          kind: 'degraded',
          reasonText: CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_GRANT_EXCEEDS_REQUESTED,
        },
      });

      expect(screen.getByRole('status')).toHaveTextContent(
        CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_GRANT_EXCEEDS_REQUESTED,
      );
    });

    it('renders an "unavailable" status — never a healthy claim — when health could not be determined', () => {
      renderRow({ connected: true, health: { kind: 'unknown' } });

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(CONNECTORS_LABELS.CONNECTOR_HEALTH_UNAVAILABLE);
      expect(status).not.toHaveTextContent(CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION);
    });

    it('does not render a health row for a disconnected connector even if a stale degraded prop is passed', () => {
      renderRow({
        connected: false,
        health: { kind: 'degraded', reasonText: 'stale reason from before disconnect' },
      });

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
