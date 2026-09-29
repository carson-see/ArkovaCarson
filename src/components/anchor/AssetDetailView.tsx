/**
 * Asset Detail View
 *
 * Certificate-like anchor details page with re-verification flow.
 */

import { useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { FileText, CheckCircle, XCircle, AlertTriangle, Clock, Copy, Check, RefreshCw, Download, ArrowLeft, Hash, Share2, ExternalLink, GitBranch, Pencil, Ban, ChevronDown } from 'lucide-react';
import { RevokeAnchorModal } from './RevokeAnchorModal';
import { QRCodeSVG } from 'qrcode.react';
import { ComplianceBadge } from './ComplianceBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload } from './FileUpload';
import { ShareSheet } from './ShareSheet';
import { LinkedInShareButton, LinkedInBadgeSnippet } from './LinkedInShare';
import { AnchorLifecycleTimeline } from './AnchorLifecycleTimeline';
import { VerificationWalkthrough } from './VerificationWalkthrough';
import { AnchorDisclaimer } from './AnchorDisclaimer';
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { extractCpeMetadataView } from '@/components/credentials/cpeMetadataView';
import { extractCleMetadataView } from '@/components/credentials/cleMetadataView';
import { SourceProvenanceDisplay } from '@/components/verification/SourceProvenanceDisplay';
import { useCredentialTemplate } from '@/hooks/useCredentialTemplate';
import { formatFingerprint } from '@/lib/fileHasher';
import { ANCHOR_STATUS_LABELS, LIFECYCLE_LABELS, CREDENTIAL_TYPE_LABELS, SHARE_LABELS, EXPLORER_LABELS, FINGERPRINT_TOOLTIP, VERSION_HISTORY_LABELS, RECORDS_LIST_LABELS, RECORD_DETAIL_LABELS, CONFIRMATION_PROGRESS_LABELS, CONNECTOR_FINGERPRINT_LABELS, DOCUSIGN_RECORD_LINKS_LABELS, DRIVE_RECORD_LINKS_LABELS, formatCredentialType, getTemplateDescription } from '@/lib/copy';
import { isConnectorSourcedAnchorMetadata } from '@/lib/connectorFingerprint';
import { sanitizeSourceUrl, type SourceProvenanceData } from '@/lib/sourceProvenance';
import { isFraudMetadataKey } from '@/lib/fraudDetection';
import { accountUrl, envelopeUrl, signerUrl, resolveDocusignEnv, type DocusignEnv } from '@/lib/docusignLinks';
import { fileUrl as driveFileUrl, folderUrl as driveFolderUrl, sharedDriveUrl as driveSharedDriveUrl } from '@/lib/driveLinks';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { verifyUrl, recordDetailPath } from '@/lib/routes';
import { getExplorerBaseUrl } from '@/components/ui/ExplorerLink';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import {
  deriveDisplayTitle,
  deriveDisplayType,
  formatDisplayFileSize,
  formatSourceModifiedTime,
} from '@/lib/recordDisplay';

/** Inline copy button for values */
function CopyButton({ value }: { value: string }) {
  const [justCopied, setJustCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground transition-colors"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setJustCopied(true);
        setTimeout(() => setJustCopied(false), 1500);
      }}
      aria-label="Copy"
    >
      {justCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

interface AnchorRecord {
  id: string;
  publicId?: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'BROADCASTING' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'SUBMITTED' | 'SUPERSEDED' | 'PENDING_RESOLUTION';
  createdAt: string;
  securedAt?: string;
  issuedAt?: string;
  revokedAt?: string;
  supersededAt?: string;
  revocationReason?: string;
  expiresAt?: string;
  fileSize: number;
  fileMime?: string;
  credentialType?: string;
  orgId?: string;
  metadata?: Record<string, unknown> | null;
  /**
   * SCRUM-3818 (docusign-bilateral-2026-08): R19 fingerprint evidence class
   * from `anchors.fingerprint_source` (migration 0376) — 'document_bytes' |
   * 'issuer_record_attestation' | null/undefined (unclassified). Gates
   * whether the connector re-verify caveat below shows the fetch-time note
   * (CONNECTOR_FINGERPRINT_LABELS.REVERIFY_NOTE) or the DECLARED_UNVERIFIED
   * note — never guessed, absent means "not measured".
   */
  fingerprintSource?: string | null;
  /** CPE-R1 (SCRUM-1847): structured CPE metadata, when present on the anchor.
   * Populated from the `cpe_metadata` column by the parent page. */
  cpeMetadata?: Record<string, unknown> | null;
  /** CLE-R1 (SCRUM-1869): structured CLE metadata, when present on the anchor.
   * Populated from the `cle_metadata` column by the parent page. */
  cleMetadata?: Record<string, unknown> | null;
  issuerName?: string;
  /** Chain transaction ID for explorer link (BETA-11) */
  chainTxId?: string | null;
  /** Chain block height (BETA-11) */
  chainBlockHeight?: number | null;
  /** Immutable description set at creation (BETA-12) */
  description?: string | null;
  /** Version number in lineage chain (1 = original) */
  versionNumber?: number;
  /** Parent anchor ID for lineage navigation */
  parentAnchorId?: string | null;
  /**
   * Lineage chain: every version of this record, newest first (see
   * `useAnchorVersions`). `publicId`/`fingerprint` are optional so existing
   * callers that built this array before the readability pass (2026-09-29)
   * still type-check; the version banner and "what changed" panel degrade
   * gracefully (no link / no fingerprint-differs line) when either is absent.
   */
  lineage?: {
    id: string;
    publicId?: string | null;
    versionNumber: number;
    status: string;
    createdAt: string;
    filename: string;
    fingerprint?: string;
  }[];
}

interface AssetDetailViewProps {
  anchor: AnchorRecord;
  onBack?: () => void;
  onDownloadProof?: () => void;
  onDownloadProofJson?: () => void;
  onRenameFile?: (newName: string) => Promise<void>;
  /**
   * SCRUM-1096 — when true, render the "Mark as Revoked" admin action.
   * The parent decides admin eligibility (e.g. profile.role === 'ORG_ADMIN').
   * Server-side `revoke_anchor` RPC is the authoritative permission check.
   */
  canRevoke?: boolean;
  /** Called after a successful revoke so the parent can refresh the anchor. */
  onRevoked?: () => void;
  /**
   * Rename honesty gate (founder-reported, 2026-08-17): only the record OWNER
   * can rename — RLS `anchors_update_own` requires user_id = auth.uid(), and
   * migration 0393's trigger `restrict_org_admin_folder_update` narrows the
   * org-admin update policy to folder_id only. The parent computes ownership
   * (anchor.user_id === auth uid) and passes it here, mirroring how
   * `canRevoke` is parent-computed. Defaults false (fail-closed): without it
   * a non-owner's pencil click yields either a raw 42501 error toast or a
   * silent zero-row false success.
   */
  canRename?: boolean;
  /**
   * CPE-R1 (SCRUM-1847) — whether the viewer holds the
   * `credential_source_import` entitlement. The parent resolves it read-only
   * via `useHasCredentialImportEntitlement` (page-level concern, mirrors how
   * `canRevoke` is parent-computed). When false/omitted the CPE section is
   * suppressed. Defaults false (fail-closed).
   */
  hasImportEntitlement?: boolean;
}

type VerificationState = 'idle' | 'verifying' | 'match' | 'mismatch';

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function buildAnchorSourceProvenance(metadata: Record<string, unknown> | null | undefined): SourceProvenanceData {
  return {
    source_url: metadataString(metadata, 'source_url'),
    source_provider: metadataString(metadata, 'source_provider') ?? metadataString(metadata, 'pipeline_source'),
    verification_level: metadataString(metadata, 'verification_level') as SourceProvenanceData['verification_level'],
    evidence_package_hash: metadataString(metadata, 'evidence_package_hash'),
    source_payload_hash: metadataString(metadata, 'source_payload_hash'),
    fetched_at: metadataString(metadata, 'fetched_at') ?? metadataString(metadata, 'source_fetched_at'),
  };
}

const ANCHOR_CREDENTIAL_METADATA_HIDDEN_KEYS = new Set([
  'pipeline_source',
  'source_url',
  'source_provider',
  'verification_level',
  'evidence_package_hash',
  'source_payload_hash',
  'fetched_at',
  'source_fetched_at',
  'abstract',
  'description',
  'summary',
  'merkle_proof',
  'merkle_root',
  'merkle_index',
  'batch_id',
  'ai_tags',
  'ai_summary',
  'ai_document_type',
  'issuer',
  'issuer_name',
  'recipient',
  'recipient_name',
  '_confidence',
]);

function buildAnchorCredentialMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => isAnchorMetadataVisible(key))
  );
}

