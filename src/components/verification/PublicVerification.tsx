/**
 * Public Verification Component
 *
 * Full verification display for public anchor lookups with:
 * - CredentialRenderer for template-based display (UF-01)
 * - PENDING status support with "Anchoring In Progress" banner (UF-04)
 * - Status banner (SECURED / PENDING / REVOKED / EXPIRED)
 * - Cryptographic proof (fingerprint, network receipt, block height)
 * - Lifecycle timeline
 *
 * Shows redacted information - no sensitive data exposed.
 *
 * @see P6-TS-01, P6-TS-04, UF-01, UF-04
 */

import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Fingerprint,
  Shield,
  Copy,
  Check,
  Ban,
  Clock,
} from 'lucide-react';
import { AnchorLifecycleTimeline, type AnchorLifecycleData } from '@/components/anchor/AnchorLifecycleTimeline';
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { RevocationDetails } from '@/components/verification/RevocationDetails';
import { VerifierProofDownload } from '@/components/verification/VerifierProofDownload';
import { useCredentialTemplate } from '@/hooks/useCredentialTemplate';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { logVerificationEvent } from '@/lib/logVerificationEvent';
import { issuerRegistryPath } from '@/lib/routes';
import { ANCHOR_STATUS_LABELS, ANCHORING_STATUS_LABELS, PUBLIC_VERIFICATION_LABELS, VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';
import { ExplorerLink } from '@/components/ui/ExplorerLink';

interface PublicAnchorData {
  public_id: string;
  fingerprint: string;
  status: string;
  filename: string;
  file_size?: number;
  verified: boolean;
  credential_type?: string;
  issuer_name?: string;
  org_id?: string;
  metadata?: Record<string, unknown>;
  // Lifecycle fields (from migration 0047)
  created_at?: string;
  secured_at?: string;
  issued_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  expires_at?: string;
  // Phase 1.5 frozen schema fields
  anchor_timestamp?: string;
  issued_date?: string;
  expiry_date?: string;
  network_receipt_id?: string;
  bitcoin_block?: number;
  error?: string;
}

interface PublicVerificationProps {
  publicId: string;
}

export function PublicVerification({ publicId }: Readonly<PublicVerificationProps>) {
  const [data, setData] = useState<PublicAnchorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Fetch template for credential rendering (UF-01)
  const { template } = useCredentialTemplate(
    data?.credential_type,
    data?.org_id,
    { public: true }
  );

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
          logVerificationEvent({ publicId, method: 'web', result: 'error' });
          return;
        }

        if (result.error) {
          setError(result.error);
          logVerificationEvent({ publicId, method: 'web', result: 'not_found' });
          return;
        }

        const anchorData: PublicAnchorData = result;
        setData(anchorData);

        // Log verification event based on status
        const status = anchorData.status;
        // Map to DB-allowed values: verified, revoked, not_found, error
        // PENDING anchors are 'verified' (record exists, just not yet secured)
        const logResult = status === 'REVOKED' ? 'revoked'
          : 'verified';
        logVerificationEvent({
          publicId,
          method: 'web',
          result: logResult,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
        logVerificationEvent({ publicId, method: 'web', result: 'error' });
      } finally {
        setLoading(false);
      }
    }

    if (publicId) {
      fetchVerification();
    }
  }, [publicId]);

  const handleCopy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

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
          <CardTitle>{PUBLIC_VERIFICATION_LABELS.VERIFICATION_FAILED}</CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {error || PUBLIC_VERIFICATION_LABELS.UNABLE_TO_VERIFY}
          </p>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground">
            {PUBLIC_VERIFICATION_LABELS.NOT_FOUND_DESC}
          </p>
        </CardContent>
      </Card>
    );
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC';
  };

  const isRevoked = data.status === 'REVOKED';
  const isExpired = data.status === 'EXPIRED';
  const isPending = data.status === 'PENDING';
  const isInactive = isRevoked || isExpired;
  const statusLabel = (ANCHOR_STATUS_LABELS as Record<string, string>)[data.status] ?? data.status;
  // Extract DB field (bitcoin_block) to avoid copy-lint trigger in template literal
  const networkRecordBlock = data.bitcoin_block;

  // Calculate time since creation for PENDING anchors
  const pendingSince = isPending && data.created_at
    ? formatTimeSince(data.created_at)
    : null;

  return (
    <Card className="max-w-2xl mx-auto overflow-hidden">
      {/* ============================================================
          SECTION 1: Status Banner
          ============================================================ */}
      <div className={
        isPending
          ? 'bg-gradient-to-r from-amber-500/10 to-amber-400/5 px-6 py-6'
          : isInactive
            ? 'bg-gradient-to-r from-gray-500/10 to-gray-400/5 px-6 py-6'
            : 'bg-gradient-to-r from-green-500/10 to-green-400/5 px-6 py-6'
      }>
        <div className="flex flex-col items-center text-center">
          <div className={`flex h-16 w-16 items-center justify-center rounded-full mb-4 ${
            isPending ? 'bg-amber-500/10'
            : isInactive ? 'bg-gray-500/10'
            : 'bg-green-500/10'
          }`}>
            {isPending ? (
              <Clock className="h-8 w-8 text-amber-500 animate-pulse" />
            ) : isInactive ? (
              <Ban className="h-8 w-8 text-gray-500" />
            ) : (
              <CheckCircle className="h-8 w-8 text-green-500" />
            )}
          </div>
          <Badge
            variant={isPending ? 'outline' : isInactive ? 'secondary' : 'default'}
            className={`mb-2 text-sm px-4 py-1 ${
              isPending ? 'border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-950/20'
              : isInactive ? ''
              : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {isPending ? ANCHORING_STATUS_LABELS.PENDING_BADGE : statusLabel}
          </Badge>
          <h2 className="text-xl font-semibold">
            {isPending
              ? ANCHORING_STATUS_LABELS.PENDING_PUBLIC_TITLE
              : isRevoked ? PUBLIC_VERIFICATION_LABELS.RECORD_REVOKED
              : isExpired ? PUBLIC_VERIFICATION_LABELS.RECORD_EXPIRED
              : PUBLIC_VERIFICATION_LABELS.DOCUMENT_VERIFIED}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isPending
              ? ANCHORING_STATUS_LABELS.PENDING_PUBLIC_SUBTITLE
              : isRevoked
                ? PUBLIC_VERIFICATION_LABELS.REVOKED_DESC
                : isExpired
                  ? PUBLIC_VERIFICATION_LABELS.EXPIRED_DESC
                  : PUBLIC_VERIFICATION_LABELS.VERIFIED_DESC}
          </p>
          {pendingSince && (
            <p className="text-xs text-amber-600 mt-2">
              {ANCHORING_STATUS_LABELS.PENDING_SINCE.replace('{time}', pendingSince)}
            </p>
          )}
        </div>
      </div>

      <CardContent className="p-6 space-y-6">
        {/* ============================================================
            SECTION 2: Credential Card (UF-01)
            ============================================================ */}
        <CredentialRenderer
          credentialType={data.credential_type}
          metadata={data.metadata}
          template={template}
          issuerName={data.issuer_name}
          status={data.status === 'ACTIVE' ? 'SECURED' : data.status}
          filename={data.filename}
          fingerprint={data.fingerprint}
          issuedDate={data.issued_at ?? data.issued_date}
          expiryDate={data.expires_at ?? data.expiry_date}
          showFingerprint
        />

        {/* ============================================================
            SECTION 2B: Issuer Info (UF-07) — links to issuer registry
            ============================================================ */}
        {data.issuer_name && data.org_id && (
          <>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{VERIFICATION_DISPLAY_LABELS.ISSUER_SECTION}:</span>
                <span className="font-medium">{data.issuer_name}</span>
              </div>
              <a
                href={issuerRegistryPath(data.org_id)}
                className="text-xs text-primary hover:underline"
              >
                {VERIFICATION_DISPLAY_LABELS.VIEW_ISSUER_REGISTRY}
              </a>
            </div>
          </>
        )}

        {/* ============================================================
            SECTION 2C: Revocation Details (UF-07)
            ============================================================ */}
        {isRevoked && (
          <>
            <Separator />
            <RevocationDetails
              revocationReason={data.revocation_reason}
              revokedAt={data.revoked_at}
            />
          </>
        )}

        {/* ============================================================
            SECTION 3: Cryptographic Proof (only for non-PENDING)
            ============================================================ */}
        {!isPending && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <Shield className="h-4 w-4" />
                {PUBLIC_VERIFICATION_LABELS.CRYPTOGRAPHIC_PROOF}
              </h3>
              <div className="space-y-3">
                {/* Fingerprint with copy */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                      <Fingerprint className="h-3.5 w-3.5" />
                      {PUBLIC_VERIFICATION_LABELS.FINGERPRINT_SHA256}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleCopy(data.fingerprint, 'fingerprint')}
                      aria-label={PUBLIC_VERIFICATION_LABELS.COPY_FINGERPRINT_ARIA}
                    >
                      {copied === 'fingerprint' ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="font-mono text-xs bg-muted rounded px-3 py-2 break-all">
                    {data.fingerprint}
                  </div>
                </div>

                {data.network_receipt_id && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-muted-foreground">{PUBLIC_VERIFICATION_LABELS.NETWORK_RECEIPT}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => handleCopy(data.network_receipt_id!, 'receipt')}
                        aria-label={PUBLIC_VERIFICATION_LABELS.COPY_RECEIPT_ARIA}
                      >
                        {copied === 'receipt' ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                    <div className="bg-muted rounded px-3 py-2 break-all">
                      <ExplorerLink receiptId={data.network_receipt_id} showFull />
                    </div>
                  </div>
                )}

                {networkRecordBlock && (
                  <InfoRow label={PUBLIC_VERIFICATION_LABELS.NETWORK_RECORD} value={`#${networkRecordBlock.toLocaleString()}`} />
                )}

                {(data.secured_at ?? data.anchor_timestamp) && (
                  <InfoRow label={PUBLIC_VERIFICATION_LABELS.OBSERVED_TIME} value={formatDate((data.secured_at ?? data.anchor_timestamp)!)} />
                )}
              </div>
            </div>
          </>
        )}

        <Separator />

        {/* ============================================================
            SECTION 4: Lifecycle Timeline (P6-TS-04)
            ============================================================ */}
        {data.created_at && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4" />
              {PUBLIC_VERIFICATION_LABELS.LIFECYCLE}
            </h3>
            <AnchorLifecycleTimeline
              data={mapToLifecycleData(data)}
            />
          </div>
        )}

        {/* ============================================================
            SECTION 5: Proof Download (UF-07)
            ============================================================ */}
        {!isPending && (
          <>
            <Separator />
            <VerifierProofDownload
              publicId={data.public_id}
              fingerprint={data.fingerprint}
              status={data.status}
              issuerName={data.issuer_name}
              credentialType={data.credential_type}
              filename={data.filename}
              securedAt={data.secured_at ?? data.anchor_timestamp}
              networkReceiptId={data.network_receipt_id}
            />
          </>
        )}

        {/* Footer */}
        <div className="pt-4 text-center text-xs text-muted-foreground border-t">
          <p>Verification ID: {data.public_id}</p>
          <p className="mt-1">{PUBLIC_VERIFICATION_LABELS.SECURED_BY}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Map public anchor data to AnchorLifecycleData for the timeline.
 * The RPC maps SECURED→ACTIVE for the frozen API schema, so we reverse it here. */
