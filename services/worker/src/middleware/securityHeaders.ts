/**
 * SCRUM-4987 — browser-enforced security headers on every worker response.
 *
 * Why here and not at the edge: the prod Cloud Run origin answers publicly and
 * bypasses Cloudflare entirely (SCRUM-3888), so a Cloudflare transform rule
 * would protect api.arkova.ai and leave the *.run.app host bare. Verified live
 * 2026-09-12: app/search/apex (Vercel) carried HSTS, CSP, X-Frame-Options,
 * nosniff, Referrer-Policy and Permissions-Policy; the worker origin and
 * api.arkova.ai returned only x-ratelimit-*.
 *
 * Mounted BEFORE corsMiddleware in index.ts so preflight (OPTIONS 204) and
 * every 401/404/429/500 carry the headers too — "headers on every response"
 * is the same contract §1.10 already imposes on the rate-limit headers.
 *
 * Policy, and why each value:
 *  - Strict-Transport-Security: same max-age/includeSubDomains/preload the
 *    Vercel hosts already send, so the arkova.ai preload entry stays coherent.
 *  - X-Content-Type-Options: nosniff — the badge SVG and any JSON error body
 *    must never be sniffed into something executable.
 *  - X-Frame-Options: DENY + CSP frame-ancestors 'none' — no worker route is
 *    designed to be framed (the embed widget is a script tag from Vercel, and
 *    the badge is consumed as an <img>, which X-Frame-Options does not touch).
 *  - Referrer-Policy: no-referrer — API URLs can carry public ids; nothing
 *    downstream needs the referrer.
 *  - Permissions-Policy: deny the powerful features outright.
 *  - Content-Security-Policy: `default-src 'none'` for the JSON/SVG surface.
 *    The one HTML surface, /api/docs (swagger-ui-express, inline bootstrap
 *    script + inline styles + a cross-origin favicon), gets its own policy:
 *    the inline allowances it needs and nothing wider.
 *
 * Nothing here is a substitute for the rate limiters, auth or RLS; it closes
 * the browser-side class (clickjacking, MIME sniffing, downgrade, referrer
 * leakage) that the scanner flagged and our own curl confirmed.
 */
import type { NextFunction, Request, Response } from 'express';

export const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

/** JSON / SVG / redirect responses — nothing may load or embed. */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** swagger-ui-express under /api/docs. Same-origin assets + the inline
 *  bootstrap it emits + Google Fonts referenced by the custom stylesheet. */
export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // No webfont is loaded: swagger-ui-dist ships its own CSS/JS same-origin and
  // the custom stylesheet in api/v1/docs.ts only names font families
  // ('DM Sans', 'JetBrains Mono') with system fallbacks — there is no @import
  // and no <link> to fonts.googleapis.com. Allow-listing Google Fonts here
  // would be a permission nothing consumes; add it back only alongside the
  // stylesheet change that needs it.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // docs.ts sets customfavIcon to app.arkova.ai/favicon.svg; without this host
  // the favicon is a CSP violation on every docs load. Change both together.
  "img-src 'self' data: https://app.arkova.ai",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

const DOCS_PREFIX = '/api/docs';

/**
 * Express routing is case-insensitive by default (`case sensitive routing`
 * is never enabled in index.ts), so `/API/docs` serves the real swagger HTML.
 * The CSP decision must follow the same rule or that HTML renders under
 * `default-src 'none'` and is blank.
 */
export function isDocsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === DOCS_PREFIX || lower.startsWith(`${DOCS_PREFIX}/`);
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Strict-Transport-Security', HSTS_VALUE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Content-Security-Policy', isDocsPath(req.path) ? DOCS_CSP : API_CSP);
  next();
}
