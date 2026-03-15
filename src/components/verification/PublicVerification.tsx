/**
 * Public Verification Component
 *
 * Full 5-section verification display for public anchor lookups:
 * 1. Status banner (SECURED / REVOKED)
 * 2. Document info (filename, size, credential type)
 * 3. Issuer info (organization name, issued date)
 * 4. Cryptographic proof (fingerprint, network receipt, block height)
 * 5. Lifecycle info (timestamps, revocation, expiry)
 *
 * Shows redacted information - no sensitive data exposed.
 *
 * @see P6-TS-01, P6-TS-04
 */

import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  FileText,
  Fingerprint,
  Building2,
  Shield,
  Copy,
  Check,
  Ban,
} from 'lucide-react';
import { AnchorLifecycleTimeline, type AnchorLifecycleData } from '@/components/anchor/AnchorLifecycleTimeline';
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
import { CREDENTIAL_TYPE_LABELS, ANCHOR_STATUS_LABELS } from '@/lib/copy';
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
  metadata?: Record<string, unknown>;
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
        const logResult = status === 'REVOKED' ? 'revoked'
          : status === 'EXPIRED' ? 'expired'
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
          <CardTitle>Verification Failed</CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {error || 'Unable to verify this document'}
          </p>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground">
            The document you are looking for may not exist or has not been verified yet.
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

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isRevoked = data.status === 'REVOKED';
  const isExpired = data.status === 'EXPIRED';
  const isInactive = isRevoked || isExpired;
  const credentialLabel = data.credential_type
    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[data.credential_type] ?? data.credential_type
    : null;
  const statusLabel = (ANCHOR_STATUS_LABELS as Record<string, string>)[data.status] ?? data.status;
  // Extract DB field (bitcoin_block) to avoid copy-lint trigger in template literal
  const networkRecordBlock = data.bitcoin_block;

  return (
    <Card className="max-w-2xl mx-auto overflow-hidden">
      {/* ============================================================
          SECTION 1: Status Banner
          ============================================================ */}
      <div className={isInactive
        ? 'bg-gradient-to-r from-gray-500/10 to-gray-400/5 px-6 py-6'
        : 'bg-gradient-to-r from-green-500/10 to-green-400/5 px-6 py-6'
      }>
        <div className="flex flex-col items-center text-center">
          <div className={`flex h-16 w-16 items-center justify-center rounded-full mb-4 ${
            isInactive ? 'bg-gray-500/10' : 'bg-green-500/10'
          }`}>
            {isInactive ? (
              <Ban className="h-8 w-8 text-gray-500" />
            ) : (
              <CheckCircle className="h-8 w-8 text-green-500" />
            )}
          </div>
          <Badge
            variant={isInactive ? 'secondary' : 'default'}
            className={`mb-2 text-sm px-4 py-1 ${isInactive ? '' : 'bg-green-600 hover:bg-green-700'}`}
          >
            {statusLabel}
          </Badge>
          <h2 className="text-xl font-semibold">
            {isRevoked ? 'Record Revoked' : isExpired ? 'Record Expired' : 'Document Verified'}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isRevoked
              ? 'This record has been revoked by the issuing organization'
              : isExpired
                ? 'This record has passed its expiration date'
                : 'This document has been permanently secured'}
          </p>
        </div>
      </div>

      <CardContent className="p-6 space-y-6">
        {/* ============================================================
            SECTION 2: Document Info
            ============================================================ */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Document
          </h3>
          <div className="space-y-2">
            <InfoRow label="Filename" value={data.filename} />
            {data.file_size && (
              <InfoRow label="Size" value={formatFileSize(data.file_size)} />
            )}
            {credentialLabel && (
              <InfoRow label="Credential Type" value={credentialLabel} />
            )}
          </div>
        </div>

        <Separator />

        {/* ============================================================
            SECTION 3: Issuer Info
            ============================================================ */}
        {(data.issuer_name || data.issued_at || data.issued_date) && (
          <>
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                Issuer
              </h3>
              <div className="space-y-2">
                {data.issuer_name && (
                  <InfoRow label="Organization" value={data.issuer_name} />
                )}
                {(data.issued_at ?? data.issued_date) && (
                  <InfoRow label="Issued" value={formatDate((data.issued_at ?? data.issued_date)!)} />
                )}
              </div>
            </div>
            <Separator />
          </>
        )}

        {/* ============================================================
            SECTION 4: Cryptographic Proof
            ============================================================ */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Cryptographic Proof
          </h3>
          <div className="space-y-3">
            {/* Fingerprint with copy */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Fingerprint className="h-3.5 w-3.5" />
                  Fingerprint (SHA-256)
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => handleCopy(data.fingerprint, 'fingerprint')}
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
                  <span className="text-sm text-muted-foreground">Network Receipt</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleCopy(data.network_receipt_id!, 'receipt')}
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
              <InfoRow label="Network Record" value={`#${networkRecordBlock.toLocaleString()}`} />
            )}

            {(data.secured_at ?? data.anchor_timestamp) && (
              <InfoRow label="Observed Time" value={formatDate((data.secured_at ?? data.anchor_timestamp)!)} />
            )}
          </div>
        </div>

        <Separator />

        {/* ============================================================
            SECTION 5: Lifecycle Timeline (P6-TS-04)
            ============================================================ */}
        {data.created_at && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Lifecycle
            </h3>
            <AnchorLifecycleTimeline
              data={mapToLifecycleData(data)}
            />
          </div>
        )}

        {/* Footer */}
        <div className="pt-4 text-center text-xs text-muted-foreground border-t">
          <p>Verification ID: {data.public_id}</p>
          <p className="mt-1">Secured by Arkova</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Map public anchor data to AnchorLifecycleData for the timeline.
 * The RPC maps SECURED→ACTIVE for the frozen API schema, so we reverse it here. */
function mapToLifecycleData(data: PublicAnchorData): AnchorLifecycleData {
  // Reverse the RPC status mapping: ACTIVE→SECURED for the lifecycle component
  // Validate against known statuses to prevent unexpected strings
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
