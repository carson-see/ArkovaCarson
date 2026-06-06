/**
 * Sentry integration for the Arkova Worker.
 *
 * Constitution 1.4: No user emails, document fingerprints, API keys in Sentry events.
 * Constitution 1.6: No document data in Sentry — documents never leave the device.
 *
 * PII scrubbing is mandatory and cannot be disabled.
 */

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import type { Event, ErrorEvent, Breadcrumb } from '@sentry/node';
import { getBuildSha } from './buildInfo.js';

// ---------------------------------------------------------------------------
// PII patterns to scrub (Constitution 1.4 + 1.6)
// ---------------------------------------------------------------------------

const URL_TOKEN_REGEX = /(access_token|token|key|secret|password|auth)=[^&\s]+/gi;
const TEXT_SCRUBBERS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]'],
  [/\b[a-f0-9]{64}\b/gi, '[FINGERPRINT]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/\bak_(live|test)_[a-zA-Z0-9]+/g, '[API_KEY]'],
  [/\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT]'],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, '[PHONE]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP_ADDR]'],
  // SCRUM-2249: project-ref before UUID scrubbing so the host is replaced whole.
  [/https:\/\/[a-z0-9]{20}\.supabase\.co/gi, 'https://[SUPABASE_PROJECT].supabase.co'],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '[UUID]',
  ],
];

const SENSITIVE_HEADERS = [
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'x-supabase-auth',
];

const SENSITIVE_EXTRA_KEYS = [
  'user_id',
  'org_id',
  'email',
  'file_content',
  'document_bytes',
  'fingerprint',
  'treasury_wif',
  'private_key',
  'secret_key',
  'api_key',
];

// ---------------------------------------------------------------------------
// Scrubbing functions
// ---------------------------------------------------------------------------

function scrubString(str: string): string {
  return TEXT_SCRUBBERS.reduce((value, [pattern, replacement]) => (
    value.replace(pattern, replacement)
  ), str);
}

function scrubUrl(url: string): string {
  return scrubString(url.replace(URL_TOKEN_REGEX, '$1=[FILTERED]'));
}

/**
 * Scrub PII from a Sentry event before it's sent.
 * Returns null to drop the event entirely.
 */
export function scrubPiiFromEvent(event: Event | null): Event | null {
  if (!event) return null;

  // Scrub exception messages
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = scrubString(exception.value);
      }
    }
  }

  // Scrub top-level message
  if (event.message) {
    event.message = scrubString(event.message);
  }

  // SCRUM-2249: transaction name carries the route, which embeds org_id UUIDs.
  if (typeof event.transaction === 'string') {
    event.transaction = scrubString(event.transaction);
  }

  // Scrub request data
  if (event.request) {
    // SCRUM-2249: request URL embeds org_id / anchor.id UUIDs and may carry
    // the Supabase project ref — scrub both.
    if (typeof event.request.url === 'string') {
      event.request.url = scrubUrl(event.request.url);
    }

    // Strip sensitive headers
    if (event.request.headers) {
      for (const header of SENSITIVE_HEADERS) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[FILTERED]';
        }
      }
    }

    // Strip request body entirely — may contain document data (Constitution 1.6)
    if (event.request.data) {
      event.request.data = '[FILTERED]';
    }

    // Strip cookies
    if (event.request.cookies) {
      delete event.request.cookies;
    }
  }

  // Scrub user context — keep ID, strip email
  if (event.user) {
    delete event.user.email;
    delete event.user.username;
    delete event.user.ip_address;
  }

  // Scrub extra context
  if (event.extra) {
    for (const key of SENSITIVE_EXTRA_KEYS) {
      if (key in event.extra) {
        (event.extra as Record<string, unknown>)[key] = '[FILTERED]';
      }
    }
  }

  // PII-09: Scrub event tags
  if (event.tags) {
    for (const [tagKey, tagValue] of Object.entries(event.tags)) {
      if (typeof tagValue === 'string') {
        const scrubbed = scrubString(tagValue);
        if (scrubbed !== tagValue) {
          (event.tags as Record<string, string>)[tagKey] = scrubbed;
        }
      }
    }
  }

  return event;
}

/**
 * Scrub PII from Sentry breadcrumbs.
 */
