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
import { CONNECTIONS_LABELS } from '@/lib/copy';

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
});
