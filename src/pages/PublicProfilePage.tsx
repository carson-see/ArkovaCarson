/**
 * Public member profile.
 *
 * Route: /profile/:profileId
 * Only profiles with is_public_profile=true are returned by the RPC.
 */

import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, ExternalLink, Globe, Loader2, User } from 'lucide-react';
import { usePublicMemberProfile } from '@/hooks/usePublicSearch';
import { ROUTES, issuerRegistryPath } from '@/lib/routes';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { OrgVerifiedBadge } from '@/components/shared/VerifiedBadge';

function getInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatRole(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

function normalizeUrl(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

export function PublicProfilePage() {
  const { profileId } = useParams<{ profileId: string }>();
  const { profile, loading, error, fetchProfile } = usePublicMemberProfile();

  useEffect(() => {
    if (profileId) void fetchProfile(profileId);
  }, [fetchProfile, profileId]);

  if (loading && !profile) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff]" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container max-w-3xl mx-auto px-4 py-12">
          <Card className="bg-transparent border-[#3c494e]/30">
            <CardContent className="py-12 text-center">
              <User className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                {error ?? 'Profile not found'}
              </p>
              <Link to={ROUTES.SEARCH} className="mt-4 inline-block">
                <Button variant="outline" size="sm">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Search
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const links = profile.social_links ?? {};

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <Link
          to={ROUTES.SEARCH}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Search
        </Link>

        <div className="rounded-2xl border border-[#00d4ff]/10 bg-gradient-to-br from-[#0d141b] to-[#111a24] p-6 sm:p-8 mb-6">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6 text-center sm:text-left">
            <Avatar className="h-20 w-20 border border-[#00d4ff]/20">
              <AvatarImage src={profile.avatar_url ?? undefined} />
              <AvatarFallback className="bg-[#192028] text-[#00d4ff] text-xl">
                {getInitials(profile.display_name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
                {profile.display_name}
              </h1>
              {profile.bio && (
                <p className="text-[#bbc9cf] text-sm mt-2 leading-relaxed">
                  {profile.bio}
                </p>
              )}
              <div className="flex flex-wrap justify-center sm:justify-start gap-2 mt-4">
                {Object.entries(links)
                  .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
                  .map(([key, value]) => (
                    <a
                      key={key}
                      href={normalizeUrl(value)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-[#3c494e]/30 rounded-full px-3 py-1 hover:bg-[#192028] transition-colors"
                    >
                      {key}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  ))}
              </div>
            </div>
          </div>
        </div>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Organizations
          </h2>
          {profile.organizations.length > 0 ? (
            <div className="space-y-2">
              {profile.organizations.map((org) => (
                <Link key={org.org_id} to={issuerRegistryPath(org.org_id)} className="block">
                  <Card className="bg-transparent border-[#3c494e]/30 hover:border-[#00d4ff]/30 transition-colors">
                    <CardContent className="p-4 flex items-center gap-3">
                      {org.logo_url ? (
                        <img
                          src={org.logo_url}
                          alt={`${org.display_name} logo`}
                          className="h-10 w-10 rounded-md object-contain bg-[#192028] p-1"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#192028]">
                          <Building2 className="h-5 w-5 text-[#00d4ff]" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium truncate">{org.display_name}</p>
                          {org.verification_status === 'VERIFIED' && <OrgVerifiedBadge />}
                          <Badge variant="outline" className="text-xs">{formatRole(org.role)}</Badge>
                        </div>
                        {org.domain && (
                          <p className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-1">
                            <Globe className="h-3 w-3" />
                            {org.domain}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="bg-transparent border-[#3c494e]/30">
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No public organizations yet</p>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
