/**
 * SEC-007: URL Validator Tests
 *
 * Verifies rejection of javascript:, data:, vbscript:, and blank URLs.
 * Verifies acceptance of http:, https:, mailto:, and relative URLs.
 */

import { describe, it, expect } from 'vitest';
import { isSafeUrl, sanitizeHref } from '@/lib/urlValidator';

describe('SEC-007: isSafeUrl', () => {
  it('accepts http: URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com/path?q=1')).toBe(true);
  });

  it('accepts https: URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('https://app.arkova.ai/verify/abc')).toBe(true);
  });

  it('accepts mailto: URLs', () => {
    expect(isSafeUrl('mailto:support@arkova.ai')).toBe(true);
    expect(isSafeUrl('mailto:test@example.com?subject=Hello')).toBe(true);
  });

  it('accepts relative URLs', () => {
    expect(isSafeUrl('/verify/123')).toBe(true);
    expect(isSafeUrl('/api/docs')).toBe(true);
    expect(isSafeUrl('#section')).toBe(true);
    expect(isSafeUrl('?page=2')).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('JAVASCRIPT:void(0)')).toBe(false);
    // Obfuscation attempts
    expect(isSafeUrl('javascript\t:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('rejects vbscript: URLs', () => {
    expect(isSafeUrl('vbscript:MsgBox("XSS")')).toBe(false);
  });

  it('rejects empty/null/undefined inputs', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(null as unknown as string)).toBe(false);
    expect(isSafeUrl(undefined as unknown as string)).toBe(false);
  });

  it('rejects URLs with leading control characters', () => {
    expect(isSafeUrl(' javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('\tjavascript:alert(1)')).toBe(false);
  });
});

describe('SEC-007: sanitizeHref', () => {
  it('returns safe URLs unchanged', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com');
    expect(sanitizeHref('/path')).toBe('/path');
  });

  it('returns # for unsafe URLs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBe('#');
    expect(sanitizeHref(null)).toBe('#');
    expect(sanitizeHref(undefined)).toBe('#');
    expect(sanitizeHref('')).toBe('#');
  });
});
