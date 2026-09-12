import { describe, it, expect } from 'vitest';
import { safeSocialHref, parseSocialLinksForWrite } from './socialLinks';

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
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:a@b.example',
    'file:///etc/passwd',
    'https://',
    'https://localhost',
    'not a url',
    '',
    'x'.repeat(201),
  ])('refuses %s', (value) => {
    expect(safeSocialHref('linkedin', value)).toBeNull();
    expect(safeSocialHref('twitter', value)).toBeNull();
  });

  it('refuses a scheme hidden behind a control character', () => {
    expect(safeSocialHref('linkedin', 'java\u000ascript:alert(1)')).toBeNull();
    expect(safeSocialHref('linkedin', 'https://ada.example/x\u0000')).toBeNull();
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

  it('rejects unknown keys and reports them against the generic website field', () => {
    expect(parseSocialLinksForWrite({ mastodon: 'https://m.example/@ada' } as never)).toEqual({
      ok: false,
      key: 'website',
    });
  });
});
