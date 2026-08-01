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
import { scrubString, scrubUrl } from './pii-scrub.js';

// ---------------------------------------------------------------------------
// PII patterns to scrub (Constitution 1.4 + 1.6)
// ---------------------------------------------------------------------------
//
// SCRUM-2492 (§1.6A): the email / fingerprint / SSN / API-key / JWT / phone /
// IP / Supabase-ref / UUID regexes + `scrubString` / `scrubUrl` were extracted
// to `./pii-scrub.ts` so the bounded connector-error `detail` builder
// (`utils/byte-safety.ts`) reuses the SAME PII redaction. Re-exported here so
// existing `utils/sentry.ts` importers keep working.
export { scrubString, scrubUrl };

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
// SCRUM-2492 (§1.6A): type-based binary scrub
// ---------------------------------------------------------------------------
//
// Connector-fetched document bytes must never reach Sentry. The existing
// scrubber below is key-NAME based (it only redacts known field names). This
// type-based pass runs FIRST and drops any binary value — Buffer, any
// TypedArray/DataView, ArrayBuffer, or the serialized `{ type: 'Buffer',
// data: [...] }` shape — by TYPE, regardless of the key it appears under,
// recursively across the whole event (contexts, extra, tags, exception
// values, breadcrumb data, arbitrary nested objects).

export const REDACTED_BYTES_TOKEN = '[REDACTED_BYTES]';

// Bound the recursive walk (Sentry events can nest; avoid pathological depth).
const MAX_SCRUB_DEPTH = 8;

function isBinaryValue(value: unknown): boolean {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (ArrayBuffer.isView(value as ArrayBufferView)) return true; // every TypedArray + DataView
  if (value instanceof ArrayBuffer) return true;
  return false;
}

function isSerializedBufferShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'Buffer' && Array.isArray(obj.data);
}

/**
 * Recursively replace any binary value (by type, regardless of key) with a
 * redaction token. Mutates the passed object in place (Sentry expects the same
 * event object back) and also returns it. Strings/numbers/etc. pass through —
 * the existing PII string scrubbers handle those.
 */
