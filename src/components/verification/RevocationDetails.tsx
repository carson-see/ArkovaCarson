/**
 * Revocation Details
 *
 * Displays revocation reason and date for REVOKED anchors
 * on the public verification page.
 *
 * @see UF-07
 */

import { Ban, Calendar, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';
import { getExplorerTxUrl } from '@/lib/explorer';

interface RevocationDetailsProps {
  revocationReason?: string | null;
  revokedAt?: string | null;
  /** Network receipt ID for the revocation OP_RETURN (BETA-02) */
  revocationTxId?: string | null;
}

export function RevocationDetails({
  revocationReason,
  revokedAt,
  revocationTxId,
}: Readonly<RevocationDetailsProps>) {
  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC';

  return (
    <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
      <Ban className="h-4 w-4" />
      <AlertDescription className="space-y-2">
        <p className="font-medium text-sm">
          {VERIFICATION_DISPLAY_LABELS.REVOCATION_SECTION}
        </p>
        <div className="space-y-1 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0">
              {VERIFICATION_DISPLAY_LABELS.REVOCATION_REASON}:
            </span>
            <span>
              {revocationReason || VERIFICATION_DISPLAY_LABELS.NO_REVOCATION_REASON}
            </span>
          </div>
          {revokedAt && (
            <div className="flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                {VERIFICATION_DISPLAY_LABELS.REVOCATION_DATE}:
              </span>
              <span>{formatDate(revokedAt)}</span>
            </div>
          )}
          {revocationTxId && (
            <div className="flex items-center gap-2">
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                {VERIFICATION_DISPLAY_LABELS.REVOCATION_RECEIPT}:
              </span>
              <a
                href={getExplorerTxUrl(revocationTxId) ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs underline underline-offset-2 hover:text-destructive truncate max-w-[200px]"
                title={revocationTxId}
              >
                {revocationTxId.slice(0, 8)}...{revocationTxId.slice(-8)}
              </a>
            </div>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