function isAnchorMetadataVisible(key: string): boolean {
  // BUG-2026-07-17-010 (SCRUM-2910, P0): fraud_* keys must never render on
  // the owner document detail view.
  return (
    !ANCHOR_CREDENTIAL_METADATA_HIDDEN_KEYS.has(key.toLowerCase()) &&
    !key.startsWith('_') &&
    !isFraudMetadataKey(key)
  );
}

const statusConfig = {
  PENDING: {
    label: 'Pending',
    variant: 'warning' as const,
    icon: Clock,
    color: 'text-yellow-600',
  },
  BROADCASTING: {
    label: 'Pending',
    variant: 'warning' as const,
    icon: Clock,
    color: 'text-yellow-600',
  },
  SECURED: {
    label: 'Secured',
    variant: 'success' as const,
    icon: CheckCircle,
    color: 'text-green-600',
  },
  REVOKED: {
    label: 'Revoked',
    variant: 'destructive' as const,
    icon: XCircle,
    color: 'text-red-600',
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'outline' as const,
    icon: AlertTriangle,
    color: 'text-amber-600',
  },
  SUPERSEDED: {
    label: ANCHOR_STATUS_LABELS.SUPERSEDED,
    variant: 'secondary' as const,
    icon: GitBranch,
    color: 'text-muted-foreground',
  },
  SUBMITTED: {
    label: 'Submitted',
    variant: 'secondary' as const,
    icon: Clock,
    color: 'text-blue-600',
  },
  PENDING_RESOLUTION: {
    label: 'Needs Review',
    variant: 'warning' as const,
    icon: Clock,
    color: 'text-amber-600',
  },
};

type StatusConfigEntry = (typeof statusConfig)[keyof typeof statusConfig];

interface AnchorRecordGridProps {
  anchor: AnchorRecord;
  status: StatusConfigEntry;
  formatDate: (dateString: string) => string;
}

/**
 * The "Anchor Record" 2-column detail grid (status, network receipt, network
 * checkpoint, network-observed/created time, public id, category, template
 * description). Extracted from AssetDetailView's render body so that very large
 * function stays within the cognitive-complexity budget (typescript:S3776);
 * this is pure presentation with no local state and is behavior-identical to
 * the previous inline markup. Includes the BUG-2026-06-24-008 (§1.5)
 * network-observed-time honesty gate.
 */
