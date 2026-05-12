/**
 * OrgPageMeta — Open Graph + Twitter Card meta tags for public org pages.
 *
 * React 19 hoists these document metadata tags into <head> and cleans them up
 * with the component tree.
 */
import type { OrgProfile } from '@/hooks/usePublicSearch';

type OrgProfileForMeta = Pick<OrgProfile, 'display_name' | 'description' | 'logo_url'>;

export interface OrgPageMetaProps {
  profile: OrgProfileForMeta;
  pageUrl: string;
}

export function OrgPageMeta({ profile, pageUrl }: OrgPageMetaProps) {
  const title = `${profile.display_name} — Verified Issuer on Arkova`;
  const description =
    profile.description ??
    `Verified issuer profile for ${profile.display_name} on Arkova. View credentials, audit history, and connected organizations.`;

  return (
    <>
      <title>{title}</title>
      <link rel="canonical" href={pageUrl} />
      <meta property="og:type" content="profile" />
      <meta property="og:site_name" content="Arkova" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={pageUrl} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      {profile.logo_url ? (
        <>
          <meta property="og:image" content={profile.logo_url} />
          <meta property="og:image:alt" content={`${profile.display_name} logo`} />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:image" content={profile.logo_url} />
        </>
      ) : (
        <meta name="twitter:card" content="summary" />
      )}
    </>
  );
}
