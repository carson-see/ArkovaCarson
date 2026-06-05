/**
 * Sentry integration for the Arkova React frontend.
 *
 * Constitution 1.4: No user emails, document fingerprints, API keys in Sentry events.
 * Constitution 1.6: No document data in Sentry — documents never leave the device.
 *
 * PII scrubbing is mandatory and cannot be disabled.
 */

import * as Sentry from '@sentry/react';
import type { Event, ErrorEvent, Breadcrumb } from '@sentry/react';

// ---------------------------------------------------------------------------
// PII patterns to scrub (Constitution 1.4 + 1.6)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SHA256_REGEX = /\b[a-f0-9]{64}\b/gi;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const API_KEY_REGEX = /\bak_(live|test)_[a-zA-Z0-9]+/g;
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const PHONE_REGEX = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g;
const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_TOKEN_REGEX = /(access_token|token|key|secret|password|auth)=[^&\s]+/gi;
// SCRUM-2249 (HARDEN-1-F): UUIDs are org_id/user_id/anchor.id identifiers that
// leak through transaction names and request URLs (e.g. /admin/organizations/<uuid>).
// Collapsed to a stable placeholder so Sentry issue grouping stays coherent.
const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// SCRUM-2249: GoTrue Navigator-lock / auth-error messages embed the prod
// Supabase project ref (https://<ref>.supabase.co). Scrub to a stable host.
const SUPABASE_REF_REGEX = /https:\/\/[a-z0-9]{20}\.supabase\.co/gi;

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
  return str
    .replace(EMAIL_REGEX, '[EMAIL]')
    .replace(SHA256_REGEX, '[FINGERPRINT]')
    .replace(SSN_REGEX, '[SSN]')
    .replace(API_KEY_REGEX, '[API_KEY]')
    .replace(JWT_REGEX, '[JWT]')
    .replace(PHONE_REGEX, '[PHONE]')
    .replace(IPV4_REGEX, '[IP_ADDR]')
    // SCRUM-2249: project-ref before generic identifier scrubbing so the
    // 20-char ref is replaced as a whole, then any UUID identifiers.
    .replace(SUPABASE_REF_REGEX, 'https://[SUPABASE_PROJECT].supabase.co')
    .replace(UUID_REGEX, '[UUID]');
}

function scrubUrl(url: string): string {
  return url
    .replace(URL_TOKEN_REGEX, '$1=[FILTERED]')
    .replace(SUPABASE_REF_REGEX, 'https://[SUPABASE_PROJECT].supabase.co')
    .replace(UUID_REGEX, '[UUID]');
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

  // SCRUM-2249: transaction name carries the route, which embeds org_id UUIDs
  // (e.g. /admin/organizations/<uuid>). Scrub to keep grouping coherent.
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
// Benign, high-volume, non-actionable errors that drown out real signal:
//   - GoTrue Navigator LockManager contention: supabase-js v2 uses the Web
//     Locks API to serialize token refresh across tabs; contention surfaces as
//     "Navigator LockManager" / "lock:..." / "AbortError" noise, not a bug.
//   - Login AbortError: the user navigates away mid sign-in and the fetch is
//     aborted. Expected, not actionable.
//
// Exported so the filter list is unit-testable and shared with any future
// init path.
export const IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [
  /Navigator ?LockManager/i,
  /Acquiring an exclusive Navigator LockManager lock/i,
  /lock:.*-auth-token/i,
  // AbortError fired by an aborted login/token fetch.
  /AbortError: .*aborted/i,
  'AbortError',
];

// ---------------------------------------------------------------------------
// Sentry initialization
// ---------------------------------------------------------------------------

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    console.log('[Sentry] No DSN configured — skipping initialization');
    return;
  }

  const environment = import.meta.env.MODE ?? 'development';

  // SCRUM-2254: real build SHA (injected at build via __APP_RELEASE__ in
  // vite.config.ts, sourced from VERCEL_GIT_COMMIT_SHA / GIT_COMMIT_SHA).
  // Falls back to VITE_APP_VERSION, then '0.1.0' for local dev.
  const release =
    (typeof __APP_RELEASE__ !== 'undefined' && __APP_RELEASE__ !== 'dev'
      ? __APP_RELEASE__
      : undefined) ??
    import.meta.env.VITE_APP_VERSION ??
    '0.1.0';

  Sentry.init({
    dsn,
    environment,
    release,
    // SCRUM-2254: identify the frontend deployment surface (replaces implicit
    // 'localhost'). The browser SDK has no top-level serverName; set it as a
    // tag on every event via initialScope. Vercel sets VITE_APP_URL.
    initialScope: {
      tags: { server_name: import.meta.env.VITE_APP_URL ?? 'arkova-frontend' },
    },
    // SCRUM-2256: drop benign GoTrue Navigator-lock + login AbortError noise.
    ignoreErrors: IGNORED_ERROR_PATTERNS,
    integrations: [
      Sentry.browserTracingIntegration(),
      // replayIntegration removed — rrweb uses new Function() internally for CSS
      // reconstruction, which violates the production CSP (script-src without
      // 'unsafe-eval'). See ARKOVA-FRONTEND-9.
    ],

    // Performance sampling
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,

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
}

export { Sentry };
