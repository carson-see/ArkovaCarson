/**
 * Organization JSON-LD Schema (PUBLIC-ORG-07 / SCRUM-1090) tests.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { OrganizationSchema, buildOrganizationSchema } from './OrganizationSchema';

const BASE_PROFILE = {
  display_name: 'Demo Issuer Co.',
  domain: 'demo.example',
  description: 'Issuer of demo credentials.',
  org_type: 'university',
  website_url: 'https://demo.example',
  linkedin_url: 'https://linkedin.com/company/demo',
  twitter_url: 'https://twitter.com/demo',
  logo_url: 'https://cdn.example/demo.png',
  location: 'Remote',
  founded_date: '2024-01-15',
} as const;

const ORG_PAGE_URL = 'https://arkova.ai/issuer/00000000-0000-0000-0000-000000000001';

describe('buildOrganizationSchema', () => {
  it('emits required schema.org Organization fields', () => {
    const schema = buildOrganizationSchema(BASE_PROFILE, ORG_PAGE_URL);
    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@type']).toBe('Organization');
    expect(schema.name).toBe('Demo Issuer Co.');
    expect(schema.url).toBe('https://demo.example');
    expect(schema.logo).toBe('https://cdn.example/demo.png');
    expect(schema.description).toContain('Issuer of demo credentials');
  });

  it('includes website + social profiles in sameAs (official site first for entity graph)', () => {
    const schema = buildOrganizationSchema(BASE_PROFILE, ORG_PAGE_URL);
    expect(schema.sameAs).toEqual([
      'https://demo.example',
      'https://linkedin.com/company/demo',
      'https://twitter.com/demo',
    ]);
  });

  it('omits sameAs entirely when no website or socials provided', () => {
    const schema = buildOrganizationSchema(
      { ...BASE_PROFILE, website_url: null, linkedin_url: null, twitter_url: null },
      ORG_PAGE_URL,
    );
    expect(schema).not.toHaveProperty('sameAs');
  });

  it('still emits sameAs when only website_url is set (single-element array)', () => {
    const schema = buildOrganizationSchema(
      { ...BASE_PROFILE, linkedin_url: null, twitter_url: null },
      ORG_PAGE_URL,
    );
    expect(schema.sameAs).toEqual(['https://demo.example']);
  });

  it('falls back to org page URL when website_url missing (so url is always present)', () => {
    const schema = buildOrganizationSchema({ ...BASE_PROFILE, website_url: null }, ORG_PAGE_URL);
    expect(schema.url).toBe(ORG_PAGE_URL);
  });

  it('uses foundingDate when founded_date present', () => {
    const schema = buildOrganizationSchema(BASE_PROFILE, ORG_PAGE_URL);
    expect(schema.foundingDate).toBe('2024-01-15');
  });

  it('omits null/empty fields rather than emitting "null"', () => {
    const schema = buildOrganizationSchema(
      {
        ...BASE_PROFILE,
        description: null,
        logo_url: null,
        founded_date: null,
        location: null,
      },
      ORG_PAGE_URL,
    );
    expect(schema).not.toHaveProperty('description');
    expect(schema).not.toHaveProperty('logo');
    expect(schema).not.toHaveProperty('foundingDate');
    expect(schema).not.toHaveProperty('address');
  });
});

describe('<OrganizationSchema />', () => {
  it('renders application/ld+json script with serialized schema', () => {
    const { container } = render(
      <OrganizationSchema profile={BASE_PROFILE} pageUrl={ORG_PAGE_URL} />,
    );
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script!.textContent ?? '{}');
    expect(parsed['@type']).toBe('Organization');
    expect(parsed.name).toBe('Demo Issuer Co.');
  });

  it('escapes </script> sequences to prevent JSON-LD breakout (XSS hardening)', () => {
    const { container } = render(
      <OrganizationSchema
        profile={{
          ...BASE_PROFILE,
          description: 'evil</script><script>alert(1)</script>',
        }}
        pageUrl={ORG_PAGE_URL}
      />,
    );
    const script = container.querySelector('script[type="application/ld+json"]');
    const raw = script!.innerHTML;
    expect(raw).not.toContain('</script>');
    expect(raw).toContain('<\\/script');
  });
});
