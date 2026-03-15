/**
 * Revocation Details
 *
 * Displays revocation reason and date for REVOKED anchors
 * on the public verification page.
 *
 * @see UF-07
 */

import { Ban, Calendar } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';

interface RevocationDetailsProps {
  revocationReason?: string | null;
  revokedAt?: string | null;
}

export function RevocationDetails({
  revocationReason,
  revokedAt,
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
        </div>
      </AlertDescription>
    </Alert>
  );
}