function AnchorRecordGrid({ anchor, status, formatDate }: Readonly<AnchorRecordGridProps>) {
  let networkReceipt: ReactNode;
  if (anchor.chainTxId) {
    networkReceipt = (
      <div className="flex items-center gap-1.5">
        <a
          href={`${getExplorerBaseUrl()}/tx/${anchor.chainTxId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[#00d4ff] hover:underline font-mono truncate"
        >
          <ExternalLink className="inline h-3 w-3 mr-1" />
          {anchor.chainTxId.slice(0, 16)}…
        </a>
        <CopyButton value={anchor.chainTxId} />
      </div>
    );
  } else {
    let awaitingLabel = '—';
    if (anchor.status === 'SUBMITTED') {
      awaitingLabel = 'Awaiting confirmation';
    } else if (anchor.status === 'PENDING') {
      awaitingLabel = 'Awaiting submission';
    }
    networkReceipt = <p className="text-xs text-amber-500">{awaitingLabel}</p>;
  }

  let statusBadgeClass = '';
  if (anchor.status === 'SECURED') {
    statusBadgeClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
  } else if (anchor.status === 'SUBMITTED') {
    statusBadgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
  }

  // BUG-2026-06-24-008 (§1.5): only label the timestamp "Network Observed Time"
  // once the anchor is SECURED; otherwise show the honest local creation time
  // under a distinct label. Never show createdAt under the network label.
  const observedTimeLabel = anchor.securedAt
    ? RECORDS_LIST_LABELS.NETWORK_OBSERVED_TIME
    : RECORDS_LIST_LABELS.CREATED_TIME;
  const observedTimeValue = anchor.securedAt
    ? formatDate(anchor.securedAt)
    : formatDate(anchor.createdAt);

  const categoryType = formatCredentialType(
    anchor.credentialType ?? (anchor.metadata?.ai_document_type as string | undefined) ?? null,
  );

  return (
    <div className="space-y-4">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Anchor Record</span>
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Status */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Status</p>
          <Badge variant={status.variant} className={`text-xs ${statusBadgeClass}`}>
            {status.label.toUpperCase()}
          </Badge>
        </div>

        {/* Network Receipt */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{EXPLORER_LABELS.NETWORK_RECEIPT}</p>
          {networkReceipt}
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{RECORDS_LIST_LABELS.NETWORK_CHECKPOINT}</p>
          <p className="text-sm font-semibold">
            {anchor.chainBlockHeight ? anchor.chainBlockHeight.toLocaleString() : '—'}
          </p>
        </div>

        {/* Network Observed Time (BUG-2026-06-24-008, §1.5) */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{observedTimeLabel}</p>
          <p className="text-sm">{observedTimeValue}</p>
        </div>

        {/* Public ID */}
        {anchor.publicId && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Public ID</p>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-mono">{anchor.publicId}</span>
              <CopyButton value={anchor.publicId} />
            </div>
          </div>
        )}

        {/* Category — AI-extracted or credential type, fallback to General Record */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Category</p>
          <Badge variant="secondary" className="text-xs font-normal">
            {categoryType === '—' ? 'General Record' : categoryType}
          </Badge>
        </div>

        {/* Template Description — anonymized summary */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Template Description</p>
          <p className="text-sm text-muted-foreground">
            {getTemplateDescription(anchor.credentialType ?? (anchor.metadata?.ai_document_type as string | undefined))}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Which connected system a record came from, for link-rendering purposes.
 *
 * `null` means "no recognised provider" — the overwhelming majority of
 * records, and every record whose metadata was not written by the worker
 * connector pipeline.
 */
type RecordSourceProvider = 'docusign' | 'google_drive' | null;

/**
 * THE forgery gate for every source-specific link on this page (SCRUM-3818 for
 * DocuSign, SCRUM-4507 for Drive). Exact string equality against a closed set
 * — never a prefix, a case-insensitive compare, or a `startsWith`.
 *
 * What makes that equality worth anything: migration 0423 STRIPS
 * `connector_source` from any INSERT by a caller other than `service_role`, and
 * reverts any UPDATE that tampers with it. So on a row written after 0423, the
 * marker can only have come from the worker connector pipeline. Rows written
 * BEFORE 0423 could carry an org-authored marker — which is why what a marker
 * unlocks is bounded to rendering identifiers the org itself supplied, back at
 * the source system the org itself controls. No trust badge, no verification
 * claim, and nothing that reaches a public surface, hangs off this gate.
 */
function resolveRecordSourceProvider(
  metadata: Record<string, unknown> | null | undefined,
): RecordSourceProvider {
  const marker = metadataString(metadata, 'connector_source');
  if (marker === 'docusign') return 'docusign';
  if (marker === 'google_drive') return 'google_drive';
  return null;
}

/**
 * Record source deep links, authenticated record-detail METADATA section only
 * — the public verification page is explicitly out of scope.
 *
 * Maps a generic-metadata-loop key to the builder that owns it, FOR THE
 * RESOLVED PROVIDER. `null`/absent keys fall through to the caller's existing
 * plain-text render — this table can only ever ADD a link, never change what
 * an unrecognised provider or an unrecognised key already shows.
 *
 * SCRUM-4507: `google_drive` maps NO key here on purpose, and that is a
 * decision rather than an omission. Three of Drive's four identifiers are
 * `_`-prefixed and the generic dump hides `_`-prefixed keys by construction
 * (BUG-2026-07-17-010), so a Drive record's links would be split across two
 * sections with no labels and no §1.5 note. They render together in
 * `DriveSourceChips` instead. Routing the decision through this one dispatcher
 * keeps "which provider owns which link" a single, closed, readable answer.
 */
function buildSourceMetadataHref(
  provider: RecordSourceProvider,
  metaKey: string,
  value: unknown,
  docusignEnv: DocusignEnv,
): string | null {
  if (provider !== 'docusign') return null;
  if (metaKey === 'account_id') return accountUrl(value, docusignEnv);
  if (metaKey === 'envelope_id') return envelopeUrl(value, docusignEnv);
  return null;
}

interface DocusignLinkChipProps {
  href: string;
  testId: string;
  children: ReactNode;
}

/**
 * Shared link markup for a DocuSign deep-link value — used by both
 * `MetadataRow` (account_id/envelope_id) and `DocusignSignerRows` (signer
 * GUIDs), which were byte-identical apart from href/data-testid/children.
 * Matches the `CtdlDataLink`/Network-Receipt precedent: `ExternalLink`
 * icon, `target="_blank" rel="noopener noreferrer"`,
 * `text-primary hover:underline font-mono`. Pure markup extraction — no
 * rendering-output change.
 */
function DocusignLinkChip({ href, testId, children }: Readonly<DocusignLinkChipProps>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-primary hover:underline font-mono break-all inline-flex items-center gap-1"
      data-testid={testId}
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

interface MetadataRowProps {
  metaKey: string;
  value: unknown;
  provider: RecordSourceProvider;
  docusignEnv: DocusignEnv;
}

/**
 * One row of the generic "Metadata" pipeline-style dump. When the anchor is
 * DocuSign-sourced (`metadata.connector_source === 'docusign'`), the
 * `account_id`/`envelope_id` rows render as safe deep links into DocuSign's
 * own console — built by `accountUrl`/`envelopeUrl`
 * (`src/lib/docusignLinks.ts`), which validate the value as a strict UUID
 * BEFORE composing any URL and return `null` otherwise. A `null` build
 * (non-UUID value, non-DocuSign anchor, or any other metadata key) always
 * falls back to the pre-existing plain-text render byte-for-byte — this can
 * only ever ADD a link, never change what already renders.
 */
function MetadataRow({ metaKey, value, provider, docusignEnv }: Readonly<MetadataRowProps>) {
  const href = buildSourceMetadataHref(provider, metaKey, value, docusignEnv);
  const testId = metaKey === 'account_id' ? 'docusign-account-link' : 'docusign-envelope-link';
  return (
    <div className="flex gap-4">
      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[120px]">{metaKey.replace(/_/g, ' ')}:</span>
      {href ? (
        <DocusignLinkChip href={href} testId={testId}>
          {String(value)}
        </DocusignLinkChip>
      ) : (
        <span className="text-xs font-mono break-all">
          {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
        </span>
      )}
    </div>
  );
}

/**
 * SCRUM-4507 — Google Drive source link-back.
 *
 * One labelled block holding every Drive identifier a record owner needs to
 * get back to the file this record was secured from, plus the §1.5 statement
 * of what those links do and do NOT assert.
 *
 * WHY A DEDICATED BLOCK rather than links inside the generic metadata dump
 * (which is how the DocuSign account/envelope links render): three of the four
 * identifiers are `_`-prefixed and `isAnchorMetadataVisible` hides every
 * `_`-prefixed key (BUG-2026-07-17-010). Rendering them through the dump would
 * mean either weakening that filter or showing half the block. Neither is
 * worth it for identifiers that read far better together, under labels, with
 * the note attached.
 *
 * EVERY element degrades independently. A malformed or absent id simply omits
 * its chip — `fileUrl`/`folderUrl`/`sharedDriveUrl` return `null` for anything
 * that is not a Drive id, so an injection-shaped value produces no element at
 * all rather than a sanitized one. If nothing is renderable the whole block
 * self-hides, including the note: a §1.5 statement about links that are not on
 * screen would be a claim about nothing.
 */
/**
 * One `label: value` row in the Drive source block.
 *
 * Factored out because all four rows were byte-identical apart from label and
 * body, and the label's class list is load-bearing: `shrink-0` is what stops a
 * `whitespace-nowrap` label wider than its `min-w-[120px]` from overflowing its
 * own flex item and landing on top of the value at narrow viewports
 * (BUG-2026-09-12-001, visible at 375px in this story's own UAT capture).
 * One component means one place that property can be got right — and one place
 * the class ratchet in AssetDetailView.test.tsx has to hold.
 */
interface DriveSourceRowProps {
  label: string;
  children: React.ReactNode;
}

function DriveSourceRow({ label, children }: Readonly<DriveSourceRowProps>) {
  return (
    <div className="flex gap-4">
      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[120px] shrink-0">
        {label}:
      </span>
      {children}
    </div>
  );
}

interface DriveSourceChipsProps {
  metadata: Record<string, unknown> | null | undefined;
}

function DriveSourceChips({ metadata }: Readonly<DriveSourceChipsProps>) {
  const fileHref = driveFileUrl(metadata?.file_id);
  const folderId = metadataString(metadata, '_drive_folder_id');
  const folderHref = driveFolderUrl(folderId);
  const folderPath = metadataString(metadata, '_drive_folder_path');
  const sharedDriveId = metadataString(metadata, '_drive_shared_drive_id');
  const sharedDriveHref = driveSharedDriveUrl(sharedDriveId);
  const revision = metadataString(metadata, 'revision_id');
  // §1.5: `revision_id` is only a real Drive revision when the producer
  // resolved a headRevisionId. For a Workspace-native file it is a synthetic
  // `mtime:`/`evt:` token, so calling it a "revision" would name something
  // Arkova never measured. Anything that is not exactly 'head_revision' —
  // including a legacy record with no kind recorded at all — gets the weaker,
  // true label.
  const revisionKind = metadataString(metadata, '_drive_revision_kind');
  const isHeadRevision = revisionKind === 'head_revision';
  const revisionLabel = isHeadRevision
    ? DRIVE_RECORD_LINKS_LABELS.REVISION_LABEL
    : DRIVE_RECORD_LINKS_LABELS.MODIFIED_TIME_LABEL;
  // Readability pass (founder-reported, 2026-09-29): a non-head-revision value
  // is a synthetic `mtime:`/`evt:` token — strip the internal prefix and show
  // a formatted date/time instead of the raw token. A head_revision value is
  // an opaque Drive revision id, never a time, so it is never reformatted.
  const revisionDisplay = isHeadRevision
    ? revision
    : (revision ? (formatSourceModifiedTime(revision) ?? revision) : revision);

  if (!fileHref && !folderHref && !sharedDriveHref && !revision) return null;

  return (
    <>
      <Separator />
      <div className="space-y-3" data-testid="drive-source-section">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {DRIVE_RECORD_LINKS_LABELS.SECTION_LABEL}
        </span>
        <div className="space-y-2">
          {fileHref && (
            <DriveSourceRow label={DRIVE_RECORD_LINKS_LABELS.FILE_LABEL}>
              <DocusignLinkChip href={fileHref} testId="drive-file-link">
                {DRIVE_RECORD_LINKS_LABELS.OPEN_IN_DRIVE}
              </DocusignLinkChip>
            </DriveSourceRow>
          )}
          {folderHref && (
            <DriveSourceRow label={DRIVE_RECORD_LINKS_LABELS.FOLDER_LABEL}>
              {/* The resolved human path is what an owner recognises; the
                  opaque folder id is the fallback when the path walk never
                  ran or failed. */}
              <DocusignLinkChip href={folderHref} testId="drive-folder-link">
                {folderPath ?? folderId}
              </DocusignLinkChip>
            </DriveSourceRow>
          )}
          {sharedDriveHref && (
            <DriveSourceRow label={DRIVE_RECORD_LINKS_LABELS.SHARED_DRIVE_LABEL}>
              <DocusignLinkChip href={sharedDriveHref} testId="drive-shared-drive-link">
                {sharedDriveId}
              </DocusignLinkChip>
            </DriveSourceRow>
          )}
          {revision && (
            <DriveSourceRow label={revisionLabel}>
              {/* NEVER a link. The stored value is not always a Drive revision
                  id, and the deep-link shape for one has not been verified
                  against the live product — a link that works for some records
                  and 404s for others is worse than plain text. */}
              <span className="text-xs font-mono break-all" data-testid="drive-revision-plain">
                {revisionDisplay}
              </span>
            </DriveSourceRow>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="drive-source-note">
          {DRIVE_RECORD_LINKS_LABELS.SOURCE_NOTE}
        </p>
      </div>
    </>
  );
}

/** UI-side display cap for signer rows — independent of any cap the producer applies. */
const DOCUSIGN_SIGNER_DISPLAY_CAP = 20;

interface DocusignSignerEntry {
  recipient_id_guid: string;
}

/**
 * True for an array entry shaped like a signer with a non-empty
 * `recipient_id_guid` string. Anything else (missing/blank guid, wrong
 * type, null) is dropped rather than rendered with a broken identity.
 */
function isDisplayableSigner(entry: unknown): entry is DocusignSignerEntry {
  if (!entry || typeof entry !== 'object') return false;
  const guid = (entry as { recipient_id_guid?: unknown }).recipient_id_guid;
  return typeof guid === 'string' && guid.trim().length > 0;
}

interface DocusignSignerRowsProps {
  signers: unknown;
  env: DocusignEnv;
}

/**
 * DocuSign record deep links (bilateral rollout, frontend-targeted T2) —
 * dedicated signer rows from `metadata._signers`, deliberately NOT part of
 * the generic metadata-dump loop above. Renders nothing when `_signers` is
 * absent, empty, or contains no displayable entry (every anchor before this
 * rollout, and any anchor from a source other than DocuSign).
 *
 * Data-minimization (ruling R6): only `recipient_id_guid` is ever read —
 * `user_id`, even when present on an entry, is never displayed, logged, or
 * linked. The GUID is shown secondary to the "Signer N · Verified via
 * DocuSign" label and doubles as the link target via `signerUrl` (DocuSign
 * has no per-signer profile URL; the envelope-details page is the only
 * signer-verification surface) — falling back to plain text, exactly like
 * the account/envelope rows, when it fails strict UUID validation.
 *
 * Capped at `DOCUSIGN_SIGNER_DISPLAY_CAP` rows with a "+N more" summary line
 * for the remainder, so a mass-signature envelope can never blow up this
 * page — independent of whatever cap (if any) the producer applies upstream.
 */
function DocusignSignerRows({ signers, env }: Readonly<DocusignSignerRowsProps>) {
  if (!Array.isArray(signers) || signers.length === 0) return null;

  const displayable = signers.filter(isDisplayableSigner);
  if (displayable.length === 0) return null;

  const visible = displayable.slice(0, DOCUSIGN_SIGNER_DISPLAY_CAP);
  const remaining = displayable.length - visible.length;

  return (
    <>
      <Separator />
      <div className="space-y-3" data-testid="docusign-signers-section">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {DOCUSIGN_RECORD_LINKS_LABELS.SIGNERS_SECTION_LABEL}
        </span>
        <div className="space-y-2">
          {visible.map((signer, index) => {
            const guid = signer.recipient_id_guid;
            const href = signerUrl(guid, env);
            return (
              <div key={`${guid}-${index}`} className="space-y-0.5" data-testid="docusign-signer-row">
                <p className="text-xs">
                  {DOCUSIGN_RECORD_LINKS_LABELS.SIGNER_PREFIX} {index + 1} · {DOCUSIGN_RECORD_LINKS_LABELS.VERIFIED_VIA_DOCUSIGN}
                </p>
                {href ? (
                  <DocusignLinkChip href={href} testId={`docusign-signer-link-${index}`}>
                    {guid}
                  </DocusignLinkChip>
                ) : (
                  <span
                    className="text-xs font-mono break-all text-muted-foreground"
                    data-testid={`docusign-signer-guid-plain-${index}`}
                  >
                    {guid}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {remaining > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="docusign-signers-more">
            +{remaining} {DOCUSIGN_RECORD_LINKS_LABELS.MORE_SIGNED_SUFFIX}
          </p>
        )}
      </div>
    </>
  );
}

// ─── Version readability (founder-reported, 2026-09-29) ────────────────────
//
// A record's version chain used to be answerable only by scrolling to the
// bottom "Version History" card, and a SUPERSEDED record said nothing at all
// about where its replacement lives. `resolveVersionContext` derives the
// current record's position in `anchor.lineage` (newest-first, from
// `useAnchorVersions`); `VersionBanner` renders the at-a-glance summary near
// the top of the page, and the "What changed" panel inside the Version
// History card states honestly what Arkova does and does not know.

interface LineageEntry {
  id: string;
  publicId?: string | null;
  versionNumber: number;
  status: string;
  createdAt: string;
  filename: string;
  fingerprint?: string;
}

interface VersionContext {
  currentVersion: number;
  maxVersion: number;
  isNewest: boolean;
  newerEntry?: LineageEntry;
  olderEntry?: LineageEntry;
}

/** `null` when there is no lineage to show (a solo record — the common case). */
function resolveVersionContext(anchor: AnchorRecord): VersionContext | null {
  const lineage = anchor.lineage;
  if (!lineage || lineage.length <= 1) return null;

  const currentVersion = anchor.versionNumber ?? 1;
  const maxVersion = Math.max(...lineage.map((v) => v.versionNumber));
  return {
    currentVersion,
    maxVersion,
    isNewest: currentVersion >= maxVersion,
    newerEntry: lineage.find((v) => v.versionNumber === currentVersion + 1),
    olderEntry: lineage.find((v) => v.versionNumber === currentVersion - 1),
  };
}

interface VersionBannerProps {
  anchor: AnchorRecord;
  formatDate: (dateString: string) => string;
}

function VersionBanner({ anchor, formatDate }: Readonly<VersionBannerProps>) {
  const ctx = resolveVersionContext(anchor);
  if (!ctx) return null;
  const { currentVersion, maxVersion, isNewest, newerEntry, olderEntry } = ctx;

  const versionOfLabel = VERSION_HISTORY_LABELS.VERSION_OF_TOTAL.replace(
    '{version}',
    String(currentVersion),
  ).replace('{total}', String(maxVersion));

  return (
    <Alert
      data-testid="version-banner"
      className={isNewest ? 'border-primary/30 bg-primary/5' : 'border-amber-500/30 bg-amber-500/5'}
    >
      <GitBranch className="h-4 w-4" />
      <AlertDescription>
        <p className="font-medium text-foreground">
          {versionOfLabel}
          {isNewest && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {VERSION_HISTORY_LABELS.CURRENT_SUFFIX}
            </span>
          )}
        </p>
        {isNewest ? (
          olderEntry && (
            <p className="mt-1 text-sm">
              {VERSION_HISTORY_LABELS.REPLACES_PREVIOUS.replace('{version}', String(olderEntry.versionNumber))}{' '}
              <a
                href={recordDetailPath(olderEntry.id)}
                className="text-primary hover:underline"
                data-testid="version-banner-previous-link"
              >
                {VERSION_HISTORY_LABELS.VIEW_PREVIOUS_VERSION}
              </a>
            </p>
          )
        ) : (
          <>
            {newerEntry && (
              <p className="mt-1 text-sm">
                {VERSION_HISTORY_LABELS.NEWER_VERSION_NOTICE.replace('{date}', formatDate(newerEntry.createdAt))}{' '}
                <a
                  href={recordDetailPath(newerEntry.id)}
                  className="text-primary hover:underline"
                  data-testid="version-banner-current-link"
                >
                  {VERSION_HISTORY_LABELS.VIEW_CURRENT_VERSION}
                </a>
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground" data-testid="version-banner-remains-valid">
              {VERSION_HISTORY_LABELS.REMAINS_VALID_EVIDENCE}
            </p>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Honest "what changed" statement (§1.5): Arkova stores fingerprints, not
 * file content, so it never claims a content diff. The only thing it can
 * state is whether the fingerprint differs from the adjacent version — and
 * only when that neighbor's fingerprint is actually known.
 */
function WhatChangedPanel({ anchor }: Readonly<{ anchor: AnchorRecord }>) {
  const ctx = resolveVersionContext(anchor);
  if (!ctx) return null;

  const neighbor = ctx.isNewest ? ctx.olderEntry : ctx.newerEntry;
  const fingerprintDiffers = Boolean(
    neighbor?.fingerprint && anchor.fingerprint && neighbor.fingerprint !== anchor.fingerprint,
  );

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3" data-testid="what-changed-section">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {VERSION_HISTORY_LABELS.WHAT_CHANGED_TITLE}
      </span>
      <p className="text-xs text-muted-foreground">{VERSION_HISTORY_LABELS.WHAT_CHANGED_NO_DIFF}</p>
      {fingerprintDiffers && neighbor && (
        <p className="text-xs text-muted-foreground" data-testid="what-changed-fingerprint-differs">
          {VERSION_HISTORY_LABELS.FINGERPRINT_DIFFERS_FROM_VERSION.replace(
            '{version}',
            String(neighbor.versionNumber),
          )}
        </p>
      )}
    </div>
  );
}

// ─── Technical details (founder-reported, 2026-09-29) ──────────────────────
//
// Every raw identifier Arkova recorded for a document (file id, revision id,
// connector ids, …) now lives in exactly ONE collapsed disclosure, instead of
// an always-visible "Metadata" block that also used to be duplicated a second
// time by CredentialRenderer's untemplated fallback (see
// `showGenericMetadataFields` on that component). Collapsed by default;
// native <button> gives full keyboard support for free, and `aria-expanded`
// plus a `hidden`-attribute content region (not a conditional unmount) keep
// the disclosure's own accessible-name/state correct without hiding the
// content from assistive tech that reads `hidden` regions on request.

interface TechnicalDetailsSectionProps {
  entries: [string, unknown][];
  provider: RecordSourceProvider;
  docusignEnv: DocusignEnv;
}

function TechnicalDetailsSection({ entries, provider, docusignEnv }: Readonly<TechnicalDetailsSectionProps>) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="technical-details-content"
          onClick={() => setOpen((prev) => !prev)}
          data-testid="technical-details-toggle"
          className="flex w-full items-center justify-between text-left text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-foreground transition-colors"
        >
          <span>{RECORD_DETAIL_LABELS.TECHNICAL_DETAILS_TOGGLE}</span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <div id="technical-details-content" hidden={!open} className="space-y-2 pt-1">
          {entries.map(([key, value]) => (
            <MetadataRow key={key} metaKey={key} value={value} provider={provider} docusignEnv={docusignEnv} />
          ))}
        </div>
      </div>
    </>
  );
}

export function AssetDetailView({ anchor, onBack, onDownloadProof, onDownloadProofJson, onRenameFile, canRename = false, canRevoke = false, onRevoked, hasImportEntitlement = false }: Readonly<AssetDetailViewProps>) {
  // Readability pass (founder-reported, 2026-09-29): a connector-sourced
  // filename (`google_drive:1IxoL...`) is an internal id, never shown as the
  // title. `displayTitle` is what renders AND what the rename pencil seeds
  // its input with — editing should start from the readable name a person
  // would actually want to change, not the raw id underneath it.
  const displayTitle = deriveDisplayTitle(anchor.filename, anchor.metadata);

  const [copied, setCopied] = useState(false);
  const [verificationState, setVerificationState] = useState<VerificationState>('idle');
  const [showVerifyDropzone, setShowVerifyDropzone] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingFilename, setEditingFilename] = useState(false);
  const [filenameInput, setFilenameInput] = useState(displayTitle);
  const [renameSaving, setRenameSaving] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  // Fetch template for credential rendering (UF-01)
  const { template } = useCredentialTemplate(anchor.credentialType, anchor.orgId);

  const status = statusConfig[anchor.status];
  const StatusIcon = status.icon;
  const sourceProvenance = buildAnchorSourceProvenance(anchor.metadata);
  // BUG-2026-08-13-010 (§1.5/§1.6A): connector-sourced fingerprints commit the
  // exact bytes as retrieved at securing time — a fresh download from the
  // source may legitimately differ. Gates the re-verify caveat + mismatch hint.
  const isConnectorSourced = isConnectorSourcedAnchorMetadata(anchor.metadata);
  // SCRUM-3818 (docusign-bilateral-2026-08): a connector-sourced anchor whose
  // fingerprintSource is 'issuer_record_attestation' (set only by the inbound
  // declared-hash path) was NEVER fetched or hashed by Arkova at all — the
  // fetch-time REVERIFY_NOTE above ("Its fingerprint matches the exact file as
  // retrieved") would be a false claim. Gate on fingerprintSource so the
  // caveat states the honest, weaker DECLARED_UNVERIFIED class instead.
  // Everything that isn't this exact combination (including connector-sourced
  // anchors where fingerprintSource is undefined/document_bytes — today's
  // real-world shape for every existing connector anchor) keeps the original
  // fetch-time note, unchanged.
  const isDeclaredUnverified = isConnectorSourced && anchor.fingerprintSource === 'issuer_record_attestation';
  const credentialMetadata = anchor.metadata ?? undefined;
  const visibleMetadata = buildAnchorCredentialMetadata(anchor.metadata);
  // Readability pass: a truthful, plain-language subtitle. "0 B" for an
  // unknown size is worse than no size at all, and a raw MIME string
  // ("application/vnd.google-apps.spreadsheet") is replaced by a
  // plain-language type wherever one is known.
  const displaySize = formatDisplayFileSize(anchor.fileSize);
  const displayType = deriveDisplayType(anchor.fileMime, anchor.metadata) ?? anchor.fileMime ?? undefined;
  const credentialTypeLabel = anchor.credentialType
    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[anchor.credentialType] ?? anchor.credentialType
    : undefined;
  const subtitleParts = [
    displaySize,
    displayType,
    credentialTypeLabel && credentialTypeLabel !== displayType ? credentialTypeLabel : undefined,
  ].filter((part): part is string => Boolean(part));
  // DocuSign record deep links (bilateral rollout, frontend-targeted T2):
  // gated strictly on connector_source === 'docusign' — a non-DocuSign
  // anchor never sees a link, regardless of what its metadata contains.
  // SCRUM-3818 / SCRUM-4507: ONE resolved provider drives every source-specific
  // link on this page. Exact-equality gate — see resolveRecordSourceProvider.
  const sourceProvider = resolveRecordSourceProvider(anchor.metadata);
  const isDocusignAnchor = sourceProvider === 'docusign';
  const isDriveAnchor = sourceProvider === 'google_drive';
  const docusignEnv = resolveDocusignEnv(anchor.metadata?._docusign_env);
  // CPE-R1 (SCRUM-1847): the CPE section is gated on the credential_source_import
  // entitlement, resolved by the parent page and passed via hasImportEntitlement.
  // The section self-hides when the gate is false or there is no CPE metadata.
  const cpeMetadataView = extractCpeMetadataView(anchor.cpeMetadata, {
    provider: metadataString(anchor.metadata, 'source_provider'),
    title: anchor.filename,
    completion_date: anchor.issuedAt,
    evidence_level: metadataString(anchor.metadata, 'verification_level'),
  });
  // CLE-R1 (SCRUM-1869): same gating as CPE — the section self-hides when the
  // entitlement gate is false or there is no CLE metadata.
  const cleMetadataView = extractCleMetadataView(anchor.cleMetadata, {
    course_title: anchor.filename,
    completion_date: anchor.issuedAt,
    evidence_level: metadataString(anchor.metadata, 'verification_level'),
  });
  const hasSourceProvenance = Boolean(
    sanitizeSourceUrl(sourceProvenance.source_url) ||
    sourceProvenance.source_provider ||
    sourceProvenance.verification_level ||
    sourceProvenance.evidence_package_hash ||
    sourceProvenance.source_payload_hash ||
    sourceProvenance.fetched_at
  );

  const handleCopyFingerprint = async () => {
    await navigator.clipboard.writeText(anchor.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVerifyFile = useCallback(
    async (_file: File, fingerprint: string) => {
      setVerificationState('verifying');

      // Small delay to show loading state
      await new Promise((resolve) => setTimeout(resolve, 500));

      const isMatch = fingerprint.toLowerCase() === anchor.fingerprint.toLowerCase();
      setVerificationState(isMatch ? 'match' : 'mismatch');
    },
    [anchor.fingerprint]
  );

  const handleResetVerification = () => {
    setVerificationState('idle');
    setShowVerifyDropzone(false);
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Record Details</h1>
          <p className="text-muted-foreground">
            View and verify your secured document
          </p>
        </div>
        {anchor.publicId && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShareOpen(true)}>
              <Share2 className="mr-2 h-4 w-4" />
              {SHARE_LABELS.SHARE_BUTTON}
            </Button>
            <LinkedInShareButton
              publicId={anchor.publicId}
              credentialType={anchor.credentialType ? CREDENTIAL_TYPE_LABELS[anchor.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] : undefined}
            />
            <LinkedInBadgeSnippet
              publicId={anchor.publicId}
              status={anchor.status}
            />
            {canRevoke && anchor.status !== 'REVOKED' && (
              <Button
                variant="outline"
                onClick={() => setRevokeOpen(true)}
                className="text-destructive hover:text-destructive"
                aria-label="Mark as Revoked"
              >
                <Ban className="mr-2 h-4 w-4" />
                Mark as Revoked
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Version banner (readability pass, founder-reported 2026-09-29) —
          at-a-glance: which version this is, whether it's current, and a
          working link to the newer/older version. Self-hides for a solo
          record (no lineage). */}
      <VersionBanner anchor={anchor} formatDate={formatDate} />

      {canRevoke && (
        <RevokeAnchorModal
          open={revokeOpen}
          onClose={() => setRevokeOpen(false)}
          anchorId={anchor.id}
          filename={displayTitle}
          onRevoked={onRevoked}
        />
      )}

      {/* Certificate Card */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-background shadow-sm">
                <ArkovaLogo size={28} />
              </div>
              <div>
                <h2 className="font-semibold">Verification Certificate</h2>
                <p className="text-sm text-muted-foreground">
                  Arkova Secure Record
                </p>
              </div>
            </div>
            <Badge variant={status.variant} className={`h-7 ${anchor.status === 'SECURED' ? 'animate-secured animate-status-pulse' : ''}`}>
              <StatusIcon className="mr-1 h-3.5 w-3.5" />
              {status.label}
            </Badge>
          </div>
        </div>

        <CardContent className="p-6 space-y-6">
          {/* Document Info */}
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted shrink-0">
              <FileText className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              {editingFilename ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={filenameInput}
                    onChange={(e) => setFilenameInput(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && filenameInput.trim() && onRenameFile) {
                        setRenameSaving(true);
                        try {
                          await onRenameFile(filenameInput.trim());
                        } finally {
                          setRenameSaving(false);
                          setEditingFilename(false);
                        }
                      } else if (e.key === 'Escape') {
                        setFilenameInput(displayTitle);
                        setEditingFilename(false);
                      }
                    }}
                    className="flex-1 min-w-0 text-lg font-medium bg-muted rounded px-2 py-1 border border-primary/30 focus:outline-hidden focus:ring-1 focus:ring-primary"
                    autoFocus
                    disabled={renameSaving}
                    maxLength={255}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    disabled={renameSaving || !filenameInput.trim()}
                    onClick={async () => {
                      if (filenameInput.trim() && onRenameFile) {
                        setRenameSaving(true);
                        try {
                          await onRenameFile(filenameInput.trim());
                        } finally {
                          setRenameSaving(false);
                          setEditingFilename(false);
                        }
                      }
                    }}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => { setFilenameInput(displayTitle); setEditingFilename(false); }}
                    disabled={renameSaving}
                  >
                    <XCircle className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <p className="text-lg font-medium truncate">{displayTitle}</p>
                  {onRenameFile && canRename && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                      onClick={() => { setFilenameInput(displayTitle); setEditingFilename(true); }}
                      aria-label="Edit document name"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              {subtitleParts.length > 0 && (
                <p className="text-sm text-muted-foreground">{subtitleParts.join(' • ')}</p>
              )}
            </div>
          </div>

          <Separator />

          {/* Fingerprint */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Hash className="h-4 w-4 text-muted-foreground" />
                Document Fingerprint
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground hover:bg-muted/80 cursor-help" aria-label={FINGERPRINT_TOOLTIP.TITLE}>?</button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs font-medium mb-1">{FINGERPRINT_TOOLTIP.TITLE}</p>
                      <p className="text-xs text-muted-foreground">{FINGERPRINT_TOOLTIP.DESCRIPTION}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleCopyFingerprint}
                aria-label={
                  copied
                    ? RECORD_DETAIL_LABELS.FINGERPRINT_COPIED_ARIA
                    : RECORD_DETAIL_LABELS.FINGERPRINT_COPY_ARIA
                }
              >
                {copied ? (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div className="p-4 rounded-lg bg-muted font-mono text-xs break-all">
              {anchor.fingerprint}
            </div>
            <p className="text-xs text-muted-foreground">
              SHA-256 cryptographic hash • {formatFingerprint(anchor.fingerprint, 8, 4)}
            </p>
          </div>

          <Separator />

          {/* ANCHOR RECORD — pipeline-style 2-column grid. Extracted into
              AnchorRecordGrid (module-level) so the AssetDetailView render
              body stays under the cognitive-complexity budget
              (typescript:S3776). Pure presentation; behavior-identical. */}
          <AnchorRecordGrid anchor={anchor} status={status} formatDate={formatDate} />

          {/* Description (BETA-12) — falls back to metadata abstract/description/summary */}
          {(() => {
            const desc = anchor.description
              ?? (anchor.metadata?.abstract as string | undefined)
              ?? (anchor.metadata?.description as string | undefined)
              ?? (anchor.metadata?.summary as string | undefined);
            if (!desc) return null;
            return (
              <>
                <Separator />
                <div className="space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Description</span>
                  <p className="text-sm text-muted-foreground break-words">{desc}</p>
                </div>
              </>
            );
          })()}

          {/* Source provenance (CSI-03) */}
          {hasSourceProvenance && (
            <>
              <Separator />
              <SourceProvenanceDisplay data={sourceProvenance} />
            </>
          )}

          {/* AI Tags — displayed as badges when present */}
          {Array.isArray(anchor.metadata?.ai_tags) && (anchor.metadata!.ai_tags as string[]).length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Tags</span>
                <div className="flex flex-wrap gap-1.5">
                  {(anchor.metadata.ai_tags as string[]).map(tag => (
                    <Badge key={tag} variant="secondary" className="text-xs font-normal">
                      {tag}
                    </Badge>
                  ))}
                </div>
                {typeof anchor.metadata?.ai_summary === 'string' && anchor.metadata.ai_summary && (
                  <p className="text-xs text-muted-foreground mt-1">{anchor.metadata.ai_summary}</p>
                )}
              </div>
            </>
          )}

          {/* Compliance Controls (CML-01) */}
          {anchor.status === 'SECURED' && (
            <>
              <Separator />
              <ComplianceBadge
                credentialType={anchor.credentialType}
                isSecured={true}
              />
            </>
          )}

          {/* Technical details (readability pass, founder-reported 2026-09-29):
              every raw identifier, collapsed by default, rendered exactly
              once. DocuSign bilateral rollout (frontend-targeted T2):
              account_id/envelope_id inside it still render as deep links —
              see MetadataRow. */}
          {visibleMetadata && (
            <TechnicalDetailsSection
              entries={Object.entries(visibleMetadata)}
              provider={sourceProvider}
              docusignEnv={docusignEnv}
            />
          )}

          {/* DocuSign Signers (bilateral rollout, frontend-targeted T2) — dedicated
              rows from metadata._signers, distinct from the generic metadata dump
              above. Self-hides on any anchor without a non-empty _signers array
              (legacy DocuSign records, and every non-DocuSign anchor). */}
          {isDocusignAnchor && (
            <DocusignSignerRows signers={anchor.metadata?._signers} env={docusignEnv} />
          )}

          {/* Google Drive source link-back (SCRUM-4507) — dedicated block for
              the Drive file / folder / shared drive / revision, gated strictly
              on connector_source === 'google_drive'. Self-hides when no Drive
              identifier is renderable. */}
          {isDriveAnchor && <DriveSourceChips metadata={anchor.metadata} />}
        </CardContent>
      </Card>

      {/* Live anchoring progress indicator (Design Audit #16) */}
      {(anchor.status === 'PENDING' || anchor.status === 'SUBMITTED') && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <div className="relative flex h-10 w-10 items-center justify-center">
                <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
                <Clock className="relative h-5 w-5 text-amber-500" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {anchor.status === 'SUBMITTED' ? 'Awaiting network confirmation' : 'Preparing for anchoring'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {anchor.status === 'SUBMITTED'
                    ? CONFIRMATION_PROGRESS_LABELS.AWAITING_CONFIRMATION
                    : 'Your record is being prepared for permanent anchoring.'}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs shrink-0">
                {anchor.status === 'SUBMITTED' ? 'Confirming' : 'Queued'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Verification Walkthrough (DEMO-02) */}
      <VerificationWalkthrough hasMetadata={!!visibleMetadata && Object.keys(visibleMetadata).length > 0} />

      {/* Credential Details (UF-01) — template-driven rendering */}
      {(anchor.credentialType || credentialMetadata) && (
        <CredentialRenderer
          credentialType={anchor.credentialType}
          metadata={credentialMetadata}
          template={template}
          issuerName={anchor.issuerName}
          status={anchor.status}
          // Readability pass: AssetDetailView already renders the record's
          // title prominently above (displayTitle) — omitting `filename`
          // here stops CredentialRenderer's own "no displayable fields"
          // fallback from repeating that same title a second time.
          issuedDate={anchor.issuedAt}
          expiryDate={anchor.expiresAt}
          cpeMetadata={cpeMetadataView}
          cleMetadata={cleMetadataView}
          hasImportEntitlement={hasImportEntitlement}
          // Readability pass: this page already renders every raw metadata
          // key itself (Technical Details, above) — without this the
          // untemplated fallback below duplicated the identical key/value
          // list a second time.
          showGenericMetadataFields={false}
        />
      )}

      {/* Lifecycle Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {LIFECYCLE_LABELS.TITLE}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AnchorLifecycleTimeline
            data={{
              status: anchor.status,
              createdAt: anchor.createdAt,
              issuedAt: anchor.issuedAt,
              securedAt: anchor.securedAt,
              revokedAt: anchor.revokedAt,
              supersededAt: anchor.supersededAt,
              revocationReason: anchor.revocationReason,
              expiresAt: anchor.expiresAt,
            }}
          />
        </CardContent>
      </Card>

      {/* Version History / Lineage (P4-TS-06) */}
      {(anchor.versionNumber ?? 1) > 1 || (anchor.lineage && anchor.lineage.length > 1) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              {VERSION_HISTORY_LABELS.TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <WhatChangedPanel anchor={anchor} />
            <div className="space-y-3" data-testid="version-history-list">
              {(anchor.lineage ?? [{ id: anchor.id, versionNumber: anchor.versionNumber ?? 1, status: anchor.status, createdAt: anchor.createdAt, filename: anchor.filename }])
                .slice()
                .sort((a, b) => b.versionNumber - a.versionNumber)
                .map((version) => {
                const isCurrent = version.id === anchor.id;
                const vStatus = statusConfig[version.status as keyof typeof statusConfig];
                const VIcon = vStatus?.icon ?? Clock;
                const rowContent = (
                  <>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full shrink-0 ${isCurrent ? 'bg-primary/10' : 'bg-muted'}`}>
                      <span className="text-xs font-bold">{version.versionNumber}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {VERSION_HISTORY_LABELS.VERSION_PREFIX} {version.versionNumber}
                        {isCurrent && (
                          <Badge variant="outline" className="ml-2 text-[10px]">{VERSION_HISTORY_LABELS.CURRENT}</Badge>
                        )}
                        {version.versionNumber === 1 && (
                          <span className="ml-2 text-xs text-muted-foreground">{VERSION_HISTORY_LABELS.ORIGINAL}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {version.filename} — {new Date(version.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                    <Badge variant={vStatus?.variant ?? 'outline'} className="shrink-0">
                      <VIcon className="mr-1 h-3 w-3" />
                      {vStatus?.label ?? version.status}
                    </Badge>
                  </>
                );
                return (
                  <div
                    key={version.id}
                    data-testid="version-history-row"
                    className={`rounded-lg transition-colors ${isCurrent ? 'bg-primary/5 border border-primary/20' : 'bg-muted/50 hover:bg-muted'}`}
                  >
                    {isCurrent ? (
                      <div className="flex items-center gap-3 px-4 py-3">{rowContent}</div>
                    ) : (
                      <a
                        href={recordDetailPath(version.id)}
                        data-testid="version-history-row-link"
                        className="flex items-center gap-3 px-4 py-3"
                      >
                        {rowContent}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* QR Code — only for SECURED anchors with a public_id */}
      {anchor.publicId && anchor.status === 'SECURED' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ArkovaIcon className="h-4 w-4" />
              Verification QR Code
            </CardTitle>
            <CardDescription>
              Share this QR code to let anyone verify this document
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <div id="qr-code-container" className="rounded-lg border bg-white p-4">
              <QRCodeSVG
                value={verifyUrl(anchor.publicId)}
                size={180}
                level="M"
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {verifyUrl(anchor.publicId)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const svg = document.querySelector('#qr-code-container svg');
                if (!svg) return;
                const canvas = document.createElement('canvas');
                canvas.width = 220;
                canvas.height = 220;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, 220, 220);
                const svgData = new XMLSerializer().serializeToString(svg);
                const img = new Image();
                img.onload = () => {
                  ctx.drawImage(img, 20, 20, 180, 180);
                  const link = document.createElement('a');
                  link.download = `arkova-qr-${(anchor.publicId ?? 'unknown').slice(0, 8)}.png`;
                  link.href = canvas.toDataURL('image/png');
                  link.click();
                };
                img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
              }}
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Download QR as PNG
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Re-verify Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Re-verify Document
          </CardTitle>
          <CardDescription>
            Drop your original document to verify it matches this record
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isConnectorSourced && (
            <p
              data-testid="connector-fingerprint-reverify-note"
              className="mb-4 rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
            >
              {isDeclaredUnverified
                ? CONNECTOR_FINGERPRINT_LABELS.DECLARED_UNVERIFIED_REVERIFY_NOTE
                : CONNECTOR_FINGERPRINT_LABELS.REVERIFY_NOTE}
            </p>
          )}
          {verificationState === 'idle' && !showVerifyDropzone && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowVerifyDropzone(true)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Verify Document
            </Button>
          )}

          {showVerifyDropzone && verificationState === 'idle' && (
            <div className="space-y-4">
              <FileUpload onFileSelect={handleVerifyFile} disabled={false} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowVerifyDropzone(false)}
              >
                Cancel
              </Button>
            </div>
          )}

          {verificationState === 'verifying' && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-primary" />
              <span className="ml-2 text-sm">Verifying document...</span>
            </div>
          )}

          {verificationState === 'match' && (
            <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                <strong>Verification Successful!</strong>
                <br />
                The document fingerprint matches. This is the authentic document.
              </AlertDescription>
            </Alert>
          )}

          {verificationState === 'mismatch' && (
            <Alert variant="destructive">
              <XCircle className="h-5 w-5" />
              <AlertDescription>
                <strong>Verification Failed!</strong>
                <br />
                The document fingerprint does not match. This may be a modified or different document.
                {isConnectorSourced && (
                  <span data-testid="connector-fingerprint-mismatch-hint" className="mt-2 block">
                    {isDeclaredUnverified
                      ? CONNECTOR_FINGERPRINT_LABELS.DECLARED_UNVERIFIED_REVERIFY_MISMATCH_HINT
                      : CONNECTOR_FINGERPRINT_LABELS.REVERIFY_MISMATCH_HINT}
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {(verificationState === 'match' || verificationState === 'mismatch') && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={handleResetVerification}
            >
              Verify Another Document
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Share Sheet (UF-08) */}
      {anchor.publicId && (
        <ShareSheet
          open={shareOpen}
          onOpenChange={setShareOpen}
          publicId={anchor.publicId}
          filename={displayTitle}
        />
      )}

      {/* Actions */}
      {anchor.status === 'SECURED' && (onDownloadProof || onDownloadProofJson) && (
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div>
              <p className="text-sm font-medium">Download Proof Package</p>
              <p className="text-xs text-muted-foreground">
                Get a complete verification package with all metadata
              </p>
            </div>
            <div className="flex gap-2">
              {onDownloadProof && (
                <Button onClick={onDownloadProof} variant="outline">
                  <Download className="mr-2 h-4 w-4" />
                  PDF
                </Button>
              )}
              {onDownloadProofJson && (
                <Button onClick={onDownloadProofJson}>
                  <Download className="mr-2 h-4 w-4" />
                  JSON
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Disclaimer (IDT WS3) */}
      <AnchorDisclaimer />
    </div>
  );
}
