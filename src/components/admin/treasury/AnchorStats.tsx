/**
 * AnchorStats — Anchor statistics panel
 *
 * Shows total anchors by status, TX counts, and timing info.
 */

import { FileText, CheckCircle, Clock, Radio, Ban, Hash, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { AnchorStats as AnchorStatsType } from '@/hooks/useAnchorStats';

interface AnchorStatsProps {
  stats: AnchorStatsType | null;
  loading: boolean;
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  PENDING: { label: 'Processing', icon: Clock, color: 'text-amber-600' },
  BROADCASTING: { label: 'Broadcasting', icon: Radio, color: 'text-blue-600' },
  SUBMITTED: { label: 'Submitted', icon: TrendingUp, color: 'text-cyan-600' },
  SECURED: { label: 'Verified', icon: CheckCircle, color: 'text-green-600' },
  REVOKED: { label: 'Revoked', icon: Ban, color: 'text-red-600' },
};

export function AnchorStats({ stats, loading }: Readonly<AnchorStatsProps>) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Anchor Statistics</CardTitle>
        <FileText className="h-4 w-4 text-muted-foreground" />
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
              {Object.entries(STATUS_CONFIG).map(([status, cfg]) => {
                const count = stats.byStatus[status] ?? 0;
                const Icon = cfg.icon;
                return (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                      {cfg.label}
                    </span>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {count.toLocaleString()}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {/* Aggregate stats */}
            <div className="border-t pt-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  Total Anchors
                </span>
                <span className="font-mono font-semibold">{stats.totalAnchors.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" />
                  Batch TXs
                </span>
                <span className="font-mono">{stats.distinctTxIds.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Avg Anchors/TX</span>
                <span className="font-mono">{stats.avgAnchorsPerTx.toLocaleString()}</span>
              </div>
              {stats.lastAnchorTime && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Last Anchor</span>
                  <span className="font-mono text-xs">
                    {new Date(stats.lastAnchorTime).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to load stats</p>
        )}
      </CardContent>
    </Card>
  );
}
