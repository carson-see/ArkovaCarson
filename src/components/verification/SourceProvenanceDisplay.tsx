/**
 * Source Provenance Display (CSI-03 / SCRUM-1599)
 *
 * Shows source URL, provider, evidence level, and fetch time
 * on public verification pages when CSI metadata is available.
 *
 * Safety:
 * - source_url is sanitized before display (tokens/secrets stripped)
 * - Only shown when URL is deemed safe
 * - Internal IDs never exposed
 */

import { ExternalLink, Calendar, Globe } from 'lucide-react';
import { SOURCE_PROVENANCE_LABELS } from '@/lib/copy';
import { EvidenceLevelBadge } from './EvidenceLevelBadge';
import {
  sanitizeSourceUrl,
  formatProvider,
  parseVerificationLevel,
  type SourceProvenanceData,
} from '@/lib/sourceProvenance';

interface SourceProvenanceDisplayProps {
  data: SourceProvenanceData;
  className?: string;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

/**
 * Truncate a URL for display, keeping domain + first path segment.
 */
function truncateUrl(url: string, maxLength = 60): string {
  if (url.length <= maxLength) return url;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const pathSegments = path.split('/').filter(Boolean);
    const display = `${parsed.hostname}/${pathSegments.slice(0, 2).join('/')}${pathSegments.length > 2 ? '/...' : ''}`;
    return display;
  } catch {
    return url.slice(0, maxLength) + '...';
  }
}

export function SourceProvenanceDisplay({
  data,
  className,
}: Readonly<SourceProvenanceDisplayProps>) {
  const safeUrl = sanitizeSourceUrl(data.source_url);
  const provider = formatProvider(data.source_provider);
  const verificationLevel = parseVerificationLevel(data.verification_level);
  const hasAnyContent = safeUrl || provider || verificationLevel || data.fetched_at;

  if (!hasAnyContent) return null;

  return (
    <div className={`space-y-3 ${className ?? ''}`} data-testid="source-provenance-display">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Globe className="h-3.5 w-3.5" />
        {SOURCE_PROVENANCE_LABELS.SECTION_TITLE}
      </h4>

      <div className="space-y-2">
        {/* Evidence Level */}
        {verificationLevel && (
          <EvidenceLevelBadge
            level={verificationLevel}
            showDescription
          />
        )}

        {/* Source URL */}
        {safeUrl && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground shrink-0">
              {SOURCE_PROVENANCE_LABELS.SOURCE_URL_LABEL}:
            </span>
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1 truncate"
              data-testid="source-url-link"
            >
              <span className="truncate">{truncateUrl(safeUrl)}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </div>
        )}

        {/* Provider */}
        {provider && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground shrink-0">
              {SOURCE_PROVENANCE_LABELS.PROVIDER_LABEL}:
            </span>
            <span>{provider}</span>
          </div>
        )}

        {/* Fetched At */}
        {data.fetched_at && (
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground shrink-0">
              {SOURCE_PROVENANCE_LABELS.FETCHED_AT_LABEL}:
            </span>
            <span className="text-sm">{formatDate(data.fetched_at)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
