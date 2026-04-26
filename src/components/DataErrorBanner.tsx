/**
 * DataErrorBanner — admin-dashboard error banner for data-fetch failures.
 *
 * Extracted during the SCRUM-1260 (R1-6) /simplify pass after the same amber
 * "warn + retry" banner shape appeared three times in the new R1-6 code:
 *   - PipelineAdminPage stats banner (`statsError`)
 *   - PipelineAdminPage records banner (`recordsError`)
 *   - X402PaymentStats x402 banner (`error`)
 *
 * Centralising the shape ensures the three banners stay visually consistent
 * (CLAUDE.md §1.3 — UI consistency) and the retry contract (button + spinner
 * gating) is enforced rather than re-implemented per call site.
 *
 * Note this is dashboard-internal and intentionally amber/warn coloured —
 * the failures are recoverable (retry button) and the data behind them is
 * non-load-bearing for end users.
 */

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DATA_ERROR_LABELS } from '@/lib/copy';

export interface DataErrorBannerProps {
  /** Bold first line. Use the constants exported from `DATA_ERROR_LABELS`. */
  title: string;
  /** Smaller body line — usually the raw error message from the catch site. */
  message: string;
  /** Optional trailing text appended after `message` (e.g. "— showing last successful values."). */
  trailingMessage?: string;
  /** Show a Retry button when set. Omit for fatal/no-retry banners. */
  onRetry?: () => void;
  /** Disables the retry button + spins the icon while a retry is in flight. */
  retrying?: boolean;
  /** Test id passed through for Playwright/UAT selectors. */
  'data-testid'?: string;
  /** Adds a margin-bottom (matches the pre-extraction PipelineAdminPage record-banner spacing). */
  spacing?: 'none' | 'mb-3';
}

export function DataErrorBanner({
  title,
  message,
  trailingMessage,
  onRetry,
  retrying = false,
  'data-testid': testId,
  spacing = 'none',
}: DataErrorBannerProps) {
  return (
    <div
      role="alert"
      className={[
        spacing === 'mb-3' ? 'mb-3 ' : '',
        'flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100',
      ].join('')}
      data-testid={testId}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-amber-200/80">
          {message}
          {trailingMessage ?? ''}
        </div>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="h-7 border-amber-400/40 text-amber-100 hover:bg-amber-400/10"
        >
          <RefreshCw className={`mr-1 h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
          {DATA_ERROR_LABELS.RETRY}
        </Button>
      )}
    </div>
  );
}
