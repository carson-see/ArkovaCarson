/**
 * Public Verification Component
 *
 * Full verification display for public anchor lookups with:
 * - CredentialRenderer for template-based display (UF-01)
 * - PENDING / SUBMITTED pre-secured banners with amber clock + status-specific copy (UF-04, SCRUM-952)
 * - Status banner (PENDING / SUBMITTED / SECURED / REVOKED / EXPIRED) — SUBMITTED ≠ SECURED
 * - Cryptographic proof (fingerprint, network receipt, block height) — terminal proof states only
 * - Lifecycle timeline
 *
 * Shows redacted information - no sensitive data exposed.
 *
 * @see P6-TS-01, P6-TS-04, UF-01, UF-04, SCRUM-952
 */

import { useState, useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { CheckCircle, XCircle, Fingerprint, Copy, Check, Ban, Clock, Flag, AlertTriangle } from 'lucide-react';
import { AnchorLifecycleTimeline, type AnchorLifecycleData } from '@/components/anchor/AnchorLifecycleTimeline';
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { ProvenanceTimeline } from '@/components/public/ProvenanceTimeline';
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
import {
  hasPublicVerificationProof,
  isPreSecuredStatus,
  normalizePublicVerificationStatus,
  type PublicVerificationStatus,
} from '@/lib/publicVerificationState';
import { ExplorerLink } from '@/components/ui/ExplorerLink';
import { ComplianceBadge } from '@/components/anchor/ComplianceBadge';
import { EvidenceLayersSection } from '@/components/verification/EvidenceLayersSection';
import { SourceProvenanceDisplay } from '@/components/verification/SourceProvenanceDisplay';
import { LinkedInCredentialHelper } from '@/components/verification/LinkedInCredentialHelper';
import { parseVerificationLevel, sanitizeSourceUrl, type SourceProvenanceData } from '@/lib/sourceProvenance';

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
  /** BETA-11: Explorer URL */
  explorer_url?: string;
  /** BETA-11: Explorer URL */
  tx_id?: string;
  /** COMP-01: Jurisdiction for eIDAS legal effect */
  jurisdiction?: string;
  /** BETA-12: Immutable description */
  description?: string;
  /** CSI-03: Source provenance fields */
  source_url?: string;
  source_provider?: string;
  verification_level?: string;
  evidence_package_hash?: string;
  source_payload_hash?: string;
  fetched_at?: string;
  error?: string;
}

interface PublicVerificationProps {
  publicId: string;
}

