/**
 * API Usage Dashboard Widget (P4.5-TS-10)
 *
 * Displays Verification API usage for the current billing period.
 * Shows total usage, per-key breakdown, and quota progress.
 */

import { Loader2, BarChart3 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { API_KEY_LABELS } from '@/lib/copy';
import type { ApiUsageData } from '@/hooks/useApiKeys';

interface ApiUsageDashboardProps {
  usage: ApiUsageData | null;
  loading?: boolean;
  error?: string | null;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function UsageBar({ used, limit }: { used: number; limit: number | 'unlimited' }) {
  if (limit === 'unlimited') {
    return (
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span>{formatNumber(used)} {API_KEY_LABELS.REQUESTS_USED}</span>
          <span className="text-muted-foreground">{API_KEY_LABELS.UNLIMITED_TIER}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-primary/40 w-1/4" />
        </div>
      </div>
    );
  }

  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remaining = Math.max(0, limit - used);
  const isWarning = percent >= 80;
  const isOver = percent >= 100;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span>{formatNumber(used)} / {formatNumber(limit)}</span>
        <span className="text-muted-foreground">
          {formatNumber(remaining)} {API_KEY_LABELS.REQUESTS_REMAINING}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOver ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-primary'
          }`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}

export function ApiUsageDashboard({
  usage,
  loading = false,
  error = null,
}: ApiUsageDashboardProps) {
  if (loading) {
    return (
      <Card className="shadow-card-rest">
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    // BUG-UAT5-04: the usage card previously rendered the raw error string
    // for any un-classified error — which leaked internal wording (e.g.
    // "Ensure the worker service is running"). Match known categories,
    // then fall back to a clean generic copy. The raw error still lands
    // in the console for triage.
    const lc = error.toLowerCase();
    const isNetworkError = lc.includes('failed to fetch') || lc.includes('networkerror');
    const isAuthError = lc.includes('authentication') || lc.includes('401') || lc.includes('unauthorized');
    if (!isNetworkError && !isAuthError) {
      console.error('[ApiUsageDashboard] unclassified usage error:', error);
    }
    const friendlyMessage = isNetworkError
      ? API_KEY_LABELS.USAGE_UNAVAILABLE
      : isAuthError
        ? API_KEY_LABELS.USAGE_CREATE_KEY_HINT
        : API_KEY_LABELS.USAGE_UNAVAILABLE;
    return (
      <Card className="shadow-card-rest">
        <CardContent className="py-8">
          <div className="flex flex-col items-center text-center gap-2">
            <BarChart3 className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-muted-foreground">
              {friendlyMessage}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!usage) return null;

  const resetDate = new Date(usage.reset_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Card className="shadow-card-rest hover:shadow-card-hover transition-all animate-in-view">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 p-2">
            <BarChart3 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">{API_KEY_LABELS.USAGE_TITLE}</CardTitle>
            <CardDescription>{API_KEY_LABELS.USAGE_DESCRIPTION}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <UsageBar used={usage.used} limit={usage.limit} />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{API_KEY_LABELS.MONTHLY_LIMIT}: {usage.limit === 'unlimited' ? API_KEY_LABELS.UNLIMITED_TIER : formatNumber(usage.limit as number)}</span>
          <span>{API_KEY_LABELS.RESET_DATE} {resetDate}</span>
        </div>

        {usage.keys.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {API_KEY_LABELS.PER_KEY_BREAKDOWN}
            </h4>
            <div className="space-y-2">
              {usage.keys.map((k) => (
                <div key={k.key_prefix} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs bg-muted rounded px-2 py-0.5">
                      {k.key_prefix}
                    </span>
                    <span className="text-muted-foreground">{k.name}</span>
                  </div>
                  <span className="font-medium">{formatNumber(k.used)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
