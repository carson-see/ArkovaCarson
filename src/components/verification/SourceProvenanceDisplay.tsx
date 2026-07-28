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
  type VerificationLevel,
} from '@/lib/sourceProvenance';

interface SourceProvenanceDisplayProps {
  data: SourceProvenanceData;
  className?: string;
}

/**
 * Measured / asserted / NOT-asserted triad per §1.5 (honesty; SCRUM-2481).
 *
 * Local-const fallback (FE-D): the canonical strings move into a titled additive
 * block in `src/lib/copy.ts` once the copy.ts-touching soaking PRs merge. Until
 * then they live here so the component ships without an early copy.ts land.
 *
 * INVARIANT: every non-issuer tier (account_linked / captured_url / ai_captured)
 * MUST list "issuer identity" under `notAsserted` — the credential's off-platform
 * surface can never imply the issuer stood behind it. Enforced by test.
 */
interface EvidenceTriad {
  measured: string;
  asserted: string;
  notAsserted: string;
}

/**
 * Row labels for the triad. Local-const fallback (FE-D) — moves to a titled
 * additive block in `src/lib/copy.ts` after the copy.ts soakers merge.
 */
const SOURCE_PROVENANCE_TRIAD_LABELS = {
  MEASURED: 'Measured',
  ASSERTED: 'Asserted',
  NOT_ASSERTED: 'Not asserted',
} as const;

const EVIDENCE_TRIAD_FALLBACK: Record<VerificationLevel, EvidenceTriad> = {
  issuer_anchored: {
    measured: 'The document fingerprint and the time it was anchored.',
    asserted: 'Issuer identity — anchored directly by the issuing organization.',
    notAsserted: 'The real-world facts the document describes (e.g. skills held).',
  },
  source_signed: {
    measured: 'The document fingerprint and the source signature.',
    asserted: 'Issuer origin — a cryptographic signature proves the source.',
    notAsserted: 'The real-world facts the document describes.',
  },
  account_linked: {
    measured: 'The fingerprint of the record imported from the connected account.',
    asserted: 'That the holder had access to the linked account.',
    notAsserted: 'Issuer identity — the originating organization did not vouch for this record.',
  },
  captured_url: {
    measured: 'The fingerprint of the page content and the time it was captured.',
    asserted: 'What was present at the public URL when it was captured.',
    notAsserted: 'Issuer identity — who published the page is not verified.',
  },
  ai_captured: {
    measured: 'The fingerprint of the uploaded document and its AI-extracted fields.',
    asserted: 'The structured content an AI parsed from the document.',
    notAsserted: 'Issuer identity — the source of the document is not established.',
  },
};

function formatDate(dateStr: string): string | null {
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleString('en-US', {
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
  const fetchedAt = data.fetched_at ? formatDate(data.fetched_at) : null;
  const hasEvidencePackage = Boolean(data.evidence_package_hash || data.source_payload_hash);
  // SCRUM-2913 (Lane 2 wiring): CE Registry provenance link, sanitized the
  // same way as source_url (strip tokens/secrets, http(s)-only) before it is
  // ever rendered as a clickable link.
  const registryUrl = sanitizeSourceUrl(data.registry_url);
  const hasAnyContent = safeUrl || provider || verificationLevel || fetchedAt || hasEvidencePackage || registryUrl;

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

        {/* Measured / asserted / NOT-asserted triad (§1.5 honesty, SCRUM-2481) */}
        {verificationLevel && (
          <dl
            className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs space-y-1"
            data-testid="evidence-triad"
            data-evidence-tier={verificationLevel}
          >
            <div className="flex gap-1.5">
              <dt className="font-medium text-muted-foreground shrink-0">
                {SOURCE_PROVENANCE_TRIAD_LABELS.MEASURED}:
              </dt>
              <dd data-testid="evidence-triad-measured">
                {EVIDENCE_TRIAD_FALLBACK[verificationLevel].measured}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-medium text-muted-foreground shrink-0">
                {SOURCE_PROVENANCE_TRIAD_LABELS.ASSERTED}:
              </dt>
              <dd data-testid="evidence-triad-asserted">
                {EVIDENCE_TRIAD_FALLBACK[verificationLevel].asserted}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-medium text-amber-700 dark:text-amber-400 shrink-0">
                {SOURCE_PROVENANCE_TRIAD_LABELS.NOT_ASSERTED}:
              </dt>
              <dd data-testid="evidence-triad-not-asserted">
                {EVIDENCE_TRIAD_FALLBACK[verificationLevel].notAsserted}
              </dd>
            </div>
          </dl>
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
        {fetchedAt && (
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground shrink-0">
              {SOURCE_PROVENANCE_LABELS.FETCHED_AT_LABEL}:
            </span>
            <span className="text-sm">{fetchedAt}</span>
          </div>
        )}

        {hasEvidencePackage && (
          <div className="text-sm" data-testid="source-evidence-package">
            <span className="text-muted-foreground">
              {SOURCE_PROVENANCE_LABELS.PROOF_SECTION_TITLE}:
            </span>{' '}
            <span>{SOURCE_PROVENANCE_LABELS.PROOF_SECTION_DESCRIPTION}</span>
          </div>
        )}

        {/* CE Registry reference (SCRUM-2913, Lane 2 wiring). R-7 §1.13: a
            provenance link only — never rendered as a listing/endorsement
            claim. Distinct row from Source URL above (a registry record vs.
            the credential's own issuer page can both be present). */}
        {registryUrl && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground shrink-0">
              {SOURCE_PROVENANCE_LABELS.REGISTRY_REFERENCE_LABEL}:
            </span>
            <a
              href={registryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1 truncate"
              data-testid="registry-reference-link"
            >
              <span className="truncate">{truncateUrl(registryUrl)}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </div>
        )}
        {registryUrl && (
          <p className="text-xs text-muted-foreground" data-testid="registry-reference-description">
            {SOURCE_PROVENANCE_LABELS.REGISTRY_REFERENCE_DESCRIPTION}
          </p>
        )}
      </div>
    </div>
  );
}
