/**
 * Credential Renderer
 *
 * Renders a credential card using template field schema + anchor metadata.
 * Templates define the display structure; metadata provides the values.
 * This is how Arkova shows records without storing documents (Constitution 1.6).
 *
 * Three rendering modes:
 * 1. Template + metadata: structured card with labeled fields
 * 2. No template, has metadata: key-value pairs from metadata
 * 3. No metadata: filename + fingerprint + status only
 *
 * @see UF-01
 */

import { Award, Building2, Calendar, Copy, Check } from 'lucide-react';
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
  SECURED: 'bg-green-600 hover:bg-green-700 text-white',
  ACTIVE: 'bg-green-600 hover:bg-green-700 text-white',
  PENDING: 'bg-amber-500 hover:bg-amber-600 text-white',
  REVOKED: 'bg-gray-500 hover:bg-gray-600 text-white',
  EXPIRED: 'bg-gray-500 hover:bg-gray-600 text-white',
};

export interface CredentialRendererProps {
  /** Anchor's credential_type enum value */
  credentialType?: string | null;
  /** Anchor's metadata JSONB values */
  metadata?: Record<string, unknown> | null;
  /** Parsed template display data (from useCredentialTemplate) */
  template?: TemplateDisplayData | null;
  /** Issuer organization name */
  issuerName?: string | null;
  /** Anchor status */
  status?: string;
  /** Anchor filename */
  filename?: string;
  /** Anchor fingerprint (SHA-256) */
  fingerprint?: string;
  /** Issued date (ISO string) */
  issuedDate?: string | null;
  /** Expiry date (ISO string) */
  expiryDate?: string | null;
  /** Whether to show the fingerprint section */
  showFingerprint?: boolean;
  /** Whether to show compact mode (for table rows) */
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
    // Mode 1: Template + metadata — structured fields
    for (const field of template.fields) {
      const raw = metadata[field.key];
      const formatted = formatFieldValue(raw, field.type);
      if (formatted) {
        displayFields.push({ label: field.label, value: formatted });
      }
    }
  } else if (hasMetadata) {
    // Mode 2: No template, has metadata — key-value pairs
    for (const [key, value] of Object.entries(metadata)) {
      // Skip internal fields
      if (key.startsWith('_') || key === 'recipient' || key === 'jurisdiction') continue;
      const formatted = formatFieldValue(value);
      if (formatted) {
        // Convert snake_case key to Title Case label
        const label = key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        displayFields.push({ label, value: formatted });
      }
    }
  }

  // Compact mode for table row previews
  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
          <Award className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {template?.name ?? credentialLabel ?? filename ?? 'Record'}
          </p>
          {issuerName && (
            <p className="text-xs text-muted-foreground truncate">{issuerName}</p>
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
    <div className="glass-card rounded-xl overflow-hidden shadow-card-rest hover:shadow-card-hover transition-all duration-300 animate-in-view">
      {/* Header: credential type + status */}
      <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
              <Award className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold truncate">
                {template?.name ?? credentialLabel ?? LABELS.DOCUMENT_RECORD}
              </h3>
              {credentialLabel && template?.name && (
                <p className="text-xs text-muted-foreground">{credentialLabel}</p>
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

      <div className="px-6 py-4 space-y-4">
        {/* Issuer */}
        {issuerName && (
          <div className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">{LABELS.ISSUED_BY}</span>
            <span className="font-medium">{issuerName}</span>
          </div>
        )}

        {/* Dates row */}
        {(issuedDate || expiryDate) && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {issuedDate && (
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">{LABELS.ISSUED_ON}:</span>
                <span>{formatDate(issuedDate)}</span>
              </div>
            )}
            {expiryDate && (
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">{LABELS.EXPIRES_ON}:</span>
                <span>{formatDate(expiryDate)}</span>
              </div>
            )}
          </div>
        )}

        {/* Metadata fields grid */}
        {displayFields.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {displayFields.map((field) => (
              <div key={field.label} className="space-y-0.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {field.label}
                </dt>
                <dd className="text-sm">{field.value}</dd>
              </div>
            ))}
          </div>
        )}

        {/* No metadata fallback */}
        {displayFields.length === 0 && !hasMetadata && filename && (
          <div className="text-sm text-muted-foreground">
            <p>{filename}</p>
            <p className="text-xs mt-1">{LABELS.NO_METADATA}</p>
          </div>
        )}

        {/* Fingerprint */}
        {showFingerprint && fingerprint && (
          <div className="space-y-1.5 pt-2 border-t">
            <div className="flex items-center justify-between">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground cursor-help">
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
                className="h-6 px-2 text-xs"
                onClick={handleCopyFingerprint}
              >
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
            <div className="font-mono text-xs bg-muted rounded px-3 py-2 break-all">
              {fingerprint}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
