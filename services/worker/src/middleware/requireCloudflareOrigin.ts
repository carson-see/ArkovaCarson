/**
 * `requireCloudflareOrigin` — origin guard for the public Cloud Run origin
 * (SCRUM-3888).
 *
 * THE PROBLEM. `arkova-worker-*.run.app` answers publicly and unauthenticated
 * — `ingress=all`, `invoker-iam-disabled`, empty IAM policy, no Cloud Armor,
 * no GCLB (CLAUDE.md §1.1 Ingress row, verified live 2026-09-13). Cloudflare
 * proxies only `api.` / `edge.` / `docs.arkova.ai`; the run.app host is the
 * SAME application with nothing in front of it. Every request that reaches
 * this worker over `api.arkova.ai` also reaches it, byte-identical, over the
 * bare run.app URL — CLAUDE.md §1.1's "no Cloudflare rate limiting" note
 * applies to both, and any edge control the release session adds to
 * `api.arkova.ai` (a WAF rule, a rate limit) protects only that hostname
 * unless this file also closes the origin it bypasses.
 *
 * THE MECHANISM. A Cloudflare Transform Rule (configured by the release
 * session at flip time — see docs/reference/CLOUDFLARE_ORIGIN_GUARD.md)
 * injects `X-Arkova-Origin-Auth: <CLOUDFLARE_ORIGIN_SECRET>` on every request
 * it proxies. A caller that reaches the worker WITHOUT going through that
 * Cloudflare zone — i.e. every request against the bare run.app host — never
 * gets the header added. This middleware checks for it and reads
 * `config.cloudflareOriginGuardMode` PER REQUEST (never captured once at
 * import time) to decide what to do about a missing/wrong header:
 *
 *   - `off`     (default) — no-op. Exists so this file can ship, be
 *                deployed, and sit completely inert until the release
 *                session wires the secret and the Transform Rule.
 *   - `observe` — never blocks. Counts `origin_guard_would_block` per route
 *                 family (see {@link getOriginGuardStats}) so the rollout can
 *                 see, before enforcing anything, how much real traffic has
 *                 no header — including any partner or SDK caller configured
 *                 against the documented run.app base URL (several are: see
 *                 the runbook's allowlist inventory) rather than
 *                 `api.arkova.ai`.
 *   - `enforce` — 403 `origin_not_allowed`, a bounded JSON body with no
 *                 request details echoed back.
 *
 * WHAT IS EXEMPT, AND WHY. `isOriginGuardExemptPath` bypasses the guard for
 * three families that must keep answering the bare run.app host directly:
 *
 *   1. `/health`, `/api/health` — Cloud Run's own health check target
 *      (Constitution §1.9: always available, no auth) and, per the same repo
 *      grep, the ONLY custom HTTP probe path configured anywhere in
 *      `deploy-worker.yml` / `scripts/gcp-setup/*.sh` — neither names
 *      `--startup-probe`/`--liveness-probe`, so Cloud Run's own default probe
 *      is a bare TCP connect on `$PORT` that never reaches Express routing
 *      and needs no exemption of its own.
 *   2. `/jobs` and everything under it — Cloud Scheduler calls
 *      `$WORKER_URL/jobs/...` directly against the run.app origin by design
 *      (`scripts/gcp-setup/cloud-scheduler.sh`), and those requests already
 *      authenticate via `verifyCronAuth()` (`routes/cron.ts`: CRON_SECRET
 *      shared-secret header, a platform-admin Supabase JWT, or a
 *      Google-signed OIDC bearer token). This guard must not add a second,
 *      redundant gate in front of an already-authenticated system caller.
 *   3. `/webhooks/*` (bare) and the two provably-inbound sub-paths under
 *      `/api/v1/webhooks/*` — every inbound partner webhook receiver. Three
 *      are PROVABLY registered directly against the run.app host, not
 *      `api.arkova.ai`: `integrations/oauth/docusign.ts`
 *      (`buildArkovaConnectConfig`), `integrations/oauth/adobe-sign.ts`, and
 *      `jobs/drive-subscription-renewal-deps.ts` (Drive `changes.watch`) all
 *      build their registered callback URL by concatenating
 *      `config.workerPublicUrl` — which `deploy-worker.yml` sets to the bare
 *      `https://arkova-worker-270018525501.us-central1.run.app`, not
 *      `api.arkova.ai` — with the webhook path. `docs/runbooks/kyb/middesk.md`
 *      and `docs/integrations/background-checks-spike.md` document the same
 *      run.app-host pattern for Middesk and Checkr, though those two are
 *      operator-registered (console-configured, not built in code) so the
 *      documentation is the only evidence available. Stripe, Veremark and
 *      Microsoft Graph have NO registration-host evidence anywhere in this
 *      repo — their listener URLs are chosen by an operator in an external
 *      dashboard/console the repo cannot see. Per BUILDER CONTRACT clause 16
 *      ("state unknowns as unknowns"), those three are exempted
 *      CONSERVATIVELY rather than assumed safe to gate: exempting a webhook
 *      path costs nothing (its own `webhookHmac` / per-connector signature
 *      check — Constitution SEC-01 — keeps authenticating it either way) and
 *      the alternative, gating a webhook that turns out to be registered
 *      against run.app, is a silent, hard-to-diagnose partner outage the
 *      moment `enforce` ships. ComputeID is the one exception with GOOD
 *      evidence the other way — `docs/partners/computeid-integration-guide.md`
 *      documents `POST https://api.arkova.ai/webhooks/computeid`, i.e.
 *      already Cloudflare-proxied — but it is still covered by the bare
 *      `/webhooks/*` prefix rather than carved out individually, because a
 *      narrower allowlist here would depend on an operator not changing that
 *      registration without also updating this file. See the runbook for the
 *      full per-path inventory table with evidence citations.
 *
 *      IMPORTANT: `/api/v1/webhooks` (bare) and `/api/v1/webhooks/self-service`
 *      are NOT on this exemption, despite the shared prefix. `api/v1/router.ts`
 *      mounts those two as the CUSTOMER-facing webhook-management API — CRUD,
 *      test-ping, replay, DLQ management, gated on `webhooks:manage` scope or
 *      a dashboard JWT (SCRUM-3981). That surface is Arkova's own, called by
 *      Arkova customers against `api.arkova.ai`, not a partner receiver
 *      registered against run.app — an earlier draft of this allowlist
 *      exempted the whole `/api/v1/webhooks` prefix and accidentally swept
 *      this mutating, authenticated surface in with it (CTO review,
 *      SCRUM-3888). Only the two literal sub-paths with run.app registration
 *      evidence — `/api/v1/webhooks/drive` and `/api/v1/webhooks/ats` — are
 *      exempt.
 *
 * WHAT IS DELIBERATELY NOT EXEMPT. The REST surfaces this guard is FOR:
 * `/api/v1/*` (excluding the webhook sub-paths above) and `/api/v2/*`. Some
 * partner documentation (`docs/api/README.md`, `docs/api/webhooks.md`,
 * `docs/api/openapi.yaml`) states the v1 base URL as the bare run.app host
 * rather than `api.arkova.ai` — that is exactly the customer-impact risk
 * `observe` mode exists to surface before anything blocks, not a reason to
 * widen the allowlist and defeat the point of SCRUM-3888. See the runbook's
 * rollout section and pre-mortem.
 *
 * SECURITY. The header is compared with `crypto.timingSafeEqual` on
 * equal-length buffers (length checked first — an unequal-length compare
 * would itself leak length through a thrown exception, the same reasoning
 * `routes/health.ts`'s `isDetailedHealthAuthorized` documents for
 * `X-Health-Token`). The raw header value is never logged, never included in
 * the 403 body, and never reaches Sentry — only a boolean `headerPresent`, the
 * route family, and a keyed HMAC hash of the caller's IP (`lib/ip-hash.ts`,
 * the same pseudonymisation `verify.ts` already uses for anonymous public
 * traffic) are recorded.
 */
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { auditIpHash } from '../lib/ip-hash.js';

