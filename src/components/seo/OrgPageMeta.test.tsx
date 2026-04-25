/**
 * OrgPageMeta — Open Graph + Twitter Card meta tags (PUBLIC-ORG-07 / SCRUM-1090).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { OrgPageMeta } from './OrgPageMeta';

const PROFILE = {
  display_name: 'Demo Issuer Co.',
  description: 'Issuer of demo credentials.',
  logo_url: 'https://cdn.example/demo.png',
};

const PAGE_URL = 'https://arkova.ai/issuer/00000000-0000-0000-0000-000000000001';

function getMeta(property: string): string | null {
  return document.head.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? null;
}

function getNamedMeta(name: string): string | null {
  return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

describe('<OrgPageMeta />', () => {
  beforeEach(() => {
    document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((m) => m.remove());
    document.title = '';
  });

  afterEach(() => {
    cleanup();
    document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((m) => m.remove());
  });

  it('sets document.title', () => {
    render(<OrgPageMeta profile={PROFILE} pageUrl={PAGE_URL} />);
    expect(document.title).toBe('Demo Issuer Co. — Verified Issuer on Arkova');
  });

  it('emits Open Graph tags', () => {
    render(<OrgPageMeta profile={PROFILE} pageUrl={PAGE_URL} />);
    expect(getMeta('og:type')).toBe('profile');
    expect(getMeta('og:title')).toBe('Demo Issuer Co. — Verified Issuer on Arkova');
    expect(getMeta('og:description')).toBe('Issuer of demo credentials.');
    expect(getMeta('og:image')).toBe('https://cdn.example/demo.png');
    expect(getMeta('og:url')).toBe(PAGE_URL);
  });

  it('emits Twitter card tags with summary_large_image when logo present', () => {
    render(<OrgPageMeta profile={PROFILE} pageUrl={PAGE_URL} />);
    expect(getNamedMeta('twitter:card')).toBe('summary_large_image');
    expect(getNamedMeta('twitter:title')).toBe('Demo Issuer Co. — Verified Issuer on Arkova');
    expect(getNamedMeta('twitter:image')).toBe('https://cdn.example/demo.png');
  });

  it('falls back to summary card when no logo', () => {
    render(
      <OrgPageMeta
        profile={{ ...PROFILE, logo_url: null }}
        pageUrl={PAGE_URL}
      />,
    );
    expect(getNamedMeta('twitter:card')).toBe('summary');
    expect(getNamedMeta('twitter:image')).toBeNull();
  });

  it('falls back to a generic description when none provided', () => {
    render(
      <OrgPageMeta profile={{ ...PROFILE, description: null }} pageUrl={PAGE_URL} />,
    );
    expect(getMeta('og:description')).toContain('Verified issuer profile');
  });

  it("cleans up its tags on unmount so a navigation away doesn't leak meta", () => {
    const { unmount } = render(<OrgPageMeta profile={PROFILE} pageUrl={PAGE_URL} />);
    expect(getMeta('og:title')).not.toBeNull();
    unmount();
    expect(getMeta('og:title')).toBeNull();
  });
});
