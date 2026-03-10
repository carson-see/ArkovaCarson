/**
 * Public Verification Component
 *
 * Displays verification status for public anchor lookups.
 * Shows the 5-section spec: Status, Credential, Timeline, Proof, Document.
 * No sensitive data exposed — recipient_identifier is pre-hashed by the RPC.
 */

import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  FileText,
  Clock,
  Shield,
  Building,
  User,
  Award,
  Calendar,
  Link as LinkIcon,
  Copy,
  MapPin,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabase';
import { VERIFICATION_LABELS, CREDENTIAL_TYPE_LABELS } from '@/lib/copy';

interface PublicAnchorData {
  verified: boolean;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SUPERSEDED';
  issuer_name: string;
  recipient_identifier: string;
  credential_type: string;
  issued_date: string | null;
  expiry_date: string | null;
  anchor_timestamp: string | null;
  bitcoin_block: number | null;
  network_receipt_id: string | null;
  merkle_proof_hash: string | null;
  record_uri: string;
  jurisdiction?: string;
  // Additional UI fields (not in API frozen schema)
  public_id: string;
  fingerprint: string;
  filename: string;
  file_size: number | null;
  error?: string;
}

interface PublicVerificationProps {
  publicId: string;
}

const STATUS_CONFIG = {
  ACTIVE: {
    label: VERIFICATION_LABELS.STATUS_ACTIVE,
    description: VERIFICATION_LABELS.ACTIVE_DESC,
    icon: CheckCircle,
    badgeClass: 'bg-success text-success-foreground',
    iconClass: 'text-success',
    bgClass: 'bg-success/10',
  },
  REVOKED: {
    label: VERIFICATION_LABELS.STATUS_REVOKED,
    description: VERIFICATION_LABELS.REVOKED_DESC,
    icon: XCircle,
    badgeClass: 'bg-muted text-muted-foreground',
    iconClass: 'text-muted-foreground',
    bgClass: 'bg-muted',
  },
  EXPIRED: {
    label: VERIFICATION_LABELS.STATUS_EXPIRED,
    description: VERIFICATION_LABELS.EXPIRED_DESC,
    icon: AlertTriangle,
    badgeClass: 'bg-muted text-muted-foreground',
    iconClass: 'text-muted-foreground',
    bgClass: 'bg-muted',
  },
  SUPERSEDED: {
    label: VERIFICATION_LABELS.STATUS_SUPERSEDED,
    description: VERIFICATION_LABELS.SUPERSEDED_DESC,
    icon: AlertTriangle,
    badgeClass: 'bg-warning text-warning-foreground',
    iconClass: 'text-warning',
    bgClass: 'bg-warning/10',
  },
} as const;