export type CloudflareOriginGuardMode = 'off' | 'observe' | 'enforce';

/** The header a Cloudflare Transform Rule injects on every proxied request. */
export const ORIGIN_AUTH_HEADER = 'x-arkova-origin-auth';

/**
 * Path families that bypass the guard regardless of mode. Case-insensitive
 * prefix match, same convention as `securityHeaders.ts`'s `isDocsPath` and
 * `routes/admin-paths.ts`'s `isAdminRouterPath` — Express's `case sensitive
 * routing` is off by default, so `/JOBS/foo` reaches the real cron router
 * just like `/jobs/foo` does and must get the same exemption.
 *
 * CTO review (SCRUM-3888): the original list here exempted the whole
 * `/api/v1/webhooks` prefix on the theory that everything under it is an
 * inbound partner receiver. It is not — `api/v1/router.ts` mounts
 * `/webhooks` (bare) and `/webhooks/self-service` under `/api/v1` as the
 * CUSTOMER-facing webhook-MANAGEMENT API (CRUD, test-ping, replay, DLQ
 * management; gated on `webhooks:manage` scope or a dashboard JWT). That
 * surface is Arkova's own, called by Arkova customers against
 * `api.arkova.ai` like any other v1 endpoint — it has no reason to bypass
 * the origin guard, and the broad prefix swept it in only because its mount
 * path happens to start with the same segment as the two paths that ARE
 * partner-inbound: Drive (`/api/v1/webhooks/drive`, WEBHOOK_PATHS.GOOGLE_DRIVE)
 * and ATS (`/api/v1/webhooks/ats`, mounted directly in index.ts). Only those
 * two literal sub-paths are exempt now; `/api/v1/webhooks` and
 * `/api/v1/webhooks/self-service` fall through to the normal v1 gating.
 */