const PUBLIC_METADATA_HIDDEN_KEYS = new Set([
  'recipient',
  'email',
  'phone',
  'phone_number',
  'ssn',
  'social_security',
  'student_id',
  'student_number',
  'address',
  'street_address',
  'home_address',
  'mailing_address',
  'dob',
  'date_of_birth',
  'birthday',
  'national_id',
  'passport_number',
  'drivers_license',
  'source_url',
  'source_provider',
  'verification_level',
  'evidence_package_hash',
  'source_payload_hash',
  'fetched_at',
  'source_fetched_at',
]);

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
        const { data: result, error: rpcError } = await (supabase as any).rpc(
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
      <Card className="max-w-2xl mx-auto overflow-hidden">
        {/* Skeleton status banner */}
        <div className="bg-gradient-to-r from-primary/5 to-primary/10 px-6 py-6">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-full bg-muted/60 shimmer mb-4" />
            <div className="h-6 w-24 rounded-full bg-muted/60 shimmer mb-2" />
            <div className="h-6 w-48 rounded bg-muted/60 shimmer mb-1" />
            <div className="h-4 w-64 rounded bg-muted/40 shimmer" />
          </div>
        </div>
        <CardContent className="p-6 space-y-6">
          {/* Skeleton credential card */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="h-5 w-32 rounded bg-muted/60 shimmer" />
            <div className="h-4 w-full rounded bg-muted/40 shimmer" />
            <div className="h-4 w-3/4 rounded bg-muted/40 shimmer" />
          </div>
          <Separator />
          {/* Skeleton cryptographic proof */}
          <div className="space-y-3">
            <div className="h-4 w-40 rounded bg-muted/60 shimmer" />
            <div className="h-10 w-full rounded bg-muted/40 shimmer" />
            <div className="h-4 w-48 rounded bg-muted/40 shimmer" />
          </div>
          <Separator />
          {/* Skeleton lifecycle */}
          <div className="space-y-3">
            <div className="h-4 w-36 rounded bg-muted/60 shimmer" />
            <div className="flex gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 w-20 rounded bg-muted/40 shimmer" />
              ))}
            </div>
          </div>
          <Separator />
          {/* Skeleton proof download */}
          <div className="space-y-3">
            <div className="h-4 w-32 rounded bg-muted/60 shimmer" />
            <div className="h-10 w-full rounded bg-muted/40 shimmer" />
          </div>
          {/* Skeleton footer */}
          <div className="border-t pt-4 space-y-2">
            <div className="mx-auto h-3 w-32 rounded bg-muted/40 shimmer" />
            <div className="mx-auto h-3 w-24 rounded bg-muted/40 shimmer" />
          </div>
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

  const publicStatus = normalizePublicVerificationStatus(data.status);
  const isRevoked = publicStatus === 'REVOKED';
  const isExpired = publicStatus === 'EXPIRED';
  const isSuperseded = publicStatus === 'SUPERSEDED';
  const isPending = publicStatus === 'PENDING';
  const isSubmitted = publicStatus === 'SUBMITTED';
  const isSecured = publicStatus === 'SECURED';
  const isAwaitingConfirmation = isPreSecuredStatus(publicStatus);
  const hasProof = hasPublicVerificationProof(publicStatus);
  const securedAt = data.secured_at ?? data.anchor_timestamp;
  const statusLabel = ANCHOR_STATUS_LABELS[publicStatus];
  // Extract DB field (bitcoin_block) to avoid copy-lint trigger in template literal
  const networkRecordBlock = data.bitcoin_block;
  const sourceProvenance = extractSourceProvenance(data);
  const credentialMetadata = sanitizeCredentialMetadata(data.metadata);
  const hasSourceProvenance = Boolean(
    sanitizeSourceUrl(sourceProvenance.source_url) ||
    sourceProvenance.source_provider ||
    sourceProvenance.verification_level ||
    sourceProvenance.fetched_at
  );

  // Calculate time since creation for not-yet-secured anchors. PENDING +
  // SUBMITTED both render the "awaiting confirmation" hero so reuse that
  // boolean here (SCRUM-952 split SUBMITTED into a distinct UI state but
  // the time-since copy is the same for both).
  const pendingSince = isAwaitingConfirmation && data.created_at
    ? formatTimeSince(data.created_at)
    : null;
  const heroTitle = getHeroTitle(publicStatus, securedAt, formatDate);
  const heroSubtitle = getHeroSubtitle(publicStatus);
  let statusBadgeVariant: 'default' | 'secondary' | 'outline' = 'default';
  let statusBadgeClassName = 'bg-green-600 hover:bg-green-700';
  let statusBadgeLabel: string = statusLabel;

  if (isAwaitingConfirmation || isExpired) {
    statusBadgeVariant = 'outline';
    statusBadgeClassName = 'border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-950/20';
  } else if (isRevoked || isSuperseded) {
    statusBadgeVariant = 'secondary';
    statusBadgeClassName = '';
  }

  if (isSubmitted) {
    statusBadgeLabel = ANCHORING_STATUS_LABELS.SUBMITTED_BADGE;
  } else if (isPending) {
    statusBadgeLabel = ANCHORING_STATUS_LABELS.PENDING_BADGE;
  }

  return (
    <Card className="max-w-2xl mx-auto overflow-hidden">
      {/* ============================================================
          SECTION 1: Status Banner
          ============================================================ */}
      <div className={
        isAwaitingConfirmation
          ? 'bg-gradient-to-r from-amber-500/10 to-amber-400/5 px-6 py-6'
          : isExpired
            ? 'bg-gradient-to-r from-amber-500/10 to-amber-400/5 px-6 py-6'
            : isRevoked || isSuperseded
              ? 'bg-gradient-to-r from-gray-500/10 to-gray-400/5 px-6 py-6'
              : 'bg-gradient-to-r from-green-500/10 to-green-400/5 px-6 py-6'
      }>
        <div className="flex flex-col items-center text-center">
          <div className={`flex h-16 w-16 items-center justify-center rounded-full mb-4 ${
            isAwaitingConfirmation ? 'bg-amber-500/10'
            : isExpired ? 'bg-amber-500/10'
            : isRevoked || isSuperseded ? 'bg-gray-500/10'
            : 'bg-green-500/10'
          }`}>
            {isPending ? (
              <Clock className="h-8 w-8 text-amber-500 animate-pulse" />
            ) : isSubmitted ? (
              <Clock className="h-8 w-8 text-amber-500" />
            ) : isExpired ? (
              <Clock className="h-8 w-8 text-amber-500" />
            ) : isRevoked ? (
              <Ban className="h-8 w-8 text-gray-500" />
            ) : isSuperseded ? (
              <XCircle className="h-8 w-8 text-gray-500" />
            ) : (
              <CheckCircle className="h-8 w-8 text-green-500" />
            )}
          </div>
          <Badge
            variant={statusBadgeVariant}
            className={`mb-2 text-sm px-4 py-1 ${statusBadgeClassName}`}
          >
            {statusBadgeLabel}
          </Badge>
          <h2 className="text-xl font-semibold">
            {heroTitle}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {heroSubtitle}
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
          metadata={credentialMetadata}
          template={template}
          issuerName={data.issuer_name}
          status={publicStatus}
          filename={data.filename}
          fingerprint={data.fingerprint}
          issuedDate={data.issued_at ?? data.issued_date}
          expiryDate={data.expires_at ?? data.expiry_date}
          showFingerprint
        />

        {/* SECTION 2A: Description (BETA-12) */}
        {data.description && (
          <>
            <Separator />
            <div className="space-y-1">
              <p className="text-sm font-medium">Description</p>
              <p className="text-sm text-muted-foreground break-words">{data.description}</p>
            </div>
          </>
        )}

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
            SECTION 2D: Compliance Controls (CML-01)
            ============================================================ */}
        {(isSecured || isRevoked) && (
          <>
            <Separator />
            <ComplianceBadge
              credentialType={data.credential_type}
              isSecured={true}
              compact={false}
            />
          </>
        )}

        {/* ============================================================
            SECTION 2b: Evidence Layers (COMP-01)
            ============================================================ */}
        {hasProof && (
          <>
            <Separator />
            <EvidenceLayersSection
              layers={[
                { type: 'anchor', present: true, timestamp: securedAt, detail: data.network_receipt_id ? `${PUBLIC_VERIFICATION_LABELS.NETWORK_RECORD_PREFIX}${data.network_receipt_id.substring(0, 16)}...` : undefined },
                { type: 'signature', present: false },
                { type: 'timestamp', present: false },
              ]}
            />
          </>
        )}

        {/* ============================================================
            SECTION 2e: Source Provenance (CSI-03)
            ============================================================ */}
        {hasSourceProvenance && (
          <>
            <Separator />
            <SourceProvenanceDisplay data={sourceProvenance} />
          </>
        )}

        {/* ============================================================
            SECTION 2f: LinkedIn Share (CSI-03)
            ============================================================ */}
        {isSecured && (
          <>
            <Separator />
            <LinkedInCredentialHelper publicId={data.public_id} />
          </>
        )}

        {/* ============================================================
            SECTION 3: Cryptographic Proof (terminal proof states only)
            ============================================================ */}
        {hasProof && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <ArkovaIcon className="h-4 w-4" />
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
              <ArkovaIcon className="h-4 w-4" />
              {PUBLIC_VERIFICATION_LABELS.LIFECYCLE}
            </h3>
            <AnchorLifecycleTimeline
              data={mapToLifecycleData(data)}
            />
          </div>
        )}

        {/* ============================================================
            SECTION 4b: Provenance Timeline (COMP-02)
            ============================================================ */}
        <ProvenanceTimeline publicId={data.public_id} />

        {/* ============================================================
            SECTION 5: Proof Download (UF-07 + CSI-03 enrichment)
            ============================================================ */}
        {hasProof && (
          <>
            <Separator />
            <VerifierProofDownload
              publicId={data.public_id}
              fingerprint={data.fingerprint}
              status={publicStatus}
              issuerName={data.issuer_name}
              credentialType={data.credential_type}
              filename={data.filename}
              securedAt={data.secured_at ?? data.anchor_timestamp}
              networkReceiptId={data.network_receipt_id}
              sourceProvenance={sourceProvenance}
            />
          </>
        )}

        {/* ============================================================
            SECTION 6: Anchor Authenticity Disclaimer (IDT WS3)
            ============================================================ */}
        <Separator />
        <div className="rounded-lg bg-muted/50 border border-border p-4 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Verification Disclaimer
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Arkova verifies that a document&apos;s cryptographic fingerprint was anchored to the
                Bitcoin blockchain at the stated time. Arkova does not verify, and makes no
                representation regarding, the accuracy, authenticity, or legitimacy of the underlying
                document content. For anchors created by unverified or individual accounts, the
                identity of the anchoring party has not been independently confirmed by Arkova.
                Relying parties should exercise their own due diligence.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 text-center text-xs text-muted-foreground border-t">
          <p>Verification ID: {data.public_id}</p>
          <p className="mt-1">{PUBLIC_VERIFICATION_LABELS.SECURED_BY}</p>
          <a
            href={`mailto:support@arkova.ai?subject=${encodeURIComponent(PUBLIC_VERIFICATION_LABELS.REPORT_ISSUE_SUBJECT + ': ' + data.public_id)}`}
            className="inline-flex items-center gap-1 mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Flag className="h-3 w-3" />
            {PUBLIC_VERIFICATION_LABELS.REPORT_ISSUE}
          </a>
        </div>
      </CardContent>

      {/* JSON-LD: EducationalOccupationalCredential (GEO schema markup) */}
      <CredentialJsonLd data={data} />
    </Card>
  );
}

