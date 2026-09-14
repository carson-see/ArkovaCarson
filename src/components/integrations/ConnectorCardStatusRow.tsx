/**
 * Shared connector-card status line and action control.
 *
 * Every connector card renders the same row: a state icon, a "Status" label
 * with a badge, card-specific detail beneath it, and a Connect/Disconnect
 * button on the right. That block was copy-pasted per card, which SonarCloud
 * flagged as duplicated code on the connectors work (PR #2912: the block is
 * shared by `DocusignConnectorCard`, `MemberDocusignConnectorCard`,
 * `AdobeSignConnectorCard` and `DriveConnectorCard`).
 *
 * Only the chrome lives here. Each card keeps what genuinely differs — its
 * status query, entitlement gate, denial copy and disconnect side effects —
 * because those are the parts that have diverged for real backend reasons
 * (see this folder's agents.md).
 *
 * `connectDisabled` gates the Connect button only. Disconnect is never gated:
 * a lapsed or denied organization must still be able to remove its connection.
 */

import type { ReactNode } from 'react';
import { CheckCircle, Loader2, PlugZap, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CONNECTIONS_LABELS } from '@/lib/copy';

interface ConnectorCardStatusRowProps {
  /** The connection status query is still in flight. */
  statusLoading: boolean;
  connected: boolean;
  /** A connect or disconnect request is in flight. */
  actionLoading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Entitlement gate for the connect action only. */
  connectDisabled?: boolean;
  /** Card-specific detail rendered under the status badge. */
  children?: ReactNode;
}

export function ConnectorCardStatusRow({
  statusLoading,
  connected,
  actionLoading,
  onConnect,
  onDisconnect,
  connectDisabled = false,
  children,
}: Readonly<ConnectorCardStatusRowProps>) {
  let StatusIcon = PlugZap;
  let statusIconClass = 'h-5 w-5 text-muted-foreground';
  let statusLabel: string = CONNECTIONS_LABELS.STATUS_NOT_CONNECTED;
  if (statusLoading) {
    StatusIcon = Loader2;
    statusIconClass = 'h-5 w-5 animate-spin text-muted-foreground';
    statusLabel = CONNECTIONS_LABELS.STATUS_CHECKING;
  } else if (connected) {
    StatusIcon = CheckCircle;
    statusIconClass = 'h-5 w-5 text-emerald-500';
    statusLabel = CONNECTIONS_LABELS.STATUS_CONNECTED;
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <StatusIcon className={statusIconClass} />
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Status</p>
            <Badge variant={connected ? 'default' : 'secondary'}>
              {statusLabel}
            </Badge>
          </div>
          {children}
        </div>
      </div>

      {connected ? (
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={actionLoading}>
          {actionLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Unplug className="mr-2 h-4 w-4" />
          )}
          {actionLoading ? CONNECTIONS_LABELS.DISCONNECTING : CONNECTIONS_LABELS.DISCONNECT_BUTTON}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={onConnect}
          disabled={statusLoading || actionLoading || connectDisabled}
        >
          {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {actionLoading ? CONNECTIONS_LABELS.CONNECTING : CONNECTIONS_LABELS.CONNECT_BUTTON}
        </Button>
      )}
    </div>
  );
}
