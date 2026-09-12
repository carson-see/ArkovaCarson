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
 *    script + inline styles + Google Fonts), gets its own policy: the
 *    inline allowances it needs and nothing wider.
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
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

const DOCS_PREFIX = '/api/docs';

export function isDocsPath(path: string): boolean {
  return path === DOCS_PREFIX || path.startsWith(`${DOCS_PREFIX}/`);
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
