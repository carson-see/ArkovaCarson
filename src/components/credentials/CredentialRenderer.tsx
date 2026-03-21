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

import { Award, Building2, Calendar, Copy, Check, GraduationCap, Shield, ScrollText, BadgeCheck, FileText } from 'lucide-react';
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
} from '@/lib/copy';
import type { TemplateDisplayData } from '@/hooks/useCredentialTemplate';

/** Status badge color mapping */
const STATUS_COLORS: Record<string, string> = {
  SECURED: 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/30',
  ACTIVE: 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/30',
  SUBMITTED: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  PENDING: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  REVOKED: 'bg-red-500/15 text-red-400 border border-red-500/30',
  EXPIRED: 'bg-[#859398]/15 text-[#859398] border border-[#859398]/30',
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
    label: 'Academic Credential',
  },
  CERTIFICATE: {
    icon: BadgeCheck,
    accentColor: 'text-[#5fd6eb]',
    borderAccent: 'border-l-[#5fd6eb]',
    bgGradient: 'from-[#5fd6eb]/8 to-transparent',
    label: 'Certified Achievement',
  },
  LICENSE: {
    icon: Shield,
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
    label: 'Professional Credential',
  },
  OTHER: {
    icon: FileText,
    accentColor: 'text-[#bbc9cf]',
    borderAccent: 'border-l-[#3c494e]',
    bgGradient: 'from-[#bbc9cf]/5 to-transparent',
    label: 'Document Record',
  },
};

export interface CredentialRendererProps {
  credentialType?: string | null;
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
}

export function CredentialRenderer({
  credentialType,
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
}: Readonly<CredentialRendererProps>) {
  const [copied, setCopied] = useState(false);

  const typeKey = credentialType ?? 'OTHER';
  const config = TYPE_CONFIG[typeKey] ?? TYPE_CONFIG.OTHER;
  const TypeIcon = config.icon;

  const credentialLabel = credentialType
    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[credentialType] ?? credentialType
    : null;

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
    return String(value);
  };

  // Determine rendering mode
  const hasTemplate = template && template.fields.length > 0;
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  // Build field list for display
  const displayFields: { label: string; value: string }[] = [];

  if (hasTemplate && hasMetadata) {
    for (const field of template.fields) {
      const raw = metadata[field.key];
      const formatted = formatFieldValue(raw, field.type);
      if (formatted) {
        displayFields.push({ label: field.label, value: formatted });
      }
    }
  } else if (hasMetadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (key.startsWith('_') || key === 'recipient' || key === 'jurisdiction') continue;
      const formatted = formatFieldValue(value);
      if (formatted) {
        const label = key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        displayFields.push({ label, value: formatted });
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
      <div className={`bg-gradient-to-r ${config.bgGradient} px-6 py-5`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#242b32] border border-[#3c494e]/20 shrink-0">
              <TypeIcon className={`h-6 w-6 ${config.accentColor}`} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-[#859398] mb-1">
                {config.label}
              </p>
              <h3 className="font-bold text-lg text-[#dce3ed] truncate">
                {template?.name ?? credentialLabel ?? LABELS.DOCUMENT_RECORD}
              </h3>
              {credentialLabel && template?.name && (
                <p className="text-xs text-[#bbc9cf]">{credentialLabel}</p>
              )}
            </div>
          </div>
          {statusLabel && (
            <Badge className={`shrink-0 ${statusColor}`}>
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
