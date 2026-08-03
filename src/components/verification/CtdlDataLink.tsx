/**
 * CTDL Data Link (public verify page)
 *
 * Links to the existing public CTDL JSON-LD projection
 * (`GET /api/v1/credentials/:publicId/ctdl`,
 * services/worker/src/api/v1/credentials-ctdl.ts) so the structured-data
 * export this record already has is actually DISCOVERABLE from the page
 * that shows the record. Before this component, that endpoint — mature,
 * heavily tested, standards-conformant — was linked from nowhere in the
 * product: not the verify page, not the credential detail view, nowhere. A
 * capability with zero UI surface is invisible to a user, a founder demo, or
 * a Credential Engine evaluator looking at the live product.
 *
 * Gating: the caller decides whether to render this at all, using
 * `hasPublicVerificationProof(status)` (src/lib/publicVerificationState.ts) —
 * the exact same set (SECURED/REVOKED/EXPIRED/SUPERSEDED) as the worker's own
 * `isCtdlPublishableStatus` (services/worker/src/ctdl/ctdl-type-map.ts). A
 * PENDING/SUBMITTED anchor is not yet an issued credential and the endpoint
 * 404s for it, so this link must never render for one.
 *
 * R-7 (§1.13) / CE-06a: this is a data-FORMAT link, never a Registry-listing
 * or publication-status claim — see ctdl-claims-guard.ts for the banned
 * phrase set this copy is written to avoid.
 */
import { ExternalLink, FileJson2 } from 'lucide-react';
import { WORKER_URL } from '@/lib/workerClient';
import { CTDL_DATA_LINK_LABELS } from '@/lib/copy';

interface CtdlDataLinkProps {
  publicId: string;
  className?: string;
}

/** Full public URL for a record's CTDL JSON-LD projection. Anonymous GET, no auth. */
export function ctdlDataUrl(publicId: string): string {
  return `${WORKER_URL}/api/v1/credentials/${encodeURIComponent(publicId)}/ctdl`;
}

export function CtdlDataLink({ publicId, className }: Readonly<CtdlDataLinkProps>) {
  return (
    <div
      className={`flex items-center gap-2 text-sm ${className ?? ''}`}
      data-testid="ctdl-data-link-row"
    >
      <FileJson2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground shrink-0">
        {CTDL_DATA_LINK_LABELS.SECTION_LABEL}:
      </span>
      <a
        href={ctdlDataUrl(publicId)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline inline-flex items-center gap-1"
        data-testid="ctdl-data-link"
      >
        {CTDL_DATA_LINK_LABELS.LINK_TEXT}
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    </div>
  );
}
