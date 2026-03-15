/**
 * Issuer Registry Page
 *
 * Public page at /issuer/:orgId showing an org's verified credentials.
 * No auth required. Only shows data for orgs with public profiles.
 *
 * @see UF-02
 */

import { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Building2, ArrowLeft, Loader2, Award } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CredentialCard } from '@/components/search/CredentialCard';
import { useIssuerRegistry } from '@/hooks/usePublicSearch';
import { SEARCH_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

export function IssuerRegistryPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { registry, loading, error, fetchRegistry } = useIssuerRegistry();

  useEffect(() => {
    if (orgId) {
      fetchRegistry(orgId);
    }
  }, [orgId, fetchRegistry]);

  if (loading) {
    return (
      <div className="min-h-screen bg-mesh-gradient">
        <div className="bg-dot-pattern min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (error || !registry) {
    return (
      <div className="min-h-screen bg-mesh-gradient">
        <div className="bg-dot-pattern min-h-screen">
          <div className="container max-w-3xl mx-auto px-4 py-12">
            <Card className="glass-card">
              <CardContent className="py-12 text-center">
                <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">
                  {error ?? SEARCH_LABELS.NO_RESULTS}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {SEARCH_LABELS.NO_RESULTS_DESC}
                </p>
                <Link to={ROUTES.SEARCH} className="mt-4 inline-block">
                  <Button variant="outline" size="sm">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {SEARCH_LABELS.PAGE_TITLE}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mesh-gradient">
      <div className="bg-dot-pattern min-h-screen">
        <div className="container max-w-3xl mx-auto px-4 py-12">
          {/* Back link */}
          <Link to={ROUTES.SEARCH} className="inline-block mb-6">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              {SEARCH_LABELS.PAGE_TITLE}
            </Button>
          </Link>

          {/* Issuer header */}
          <div className="glass-card rounded-xl p-6 mb-8 shadow-card-rest animate-in-view">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
                <Building2 className="h-7 w-7 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight truncate">
                  {registry.org_name}
                </h1>
                {registry.org_domain && (
                  <p className="text-sm text-muted-foreground">{registry.org_domain}</p>
                )}
              </div>
              <Badge variant="secondary" className="ml-auto gap-1 shrink-0">
                <Award className="h-3.5 w-3.5" />
                {SEARCH_LABELS.CREDENTIALS_COUNT.replace('{count}', String(registry.total))}
              </Badge>
            </div>
          </div>

          {/* Credentials list */}
          <h2 className="text-lg font-semibold mb-4 animate-in-view stagger-1">
            {SEARCH_LABELS.ISSUER_REGISTRY_TITLE}
          </h2>

          {registry.anchors.length > 0 ? (
            <div className="space-y-3">
              {registry.anchors.map((anchor, i) => (
                <div key={anchor.public_id} className={`stagger-${Math.min(i + 2, 8)}`}>
                  <CredentialCard anchor={anchor} />
                </div>
              ))}
            </div>
          ) : (
            <Card className="glass-card">
              <CardContent className="py-12 text-center">
                <Award className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {SEARCH_LABELS.NO_RESULTS}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