const EXEMPT_PREFIXES = [
  '/health',
  '/api/health',
  '/jobs',
  '/webhooks',
  '/api/v1/webhooks/drive',
  '/api/v1/webhooks/ats',
] as const;

/**
 * Collapse `.`/`..` segments and repeated slashes before any allowlist or
 * route-family comparison.
 *
 * CTO review (SCRUM-3888): Express never normalizes a request path before
 * matching a mounted router — verified directly against express@5.2.1 (the
 * version pinned here), a request for `/api/v1/webhooks/../keys` reaches the
 * REAL `/api/v1` → `/webhooks` mount (the customer webhook-management router
 * above) with `req.url` still carrying the literal `../keys`. Comparing the
 * allowlist against the raw, unnormalized `req.path` would let a request
 * shaped like that read as an exempt partner-webhook call — via the
 * `/api/v1/webhooks/` string prefix — while it is actually addressed to a
 * different route one dot-segment away. Normalizing first makes the
 * allowlist check answer the same question Express's own routing will
 * eventually answer: "what path does this request resolve to."
 */
function normalizePath(rawPath: string): string {
  const normalized = posix.normalize(rawPath);
  return normalized === '.' ? '/' : normalized;
}

export function isOriginGuardExemptPath(path: string): boolean {
  const lower = normalizePath(path).toLowerCase();
  return EXEMPT_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * Coarse route-family buckets for the observe-mode counters — fine enough to
 * tell "this is the anonymous verify surface" from "this is authenticated
 * v1 traffic" apart without creating one counter per distinct path (which
 * would grow unbounded on ID-bearing routes like `/api/v1/verify/:publicId`).
 */
