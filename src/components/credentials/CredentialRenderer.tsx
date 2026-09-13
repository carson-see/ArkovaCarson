/**
 * Credential Renderer — Synthetic Sentinel Visual Cards
 *
 * Renders credential cards with type-specific visual treatments:
 * - DEGREE: Diploma-style with institutional seal, recipient name prominent
 * - CERTIFICATE: Certificate border with issuer branding
 * - LICENSE: Professional license card with ID number
 * - TRANSCRIPT: Academic record with data grid
 * - PROFESSIONAL: Professional credential with certification badge
 * - OTHER/fallback: Clean document card
 *
 * Three rendering modes:
 * 1. Template + metadata: structured card with labeled fields
 * 2. No template, has metadata: key-value pairs from metadata
 * 3. No metadata: filename + fingerprint + status only
 *
 * @see UF-01, DEMO-04
 */

import { Award, Building2, Calendar, Copy, Check, GraduationCap, ScrollText, BadgeCheck, FileText, Scale, Landmark, FileSignature, Microscope, BookOpen, Stamp } from 'lucide-react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CREDENTIAL_TYPE_LABELS,
  ANCHOR_STATUS_LABELS,
  CREDENTIAL_RENDERER_LABELS as LABELS,
  formatCredentialSubType,
} from '@/lib/copy';
import type { TemplateDisplayData } from '@/hooks/useCredentialTemplate';
import { isFraudMetadataKey } from '@/lib/fraudDetection';
import { CpeMetadataSection, type CpeMetadataView } from './CpeMetadataSection';
import { CleMetadataSection, type CleMetadataView } from './CleMetadataSection';
import { formatAuthorsDisplay } from '@/lib/publicRecordTemplate';

/** Status badge color mapping */
const STATUS_COLORS: Record<string, string> = {
  SECURED: 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/30',
  ACTIVE: 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/30',
  SUBMITTED: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  PENDING: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  REVOKED: 'bg-red-500/15 text-red-400 border border-red-500/30',
  EXPIRED: 'bg-[#859398]/15 text-[#859398] border border-[#859398]/30',
  SUPERSEDED: 'bg-[#859398]/15 text-[#859398] border border-[#859398]/30',
};

/** Type-specific visual config */
const TYPE_CONFIG: Record<string, {
  icon: React.ElementType;
  accentColor: string;
  borderAccent: string;
  bgGradient: string;
  label: string;
}> = {
  DEGREE: {
    icon: GraduationCap,
    accentColor: 'text-[#a8e8ff]',
    borderAccent: 'border-l-[#00d4ff]',
    bgGradient: 'from-[#00d4ff]/8 to-transparent',
    label: 'Academic Degree',
  },
  CERTIFICATE: {
    icon: BadgeCheck,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Certified Achievement',
  },
  LICENSE: {
    icon: ArkovaIcon,
    accentColor: 'text-[#a8e8ff]',
    borderAccent: 'border-l-[#a8e8ff]',
    bgGradient: 'from-[#a8e8ff]/8 to-transparent',
    label: 'Professional License',
  },
  TRANSCRIPT: {
    icon: ScrollText,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Academic Record',
  },
  PROFESSIONAL: {
    icon: Award,
    accentColor: 'text-[#00d4ff]',
    borderAccent: 'border-l-[#00d4ff]',
    bgGradient: 'from-[#00d4ff]/8 to-transparent',
    label: 'Professional Certification',
  },
  CLE: {
    icon: Scale,
    accentColor: 'text-[#a8e8ff]',
    borderAccent: 'border-l-[#a8e8ff]',
    bgGradient: 'from-[#a8e8ff]/8 to-transparent',
    label: 'CLE Credit',
  },
  BADGE: {
    icon: Stamp,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Digital Badge',
  },
  ATTESTATION: {
    icon: FileSignature,
    accentColor: 'text-[#00d4ff]',
    borderAccent: 'border-l-[#00d4ff]',
    bgGradient: 'from-[#00d4ff]/8 to-transparent',
    label: 'Attestation',
  },
  FINANCIAL: {
    icon: Landmark,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Financial Document',
  },
  LEGAL: {
    icon: Scale,
    accentColor: 'text-[#a8e8ff]',
    borderAccent: 'border-l-[#a8e8ff]',
    bgGradient: 'from-[#a8e8ff]/8 to-transparent',
    label: 'Legal Document',
  },
  INSURANCE: {
    icon: ArkovaIcon,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Insurance Certificate',
  },
  SEC_FILING: {
    icon: Landmark,
    accentColor: 'text-[#00d4ff]',
    borderAccent: 'border-l-[#00d4ff]',
    bgGradient: 'from-[#00d4ff]/8 to-transparent',
    label: 'SEC Filing',
  },
  PATENT: {
    icon: Microscope,
    accentColor: 'text-[#a8e8ff]',
    borderAccent: 'border-l-[#a8e8ff]',
    bgGradient: 'from-[#a8e8ff]/8 to-transparent',
    label: 'Patent',
  },
  REGULATION: {
    icon: BookOpen,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Regulation',
  },
  PUBLICATION: {
    icon: BookOpen,
    accentColor: 'text-[#00d4ff]',
    borderAccent: 'border-l-[#00d4ff]',
    bgGradient: 'from-[#00d4ff]/8 to-transparent',
    label: 'Publication',
  },
  OTHER: {
    icon: FileText,
    accentColor: 'text-[#bbc9cf]',
    borderAccent: 'border-l-[#3c494e]',
    bgGradient: 'from-[#bbc9cf]/5 to-transparent',
    label: 'Document Record',
  },
};

