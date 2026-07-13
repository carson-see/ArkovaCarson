/**
 * Webhook Delivery History + Failed Deliveries (WH-03 / SCRUM-2398)
 *
 * Renders the org's recent delivery attempts (webhook_delivery_logs, read
 * RLS-scoped in useWebhookDeliveries) and the failed-delivery queue
 * (worker self-service DLQ projection).
 *
 * Displays delivery METADATA only — status, timestamps, attempt count,
 * target URL, response code, bounded worker-generated error detail. The
 * event payload never reaches this component (the hook never selects it).
 *
 * Replay: the worker records every replay as a NEW delivery-log row (the
 * original is preserved for audit), so repeated replays are independent,
 * auditable attempts. This component adds the UI half of that safety: the
 * Resend button is disabled while a replay is in flight, so a double-click
 * cannot fire twice.
 */

import { useState } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { WEBHOOK_LABELS } from '@/lib/copy';
import type { WebhookDelivery, WebhookDlqEntry } from '@/hooks/useWebhookDeliveries';

interface WebhookDeliveryLogProps {
  deliveries: WebhookDelivery[];
  dlqEntries: WebhookDlqEntry[];
  loading?: boolean;
  dlqLoading?: boolean;
  error?: string | null;
  dlqError?: string | null;
  onReplay: (deliveryId: string) => Promise<void>;
  onDismiss: (entryId: string) => Promise<void>;
}

/**
 * webhook_delivery_logs.status → display label. A separate enum domain from
 * anchor/attestation statuses (statusDisplay.ts) — do not merge them.
 */
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: WEBHOOK_LABELS.DELIVERY_STATUS_PENDING,
  success: WEBHOOK_LABELS.DELIVERY_STATUS_SUCCESS,
  failed: WEBHOOK_LABELS.DELIVERY_STATUS_FAILED,
  retrying: WEBHOOK_LABELS.DELIVERY_STATUS_RETRYING,
};

function statusBadgeVariant(status: string): 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed') return 'destructive';
  if (status === 'success') return 'secondary';
  return 'outline';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function WebhookDeliveryLog({
  deliveries,
  dlqEntries,
  loading = false,
  dlqLoading = false,
  error = null,
  dlqError = null,
  onReplay,
  onDismiss,
}: Readonly<WebhookDeliveryLogProps>) {
  // Ids with an in-flight replay — the button-level double-click guard.
  const [replayingIds, setReplayingIds] = useState<Set<string>>(new Set());
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());

  const handleReplay = async (deliveryId: string) => {
    if (replayingIds.has(deliveryId)) return;
    setReplayingIds((prev) => new Set(prev).add(deliveryId));
    try {
      await onReplay(deliveryId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : WEBHOOK_LABELS.REPLAY_ERROR);
    } finally {
      setReplayingIds((prev) => {
        const next = new Set(prev);
        next.delete(deliveryId);
        return next;
      });
    }
  };

  const handleDismiss = async (entryId: string) => {
    if (dismissingIds.has(entryId)) return;
    setDismissingIds((prev) => new Set(prev).add(entryId));
    try {
      await onDismiss(entryId);
      toast.success(WEBHOOK_LABELS.DISMISS_SUCCESS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : WEBHOOK_LABELS.DISMISS_ERROR);
    } finally {
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Delivery history ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{WEBHOOK_LABELS.DELIVERIES_TITLE}</CardTitle>
          <CardDescription>{WEBHOOK_LABELS.DELIVERIES_DESC}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {!loading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!loading && !error && deliveries.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <p>{WEBHOOK_LABELS.DELIVERIES_EMPTY}</p>
            </div>
          )}
          {!loading && !error && deliveries.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_EVENT}</th>
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_ENDPOINT}</th>
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_STATUS}</th>
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_RESPONSE}</th>
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_ATTEMPT}</th>
                    <th className="py-2 pr-4 font-medium">{WEBHOOK_LABELS.DELIVERIES_COL_TIME}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => {
                    const isReplaying = replayingIds.has(delivery.id);
                    return (
                      <tr
                        key={delivery.id}
                        data-testid={`delivery-row-${delivery.id}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 pr-4">
                          <code className="font-mono text-xs">{delivery.event_type}</code>
                        </td>
                        <td className="py-2 pr-4 max-w-48 truncate font-mono text-xs" title={delivery.endpoint_url}>
                          {delivery.endpoint_url}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={statusBadgeVariant(delivery.status)} className="text-xs">
                            {DELIVERY_STATUS_LABELS[delivery.status] ?? WEBHOOK_LABELS.DELIVERY_STATUS_PENDING}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">{delivery.response_status ?? '—'}</td>
                        <td className="py-2 pr-4">{delivery.attempt_number}</td>
                        <td className="py-2 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                          {formatTime(delivery.created_at)}
                        </td>
                        <td className="py-2 text-right">
                          {delivery.status === 'failed' && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isReplaying}
                              onClick={() => handleReplay(delivery.id)}
                            >
                              {isReplaying ? (
                                <>
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  {WEBHOOK_LABELS.REPLAY_SENDING}
                                </>
                              ) : (
                                <>
                                  <RotateCcw className="mr-1 h-3 w-3" />
                                  {WEBHOOK_LABELS.REPLAY_ACTION}
                                </>
                              )}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Failed deliveries (dead-letter queue) ────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{WEBHOOK_LABELS.FAILED_TITLE}</CardTitle>
          <CardDescription>{WEBHOOK_LABELS.FAILED_DESC}</CardDescription>
        </CardHeader>
        <CardContent>
          {dlqLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {!dlqLoading && dlqError && (
            <Alert variant="destructive">
              <AlertDescription>{dlqError}</AlertDescription>
            </Alert>
          )}
          {!dlqLoading && !dlqError && dlqEntries.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <p>{WEBHOOK_LABELS.FAILED_EMPTY}</p>
            </div>
          )}
          {!dlqLoading && !dlqError && dlqEntries.length > 0 && (
            <div className="space-y-3">
              {dlqEntries.map((entry) => {
                const isDismissing = dismissingIds.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    data-testid={`dlq-entry-${entry.id}`}
                    className="flex items-start justify-between gap-4 rounded-lg border p-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-xs">{entry.event_type}</code>
                        <span className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={entry.endpoint_url}>
                          {entry.endpoint_url}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {WEBHOOK_LABELS.FAILED_COL_ERROR}: {entry.error_message.slice(0, 200)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {WEBHOOK_LABELS.FAILED_COL_ATTEMPTS}: {entry.last_attempt} · {WEBHOOK_LABELS.FAILED_COL_FAILED_AT}: {formatTime(entry.failed_at)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isDismissing}
                      onClick={() => handleDismiss(entry.id)}
                    >
                      {isDismissing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <X className="mr-1 h-3 w-3" />
                      )}
                      {WEBHOOK_LABELS.DISMISS_ACTION}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
