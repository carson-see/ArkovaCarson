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

// ---------------------------------------------------------------------------
// PII patterns to scrub (Constitution 1.4 + 1.6)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SHA256_REGEX = /\b[a-f0-9]{64}\b/gi;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const API_KEY_REGEX = /\bak_(live|test)_[a-zA-Z0-9]+/g;
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const URL_TOKEN_REGEX = /(access_token|token|key|secret|password|auth)=[^&\s]+/gi;

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
    .replace(JWT_REGEX, '[JWT]');
}

function scrubUrl(url: string): string {
  return url.replace(URL_TOKEN_REGEX, '$1=[FILTERED]');
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

  // Scrub request data
  if (event.request) {
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
// Sentry initialization
// ---------------------------------------------------------------------------

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) {
    // AUDIT-22: console.log intentional here — logger imports config, which
    // creates a circular dependency. These bootstrap messages fire once at startup.
    console.log('[Sentry] No DSN configured — skipping initialization'); // eslint-disable-line no-console
    return;
  }

  Sentry.init({
    dsn,
    environment,
    release: process.env.npm_package_version ?? '0.1.0',
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

  console.log(`[Sentry] Initialized for ${environment}`); // eslint-disable-line no-console
}

export { Sentry };
