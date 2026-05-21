/**
 * Evidence Level Badge (CSI-03 / SCRUM-1599)
 *
 * Displays the verification_level of a credential source import
 * with an appropriate label and color treatment.
 *
 * Levels (strongest to weakest):
 * - Issuer Anchored (green)
 * - Source Signed (green)
 * - Account Linked (blue)
 * - Captured URL Evidence (amber)
 * - AI-Captured Evidence (amber)
 */

import { Shield, ShieldCheck, Link2, Globe, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { SOURCE_PROVENANCE_LABELS } from '@/lib/copy';
import {
  getEvidenceLevelLabel,
  getEvidenceLevelDescription,
  isStrongEvidence,
  getEvidenceLevelStrength,
  type VerificationLevel,
} from '@/lib/sourceProvenance';

interface EvidenceLevelBadgeProps {
  level: VerificationLevel | string | null | undefined;
  showDescription?: boolean;
  className?: string;
}

const LEVEL_ICON: Record<string, React.ElementType> = {
  issuer_anchored: ShieldCheck,
  source_signed: Shield,
  account_linked: Link2,
  captured_url: Globe,
  ai_captured: Sparkles,
};

function getBadgeClasses(level: string | null | undefined): string {
  if (!level) return '';
  if (isStrongEvidence(level)) {
    return 'border-green-500 text-green-700 bg-green-50 dark:bg-green-950/20 dark:text-green-400';
  }
  const strength = getEvidenceLevelStrength(level);
  if (strength === 3) {
    return 'border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950/20 dark:text-blue-400';
  }
  return 'border-amber-500 text-amber-700 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400';
}

export function EvidenceLevelBadge({
  level,
  showDescription = false,
  className,
}: Readonly<EvidenceLevelBadgeProps>) {
  const label = getEvidenceLevelLabel(level);
  if (!label) return null;

  const description = getEvidenceLevelDescription(level);
  const Icon = LEVEL_ICON[level as string] ?? Shield;

  const badgeElement = (
    <Badge
      variant="outline"
      className={`gap-1 text-xs ${getBadgeClasses(level)} ${className ?? ''}`}
      data-testid="evidence-level-badge"
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );

  if (showDescription && description) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{SOURCE_PROVENANCE_LABELS.EVIDENCE_LEVEL_LABEL}</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {badgeElement}
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">{description}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    );
  }

  return badgeElement;
}
