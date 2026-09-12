import { describe, it, expect } from 'vitest';
import { parseSocialLinksForWrite, pickSocialLinks, resolveSocialLinks, safeSocialHref } from './socialLinks';

describe('safeSocialHref (SCRUM-4989)', () => {
  it('passes https and http URLs through', () => {
    expect(safeSocialHref('linkedin', 'https://linkedin.com/in/ada')).toBe('https://linkedin.com/in/ada');
    expect(safeSocialHref('website', 'http://ada.example/')).toBe('http://ada.example/');
  });

  it('prefixes https:// onto a bare domain', () => {
    expect(safeSocialHref('website', 'ada.example/page')).toBe('https://ada.example/page');
  });

  it('turns an @handle into an x.com profile link (twitter only)', () => {
    expect(safeSocialHref('twitter', '@ada_l')).toBe('https://x.com/ada_l');
    expect(safeSocialHref('github', '@ada_l')).toBeNull();
  });

  it.each([
    'javascript:alert(document.cookie)',
    'JAVASCRIPT:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\u0009javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHN2Zz4=',
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'mailto:a@b.example',
    'file:///etc/passwd',
    'blob:https://ada.example/x',
    'about:blank',
    'view-source:https://ada.example',
    // Protocol-relative and backslash authorities: a browser inherits the page
    // scheme (or normalises the backslashes) and navigates off-site.
    '//evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example/x',
    'https://',
    'https://localhost',
    'not a url',
    '',
    'x'.repeat(201),
  ])('refuses %s', (value) => {
    expect(safeSocialHref('linkedin', value)).toBeNull();
    expect(safeSocialHref('twitter', value)).toBeNull();
  });

  // Browsers strip these from a URL before parsing it, which is exactly how
  // "java<sep>script:" becomes a live scheme.
  it.each([
    ['LF', 'java\u000ascript:alert(1)'],
    ['CR', 'java\u000dscript:alert(1)'],
    ['TAB', 'java\u0009script:alert(1)'],
    ['NUL', 'java\u0000script:alert(1)'],
    ['NBSP', 'java\u00a0script:alert(1)'],
    ['BOM', 'java\ufeffscript:alert(1)'],
    ['U+2028', 'java\u2028script:alert(1)'],
    ['U+2029', 'java\u2029script:alert(1)'],
  ])('refuses a scheme split by %s', (_label, value) => {
    expect(safeSocialHref('linkedin', value)).toBeNull();
    expect(safeSocialHref('twitter', value)).toBeNull();
  });

  it('refuses a control character anywhere in an otherwise valid URL', () => {
    expect(safeSocialHref('linkedin', 'https://ada.example/x\u0000')).toBeNull();
  });

  it('refuses userinfo in the authority (https://linkedin.com@evil.example goes to evil.example)', () => {
    expect(safeSocialHref('linkedin', 'https://linkedin.com@evil.example/')).toBeNull();
    expect(safeSocialHref('website', 'https://user:pass@ada.example/')).toBeNull();
  });

  it('refuses non-string values', () => {
    expect(safeSocialHref('website', { toString: () => 'https://x.example' })).toBeNull();
    expect(safeSocialHref('website', null)).toBeNull();
  });
});

describe('parseSocialLinksForWrite (SCRUM-4989)', () => {
  it('accepts valid links and drops empties', () => {
    expect(parseSocialLinksForWrite({ linkedin: 'https://linkedin.com/in/ada', twitter: '', github: undefined })).toEqual({
      ok: true,
      value: { linkedin: 'https://linkedin.com/in/ada' },
    });
  });

  it('returns null when every field is empty', () => {
    expect(parseSocialLinksForWrite({ linkedin: '', website: '  ' })).toEqual({ ok: true, value: null });
  });

  it('rejects a javascript: URI and names the offending key', () => {
    expect(parseSocialLinksForWrite({ linkedin: 'https://linkedin.com/in/ada', website: 'javascript:alert(1)' })).toEqual({
      ok: false,
      key: 'website',
    });
  });

  it('drops unknown (legacy) keys instead of blocking the save', () => {
    // profiles.social_links was an unvalidated jsonb for its whole history, so
    // a row can carry keys outside the four we render. Those must never make
    // the settings form un-saveable for a user who did not touch them.
    expect(
      parseSocialLinksForWrite({ mastodon: 'https://m.example/@ada', github: 'github.com/ada' } as never),
    ).toEqual({ ok: true, value: { github: 'github.com/ada' } });
  });
});

describe('pickSocialLinks (SCRUM-4989 review)', () => {
  it('keeps only the four known keys with string values', () => {
    expect(
      pickSocialLinks({ linkedin: 'linkedin.com/in/ada', mastodon: 'x', github: 42, website: '' }),
    ).toEqual({ linkedin: 'linkedin.com/in/ada', website: '' });
  });

  it('returns an empty object for non-objects', () => {
    expect(pickSocialLinks(null)).toEqual({});
    expect(pickSocialLinks('str')).toEqual({});
  });
});

describe('resolveSocialLinks (SCRUM-4989 review)', () => {
  it('resolves every known key through safeSocialHref and drops unsafe ones', () => {
    expect(
      resolveSocialLinks({
        linkedin: 'linkedin.com/in/ada',
        twitter: '@ada',
        github: 'javascript:alert(1)',
        website: 'https://ada.example',
        mastodon: 'https://m.example/@ada',
      }),
    ).toEqual({
      linkedin: 'https://linkedin.com/in/ada',
      twitter: 'https://x.com/ada',
      website: 'https://ada.example/',
    });
  });
});