/**
 * The `metadata` keys that MIRROR the canonical `anchors.sub_type` column, in
 * precedence order. One list: membership (`isSubTypeKey`) and lookup order
 * (`extractSubTypeLabel`) drifting apart is how a key ends up hidden from the
 * label but rendered in the metadata list, or the reverse.
 */
const SUB_TYPE_METADATA_KEYS: readonly string[] = ['subType', 'subtype', 'sub_type'];

function isSubTypeKey(key: string): boolean {
  return SUB_TYPE_METADATA_KEYS.includes(key);
}

/**
 * A sub-type is only usable as a label when it FORMATS to visible text.
 *
 * Two ways it does not, both reachable because `anchors.sub_type` is bare
 * `text` with no CHECK and no enum:
 *   - blank input — `formatCredentialSubType('')` returns the em-dash
 *     placeholder, so an unguarded blank would REPLACE a real credential-type
 *     label with '—', worse than the generic label it improves on;
 *   - blank OUTPUT — separator-only input formats to whitespace
 *     (`'_'` splits into two empty segments joined by a space), which is
 *     truthy and would win the label with nothing to show.
 * So the guard is on the formatted result, not just the raw value.
 */
function formatSubTypeOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return formatCredentialSubType(trimmed).trim() || null;
}

function extractSubTypeLabel(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  for (const key of SUB_TYPE_METADATA_KEYS) {
    const label = formatSubTypeOrNull(metadata[key]);
    if (label) return label;
  }
  return null;
}

export interface CredentialRendererProps {
  credentialType?: string | null;
  /**
   * SCRUM-3529: the canonical `anchors.sub_type` column (GRE-01 —
   * `official_undergraduate`, `nursing_rn`), surfaced by `get_public_anchor` as
   * a top-level key (migration 0421) and by `GET /api/v1/verify/:publicId`.
   *
   * Takes precedence over any `sub_type` duplicate inside `metadata`, which is
   * only whatever a writer happened to mirror there. Callers that have no
   * column value may omit this; the metadata fallback still applies.
   */
  subType?: string | null;
  metadata?: Record<string, unknown> | null;
  template?: TemplateDisplayData | null;
  issuerName?: string | null;
  status?: string;
  filename?: string;
  fingerprint?: string;
  issuedDate?: string | null;
  expiryDate?: string | null;
  showFingerprint?: boolean;
  compact?: boolean;
  /**
   * CPE metadata (SCRUM-1847). When present, mounts {@link CpeMetadataSection}.
   * Detail view also requires `hasImportEntitlement`; public view passes
   * `publicView` and the section renders without an entitlement gate.
   */
  cpeMetadata?: CpeMetadataView | null;
  /**
   * CLE metadata (SCRUM-1869). When present, mounts {@link CleMetadataSection}
   * in its own region, separate from the CPE block. Shares the same
   * `hasImportEntitlement` / `publicView` gating as CPE.
   */
  cleMetadata?: CleMetadataView | null;
  /** Viewer holds the `credential_source_import` entitlement (detail view). */
  hasImportEntitlement?: boolean;
  /** Render CPE/CLE metadata in the public-verification variant. */
  publicView?: boolean;
}

