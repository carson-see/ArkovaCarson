/**
 * apiIpShadowGuard — the broad per-IP guard in front of `/api/*`.
 *
 * `index.ts` mounts this twice: once at `/api` (ahead of badgeRouter and the
 * other `/api` prefix routers) and once with no prefix at all (ahead of
 * didWebRouter + proofKeysRouter, which serve `/.well-known/*` and `/orgs/*`).
 * It is a blunt 60/min-per-IP backstop for anonymous traffic, NOT the limiter
 * that implements any Constitution 1.10 tier — every tier has its own,
 * correctly-keyed limiter further down the chain. Two carve-outs keep this
 * backstop from shadowing the limiters that do implement the contract:
 *
 * **F-2 — keyed `/api/v1/*` traffic (2026-08 soak).** This guard was catching
 * every `/api/*` request, including `/api/v1/*` traffic already carrying a
 * valid API key. `apiV1Router` applies its own 1,000/min-per-key limiter, but
 * requests never got there — this bucket exhausted at 60/min per source IP
 * first, capping every keyed customer regardless of tier. Requests presenting a
 * syntactically-formed API key credential (`Bearer ak_…` or `X-API-Key: ak_…`)
 * on `/api/v1/*` now skip it. They are still fully rate-limited downstream —
 * either by `apiV1Router`'s keyedRateLimiter (1,000/min/key) or, for the
 * handful of `/api/v1/*` mounts registered outside apiV1Router (org,
 * integrations, rules/templates, versions, anchor, audit,
 * partner-provisioning), by their own explicit `rateLimiters.api` instance.
 *
 * **SCRUM-2603 — anonymous public verification.** §1.10 gives anonymous callers
 * 100 req/min/IP on the public verification API. Anonymous verify traffic never
 * got that: this 60/min guard ran first, and — before SCRUM-3418 — it wrote the
 * SAME bare-per-IP bucket as `apiV1Router`'s 100/min `anonRateLimiter`, so one
 * verify request charged that one entry twice and the 60-cap guard refused at
 * request #31. Roughly a third of the published contract. (The guard's own two
 * mounts are NOT part of that arithmetic: RC #2269 made `rateLimit()` charge a
 * request at most once per limiter instance — see `utils/rateLimit.ts`,
 * COUNTED_LIMITERS.) `/api/v1/verify` therefore skips this guard and is capped
 * by `publicVerifyAnonLimiter` below at exactly the contract.
 *
 * That limiter is deliberately mounted in `index.ts` rather than left to
 * `apiV1Router`'s `anonRateLimiter` (which enforces the same 100/min): the v1
 * router runs `verificationApiGate()` BEFORE its rate limiting, so with
 * `ENABLE_VERIFICATION_API` off a verify request 503s without ever reaching
 * that limiter — and skipping this guard would then leave the path uncapped.
 * The two limiters cost one count each per request and share a cap, so
 * anonymous verify binds at 100/min whether the v1 surface is lit or dark.
 *
 * Everything else (badge, checkout, verify-anchor, treasury, admin, anonymous
 * non-verify `/api/v1/*`, and the prefix-less did:web / proof-keys reads) is
 * unaffected and still capped here at 60/min per IP.
 *
 * The predicate is split out from the wiring — same shape as
 * `routes/admin-paths.ts` — so the carve-outs are unit-testable without
 * booting `index.ts`. See `apiIpShadowGuard.test.ts`.
 */

import type { Request } from 'express';
import { rateLimit } from '../utils/rateLimit.js';

/** The public verification surface, per Constitution 1.10. */
const PUBLIC_VERIFY_PREFIX = '/api/v1/verify';

/** Prefix that owns a downstream per-key limiter (apiV1Router's 1,000/min). */
const V1_PREFIX = '/api/v1/';

/** Does this request present a syntactically-formed Arkova API key? */
export function hasApiKeyCredential(req: Request): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ak_')) return true;
  const xApiKey = req.headers['x-api-key'];
  return typeof xApiKey === 'string' && xApiKey.startsWith('ak_');
}

/**
 * Path portion of a URL, lower-cased.
 *
 * Both carve-outs below must agree with how Express actually routes the
 * request, and Express's `case sensitive routing` setting is OFF by default —
 * `/API/v1/verify/ARK-X` reaches the verify handlers and is counted by
 * `publicVerifyAnonLimiter` (mounted at `/api/v1/verify`) just like the
 * lower-case form. A case-sensitive predicate here would fail to skip that URL
 * form, so the 60/min guard would count it and put that URL form back on the
 * SCRUM-2603 ceiling while the lower-case form got its contractual 100/min.
 */
function normalizePath(originalUrl: string): string {
  const queryStart = originalUrl.indexOf('?');
  const path = queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
  return path.toLowerCase();
}

/** Prefix test on an already-normalized path: exact match, or a `/`-delimited child. */
function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Is this the public verification surface?
 *
 * Matched on the path only — the query string is stripped so
 * `/api/v1/verify?pretty=1` counts — and the prefix must be followed by `/` or
 * end of path, so a neighbouring route such as `/api/v1/verify-anchor` does not
 * inherit the carve-out. Case-insensitive; see `normalizePath`.
 */
export function isPublicVerifyPath(originalUrl: string): boolean {
  return isUnder(normalizePath(originalUrl), PUBLIC_VERIFY_PREFIX);
}

/**
 * Requests this guard defers to a downstream, correctly-keyed limiter.
 * Returning true skips the count entirely — it does not exempt the request from
 * rate limiting, it hands it to the limiter that owns its §1.10 tier.
 */
export function shouldSkipApiIpShadowGuard(req: Request): boolean {
  const path = normalizePath(req.originalUrl ?? '');
  if (isUnder(path, PUBLIC_VERIFY_PREFIX)) return true;
  return path.startsWith(V1_PREFIX) && hasApiKeyCredential(req);
}

/** Backstop cap for anonymous, non-carved-out `/api/*` traffic. */
export const API_IP_SHADOW_GUARD_MAX_PER_MIN = 60;

export const apiIpShadowGuard = rateLimit({
  windowMs: 60_000,
  maxRequests: API_IP_SHADOW_GUARD_MAX_PER_MIN,
  scope: 'api-ip-shadow-guard',
  skip: shouldSkipApiIpShadowGuard,
});

/** Constitution 1.10 anonymous tier. */
export const PUBLIC_VERIFY_ANON_MAX_PER_MIN = 100;

/**
 * The §1.10 anonymous cap for the public verification API, mounted at
 * `/api/v1/verify` ahead of the feature gate so it holds whether or not the v1
 * surface is enabled. Keyed callers skip it — they are on the 1,000/min
 * per-key tier that `apiV1Router`'s keyedRateLimiter enforces.
 */
export const publicVerifyAnonLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: PUBLIC_VERIFY_ANON_MAX_PER_MIN,
  scope: 'v1-verify-anon',
  skip: hasApiKeyCredential,
});
