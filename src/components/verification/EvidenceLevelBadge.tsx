/**
 * Evidence Level Badge (CSI-03 / SCRUM-1599; honesty hardened SCRUM-2481)
 *
 * Displays the verification_level of a credential source import with an
 * appropriate label, icon, colour treatment, and per-tier alt/aria text.
 *
 * SCRUM-2481 honesty guarantees (structural, not cosmetic):
 * - The green "issuer-verified" treatment is routed EXCLUSIVELY through
 *   isIssuerAuthenticated(). Only `issuer_anchored` and `source_signed` earn
 *   green. `account_linked` / `captured_url` / `ai_captured` can NEVER render
 *   the green treatment or any issuer-family wording.
 * - Every tier carries a distinct `data-evidence-tier` and a distinct,
 *   honest `aria-label` describing what it DID and did NOT verify.
 * - The icon fallback is exhaustive for known tiers (a known tier always
 *   resolves its own icon); the defensive `Shield` fallback is only reachable
 *   for a genuinely unknown tier, which is already null-guarded above and never
 *   renders issuer wording.
 *
 * Levels (strongest to weakest):
 * - Issuer Anchored (green, issuer-authenticated)
 * - Source Signed (green, issuer-authenticated)
 * - Account Linked (blue, NOT issuer-authenticated)
 * - Captured URL Evidence (amber, NOT issuer-authenticated)
 * - AI-Captured Evidence (amber, NOT issuer-authenticated)
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
  isIssuerAuthenticated,
  getEvidenceLevelStrength,
  parseVerificationLevel,
  type VerificationLevel,
} from '@/lib/sourceProvenance';

interface EvidenceLevelBadgeProps {
  level: VerificationLevel | string | null | undefined;
  showDescription?: boolean;
  className?: string;
}

const LEVEL_ICON: Record<VerificationLevel, React.ElementType> = {
  issuer_anchored: ShieldCheck,
  source_signed: Shield,
  account_linked: Link2,
  captured_url: Globe,
  ai_captured: Sparkles,
};

/**
 * Per-tier alt / aria text. Local-const fallback (SCRUM-2481 FE-D): the
 * canonical strings will move into a titled additive block in `src/lib/copy.ts`
 * once the copy.ts-touching soaking PRs merge; until then these live here so the
 * component ships without a functional dependency on that copy.ts land.
 *
 * HONESTY INVARIANT: the three non-issuer tiers must contain NO issuer-family
 * wording ("Verified" / "Issuer" / "Authenticated"). Enforced by test.
 */
const TIER_ALT_FALLBACK: Record<VerificationLevel, string> = {
  issuer_anchored:
    'Issuer Anchored: authenticated directly by the issuing organization.',
  source_signed:
    'Source Signed: the credential source cryptographically signed this record, proving issuer origin.',
  account_linked:
    'Account Linked: imported from a connected account. Proves account access only; the originating organization did not vouch for this record.',
  captured_url:
    'Captured URL Evidence: fetched from a public web page. Records what was captured, not who published it.',
  ai_captured:
    'AI-Captured Evidence: extracted by AI from an uploaded document. Content parsed automatically; source identity not established.',
};

function getBadgeClasses(level: VerificationLevel | string | null | undefined): string {
  if (!parseVerificationLevel(level)) return '';
  // SCRUM-2481: green is reserved for issuer-authenticated tiers ONLY.
  if (isIssuerAuthenticated(level)) {
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
  const tier = parseVerificationLevel(level);
  const label = getEvidenceLevelLabel(level);
  // Unknown / null / undefined tiers render nothing — the defensive icon and
  // class fallbacks below are therefore never reached with issuer wording.
  if (!tier || !label) return null;

  const description = getEvidenceLevelDescription(tier);
  // Exhaustive for known tiers; `Shield` is only a defensive fallback.
  const Icon = LEVEL_ICON[tier] ?? Shield;
  const altText = TIER_ALT_FALLBACK[tier];

  const badgeElement = (
    <Badge
      variant="outline"
      className={`gap-1 text-xs ${getBadgeClasses(tier)} ${className ?? ''}`}
      data-testid="evidence-level-badge"
      data-evidence-tier={tier}
      aria-label={altText}
      title={altText}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
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