const METADATA_DISPLAY_HIDDEN_KEYS = new Set([
  'recipient',
  'jurisdiction',
  'merkle_proof',
  'merkle_root',
  'chain_tx_id',
  'batch_id',
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
  // SCRUM-5105 follow-up: these already have a dedicated render surface one
  // screen up in AssetDetailView.tsx (which hides them from its OWN generic
  // metadata dump via ANCHOR_CREDENTIAL_METADATA_HIDDEN_KEYS) — the no-
  // template fallback here (mode 2) had no equivalent, so they rendered as
  // raw rows ("Ai Summary:", "Securing Path:", ...) whenever a credential
  // had no matching template. Note: the `startsWith('_')` guard just below
  // already covers every `_`-prefixed key (e.g. `_confidence`) — these four
  // are the ones that are NOT underscore-prefixed.
  'ai_summary',
  'ai_document_type',
  'ai_tags',
  'securing_path',
]);

function isMetadataDisplayHiddenKey(key: string): boolean {
  // BUG-2026-07-17-010 (SCRUM-2910, P0): fraud_* keys must never render in
  // the credential card (owner detail AND public verification).
  return key.startsWith('_') || METADATA_DISPLAY_HIDDEN_KEYS.has(key.toLowerCase()) || isFraudMetadataKey(key);
}

/**
 * SCRUM-3529: skip a metadata/template-field key from the rendered field
 * list. One shared test for BOTH the templated and untemplated rendering
 * branches below, so the two cannot drift the way `isSubTypeKey` and
 * `extractSubTypeLabel` would have if membership and lookup order were two
 * separate lists (the reason `SUB_TYPE_METADATA_KEYS` is a single array).
 *
 * The second condition is the sub-type collision: when the canonical
 * `subType` prop already produced a label, a metadata OR template-field key
 * matching `SUB_TYPE_METADATA_KEYS` is a MIRROR of it — rendering it as a
 * second field would publish two Types for one credential, and the mirror is
 * the one that can be stale. A template field collides here because
 * `CredentialTemplatesManager` derives a field's key from its label
 * (`f.name.toLowerCase().replace(/\s+/g, '_')`), so an org-defined field
 * literally named "Sub Type" becomes key `sub_type`.
 */
function shouldSkipMetadataField(key: string, canonicalSubTypeLabel: string | null): boolean {
  return isMetadataDisplayHiddenKey(key) || (!!canonicalSubTypeLabel && isSubTypeKey(key));
}

