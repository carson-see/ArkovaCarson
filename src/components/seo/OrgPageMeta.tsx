/**
 * OrgPageMeta — Open Graph + Twitter Card meta tags for public org pages
 * (PUBLIC-ORG-07 / SCRUM-1090).
 *
 * Side-effect component: imperatively appends meta tags to <head> via
 * useEffect, removes them on unmount. This pattern matches the rest of
 * the codebase (no react-helmet dependency) — see SearchPage.tsx for the
 * document.title precedent.
 *
 * Each tag is tagged with `data-org-page-meta` so unmount cleanup can find
 * its own additions without touching unrelated meta from index.html.
 */
import { useEffect } from 'react';

interface OrgProfileForMeta {
  display_name: string;
  description: string | null;
  logo_url: string | null;
}

export interface OrgPageMetaProps {
  profile: OrgProfileForMeta;
  pageUrl: string;
}

const META_MARKER = 'data-org-page-meta';

function setMeta(attr: 'property' | 'name', key: string, value: string): void {
  const el = document.createElement('meta');
  el.setAttribute(attr, key);
  el.setAttribute('content', value);
  el.setAttribute(META_MARKER, 'true');
  document.head.appendChild(el);
}

export function OrgPageMeta({ profile, pageUrl }: OrgPageMetaProps) {
  useEffect(() => {
    const title = `${profile.display_name} — Verified Issuer on Arkova`;
    document.title = title;
    const description =
      profile.description ??
      `Verified issuer profile for ${profile.display_name} on Arkova. View credentials, audit history, and connected organizations.`;

    setMeta('property', 'og:type', 'profile');
    setMeta('property', 'og:title', title);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', pageUrl);
    setMeta('name', 'twitter:title', title);
    setMeta('name', 'twitter:description', description);

    if (profile.logo_url) {
      setMeta('property', 'og:image', profile.logo_url);
      setMeta('name', 'twitter:card', 'summary_large_image');
      setMeta('name', 'twitter:image', profile.logo_url);
    } else {
      setMeta('name', 'twitter:card', 'summary');
    }

    return () => {
      document.head
        .querySelectorAll(`meta[${META_MARKER}]`)
        .forEach((node) => node.remove());
    };
  }, [profile.display_name, profile.description, profile.logo_url, pageUrl]);

  return null;
}
