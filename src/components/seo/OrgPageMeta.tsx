/**
 * OrgPageMeta — Open Graph + Twitter Card meta tags for public org pages.
 *
 * Imperatively appends meta tags to <head> via useEffect because React 18
 * doesn't render <meta> tags inside the component tree into <head> (a fix
 * landed in React 19; switch to inline rendering once we upgrade).
 *
 * Tracks its own appended nodes via a ref so cleanup-on-unmount and
 * effect-re-run never touch tags appended by a sibling instance.
 */
import { useEffect, useRef } from 'react';
import type { OrgProfile } from '@/hooks/usePublicSearch';

type OrgProfileForMeta = Pick<OrgProfile, 'display_name' | 'description' | 'logo_url'>;

export interface OrgPageMetaProps {
  profile: OrgProfileForMeta;
  pageUrl: string;
}

export function OrgPageMeta({ profile, pageUrl }: OrgPageMetaProps) {
  const createdMetas = useRef<HTMLMetaElement[]>([]);
  const createdLinks = useRef<HTMLLinkElement[]>([]);

  useEffect(() => {
    const setMeta = (attr: 'property' | 'name', key: string, value: string): void => {
      const el = document.createElement('meta');
      el.setAttribute(attr, key);
      el.setAttribute('content', value);
      document.head.appendChild(el);
      createdMetas.current.push(el);
    };

    const setLink = (rel: string, href: string): void => {
      const el = document.createElement('link');
      el.setAttribute('rel', rel);
      el.setAttribute('href', href);
      document.head.appendChild(el);
      createdLinks.current.push(el);
    };

    const title = `${profile.display_name} — Verified Issuer on Arkova`;
    document.title = title;
    const description =
      profile.description ??
      `Verified issuer profile for ${profile.display_name} on Arkova. View credentials, audit history, and connected organizations.`;

    // Canonical link prevents Google from indexing the same org page under
    // multiple hosts (search.arkova.ai vs app.arkova.ai). Pageviews under
    // alternate hosts roll up into the canonical URL's authority.
    setLink('canonical', pageUrl);

    setMeta('property', 'og:type', 'profile');
    setMeta('property', 'og:site_name', 'Arkova');
    setMeta('property', 'og:title', title);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', pageUrl);
    setMeta('name', 'twitter:title', title);
    setMeta('name', 'twitter:description', description);

    if (profile.logo_url) {
      setMeta('property', 'og:image', profile.logo_url);
      setMeta('property', 'og:image:alt', `${profile.display_name} logo`);
      setMeta('name', 'twitter:card', 'summary_large_image');
      setMeta('name', 'twitter:image', profile.logo_url);
    } else {
      setMeta('name', 'twitter:card', 'summary');
    }

    return () => {
      for (const node of createdMetas.current) node.remove();
      createdMetas.current = [];
      for (const node of createdLinks.current) node.remove();
      createdLinks.current = [];
    };
  }, [profile.display_name, profile.description, profile.logo_url, pageUrl]);

  return null;
}
