/**
 * Usage Widget
 *
 * Shows monthly record usage against plan limits with color-coded progress bar.
 * Displays proactive warnings at 80% and 100% usage. Links to upgrade.
 *
 * @see UF-06
 */

import { useEffect, useRef } from 'react';
import { BarChart3, AlertTriangle, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEntitlements } from '@/hooks/useEntitlements';
import { USAGE_LABELS, ENTITLEMENT_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { toast } from 'sonner';

interface UsageWidgetProps {
  /** Whether to show the compact version (no header card, just the bar) */
  compact?: boolean;
}

export function UsageWidget({ compact = false }: Readonly<UsageWidgetProps>) {
  const {
    recordsUsed,
    recordsLimit,
    remaining,
    percentUsed,
    isNearLimit,
    planName,
    loading,
    error,
  } = useEntitlements();

  const warning80Shown = useRef(false);
  const warning100Shown = useRef(false);

  // Show warning toasts at 80% and 100% (each fires once per mount)
  useEffect(() => {
    if (loading || percentUsed === null) return;
    if (percentUsed >= 100 && !warning100Shown.current) {
      toast.warning(USAGE_LABELS.WARNING_100);
      warning100Shown.current = true;
    } else if (percentUsed >= 80 && !warning80Shown.current) {
      toast.warning(USAGE_LABELS.WARNING_80);
      warning80Shown.current = true;
    }
  }, [percentUsed, loading]);

  if (loading) {
    return compact ? (
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-2 w-full" />
      </div>
    ) : (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4 w-48 mb-3" />
          <Skeleton className="h-2 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) return null;

  const isUnlimited = recordsLimit === null;
  const progressValue = percentUsed ?? 0;

  // Color coding: green <50%, amber 50-80%, red >80%
  function getProgressColor(pct: number): string {
    if (pct >= 80) return 'bg-red-500';
    if (pct >= 50) return 'bg-amber-500';
    return 'bg-green-500';
  }
  const progressColor = getProgressColor(progressValue);

  const usageText = isUnlimited
    ? USAGE_LABELS.RECORDS_UNLIMITED
    : USAGE_LABELS.RECORDS_USED
        .replace('{used}', String(recordsUsed))
        .replace('{limit}', String(recordsLimit));

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{usageText}</span>
          <Badge variant="outline" className="text-xs">{planName}</Badge>
        </div>
        {!isUnlimited && (
          <div className="relative h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${progressColor}`}
              style={{ width: `${Math.min(progressValue, 100)}%` }}
            />
          </div>
        )}
        {isNearLimit && !isUnlimited && (
          <Link to={ROUTES.BILLING}>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs text-primary">
              {USAGE_LABELS.UPGRADE_CTA}
              <ArrowUpRight className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        )}
      </div>
    );
  }

  return (
    <Card className="glass-card shadow-card-rest animate-in-view">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            {USAGE_LABELS.TITLE}
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            {planName}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Usage count */}
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold">{recordsUsed}</span>
          {!isUnlimited && (
            <span className="text-sm text-muted-foreground">
              / {recordsLimit} records
            </span>
          )}
          {isUnlimited && (
            <span className="text-sm text-muted-foreground">
              records this month
            </span>
          )}
        </div>

        {/* Progress bar */}
        {!isUnlimited && (
          <div className="relative h-2.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${progressColor}`}
              style={{ width: `${Math.min(progressValue, 100)}%` }}
            />
          </div>
        )}

        {/* Remaining info */}
        <div className="flex justify-between text-xs text-muted-foreground">
          {!isUnlimited && remaining !== null && (
            <span>{remaining} {ENTITLEMENT_LABELS.RECORDS_REMAINING}</span>
          )}
          {isUnlimited && (
            <span>{ENTITLEMENT_LABELS.UNLIMITED}</span>
          )}
        </div>

        {/* Warning state */}
        {isNearLimit && !isUnlimited && (
          <div className="flex items-center justify-between gap-2 text-xs rounded-lg bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {percentUsed !== null && percentUsed >= 100
                  ? ENTITLEMENT_LABELS.QUOTA_REACHED_TITLE
                  : ENTITLEMENT_LABELS.QUOTA_NEAR_LIMIT}
              </span>
            </div>
            <Link to={ROUTES.BILLING}>
              <Button variant="outline" size="sm" className="h-6 text-xs">
                {USAGE_LABELS.UPGRADE_CTA}
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
