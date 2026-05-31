/**
 * NasbaStatusBadge (SCRUM-1856 / CPE-R1-1)
 *
 * Standalone badge for a credential's NASBA (National Association of State
 * Boards of Accountancy) registry status. Three visual states:
 *   - confirmed  → green   ("NASBA Registered")
 *   - unknown    → amber   ("NASBA Status Unknown")
 *   - not_found  → red     ("Not in NASBA Registry")
 *
 * A small info affordance surfaces the legal disclaimer. The disclaimer text
 * is sourced from {@link CPE_COMPLIANCE_COPY} — never hardcoded inline — and is
 * exposed both visually (hover/focus tooltip) and to assistive tech (an
 * always-present visually-hidden description wired via aria-describedby), so it
 * is reachable without simulating a hover.
 *
 * @see SCRUM-1847, SCRUM-1856
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
import { CPE_COMPLIANCE_COPY, type NasbaStatus } from './cpeComplianceCopy';

export interface NasbaStatusBadgeProps {
  status: NasbaStatus;
  /** Compact variant for table rows: label only, no info/disclaimer affordance. */
  compact?: boolean;
  className?: string;
}

/** Per-state color treatment. Green / amber / red, each visually distinct. */
const STATUS_STYLES: Record<NasbaStatus, string> = {
  confirmed:
    'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  unknown:
    'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  not_found:
    'bg-red-500/15 text-red-400 border border-red-500/30',
};

export function NasbaStatusBadge({
  status,
  compact = false,
  className = '',
}: Readonly<NasbaStatusBadgeProps>) {
  const describedById = useId();
  const label = CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS[status];

  const badge = (
    <Badge
      data-nasba-status={status}
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
              aria-label={CPE_COMPLIANCE_COPY.NASBA_TOOLTIP_ARIA}
              aria-describedby={describedById}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[#859398] hover:text-[#00d4ff] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]/40"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{CPE_COMPLIANCE_COPY.NASBA_DISCLAIMER}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Always-present accessible description: screen readers announce the
          disclaimer via aria-describedby; visually hidden for sighted users
          who get it through the hover/focus tooltip above. */}
      <span id={describedById} className="sr-only">
        {CPE_COMPLIANCE_COPY.NASBA_DISCLAIMER}
      </span>
    </span>
  );
}