export function scrubPiiFromBreadcrumb(breadcrumb: Breadcrumb | null): Breadcrumb | null {
  if (!breadcrumb) return null;

  if (breadcrumb.data) {
    // Scrub URLs containing tokens
    if (breadcrumb.data.url && typeof breadcrumb.data.url === 'string') {
      breadcrumb.data.url = scrubUrl(breadcrumb.data.url);
    }

    // Strip request bodies from fetch breadcrumbs
    if (breadcrumb.data.body) {
      delete breadcrumb.data.body;
    }
  }

  // Scrub breadcrumb message
  if (breadcrumb.message) {
    breadcrumb.message = scrubString(breadcrumb.message);
  }

  return breadcrumb;
}

// ---------------------------------------------------------------------------
// Noise filters (SCRUM-2256 / HARDEN-1-F)
// ---------------------------------------------------------------------------
//
// Benign, high-volume, non-actionable errors. Same intent as the frontend:
//   - GoTrue Navigator LockManager contention from supabase-js token refresh.
//   - Login/token AbortError when a request is aborted.
// Exported for unit-testability.
export const IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [
  /Navigator ?LockManager/i,
  /Acquiring an exclusive Navigator LockManager lock/i,
  /lock:.*-auth-token/i,
  /AbortError: .*aborted/i,
  'AbortError',
];

// ---------------------------------------------------------------------------
// Sentry initialization
// ---------------------------------------------------------------------------

export interface SentryRuntimeConfig {
  kRevision?: string;
  kService?: string;
}

export function initSentry(
  dsn: string | undefined,
  environment: string,
  runtime: SentryRuntimeConfig = {},
): void {
  if (!dsn) {
    // AUDIT-22: console.log intentional here — logger imports config, which
    // creates a circular dependency. These bootstrap messages fire once at startup.
    console.log('[Sentry] No DSN configured — skipping initialization');
    return;
  }

  // SCRUM-2254: real build SHA (BUILD_SHA baked at Docker build via
  // --build-arg, same value /health exposes) instead of the package version.
  // Falls back to npm_package_version, then '0.1.0' for local dev.
  const buildSha = getBuildSha();
  const release =
    buildSha !== 'unknown' ? buildSha : process.env.npm_package_version ?? '0.1.0';

  // SCRUM-2254: identify the deployment surface. Cloud Run sets K_REVISION
  // (e.g. arkova-worker-00123-abc) and K_SERVICE; prefer those over the
  // default 'localhost'.
  const serverName = runtime.kRevision ?? runtime.kService ?? 'arkova-worker';

  Sentry.init({
    dsn,
    environment,
    release,
    serverName,
    // SCRUM-2256: drop benign GoTrue Navigator-lock + AbortError noise.
    ignoreErrors: IGNORED_ERROR_PATTERNS,
    integrations: [nodeProfilingIntegration()],

    // Performance sampling
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    profilesSampleRate: environment === 'production' ? 0.1 : 1.0,

    // PII scrubbing — mandatory (Constitution 1.4 + 1.6)
    beforeSend(event) {
      return scrubPiiFromEvent(event) as ErrorEvent | null;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubPiiFromBreadcrumb(breadcrumb);
    },

    // Never send default PII
    sendDefaultPii: false,
  });

  console.log(`[Sentry] Initialized for ${environment}`);  
}

// ---------------------------------------------------------------------------
// Stuck-anchor-monitor fingerprinting (SCRUM-2255 / HARDEN-1-F)
// ---------------------------------------------------------------------------
//
// The stuck-anchor monitor runs hourly. Without an explicit fingerprint, each
// run produces a fresh Sentry issue (default grouping keys on message + stack),
// so a persistent stall floods the inbox with 20+ near-duplicate issues. A
// fixed fingerprint collapses all re-fires into ONE issue that simply keeps
// incrementing its event count.
//
// SEAM FOR PR #1055 (feat/stuck-anchor-monitor, SCRUM-2234): the monitor's
// Sentry capture is NOT on main yet — it ships with #1055. That PR should call
// `captureStuckAnchorAlert(...)` from `jobs/pipeline-health.ts` (or wherever the
// stuck-anchor alert is raised) INSTEAD of a bare `Sentry.captureMessage`, so it
// inherits the stable fingerprint below. Do not duplicate this helper there.
export const STUCK_ANCHOR_FINGERPRINT = ['stuck-anchor-monitor'] as const;

