/**
 * Credential Card
 *
 * Displays a credential in an issuer's public registry.
 * Shows credential type, filename, issued date, and verify link.
 *
 * @see UF-02
 */

import { Award, Calendar, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { CREDENTIAL_TYPE_LABELS, SEARCH_LABELS } from '@/lib/copy';
import { verifyPath } from '@/lib/routes';
import type { IssuerRegistryAnchor } from '@/hooks/usePublicSearch';

interface CredentialCardProps {
  anchor: IssuerRegistryAnchor;
}

export function CredentialCard({ anchor }: Readonly<CredentialCardProps>) {
  const typeLabel = anchor.credential_type
    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[anchor.credential_type] ?? anchor.credential_type
    : null;

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  return (
    <div className="glass-card rounded-xl p-4 shadow-card-rest hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 animate-in-view">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
          <Award className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {anchor.label ?? anchor.filename}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {typeLabel && (
              <Badge variant="outline" className="text-xs">
                {typeLabel}
              </Badge>
            )}
            {anchor.issued_at && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {SEARCH_LABELS.ISSUED_ON} {formatDate(anchor.issued_at)}
              </span>
            )}
          </div>
        </div>
        <Link
          to={verifyPath(anchor.public_id)}
          className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
        >
          {SEARCH_LABELS.VERIFY_LINK}
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
