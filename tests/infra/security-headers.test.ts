import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const vercelConfig = JSON.parse(
  readFileSync(resolve(__dirname, '../../vercel.json'), 'utf-8')
);

// Find the global security headers block (source: "/(.*)")
const headerBlock = vercelConfig.headers?.find(
  (h: { source: string }) => h.source === '/(.*)',
);
const headers: Array<{ key: string; value: string }> = headerBlock?.headers ?? [];

function getHeaderValue(key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

describe('GEO-12: Security Headers (vercel.json)', () => {
  it('vercel.json has a headers array', () => {
    expect(vercelConfig.headers).toBeDefined();
    expect(Array.isArray(vercelConfig.headers)).toBe(true);
    expect(vercelConfig.headers.length).toBeGreaterThan(0);
  });

  it('X-Content-Type-Options is nosniff', () => {
    expect(getHeaderValue('X-Content-Type-Options')).toBe('nosniff');
  });

  it('X-Frame-Options is SAMEORIGIN', () => {
    expect(getHeaderValue('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(getHeaderValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('Permissions-Policy blocks camera, microphone, and geolocation', () => {
    const value = getHeaderValue('Permissions-Policy');
    expect(value).toBeDefined();
    expect(value).toContain('camera=()');
    expect(value).toContain('microphone=()');
    expect(value).toContain('geolocation=()');
  });

  it('HSTS is present with long max-age', () => {
    const value = getHeaderValue('Strict-Transport-Security');
    expect(value).toBeDefined();
    const maxAgeMatch = value!.match(/max-age=(\d+)/);
    expect(maxAgeMatch).not.toBeNull();
    expect(Number(maxAgeMatch![1])).toBeGreaterThanOrEqual(31536000);
    expect(value).toContain('includeSubDomains');
  });

  it('CSP is present and includes self, supabase, stripe, and sentry', () => {
    const value = getHeaderValue('Content-Security-Policy');
    expect(value).toBeDefined();
    expect(value).toContain("default-src 'self'");
    expect(value).toContain('https://*.supabase.co');
    expect(value).toContain('https://*.sentry.io');
    expect(value).toContain('https://*.stripe.com');
  });

  it('CSP connect-src does not use wildcards for run.app or railway.app (SEC-RECON-6)', () => {
    const value = getHeaderValue('Content-Security-Policy');
    expect(value).toBeDefined();
    expect(value).not.toContain('*.run.app');
    expect(value).not.toContain('*.railway.app');
  });

  it('X-DNS-Prefetch-Control is on', () => {
    expect(getHeaderValue('X-DNS-Prefetch-Control')).toBe('on');
  });

  it('SPA rewrite rule exists', () => {
    expect(vercelConfig.rewrites).toBeDefined();
    expect(Array.isArray(vercelConfig.rewrites)).toBe(true);
    const spaRewrite = vercelConfig.rewrites.find(
      (r: { destination: string }) => r.destination === '/index.html'
    );
    expect(spaRewrite).toBeDefined();
  });

  it('source pattern matches all routes', () => {
    expect(headerBlock.source).toBe('/(.*)');
  });
});