const ROUTE_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ['/api/v1/verify', 'api-v1-verify'],
  ['/api/v1', 'api-v1'],
  ['/api/v2', 'api-v2'],
  ['/api/anchor', 'api-anchor'],
  ['/api/partner-provisioning', 'api-partner-provisioning'],
  ['/api/audit', 'api-audit'],
  ['/api/docs', 'api-docs'],
  ['/api', 'api-other'],
  ['/.well-known', 'well-known'],
  ['/orgs', 'orgs-did'],
  ['/v2/openapi.json', 'v2-openapi'],
];

export function routeFamily(path: string): string {
  const lower = normalizePath(path).toLowerCase();
  for (const [prefix, name] of ROUTE_FAMILIES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return name;
  }
  return 'other';
}

/**
 * Constant-time compare. `false` on any shape mismatch (missing header,
 * missing secret, unequal length) BEFORE ever calling `timingSafeEqual` —
 * that function throws on unequal-length buffers, and letting the exception
 * path signal "no match" would leak the secret's length through timing on
 * the throw itself. Equal-length buffers are always compared through
 * `timingSafeEqual`, never `===`.
 */
export function originHeaderMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// ─── Observe-mode counters ──────────────────────────────────────────────────
//
// Process-local (Cloud Run runs multiple instances; this is a rollout signal
// read via authenticated /health?detailed=true on whichever instance answers
// the probe, not a durable audit trail — the structured `origin_guard_would_
// block` / `origin_guard_blocked` log lines are the durable record).

const wouldBlockCounts = new Map<string, number>();
let wouldBlockTotal = 0;

function recordWouldBlock(family: string): void {
  wouldBlockCounts.set(family, (wouldBlockCounts.get(family) ?? 0) + 1);
  wouldBlockTotal += 1;
}

export interface OriginGuardStats {
  mode: CloudflareOriginGuardMode;
  secretConfigured: boolean;
  total: number;
  byRouteFamily: Record<string, number>;
}

/** Snapshot for `/health?detailed=true` (routes/health.ts `info.originGuard`). */
export function getOriginGuardStats(): OriginGuardStats {
  return {
    mode: (config.cloudflareOriginGuardMode ?? 'off') as CloudflareOriginGuardMode,
    secretConfigured: Boolean(config.cloudflareOriginSecret),
    total: wouldBlockTotal,
    byRouteFamily: Object.fromEntries(wouldBlockCounts),
  };
}

/** Test-only: reset the in-memory counters between test cases. */
export function _resetOriginGuardStats(): void {
  wouldBlockCounts.clear();
  wouldBlockTotal = 0;
}

/**
 * Express middleware. Mounted FIRST in `index.ts` (immediately after
 * `correlationIdMiddleware` + `securityHeaders`, ahead of `corsMiddleware`
 * and every route) so every path gets one consistent answer regardless of
 * which router would eventually have handled it — see the file header for
 * the full allowlist rationale.
 */
export function requireCloudflareOrigin(req: Request, res: Response, next: NextFunction): void {
  const mode = (config.cloudflareOriginGuardMode ?? 'off') as CloudflareOriginGuardMode;
  if (mode === 'off') {
    next();
    return;
  }

  if (isOriginGuardExemptPath(req.path)) {
    next();
    return;
  }

  const provided = req.get(ORIGIN_AUTH_HEADER) ?? undefined;
  if (originHeaderMatches(provided, config.cloudflareOriginSecret)) {
    next();
    return;
  }

  const family = routeFamily(req.path);
  recordWouldBlock(family);

  // Never log the header value itself — only whether one was present, the
  // route family, and a keyed hash of the caller's IP (lib/ip-hash.ts).
  const logFields = {
    routeFamily: family,
    headerPresent: typeof provided === 'string' && provided.length > 0,
    ipHash: auditIpHash(req.ip, config.ipHashPepper),
  };

  if (mode === 'observe') {
    logger.warn(logFields, 'origin_guard_would_block');
    next();
    return;
  }

  // enforce
  logger.warn(logFields, 'origin_guard_blocked');
  res.status(403).json({
    error: {
      code: 'origin_not_allowed',
      message: 'This origin is not permitted to call this endpoint directly.',
    },
  });
}
