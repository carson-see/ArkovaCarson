/**
 * Issuer Registry Page — Public Organization Profile
 *
 * LinkedIn/Crunchbase-inspired company profile page at /issuer/:orgId.
 * No auth required. Shows org details, credential stats, and recent records.
 *
 * @see UF-02
 */

import { useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useParams, Link } from 'react-router-dom';
import { Building2, ArrowLeft, Loader2, Globe, MapPin, Calendar, ExternalLink, Award, FileText, Scale, Landmark, BookOpen, Briefcase, CheckCircle2, Users, Network } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CredentialCard } from '@/components/search/CredentialCard';
import { useIssuerRegistry, useOrgProfile } from '@/hooks/usePublicSearch';
import { CREDENTIAL_TYPE_LABELS, INDUSTRY_TAG_LABELS } from '@/lib/copy';
import { ROUTES, getAppBaseUrl, issuerRegistryPath, publicProfilePath } from '@/lib/routes';
import { isSearchSubdomain } from '@/App';
import { OrganizationSchema } from '@/components/seo/OrganizationSchema';
import { OrgPageMeta } from '@/components/seo/OrgPageMeta';

/** Map credential types to icons */
function credentialIcon(type: string | null) {
  switch (type) {
    case 'PUBLICATION': return <BookOpen className="h-4 w-4" />;
    case 'SEC_FILING': return <Landmark className="h-4 w-4" />;
    case 'LEGAL': return <Scale className="h-4 w-4" />;
    case 'PROFESSIONAL': return <Briefcase className="h-4 w-4" />;
    case 'CERTIFICATE': return <Award className="h-4 w-4" />;
    default: return <FileText className="h-4 w-4" />;
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatOrgType(type: string | null): string {
  if (!type) return 'Organization';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatRole(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

export function IssuerRegistryPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { profile, loading: profileLoading, error: profileError, fetchProfile } = useOrgProfile();
  const { registry, loading: registryLoading, fetchRegistry } = useIssuerRegistry();
  const standalone = isSearchSubdomain();

  useEffect(() => {
    if (orgId) {
      fetchProfile(orgId);
      fetchRegistry(orgId);
    }
  }, [orgId, fetchProfile, fetchRegistry]);

  const loading = profileLoading || registryLoading;

  if (loading && !profile) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff]" />
      </div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container max-w-4xl mx-auto px-4 py-12">
          <Card className="bg-transparent border-[#3c494e]/30">
            <CardContent className="py-12 text-center">
              <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                {profileError ?? 'Organization not found'}
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

  const securedPct = profile.total_credentials > 0
    ? Math.round((profile.secured_credentials / profile.total_credentials) * 100)
    : 0;

  const pageUrl = `${getAppBaseUrl()}${issuerRegistryPath(profile.org_id)}`;

  return (
    <div className="min-h-screen bg-background">
      <OrganizationSchema profile={profile} pageUrl={pageUrl} />
      <OrgPageMeta profile={profile} pageUrl={pageUrl} />
      <div className="container max-w-4xl mx-auto px-4 py-8">
        {/* Back nav */}
        <Link
          to={ROUTES.SEARCH}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Search
        </Link>

        {/* ── Hero Header ─────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-[#00d4ff]/10 bg-gradient-to-br from-[#0d141b] to-[#111a24] p-6 sm:p-8 mb-6">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6">
            {/* Logo */}
            <div className="shrink-0">
              {profile.logo_url ? (
                <img
                  src={profile.logo_url}
                  alt={`${profile.display_name} organization logo`}
                  className="h-16 w-16 sm:h-20 sm:w-20 rounded-2xl object-contain bg-[#192028] p-2"
                />
              ) : (
                <div className="flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-2xl bg-[#192028]">
                  <Building2 className="h-8 w-8 sm:h-10 sm:w-10 text-[#00d4ff]" />
                </div>
              )}
            </div>

            {/* Name + meta */}
            <div className="flex-1 min-w-0 text-center sm:text-left">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-3 mb-1">
                <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
                  {profile.display_name}
                </h1>
                {profile.verification_status === 'VERIFIED' && (
                  <Badge className="bg-[#00d4ff]/10 text-[#00d4ff] border-[#00d4ff]/20 gap-1 shrink-0">
                    <CheckCircle2 className="h-3 w-3" />
                    Verified
                  </Badge>
                )}
                {profile.industry_tag && (
                  <Badge variant="outline" className="text-xs shrink-0 border-[#3c494e]/40 text-[#bbc9cf]">
                    {INDUSTRY_TAG_LABELS[profile.industry_tag] ?? profile.industry_tag}
                  </Badge>
                )}
              </div>

              {profile.description && (
                <p className="text-[#bbc9cf] text-sm mb-3 line-clamp-2">
                  {profile.description}
                </p>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {profile.org_type && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {formatOrgType(profile.org_type)}
                  </span>
                )}
                {profile.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {profile.location}
                  </span>
                )}
                {profile.founded_date && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Founded {new Date(profile.founded_date).getFullYear()}
                  </span>
                )}
                {profile.domain && (
                  <a
                    href={profile.domain.startsWith('http') ? profile.domain : `https://${profile.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-[#00d4ff] transition-colors"
                  >
                    <Globe className="h-3 w-3" />
                    {profile.domain}
                  </a>
                )}
              </div>

              {/* Links */}
              <div className="flex justify-center sm:justify-start gap-2 mt-4">
                {profile.website_url && (
                  <a
                    href={profile.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-[#00d4ff] hover:text-[#00d4ff]/80 border border-[#00d4ff]/20 rounded-full px-3 py-1 hover:bg-[#00d4ff]/5 transition-colors"
                  >
                    <Globe className="h-3 w-3" />
                    Website
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
                {profile.twitter_url && (
                  <a
                    href={profile.twitter_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-[#3c494e]/30 rounded-full px-3 py-1 hover:bg-[#192028] transition-colors"
                  >
                    X / Twitter
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
                {profile.linkedin_url && (
                  <a
                    href={profile.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-[#3c494e]/30 rounded-full px-3 py-1 hover:bg-[#192028] transition-colors"
                  >
                    LinkedIn
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Stats Cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card className="bg-transparent border-[#3c494e]/30">
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-black text-[#00d4ff]">
                {formatNumber(profile.total_credentials)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Total Records</p>
            </CardContent>
          </Card>
          <Card className="bg-transparent border-[#3c494e]/30">
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-black text-green-400">
                {formatNumber(profile.secured_credentials)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Network Secured</p>
            </CardContent>
          </Card>
          <Card className="bg-transparent border-[#3c494e]/30">
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-1.5">
                <ArkovaIcon className="h-5 w-5 text-[#00d4ff]" />
                <p className="text-2xl font-black">{securedPct}%</p>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Verification Rate</p>
            </CardContent>
          </Card>
        </div>

        {/* ── Members ─────────────────────────────────────────────────── */}
        {(profile.public_members ?? []).length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <Users className="h-4 w-4" />
              Members
            </h2>
            <Card className="bg-transparent border-[#3c494e]/30">
              <CardContent className="p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(profile.public_members ?? []).slice(0, 12).map((member) => {
                    const body = (
                      <div className="flex items-center gap-3 rounded-lg border border-[#3c494e]/25 p-3 hover:border-[#00d4ff]/25 transition-colors">
                        {member.avatar_url ? (
                          <img
                            src={member.avatar_url}
                            alt={`${member.display_name} profile`}
                            className="h-9 w-9 rounded-full object-cover bg-[#192028]"
                          />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#192028]">
                            <Users className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{member.display_name}</p>
                          <p className="text-xs text-muted-foreground">{formatRole(member.role)}</p>
                        </div>
                        {member.is_public_profile && (
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                      </div>
                    );

                    if (member.profile_public_id) {
                      return (
                        <Link key={member.profile_public_id} to={publicProfilePath(member.profile_public_id)}>
                          {body}
                        </Link>
                      );
                    }

                    return <div key={member.member_key ?? `anonymous-${member.role}-${member.display_name}`}>{body}</div>;
                  })}
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* ── Sub Organizations ───────────────────────────────────────── */}
        {(profile.sub_organizations ?? []).length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <Network className="h-4 w-4" />
              Sub Organizations
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(profile.sub_organizations ?? []).map((org) => (
                <Link key={org.org_id} to={issuerRegistryPath(org.org_id)}>
                  <Card className="bg-transparent border-[#3c494e]/30 hover:border-[#00d4ff]/30 transition-colors h-full">
                    <CardContent className="p-4 flex items-center gap-3">
                      {org.logo_url ? (
                        <img
                          src={org.logo_url}
                          alt={`${org.display_name} logo`}
                          className="h-10 w-10 rounded-md object-contain bg-[#192028] p-1"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#192028]">
                          <Building2 className="h-5 w-5 text-[#00d4ff]" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{org.display_name}</p>
                          {org.verification_status === 'VERIFIED' && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#00d4ff] shrink-0" />
                          )}
                        </div>
                        {org.domain && (
                          <p className="text-xs text-muted-foreground truncate">{org.domain}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ── Credential Breakdown ─────────────────────────────────────── */}
        {profile.credential_breakdown.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Record Types
            </h2>
            <Card className="bg-transparent border-[#3c494e]/30">
              <CardContent className="p-4">
                <div className="space-y-3">
                  {profile.credential_breakdown
                    .filter(b => b.type)
                    .slice(0, 6)
                    .map((b) => {
                      const pct = profile.total_credentials > 0
                        ? (b.count / profile.total_credentials) * 100
                        : 0;
                      const label = b.type
                        ? CREDENTIAL_TYPE_LABELS[b.type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? b.type
                        : 'Other';
                      return (
                        <div key={b.type} className="flex items-center gap-3">
                          <div className="flex items-center gap-2 w-40 shrink-0">
                            <span className="text-muted-foreground">{credentialIcon(b.type)}</span>
                            <span className="text-xs truncate">{label}</span>
                          </div>
                          <div className="flex-1 h-2 bg-[#192028] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[#00d4ff] rounded-full transition-all duration-500"
                              style={{ width: `${Math.max(pct, 1)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                            {formatNumber(b.count)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Recent Credentials ───────────────────────────────────────── */}
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Recent Records
          </h2>

          {registry && registry.anchors.length > 0 ? (
            <div className="space-y-2">
              {registry.anchors.map((anchor) => (
                <CredentialCard key={anchor.public_id} anchor={anchor} />
              ))}
            </div>
          ) : registryLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Card className="bg-transparent border-[#3c494e]/30">
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No public records yet</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Footer (standalone) ──────────────────────────────────────── */}
        {standalone && (
          <div className="mt-16 pt-8 border-t border-[#3c494e]/30 text-center">
            <p className="text-xs text-muted-foreground mb-3">
              Powered by Arkova — document integrity anchored on a public network
            </p>
            <div className="flex justify-center gap-4 text-xs">
              <a href="https://arkova.ai" target="_blank" rel="noopener noreferrer" className="text-[#00d4ff] hover:text-[#00d4ff]/80 inline-flex items-center gap-1">
                arkova.ai <ExternalLink className="h-3 w-3" />
              </a>
              <Link to={ROUTES.ABOUT} className="text-muted-foreground hover:text-foreground">About</Link>
              <Link to={ROUTES.PRIVACY} className="text-muted-foreground hover:text-foreground">Privacy</Link>
              <Link to={ROUTES.TERMS} className="text-muted-foreground hover:text-foreground">Terms</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
