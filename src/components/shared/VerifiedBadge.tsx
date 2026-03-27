/**
 * Verified Badge Components (IDT WS1/WS3/WS4)
 *
 * Reusable verified badges for users, organizations, and anchor trust labels.
 * Per IDT spec, trust signal varies by source type.
 */

import { CheckCircle, ShieldCheck, Building2, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Individual verified badge — shown next to user names */
export function UserVerifiedBadge({ className }: { className?: string }) {
  return (
    <Badge
      className={`bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs gap-1 ${className ?? ''}`}
      title="Identity verified via government ID and liveness check"
    >
      <CheckCircle className="h-3 w-3" />
      Verified
    </Badge>
  );
}

/** Organization verified badge — shown next to org names */
export function OrgVerifiedBadge({ className }: { className?: string }) {
  return (
    <Badge
      className={`bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs gap-1 ${className ?? ''}`}
      title="EIN/Tax ID confirmed, domain verified"
    >
      <ShieldCheck className="h-3 w-3" />
      Verified Organization
    </Badge>
  );
}

/** Affiliated sub-org badge */
export function AffiliatedBadge({
  parentName,
  className,
}: {
  parentName: string;
  className?: string;
}) {
  return (
    <Badge
      className={`bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs gap-1 ${className ?? ''}`}
      title={`Affiliated with ${parentName}`}
    >
      <Link2 className="h-3 w-3" />
      Affiliated
    </Badge>
  );
}

/**
 * Anchor Trust Label (IDT WS3)
 *
 * Shows issuer trust level on anchor/credential displays.
 */
export type TrustLevel = 'verified_org' | 'affiliated' | 'verified_individual' | 'unverified_org' | 'unverified_individual';

interface AnchorTrustLabelProps {
  level: TrustLevel;
  issuerName?: string;
  parentOrgName?: string;
}

const TRUST_CONFIG: Record<TrustLevel, {
  label: string;
  badgeClass: string;
  icon: typeof ShieldCheck;
}> = {
  verified_org: {
    label: 'Verified Issuer',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    icon: ShieldCheck,
  },
  affiliated: {
    label: 'Affiliated Issuer',
    badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    icon: Link2,
  },
  verified_individual: {
    label: 'Verified Issuer',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    icon: CheckCircle,
  },
  unverified_org: {
    label: 'Unverified Issuer',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    icon: Building2,
  },
  unverified_individual: {
    label: 'Unverified Issuer',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    icon: Building2,
  },
};

export function AnchorTrustLabel({ level, issuerName, parentOrgName }: AnchorTrustLabelProps) {
  const config = TRUST_CONFIG[level];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-2">
      <Badge className={`${config.badgeClass} text-xs gap-1`}>
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
      {issuerName && (
        <span className="text-xs text-muted-foreground">{issuerName}</span>
      )}
      {level === 'affiliated' && parentOrgName && (
        <span className="text-xs text-muted-foreground">
          (affiliated with {parentOrgName})
        </span>
      )}
    </div>
  );
}

/**
 * Helper to determine trust level from profile/org data.
 */
export function getTrustLevel(opts: {
  isOrg: boolean;
  orgVerified: boolean;
  isAffiliated?: boolean;
  userVerified: boolean;
}): TrustLevel {
  if (opts.isOrg) {
    if (opts.orgVerified) return 'verified_org';
    if (opts.isAffiliated) return 'affiliated';
    return 'unverified_org';
  }
  if (opts.userVerified) return 'verified_individual';
  return 'unverified_individual';
}