/** Map public anchor data to AnchorLifecycleData for the timeline.
 * The RPC maps SECURED→ACTIVE for the frozen API schema, so we reverse it here. */
function mapToLifecycleData(data: PublicAnchorData): AnchorLifecycleData {
  const status = normalizePublicVerificationStatus(data.status);
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

function extractSourceProvenance(data: PublicAnchorData): SourceProvenanceData {
  const metadata = data.metadata ?? {};
  const verificationLevel = parseVerificationLevel(
    data.verification_level ?? metadata.verification_level
  );

  return {
    source_url: sanitizeSourceUrl(firstString(data.source_url, metadata.source_url)),
    source_provider: firstString(data.source_provider, metadata.source_provider),
    verification_level: verificationLevel,
    evidence_package_hash: firstString(data.evidence_package_hash, metadata.evidence_package_hash),
    source_payload_hash: firstString(data.source_payload_hash, metadata.source_payload_hash),
    fetched_at: firstString(data.fetched_at, metadata.fetched_at, metadata.source_fetched_at),
  };
}

function sanitizeCredentialMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return metadata;

  const safeEntries = Object.entries(metadata).filter(([key]) => {
    const normalizedKey = key.toLowerCase();
    return !PUBLIC_METADATA_HIDDEN_KEYS.has(normalizedKey) && !normalizedKey.startsWith('source_');
  });

  return Object.fromEntries(safeEntries);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function getHeroTitle(
  status: PublicVerificationStatus,
  securedAt: string | undefined,
  formatDate: (dateStr: string) => string,
): string {
  if (status === 'SUBMITTED') return ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_TITLE;
  if (status === 'PENDING') return ANCHORING_STATUS_LABELS.PENDING_PUBLIC_TITLE;
  if (status === 'REVOKED') return PUBLIC_VERIFICATION_LABELS.RECORD_REVOKED;
  if (status === 'EXPIRED') return PUBLIC_VERIFICATION_LABELS.RECORD_EXPIRED;
  if (status === 'SUPERSEDED') return PUBLIC_VERIFICATION_LABELS.RECORD_SUPERSEDED;
  if (securedAt) {
    return PUBLIC_VERIFICATION_LABELS.VERIFIED_ON.replace('{date}', formatDate(securedAt));
  }
  return PUBLIC_VERIFICATION_LABELS.DOCUMENT_VERIFIED;
}

function getHeroSubtitle(status: PublicVerificationStatus): string {
  if (status === 'SUBMITTED') return ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_SUBTITLE;
  if (status === 'PENDING') return ANCHORING_STATUS_LABELS.PENDING_PUBLIC_SUBTITLE;
  if (status === 'REVOKED') return PUBLIC_VERIFICATION_LABELS.REVOKED_DESC;
  if (status === 'EXPIRED') return PUBLIC_VERIFICATION_LABELS.EXPIRED_DESC;
  if (status === 'SUPERSEDED') return PUBLIC_VERIFICATION_LABELS.SUPERSEDED_DESC;
  return PUBLIC_VERIFICATION_LABELS.VERIFIED_DESC;
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

/** Inject EducationalOccupationalCredential JSON-LD for AI search discoverability */
function CredentialJsonLd({ data }: Readonly<{ data: PublicAnchorData }>) {
  const credentialType = data.credential_type ?? 'Document';
  const isEducational = ['DIPLOMA', 'CERTIFICATE', 'TRANSCRIPT', 'DEGREE'].includes(credentialType);

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': isEducational ? 'EducationalOccupationalCredential' : 'CreativeWork',
    'name': data.filename,
    'credentialCategory': credentialType.toLowerCase().replace(/_/g, ' '),
    'url': `https://app.arkova.ai/verify/${data.public_id}`,
    'identifier': data.public_id,
  };

  if (data.issuer_name) {
    jsonLd.recognizedBy = {
      '@type': 'Organization',
      'name': data.issuer_name,
    };
  }

  if (data.issued_at ?? data.issued_date) {
    jsonLd.dateCreated = data.issued_at ?? data.issued_date;
  }

  if (data.expires_at ?? data.expiry_date) {
    jsonLd.expires = data.expires_at ?? data.expiry_date;
  }

  if (normalizePublicVerificationStatus(data.status) === 'SECURED') {
    jsonLd.additionalProperty = {
      '@type': 'PropertyValue',
      'name': 'verificationStatus',
      'value': 'verified',
    };
  }

  // Escape </script> sequences to prevent XSS breakout from JSON-LD
  const safeJson = JSON.stringify(jsonLd).replace(/<\//g, '<\\/');

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  );
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
      <span className={`text-sm text-right break-words ${
        ({ warning: 'text-yellow-600', destructive: 'text-destructive' } as Record<string, string>)[variant ?? ''] ?? ''
      }`}>
        {value}
      </span>
    </div>
  );
}
