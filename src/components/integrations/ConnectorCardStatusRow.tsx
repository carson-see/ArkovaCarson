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
 *
 * `health` surfaces the SCRUM-1146 health dashboard (`GET
 * /api/connectors/health` via `useConnectorHealth`) that no UI read before
 * this — see this folder's agents.md. It is entirely additive: omitting it
 * (or passing `{ kind: 'connected' }`) renders exactly the row above,
 * unchanged. `degraded`/`unknown` render a second, distinct status line with
 * `role="status"` so a screen reader announces it — never color-only — and
 * only while `connected` is true (a disconnected connector already reads
 * "Not connected"; a stale health reading for it is not actionable).
 */

import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle, HelpCircle, Loader2, PlugZap, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CONNECTIONS_LABELS, CONNECTORS_LABELS } from '@/lib/copy';

/**
 * Presentational-only health summary for this row. `'connected'` (or the prop
 * omitted) means "render the row exactly as before" — the healthy case is
 * deliberately inert. `'unknown'` covers a health request that failed,
 * returned nothing, or could not be parsed; it must NEVER be conflated with
 * `'connected'` (fail-closed — see `useConnectorHealth`).
 */
export type ConnectorHealthDisplay =
  | { kind: 'connected' }
  | {
      kind: 'degraded';
      reasonText: string;
      details?: Array<{ label: string; value: string }>;
      action?: { label: string; onClick: () => void; loading?: boolean };
    }
  | { kind: 'unknown' };

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
  /** SCRUM-1146 health surface — see the component doc comment above. */
  health?: ConnectorHealthDisplay;
}

export function ConnectorCardStatusRow({
  statusLoading,
  connected,
  actionLoading,
  onConnect,
  onDisconnect,
  connectDisabled = false,
  children,
  health,
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

  // Only meaningful while connected — a disconnected connector already reads
  // "Not connected", and a health reading from before disconnect is stale,
  // not actionable (pinned by the "does not render ... for a disconnected
  // connector" test).
  const showHealth = connected && health && health.kind !== 'connected';

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
          {showHealth && health.kind === 'degraded' && (
            <div
              role="status"
              className="mt-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div>
                <span className="font-medium">{CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION}:</span>{' '}
                {health.reasonText}
                {health.details && health.details.length > 0 && (
                  <dl className="mt-2 space-y-1">
                    {health.details.map(({ label, value }) => (
                      <div key={label} className="flex flex-wrap gap-x-1">
                        <dt className="font-medium">{label}:</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {health.action && (
                  <Button
                    className="mt-2"
                    variant="outline"
                    size="sm"
                    onClick={health.action.onClick}
                    disabled={health.action.loading}
                  >
                    {health.action.loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                    {health.action.label}
                  </Button>
                )}
              </div>
            </div>
          )}
          {showHealth && health.kind === 'unknown' && (
            <div
              role="status"
              className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground"
            >
              <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{CONNECTORS_LABELS.CONNECTOR_HEALTH_UNAVAILABLE}</span>
            </div>
          )}
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