export function CredentialRenderer({
  credentialType,
  subType,
  metadata,
  template,
  issuerName,
  status,
  filename,
  fingerprint,
  issuedDate,
  expiryDate,
  showFingerprint = false,
  compact = false,
  cpeMetadata,
  cleMetadata,
  hasImportEntitlement = false,
  publicView = false,
}: Readonly<CredentialRendererProps>) {
  const [copied, setCopied] = useState(false);

  const typeKey = credentialType ?? 'OTHER';
  const config = TYPE_CONFIG[typeKey] ?? TYPE_CONFIG.OTHER;
  const TypeIcon = config.icon;
  // The canonical column wins over the metadata duplicate (SCRUM-3529).
  const canonicalSubTypeLabel = formatSubTypeOrNull(subType);
  const subTypeLabel = canonicalSubTypeLabel ?? extractSubTypeLabel(metadata);

  const credentialLabel = subTypeLabel ?? (credentialType
    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[credentialType] ?? credentialType
    : null);

  const statusLabel = status
    ? (ANCHOR_STATUS_LABELS as Record<string, string>)[status] ?? status
    : null;

  const statusColor = status ? STATUS_COLORS[status] ?? '' : '';

  const handleCopyFingerprint = async () => {
    if (!fingerprint) return;
    await navigator.clipboard.writeText(fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };

  const formatFieldValue = (value: unknown, type?: string): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (type === 'date' && typeof value === 'string') {
      return formatDate(value);
    }
    // Auto-detect ISO-8601 datetime strings so non-template metadata
    // keys (e.g. `issued_at` on the public verify page) render as a
    // human date instead of the raw timestamp.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return formatDate(value);
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  };

  const formatFieldLabel = (key: string): string => {
    return isSubTypeKey(key)
      ? 'Type'
      : key
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  // Determine rendering mode
  const hasTemplate = template && template.fields.length > 0;
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  // Build field list for display
  const displayFields: { label: string; value: string }[] = [];

  if (hasTemplate && hasMetadata) {
    for (const field of template.fields) {
      if (shouldSkipMetadataField(field.key, canonicalSubTypeLabel)) continue;
      const raw = metadata[field.key];
      // SCRUM-5105: `authors` (when a template happens to declare that key)
      // is a `{ name, orcid? }[]` from publicRecordTemplate.ts — narrow
      // override so it never falls through to the generic
      // JSON.stringify(object) branch in formatFieldValue. A malformed/
      // legacy value (formatAuthorsDisplay returns null) still falls
      // through to the default formatter, same as every other key.
      const formatted = (field.key === 'authors' ? formatAuthorsDisplay(raw) : null) ?? formatFieldValue(raw, field.type);
      if (formatted) {
        displayFields.push({ label: field.label, value: formatted });
      }
    }
  } else if (hasMetadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (shouldSkipMetadataField(key, canonicalSubTypeLabel)) continue;
      // SCRUM-5105 (CTO ruling): `authors` is an array of `{ name, orcid? }`
      // objects — this is the ONE narrow key override in this generic dump;
      // every other key's formatting is untouched. A malformed/legacy
      // `authors` value (formatAuthorsDisplay returns null) still falls
      // through to the default formatter below.
      const formatted = (key === 'authors' ? formatAuthorsDisplay(value) : null) ?? (
        isSubTypeKey(key) && typeof value === 'string'
          ? formatSubTypeOrNull(value)
          : formatFieldValue(value)
      );
      if (formatted) {
        displayFields.push({ label: formatFieldLabel(key), value: formatted });
      }
    }
  }

  // Extract recipient name from metadata
  const recipientName = metadata?.recipient as string
    ?? metadata?.recipient_name as string
    ?? metadata?.name as string
    ?? null;

  // Compact mode for table row previews
  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-[#242b32] shrink-0`}>
          <TypeIcon className={`h-4 w-4 ${config.accentColor}`} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate text-[#dce3ed]">
            {template?.name ?? credentialLabel ?? filename ?? LABELS.DOCUMENT_RECORD}
          </p>
          {issuerName && (
            <p className="text-xs text-[#bbc9cf] truncate">{issuerName}</p>
          )}
        </div>
        {statusLabel && (
          <Badge className={`ml-auto shrink-0 ${statusColor}`}>
            {statusLabel}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl overflow-hidden border-l-4 ${config.borderAccent} bg-[#192028] transition-all duration-300`}>
      {/* Header with type-specific gradient */}
      <div className={`bg-gradient-to-r ${config.bgGradient} px-4 py-5 sm:px-6`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#242b32] border border-[#3c494e]/20 shrink-0">
              <TypeIcon className={`h-6 w-6 ${config.accentColor}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-widest text-[#859398] mb-1">
                {config.label}
              </p>
              <h3 className="font-bold text-lg leading-tight text-[#dce3ed] break-words">
                {template?.name ?? credentialLabel ?? LABELS.DOCUMENT_RECORD}
              </h3>
              {credentialLabel && template?.name && (
                <p className="text-xs text-[#bbc9cf]">{credentialLabel}</p>
              )}
            </div>
          </div>
          {statusLabel && (
            <Badge className={`w-fit shrink-0 sm:ml-auto ${statusColor}`}>
              {statusLabel}
            </Badge>
          )}
        </div>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Recipient name — prominent for degrees/certificates */}
        {recipientName && (typeKey === 'DEGREE' || typeKey === 'CERTIFICATE' || typeKey === 'PROFESSIONAL') && (
          <div className="py-2">
            <p className="text-[10px] uppercase tracking-widest text-[#859398] mb-1">Recipient</p>
            <p className="text-2xl font-black tracking-tight text-[#dce3ed]">{recipientName}</p>
          </div>
        )}

        {/* Issuer */}
        {issuerName && (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#242b32] border border-[#3c494e]/20 flex items-center justify-center">
              <Building2 className="h-4 w-4 text-[#bbc9cf]" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-[#859398]">{LABELS.ISSUED_BY}</p>
              <p className="text-sm font-semibold text-[#dce3ed]">{issuerName}</p>
            </div>
          </div>
        )}

        {/* Dates */}
        {(issuedDate || expiryDate) && (
          <div className="flex flex-wrap gap-6">
            {issuedDate && (
              <div className="flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-[#859398]" />
                <span className="text-[10px] uppercase tracking-widest text-[#859398]">{LABELS.ISSUED_ON}:</span>
                <span className="text-sm text-[#dce3ed]">{formatDate(issuedDate)}</span>
              </div>
            )}
            {expiryDate && (
              <div className="flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-[#859398]" />
                <span className="text-[10px] uppercase tracking-widest text-[#859398]">{LABELS.EXPIRES_ON}:</span>
                <span className="text-sm text-[#dce3ed]">{formatDate(expiryDate)}</span>
              </div>
            )}
          </div>
        )}

        {/* Metadata fields — tonal layered grid */}
        {displayFields.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {displayFields.map((field) => (
              <div key={field.label} className="bg-[#242b32] rounded-lg px-4 py-3">
                <dt className="text-[10px] font-semibold uppercase tracking-widest text-[#859398] mb-1">
                  {field.label}
                </dt>
                <dd className="text-sm text-[#dce3ed]">{field.value}</dd>
              </div>
            ))}
          </div>
        )}

        {/* CPE metadata section (SCRUM-1847). Self-gating: renders nothing
            when cpeMetadata is absent, or (detail view) when the viewer lacks
            the credential_source_import entitlement. The sibling CLE section
            below lives in its own region — keep this CPE block localized. */}
        {cpeMetadata && (
          <CpeMetadataSection
            cpeMetadata={cpeMetadata}
            hasImportEntitlement={hasImportEntitlement}
            publicView={publicView}
          />
        )}

        {/* CLE metadata section (SCRUM-1869). Separate region from the CPE
            block above. Same self-gating: renders nothing when cleMetadata is
            absent, or (detail view) when the viewer lacks the
            credential_source_import entitlement. */}
        {cleMetadata && (
          <CleMetadataSection
            cleMetadata={cleMetadata}
            hasImportEntitlement={hasImportEntitlement}
            publicView={publicView}
          />
        )}

        {/* No metadata fallback */}
        {displayFields.length === 0 && filename && (
          <div className="bg-[#242b32] rounded-lg px-4 py-3">
            <p className="text-sm text-[#dce3ed]">{filename}</p>
            <p className="text-xs mt-1 text-[#859398]">{LABELS.NO_METADATA}</p>
          </div>
        )}

        {/* Fingerprint */}
        {showFingerprint && fingerprint && (
          <div className="space-y-2 pt-3 border-t border-[#3c494e]/15">
            <div className="flex items-center justify-between">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[#859398] cursor-help">
                      {LABELS.FINGERPRINT_LABEL}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{LABELS.FINGERPRINT_TOOLTIP}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-[#bbc9cf] hover:text-[#00d4ff]"
                onClick={handleCopyFingerprint}
                aria-label={LABELS.COPY_FINGERPRINT}
              >
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
            <div className="font-mono text-xs bg-[#080f16] text-[#5fd6eb] rounded-lg px-4 py-3 break-all border border-[#3c494e]/10">
              {fingerprint}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