export function scrubBinaryValues<T>(value: T, depth = 0): T {
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (isSerializedBufferShape(value)) {
    return REDACTED_BYTES_TOKEN as unknown as T;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = isBinaryValue(value[i]) ? REDACTED_BYTES_TOKEN : scrubBinaryValues(value[i], depth + 1);
    }
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (isBinaryValue(child) || isSerializedBufferShape(child)) {
      obj[key] = REDACTED_BYTES_TOKEN;
    } else {
      obj[key] = scrubBinaryValues(child, depth + 1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Scrubbing functions
// ---------------------------------------------------------------------------
// `scrubString` / `scrubUrl` are imported from `./pii-scrub.js` (re-exported
// above) — SCRUM-2492 single-source-of-truth for the PII regexes.

/**
 * Scrub PII from a Sentry event before it's sent.
 * Returns null to drop the event entirely.
 */
export function scrubPiiFromEvent(event: Event | null): Event | null {
  if (!event) return null;

  // SCRUM-2492 (§1.6A): drop binary values BY TYPE first, across the whole
  // event (contexts, extra, tags, exception values, arbitrary nested keys),
  // before the key-name-based PII passes below. Connector document bytes must
  // never reach Sentry regardless of the field they ride on.
  scrubBinaryValues(event);

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

  // SCRUM-2492 (§1.6A): type-based binary scrub over the breadcrumb (incl. its
  // `data` bag) before the key-name pass — document bytes must never ride a
  // breadcrumb into Sentry.
  scrubBinaryValues(breadcrumb);

  const data = breadcrumb.data as
    | (Record<string, unknown> & { url?: unknown; body?: unknown })
    | undefined;
  if (data?.url && typeof data.url === 'string') {
    data.url = scrubUrl(data.url);
  }
  if (data?.body) {
    delete data.body;
  }

  breadcrumb.message = breadcrumb.message
    ? scrubString(breadcrumb.message)
    : breadcrumb.message;

  return breadcrumb;
}

const WORKER_AUTH_NOISE_PATTERNS = [
  /Navigator ?LockManager/i,
  /Acquiring an exclusive Navigator LockManager lock/i,
  /lock:.*-auth-token/i,
  /AbortError: .*aborted/i,
  'AbortError',
] satisfies Array<string | RegExp>;

// Benign, high-volume auth/lock noise; exported for init wiring and unit tests.
export const IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [...WORKER_AUTH_NOISE_PATTERNS];

// ---------------------------------------------------------------------------
// Sentry initialization
// ---------------------------------------------------------------------------

export interface SentryRuntimeConfig {
  kRevision?: string;
  kService?: string;
}

// ---------------------------------------------------------------------------
// MT-1 (SCRUM-2901): Sentry environment derivation
// ---------------------------------------------------------------------------
//
// Rigs and staging run with NODE_ENV=production, so NODE_ENV cannot be the
// environment tag — a rig standup would flood prod alerting. The deployment
// surface identity (K_SERVICE) is the honest signal: only the real prod
// service earns 'production'; every other Cloud Run service is tagged with
// its own service name (per-rig attribution, filterable as non-prod).

/** The one Cloud Run service whose events may be tagged 'production'. */
export const PROD_SERVICE_NAME = 'arkova-worker';

export interface SentryEnvironmentInputs {
  /** Explicit SENTRY_ENVIRONMENT override (wins when non-blank). */
  sentryEnvironment?: string;
  /** Cloud Run service name (K_SERVICE); unset off Cloud Run. */
  kService?: string;
  /** NODE_ENV — trusted only off Cloud Run, and never for 'production'. */
  nodeEnv: string;
}

export function resolveSentryEnvironment(inputs: SentryEnvironmentInputs): string {
  const explicit = inputs.sentryEnvironment?.trim();
  if (explicit) {
    // Guard (review P1): an explicit override may RENAME non-prod environments,
    // but must NOT let a non-prod service identity claim 'production' — otherwise
    // a rig with SENTRY_ENVIRONMENT=production floods the prod alert stream, the
    // exact failure this derivation prevents. Only the real prod service may
    // emit 'production', even via override.
    if (explicit !== 'production' || inputs.kService === PROD_SERVICE_NAME) {
      return explicit;
    }
    // else: fall through to the honest K_SERVICE/NODE_ENV derivation below.
  }

  if (inputs.kService) {
    // NOTE (Architect review): the prod canary revision deploys onto the SAME
    // service (`--tag canary --no-traffic`), so K_SERVICE is still
    // 'arkova-worker' and canary events tag 'production'. K_SERVICE structurally
    // can't distinguish canary from live (only K_REVISION carries the tag). This
    // is acceptable today; if canary isolation is ever wanted, derive from the
    // revision tag here.
    return inputs.kService === PROD_SERVICE_NAME ? 'production' : inputs.kService;
  }

  // §1.5 honesty: a bare NODE_ENV=production without the prod service
  // identity (local shell, docker run) must not pollute the prod stream.
  return inputs.nodeEnv === 'production' ? 'local-production' : inputs.nodeEnv;
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
    buildSha === 'unknown' ? process.env.npm_package_version ?? '0.1.0' : buildSha;

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
  level: 'warning' | 'error' = 'warning',
): void {
  Sentry.captureMessage(message, {
    level,
    fingerprint: [...STUCK_ANCHOR_FINGERPRINT],
    ...(extra ? { extra } : {}),
  });
}

// ---------------------------------------------------------------------------
// Pipeline-throughput-monitor fingerprinting (SCRUM-2901 / PI-0.5)
// ---------------------------------------------------------------------------
//
// The pipeline-throughput monitor (jobs/pipelineThroughputMonitor.ts) is the
// dead-man switch on record→anchor conversion: /health says anchoring:"ok"
// while the unlinked public-records backlog grows, so this monitor pages when
// feeders produce records and NOTHING secures in the window. Like the
// stuck-anchor monitor above, a persistent stall re-fires on every scheduled
// run — a fixed fingerprint collapses all re-fires into ONE Sentry issue that
// keeps incrementing its event count instead of flooding the inbox.
export const PIPELINE_THROUGHPUT_FINGERPRINT = ['pipeline-throughput-monitor'] as const;

/**
 * Capture a pipeline-throughput-monitor alert with a stable fingerprint so
 * scheduled re-fires collapse into a single Sentry issue.
 *
 * PII (§1.4): callers MUST pass aggregate metrics only — window counts and
 * backlog totals, never emails, document fingerprints, API keys, or per-row
 * ids. The beforeSend scrubber still runs, but the context is aggregate-only
 * by construction.
 *
 * Always error-level: both fire conditions (total securing death, linker
 * stall) are page-worthy — there is no warning-tier caller, so no severity
 * parameter (review nit, 2026-07-17).
 *
 * @param message - Human-readable summary (e.g. "812 new unlinked records,
 *                  0 anchors secured in 24h").
 * @param extra   - Optional aggregate-only structured context (counts).
 */
export const PIPELINE_THROUGHPUT_ALERT_SOURCE = 'pipeline-throughput-monitor';
export const PIPELINE_THROUGHPUT_ALERT_TYPE = 'pipeline_throughput';

export interface PipelineThroughputEscalation {
  /**
   * Duration bucket ('t24h' | 't48h' | …). Appended to the fingerprint so that
   * crossing an escalation boundary opens a genuinely NEW Sentry issue instead
   * of incrementing a stale one. Omit for the un-escalated default.
   */
  sustainedBucket?: string;
  /** 'fatal' once the condition is sustained past 72h; 'error' otherwise. */
  level?: 'error' | 'fatal';
}

export function capturePipelineThroughputAlert(
  message: string,
  extra?: Record<string, unknown>,
  escalation: PipelineThroughputEscalation = {},
): void {
  const bucket = escalation.sustainedBucket;
  Sentry.captureMessage(message, {
    level: escalation.level ?? 'error',
    // SCRUM-3050: the bucket is part of the grouping key. Without it a 70-hour
    // outage produced ONE issue that was created on hour zero and never
    // notified again — the monitor got quieter as the incident got worse.
    fingerprint: bucket
      ? [...PIPELINE_THROUGHPUT_FINGERPRINT, bucket]
      : [...PIPELINE_THROUGHPUT_FINGERPRINT],
    // TAGS, not just extra: Sentry issue-alert rules filter on TAGS
    // (`TaggedEventFilter`). This helper previously carried source/story only
    // inside `extra`, so a tag-filtered rule could never have matched it — the
    // alert would have been unroutable even once someone created the rule.
    tags: {
      source: PIPELINE_THROUGHPUT_ALERT_SOURCE,
      story: 'SCRUM-2901',
      alert_type: PIPELINE_THROUGHPUT_ALERT_TYPE,
      ...(bucket ? { sustained_bucket: bucket } : {}),
    },
    ...(extra ? { extra } : {}),
  });
}

// ---------------------------------------------------------------------------
// Scheduler pause dead-man fingerprinting (SCRUM-2900 / PI-0.5)
// ---------------------------------------------------------------------------
//
// The scheduler pause audit (jobs/scheduler-pause-attribution.ts) fires when a
// monitored Cloud Scheduler job is PAUSED without a codified manifest pause or
// an active maintenance-pause sanction — the 2026-05 untracked feeder-freeze
// shape. A persistent unexpected pause re-fires on every scheduled audit run;
// the fixed fingerprint collapses re-fires into ONE Sentry issue.
export const SCHEDULER_PAUSE_FINGERPRINT = ['scheduler-pause-deadman'] as const;

/**
 * Capture a scheduler-pause dead-man alert with a stable fingerprint so
 * scheduled re-fires collapse into a single Sentry issue.
 *
 * PII (§1.4): the acting identity that paused the job (from the Cloud
 * Scheduler audit log) is an OPERATOR / service-account principal —
 * operational attribution data, not user PII. Callers pass it in `extra`
 * (e.g. `findings[].actor_principal`), NEVER in the message: `beforeSend`
 * runs `scrubString` over messages and would redact an email-shaped
 * principal to [EMAIL], and the message must stay grouping-stable anyway.
 * Everything else in `extra` stays aggregate/operational-only — job ids,
 * classifications, timestamps; never user emails, document fingerprints, or
 * keys (mirrors capturePipelineThroughputAlert).
 *
 * Always error-level: an unexpected pause of a critical scheduled job is
 * page-worthy by definition — there is no warning-tier caller.
 *
 * @param message - Human-readable summary (job ids + classification only).
 * @param extra   - Structured context incl. per-finding actor attribution.
 */
export function captureSchedulerPauseAlert(
  message: string,
  extra?: Record<string, unknown>,
): void {
  Sentry.captureMessage(message, {
    level: 'error',
    fingerprint: [...SCHEDULER_PAUSE_FINGERPRINT],
    ...(extra ? { extra } : {}),
  });
}

// ---------------------------------------------------------------------------
// Credit-conservation reconciler fingerprinting (S1-9 / SCRUM-2349 / PM-25)
// ---------------------------------------------------------------------------
//
// The money-conservation reconciler runs daily (calls the prod
// `org_credit_ledger_divergence` SQL function over all orgs and pages on any
// drift). Like the stuck-anchor monitor, a persistent divergence would, without
// a stable fingerprint, mint a fresh Sentry issue every day. A fixed
// fingerprint collapses repeated daily drift alerts into ONE issue that keeps
// incrementing its event count.
export const CREDIT_CONSERVATION_FINGERPRINT = ['credit-conservation-reconciler'] as const;

/**
 * Capture a credit-conservation drift alert with a stable fingerprint so daily
 * re-fires collapse into a single Sentry issue.
 *
 * PII (§1.4): raw credit amounts are PII. Callers MUST pass aggregate context
 * only — org_id + divergence MAGNITUDE, never raw balance / ledger_sum /
 * expected. The beforeSend scrubber still runs, but the caller builds the
 * context aggregate-only by construction.
 *
 * @param message - Human-readable summary (e.g. "Credit conservation VIOLATED:
 *                  2 of 140 org(s) diverge").
 * @param extra   - Optional aggregate-only structured context (counts, per-org
 *                  {org_id, divergence}). No raw balances.
 */
export function captureCreditConservationAlert(
  message: string,
  extra?: Record<string, unknown>,
  level: 'warning' | 'error' = 'error',
): void {
  Sentry.captureMessage(message, {
    level,
    fingerprint: [...CREDIT_CONSERVATION_FINGERPRINT],
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
