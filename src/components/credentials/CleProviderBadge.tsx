/**
 * CleProviderBadge (SCRUM-1869 / CLE-R1)
 *
 * Standalone badge for a CLE (Continuing Legal Education) credential's provider
 * approval status, as looked up against Arkova's reference registry. Three
 * visual states:
 *   - approved     → green   ("Approved Provider")
 *   - unknown      → amber   ("Provider Status Unknown")
 *   - not_approved → red     ("Provider Not Approved")
 *
 * A small info affordance surfaces the legal disclaimer. The disclaimer text is
 * sourced from {@link CLE_COMPLIANCE_COPY} — never hardcoded inline — and is
 * exposed both visually (hover/focus tooltip) and to assistive tech (an
 * always-present visually-hidden description wired via aria-describedby), so it
 * is reachable without simulating a hover.
 *
 * Mirrors the NasbaStatusBadge pattern (SCRUM-1856 / CPE-R1-1).
 *
 * @see SCRUM-1869, SCRUM-1856
 */

import { useId } from 'react';
import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { CLE_COMPLIANCE_COPY, type CleProviderApprovalStatus } from './cleComplianceCopy';

export interface CleProviderBadgeProps {
  status: CleProviderApprovalStatus;
  /** Compact variant for table rows: label only, no info/disclaimer affordance. */
  compact?: boolean;
  className?: string;
}

/** Per-state color treatment. Green / amber / red, each visually distinct. */
const STATUS_STYLES: Record<CleProviderApprovalStatus, string> = {
  approved:
    'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  unknown:
    'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  not_approved:
    'bg-red-500/15 text-red-400 border border-red-500/30',
};

export function CleProviderBadge({
  status,
  compact = false,
  className = '',
}: Readonly<CleProviderBadgeProps>) {
  const describedById = useId();
  const label = CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS[status];

  const badge = (
    <Badge
      data-cle-provider-status={status}
      className={`${STATUS_STYLES[status]} ${className}`}
    >
      {label}
    </Badge>
  );

  if (compact) {
    return badge;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {badge}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={CLE_COMPLIANCE_COPY.PROVIDER_TOOLTIP_ARIA}
              aria-describedby={describedById}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[#859398] hover:text-[#00d4ff] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]/40"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{CLE_COMPLIANCE_COPY.PROVIDER_DISCLAIMER}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Always-present accessible description: screen readers announce the
          disclaimer via aria-describedby; visually hidden for sighted users
          who get it through the hover/focus tooltip above. */}
      <span id={describedById} className="sr-only">
        {CLE_COMPLIANCE_COPY.PROVIDER_DISCLAIMER}
      </span>
    </span>
  );
}