/**
 * Capture a stuck-anchor-monitor alert with a stable fingerprint so hourly
 * re-fires collapse into a single Sentry issue.
 *
 * @param message - Human-readable summary (e.g. "12 anchors stuck in SUBMITTED").
 * @param extra   - Optional structured context (counts, statuses). Must be
 *                  PII-free — the beforeSend scrubber still runs, but callers
 *                  should pass aggregate metrics, never per-document data.
 */
export function captureStuckAnchorAlert(
  message: string,
  extra?: Record<string, unknown>,
): void {
  Sentry.captureMessage(message, {
    level: 'warning',
    fingerprint: [...STUCK_ANCHOR_FINGERPRINT],
    ...(extra ? { extra } : {}),
  });
}

// ---------------------------------------------------------------------------
// Sentry Cron Monitoring (Phase 4, Item 18)
// ---------------------------------------------------------------------------

/**
 * Wraps a cron job function with Sentry Crons monitoring.
 * Reports check-in start, success, or failure to Sentry for visibility.
 *
 * @param monitorSlug - Unique slug for this cron monitor in Sentry
 * @param schedule - Cron schedule expression (for auto-creating monitors)
 * @param fn - The cron job function to wrap
 */
export function withCronMonitoring<T>(
  monitorSlug: string,
  schedule: string,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const checkInId = Sentry.captureCheckIn({
      monitorSlug,
      status: 'in_progress',
    }, {
      schedule: { type: 'crontab', value: schedule },
      maxRuntime: 10, // minutes
    });

    try {
      const result = await fn();
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug,
        status: 'ok',
      });
      await Sentry.flush(2000);
      return result;
    } catch (error) {
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug,
        status: 'error',
      });
      await Sentry.flush(2000);
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// RPC fallback observability (SCRUM-1262 R1-8 + /simplify carry-over)
// ---------------------------------------------------------------------------
//
// Pairs a Sentry breadcrumb + structured warn log for RPC-fallback events
// (e.g. GetBlock listunspent → mempool.space). Centralised here so that
// future fallback sites (`getrawtransaction`, `getblockheader`, fee
// estimation) all emit the same shape and Cloud Logging / Arize / db-health
// dashboards can rely on a fixed field set.
//
// Field shape locked:
//   - `chain_rpc_fallback: true`     — boolean filter for log views
//   - `method: string`               — RPC method name that fell back
//   - `provider: string`             — original provider (e.g. 'getblock')
//   - `reason: string`               — short error message from the RPC call
//
// Caller MUST pass a logger.warn-compatible logger so this util stays
// dependency-free (avoids circular imports from `utils/logger.ts` consumers
// that also import sentry — e.g. the AUDIT-22 bootstrap path).

export interface RpcFallbackLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface EmitRpcFallbackArgs {
  /** Provider that fell back, e.g. `'getblock'`. Used as the breadcrumb tag. */
  provider: string;
  /** RPC method that fell back, e.g. `'listunspent'`, `'getrawtransaction'`. */
  method: string;
  /** Error from the failing RPC call. Surfaced as `reason` in both events. */
  error: unknown;
  /** Where the call falls back to, e.g. `'mempool.space'`. */
  fallbackTo: string;
  /** logger.warn-compatible target — pass `logger` from `utils/logger.js`. */
  logger: RpcFallbackLogger;
  /** Origin file/method, e.g. `'GetBlockHybridProvider.listUnspent'`. */
  origin: string;
}

export function emitRpcFallback(args: EmitRpcFallbackArgs): void {
  const reason = args.error instanceof Error ? args.error.message : 'unknown';
  Sentry.addBreadcrumb({
    category: 'chain.rpc-fallback',
    message: `${args.provider}.${args.method} → ${args.fallbackTo}`,
    level: 'warning',
    data: { method: args.method, reason },
  });
  args.logger.warn(
    {
      chain_rpc_fallback: true,
      method: args.method,
      provider: args.provider,
      reason,
    },
    `${args.origin}: RPC fallback to ${args.fallbackTo}`,
  );
}

export { Sentry };