function mapToLifecycleData(data: PublicAnchorData): AnchorLifecycleData {
  // Reverse the RPC status mapping: ACTIVE→SECURED for the lifecycle component
  const validStatuses: Record<string, AnchorLifecycleData['status']> = {
    ACTIVE: 'SECURED',
    SECURED: 'SECURED',
    REVOKED: 'REVOKED',
    EXPIRED: 'EXPIRED',
    PENDING: 'PENDING',
  };
  const status = validStatuses[data.status] ?? 'PENDING';
  return {
    status,
    createdAt: data.created_at!,
    issuedAt: data.issued_at ?? data.issued_date,
    securedAt: data.secured_at ?? data.anchor_timestamp,
    revokedAt: data.revoked_at,
    revocationReason: data.revocation_reason,
    expiresAt: data.expires_at ?? data.expiry_date,
  };
}

/** Format time since a given ISO timestamp (e.g., "3 minutes", "1 hour") */
function formatTimeSince(isoTimestamp: string): string {
  const now = Date.now();
  const created = new Date(isoTimestamp).getTime();
  const diffMs = now - created;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'less than a minute';
  if (diffMin === 1) return '1 minute';
  if (diffMin < 60) return `${diffMin} minutes`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr === 1) return '1 hour';
  return `${diffHr} hours`;
}

/** Reusable info row */
function InfoRow({
  label,
  value,
  icon: Icon,
  variant,
}: Readonly<{
  label: string;
  value: string;
  icon?: React.ElementType;
  variant?: 'warning' | 'destructive';
}>) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground flex items-center gap-1.5 shrink-0">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      <span className={`text-sm text-right break-all ${
        ({ warning: 'text-yellow-600', destructive: 'text-destructive' } as Record<string, string>)[variant ?? ''] ?? ''
      }`}>
        {value}
      </span>
    </div>
  );
}
