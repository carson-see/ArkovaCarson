/**
 * Issuer Card
 *
 * Displays a public issuer search result with org name, domain,
 * credential count, and link to their public registry.
 *
 * @see UF-02
 */

import { Building2, Award, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { SEARCH_LABELS } from '@/lib/copy';
import { issuerRegistryPath } from '@/lib/routes';
import type { IssuerResult } from '@/hooks/usePublicSearch';

interface IssuerCardProps {
  issuer: IssuerResult;
}

export function IssuerCard({ issuer }: Readonly<IssuerCardProps>) {
  return (
    <Link
      to={issuerRegistryPath(issuer.org_id)}
      className="glass-card rounded-xl p-5 shadow-card-rest hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 animate-in-view group"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
          <Building2 className="h-6 w-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-base truncate group-hover:text-primary transition-colors">
            {issuer.org_name}
          </h3>
          {issuer.org_domain && (
            <p className="text-sm text-muted-foreground truncate">
              {issuer.org_domain}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="secondary" className="gap-1">
              <Award className="h-3 w-3" />
              {SEARCH_LABELS.CREDENTIALS_COUNT.replace('{count}', String(issuer.credential_count))}
            </Badge>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
      </div>
    </Link>
  );
}
