/**
 * Attestation Status Card (SCRUM-1874)
 *
 * Displays the current status of an attestation with appropriate
 * color coding, icon, description, and metadata. Used in both the
 * attestation detail panel and the public verification page.
 *
 * Statuses: DRAFT | PENDING | ACTIVE | REVOKED | EXPIRED | CHALLENGED
 */

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle,
  Clock,
  Ban,
  XCircle,
  AlertTriangle,
  FileCheck,
} from 'lucide-react';
import { ATTESTATION_LABELS } from '@/lib/copy';

type AttestationStatus = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'CHALLENGED';

interface StatusConfig {
  icon: typeof CheckCircle;
  color: string;
  bg: string;
  label: string;
  description: string;
}

const STATUS_MAP: Record<AttestationStatus, StatusConfig> = {
  DRAFT: {
    icon: Clock,
    color: 'text-muted-foreground',
    bg: 'bg-muted border-border',
    label: ATTESTATION_LABELS.STATUS_DRAFT,
    description: ATTESTATION_LABELS.STATUS_DRAFT_DESC,
  },
  PENDING: {
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    label: ATTESTATION_LABELS.STATUS_PENDING,
    description: ATTESTATION_LABELS.STATUS_PENDING_DESC,
  },
  ACTIVE: {
    icon: CheckCircle,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    label: ATTESTATION_LABELS.STATUS_ACTIVE,
    description: ATTESTATION_LABELS.STATUS_ACTIVE_DESC,
  },
  REVOKED: {
    icon: Ban,
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/20',
    label: ATTESTATION_LABELS.STATUS_REVOKED,
    description: ATTESTATION_LABELS.STATUS_REVOKED_DESC,
  },
  EXPIRED: {
    icon: XCircle,
    color: 'text-muted-foreground',
    bg: 'bg-muted border-border',
    label: ATTESTATION_LABELS.STATUS_EXPIRED,
    description: ATTESTATION_LABELS.STATUS_EXPIRED_DESC,
  },
  CHALLENGED: {
    icon: AlertTriangle,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    label: ATTESTATION_LABELS.STATUS_CHALLENGED,
    description: ATTESTATION_LABELS.STATUS_CHALLENGED_DESC,
  },
};

interface AttestationStatusCardProps {
  status: string;
  publicId?: string;
  attestationType?: string;
}

export function AttestationStatusCard({
  status,
  publicId,
  attestationType,
}: AttestationStatusCardProps) {
  const config = STATUS_MAP[status as AttestationStatus] ?? STATUS_MAP.PENDING;
  const Icon = config.icon;

  return (
    <Card className={`border ${config.bg}`}>
      <CardContent className="py-5">
        <div className="flex items-center gap-2 mb-3">
          <FileCheck className="h-4 w-4 text-[#00d4ff]" />
          <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold font-mono">
            {ATTESTATION_LABELS.STATUS_CARD_TITLE}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className={`flex h-12 w-12 items-center justify-center rounded-sm ${config.bg}`}>
            <Icon className={`h-6 w-6 ${config.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className={`font-bold text-lg ${config.color}`}>{config.label}</p>
              {attestationType && (
                <Badge variant="secondary" className="text-[10px]">
                  {attestationType}
                </Badge>
              )}
            </div>
            <p className="text-sm text-[#bbc9cf]">{config.description}</p>
            {publicId && (
              <p className="text-xs text-[#bbc9cf] mt-1">
                <code className="font-mono text-[#00d4ff]">{publicId}</code>
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
