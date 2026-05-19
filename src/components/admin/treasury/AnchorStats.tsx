/**
 * AnchorStats — Anchor statistics panel
 *
 * Shows records by lifecycle stage, network stats, and timing.
 *
 * Language:
 *   - "Queued" = PENDING (waiting to be batched)
 *   - "In Mempool" = SUBMITTED (published, waiting for confirmation)
 *   - "Anchored" = SECURED (confirmed on the network)
 *   - Nothing is "anchored" until the network confirms it.
 */

import { FileText, CheckCircle, Clock, Radio, Ban, TrendingUp, Anchor } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { TreasuryAnchorStats as AnchorStatsType } from '@/hooks/useTreasuryBalance';
import { TREASURY_LABELS } from '@/lib/copy';

interface AnchorStatsProps {
  stats: AnchorStatsType | null;
  loading: boolean;
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  PENDING: { label: TREASURY_LABELS.ANCHOR_STATUS_QUEUED, icon: Clock, color: 'text-amber-600' },
  BROADCASTING: { label: TREASURY_LABELS.ANCHOR_STATUS_SUBMITTING, icon: Radio, color: 'text-blue-600' },
  SUBMITTED: { label: TREASURY_LABELS.ANCHOR_STATUS_IN_MEMPOOL, icon: TrendingUp, color: 'text-cyan-600' },
  SECURED: { label: TREASURY_LABELS.ANCHOR_STATUS_ANCHORED, icon: CheckCircle, color: 'text-green-600' },
  REVOKED: { label: TREASURY_LABELS.ANCHOR_STATUS_REVOKED, icon: Ban, color: 'text-red-600' },
};

function orderedStatusKeys(byStatus: Record<string, number | null>): string[] {
  const configuredStatuses = Object.keys(STATUS_CONFIG);
  const extraStatuses = Object.keys(byStatus).filter(
    (status) => !Object.prototype.hasOwnProperty.call(STATUS_CONFIG, status),
  );
  return [...configuredStatuses, ...extraStatuses];
}

function formatMaybeCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

export function AnchorStats({ stats, loading }: Readonly<AnchorStatsProps>) {
  const anchored = stats?.byStatus['SECURED'] ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{TREASURY_LABELS.ANCHOR_STATS_PIPELINE_STATUS}</CardTitle>
        <Anchor className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={`stat-skel-${i}`} className="h-5 w-full" />
            ))}
          </div>
        ) : stats ? (
          <div className="space-y-4">
            {/* Status breakdown */}
            <div className="space-y-2">
              {orderedStatusKeys(stats.byStatus).map((status) => {
                const cfg = STATUS_CONFIG[status] ?? {
                  label: status,
                  icon: FileText,
                  color: 'text-muted-foreground',
                };
                const count = stats.byStatus[status] ?? null;
                const Icon = cfg.icon;
                return (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                      {cfg.label}
                    </span>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {formatMaybeCount(count)}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {/* Summary */}
            <div className="border-t pt-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                  {TREASURY_LABELS.ANCHOR_STATS_ANCHORED_ON_NETWORK}
                </span>
                <span className="font-mono font-semibold text-green-600">{formatMaybeCount(anchored)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  {TREASURY_LABELS.ANCHOR_STATS_TOTAL_RECORDS}
                </span>
                <span className="font-mono font-semibold">{formatMaybeCount(stats.totalAnchors)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  {TREASURY_LABELS.ANCHOR_STATS_NETWORK_RECEIPTS}
                </span>
                <span className="font-mono">{formatMaybeCount(stats.distinctTxIds)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.ANCHOR_STATS_AVG_RECORDS_PER_RECEIPT}</span>
                <span className="font-mono">{formatMaybeCount(stats.avgAnchorsPerTx)}</span>
              </div>
              {stats.lastAnchorTime && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{TREASURY_LABELS.ANCHOR_STATS_LAST_ACTIVITY}</span>
                  <span className="font-mono text-xs">
                    {new Date(stats.lastAnchorTime).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{TREASURY_LABELS.ANCHOR_STATS_UNAVAILABLE}</p>
        )}
      </CardContent>
    </Card>
  );
}
