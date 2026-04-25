/**
 * Organization JSON-LD Schema (PUBLIC-ORG-07 / SCRUM-1090).
 *
 * Emits a schema.org Organization block on each public org page so AI
 * search engines (ChatGPT, Perplexity, Gemini, Google AI Overviews) and
 * traditional crawlers (Google, Bing, LinkedIn unfurls) can recognize the
 * org as a discrete entity with verified social profiles + logo.
 *
 * Builder is split out so tests can assert on the JSON shape without
 * rendering, and so a future server-side renderer (PUBLIC-ORG-06
 * Cloudflare Worker proxy) can call the same builder for SSR'd HTML.
 */

interface OrgProfileForSchema {
  display_name: string;
  domain: string | null;
  description: string | null;
  org_type: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  logo_url: string | null;
  location: string | null;
  founded_date: string | null;
}

export interface OrganizationJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Organization';
  name: string;
  url: string;
  description?: string;
  logo?: string;
  sameAs?: string[];
  foundingDate?: string;
  address?: { '@type': 'PostalAddress'; addressLocality: string };
}

export function buildOrganizationSchema(
  profile: OrgProfileForSchema,
  pageUrl: string,
): OrganizationJsonLd {
  const sameAs = [profile.linkedin_url, profile.twitter_url].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );

  const schema: OrganizationJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: profile.display_name,
    url: profile.website_url ?? pageUrl,
  };

  if (profile.description) schema.description = profile.description;
  if (profile.logo_url) schema.logo = profile.logo_url;
  if (sameAs.length > 0) schema.sameAs = sameAs;
  if (profile.founded_date) schema.foundingDate = profile.founded_date;
  if (profile.location) {
    schema.address = { '@type': 'PostalAddress', addressLocality: profile.location };
  }

  return schema;
}

export interface OrganizationSchemaProps {
  profile: OrgProfileForSchema;
  pageUrl: string;
}

export function OrganizationSchema({ profile, pageUrl }: OrganizationSchemaProps) {
  // Escape </script> in user-controlled string fields to prevent JSON-LD
  // breakout. Same hardening pattern as PublicVerification.tsx:635.
  const json = JSON.stringify(buildOrganizationSchema(profile, pageUrl)).replace(
    /<\/script/gi,
    '<\\/script',
  );
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