export function PublicVerification({ publicId }: PublicVerificationProps) {
  const [data, setData] = useState<PublicAnchorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function fetchVerification() {
      setLoading(true);
      setError(null);

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: result, error: rpcError } = await (supabase.rpc as any)(
          'get_public_anchor',
          { p_public_id: publicId }
        );

        if (rpcError) {
          setError(rpcError.message);
          return;
        }

        if (result.error) {
          setError(result.error);
          return;
        }

        setData(result as PublicAnchorData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
      } finally {
        setLoading(false);
      }
    }

    if (publicId) {
      fetchVerification();
    }
  }, [publicId]);

  if (loading) {
    return (
      <Card className="max-w-2xl mx-auto">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="max-w-2xl mx-auto">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-4">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <CardTitle>{VERIFICATION_LABELS.NOT_FOUND_TITLE}</CardTitle>
          <CardDescription>
            {error || VERIFICATION_LABELS.NOT_FOUND_DESC}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const statusConfig = STATUS_CONFIG[data.status] || STATUS_CONFIG.ACTIVE;
  const StatusIcon = statusConfig.icon;

  const credentialTypeLabel =
    CREDENTIAL_TYPE_LABELS[data.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ||
    data.credential_type;

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(data.record_uri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="max-w-2xl mx-auto">
      {/* ─── Section 1: Verification Status ─── */}
      <CardHeader className="text-center pb-4">
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${statusConfig.bgClass} mb-4`}>
          <StatusIcon className={`h-8 w-8 ${statusConfig.iconClass}`} />
        </div>
        <Badge variant="default" className={`mx-auto mb-2 ${statusConfig.badgeClass}`}>
          {statusConfig.label}
        </Badge>
        <CardTitle>{data.verified ? 'Credential Verified' : `Credential ${statusConfig.label}`}</CardTitle>
        <CardDescription>{statusConfig.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ─── Section 2: Credential Details ─── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {VERIFICATION_LABELS.SECTION_CREDENTIAL}
          </h3>
          <div className="space-y-3">
            <InfoRow
              icon={<Building className="h-4 w-4" />}
              label={VERIFICATION_LABELS.ISSUER}
              value={data.issuer_name}
            />
            <InfoRow
              icon={<Award className="h-4 w-4" />}
              label={VERIFICATION_LABELS.CREDENTIAL_TYPE}
              value={credentialTypeLabel}
            />
            {data.recipient_identifier && (
              <InfoRow
                icon={<User className="h-4 w-4" />}
                label={VERIFICATION_LABELS.RECIPIENT_ID}
                value={data.recipient_identifier}
                mono
                hint={VERIFICATION_LABELS.RECIPIENT_HASH_NOTE}
              />
            )}
            {data.jurisdiction && (
              <InfoRow
                icon={<MapPin className="h-4 w-4" />}
                label={VERIFICATION_LABELS.JURISDICTION}
                value={data.jurisdiction}
              />
            )}
          </div>
        </div>

        <Separator />

        {/* ─── Section 3: Timeline ─── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {VERIFICATION_LABELS.SECTION_TIMELINE}
          </h3>
          <div className="space-y-3">
            {data.issued_date && (
              <InfoRow
                icon={<Calendar className="h-4 w-4" />}
                label={VERIFICATION_LABELS.ISSUED_DATE}
                value={formatDate(data.issued_date)}
              />
            )}
            {data.expiry_date && (
              <InfoRow
                icon={<Calendar className="h-4 w-4" />}
                label={VERIFICATION_LABELS.EXPIRY_DATE}
                value={formatDate(data.expiry_date)}
              />
            )}
            {data.anchor_timestamp && (
              <InfoRow
                icon={<Clock className="h-4 w-4" />}
                label={VERIFICATION_LABELS.ANCHOR_TIMESTAMP}
                value={formatDate(data.anchor_timestamp)}
              />
            )}
          </div>
        </div>

        <Separator />

        {/* ─── Section 4: Network Proof ─── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {VERIFICATION_LABELS.SECTION_PROOF}
          </h3>
          <div className="space-y-3">
            {data.network_receipt_id && (
              <InfoRow
                icon={<Shield className="h-4 w-4" />}
                label={VERIFICATION_LABELS.NETWORK_RECEIPT}
                value={data.network_receipt_id}
                mono
              />
            )}
            {data.bitcoin_block && (
              <InfoRow
                icon={<Shield className="h-4 w-4" />}
                label="Network Record"
                value={`#${data.bitcoin_block.toLocaleString()}`}
              />
            )}
            {data.merkle_proof_hash && (
              <InfoRow
                icon={<Shield className="h-4 w-4" />}
                label={VERIFICATION_LABELS.PROOF_FINGERPRINT}
                value={data.merkle_proof_hash}
                mono
              />
            )}
          </div>
        </div>

        <Separator />

        {/* ─── Section 5: Document Information ─── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {VERIFICATION_LABELS.SECTION_DOCUMENT}
          </h3>
          <div className="space-y-3">
            <InfoRow
              icon={<FileText className="h-4 w-4" />}
              label={VERIFICATION_LABELS.FILENAME}
              value={data.filename}
            />
            <InfoRow
              icon={<Shield className="h-4 w-4" />}
              label={VERIFICATION_LABELS.FINGERPRINT}
              value={data.fingerprint}
              mono
            />
            {data.file_size && (
              <InfoRow
                icon={<FileText className="h-4 w-4" />}
                label={VERIFICATION_LABELS.FILE_SIZE}
                value={formatFileSize(data.file_size)}
              />
            )}
          </div>
        </div>

        <Separator />

        {/* ─── Verification Link + Footer ─── */}
        <div className="flex items-center justify-between gap-2 p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <LinkIcon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate">
              {data.record_uri}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyLink}
            className="shrink-0"
          >
            <Copy className="h-3 w-3 mr-1" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <div className="text-center text-xs text-muted-foreground space-y-1">
          <p>{VERIFICATION_LABELS.VERIFICATION_ID}: {data.public_id}</p>
          <p>{VERIFICATION_LABELS.SECURED_BY}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Helper Components ───

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}

function InfoRow({ icon, label, value, mono, hint }: InfoRowProps) {
  return (
    <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className={`text-sm text-muted-foreground break-all ${mono ? 'font-mono text-xs' : ''}`}>
          {value}
        </p>
        {hint && (
          <p className="text-xs text-muted-foreground/70 mt-0.5 italic">{hint}</p>
        )}
      </div>
    </div>
  );
}

// ─── Formatting Helpers ───

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
