/**
 * MCP anomaly detection — rolling-window heuristics over recent tool
 * invocations. Every tool call from `withTelemetry` passes an
 * `AnomalyEvent` through `ingest()`; when any heuristic fires we emit
 * a Sentry event so exploitation attempts surface in minutes.
 *
 * Heuristics:
 *   1. `rapid_tool_cycling`   — N distinct tools in a window per key.
 *   2. `auth_failure_burst`   — repeated auth failures per actor.
 *   3. `cross_tenant_access`  — one key touching multiple orgs.
 *   4. `oversized_args`       — single-call arg payload over budget.
 *   5. `rate_limit_storm`     — ignored 429s per actor.
 *
 * Dedupe: `${signal}:${key}:${minuteBucket}` is held for 5 minutes so
 * one burst does not storm Sentry.
 *
 * Pure TypeScript — clock + Sentry sender are injected so tests are
 * hermetic. The Workers runtime instantiates one detector at module
 * scope in `mcp-server.ts` so heuristics can span requests inside a
 * single isolate.
 */

import type { McpOutcome } from './mcp-audit-log';

export type AnomalySignal =
  | 'rapid_tool_cycling'
  | 'auth_failure_burst'
  | 'cross_tenant_access'
  | 'oversized_args'
  | 'rate_limit_storm';

export interface AnomalyEvent {
  toolName: string;
  apiKeyId: string | null;
  userId: string | null;
  orgId?: string | null;
  clientIp: string | null;
  outcome: McpOutcome;
  argsBytes: number;
  /** Milliseconds since epoch. */
  timestamp: number;
}

export interface AnomalyAlert {
  signal: AnomalySignal;
  fingerprint: string;
  severity: 'warning' | 'error' | 'critical';
  summary: string;
  detail: Record<string, unknown>;
}

export interface AnomalyDetectorConfig {
  /** Window length in ms. Default: 60s. */
  windowMs?: number;
  /** Dedupe period in ms. */
  dedupeMs?: number;
  rapidToolCycleThreshold?: number;
  authFailureThreshold?: number;
  crossTenantThreshold?: number;
  oversizedArgsThreshold?: number;
  rateLimitStormThreshold?: number;
  emit?: (alert: AnomalyAlert) => void;
  now?: () => number;
}

const DEFAULTS: Required<Omit<AnomalyDetectorConfig, 'emit' | 'now'>> = {
  windowMs: 60_000,
  dedupeMs: 5 * 60_000,
  rapidToolCycleThreshold: 6,
  authFailureThreshold: 5,
  crossTenantThreshold: 3,
  oversizedArgsThreshold: 16 * 1024,
  rateLimitStormThreshold: 20,
};

const SENTRY_DSN_RE = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/;

export interface AnomalyDetector {
  ingest: (event: AnomalyEvent) => AnomalyAlert[];
  snapshot: () => { events: number; dedupe: number };
}

export function createAnomalyDetector(config: AnomalyDetectorConfig = {}): AnomalyDetector {
  const merged = { ...DEFAULTS, ...config };
  const now = config.now ?? (() => Date.now());
  const emit = config.emit;

  const events: AnomalyEvent[] = [];
  const dedupe = new Map<string, number>();

  function trimWindow(): void {
    const cutoff = now() - merged.windowMs;
    while (events.length && events[0].timestamp < cutoff) events.shift();
    const dedupeCutoff = now() - merged.dedupeMs;
    for (const [fp, ts] of dedupe) {
      if (ts < dedupeCutoff) dedupe.delete(fp);
    }
  }

  function shouldEmit(fingerprint: string): boolean {
    const existing = dedupe.get(fingerprint);
    if (existing && existing >= now() - merged.dedupeMs) return false;
    dedupe.set(fingerprint, now());
    return true;
  }

  function bucket(): number {
    return Math.floor(now() / merged.windowMs);
  }

  function ingest(event: AnomalyEvent): AnomalyAlert[] {
    events.push(event);
    trimWindow();

    const keyActor = event.apiKeyId;
    const ipActor = event.apiKeyId ?? event.clientIp;

    // Single pass — each heuristic accumulates only what it needs.
    const toolsByKey = new Set<string>();
    const orgsByKey = new Set<string>();
    let authFailuresForActor = 0;
    let rateLimitsForActor = 0;

    for (const e of events) {
      if (keyActor && e.apiKeyId === keyActor) {
        toolsByKey.add(e.toolName);
        if (e.orgId) orgsByKey.add(e.orgId);
      }
      if (ipActor && (e.apiKeyId ?? e.clientIp) === ipActor) {
        if (e.outcome === 'auth_failed') authFailuresForActor++;
        if (e.outcome === 'rate_limited') rateLimitsForActor++;
      }
    }

    const fired: AnomalyAlert[] = [];
    const b = bucket();

    if (keyActor && toolsByKey.size >= merged.rapidToolCycleThreshold) {
      fired.push({
        signal: 'rapid_tool_cycling',
        fingerprint: `rapid_tool_cycling:${keyActor}:${b}`,
        severity: 'warning',
        summary: `API key cycled across ${toolsByKey.size} tools in ${merged.windowMs / 1000}s`,
        detail: { apiKeyId: keyActor, tools: [...toolsByKey] },
      });
    }

    if (
      event.outcome === 'auth_failed' &&
      ipActor &&
      authFailuresForActor >= merged.authFailureThreshold
    ) {
      fired.push({
        signal: 'auth_failure_burst',
        fingerprint: `auth_failure_burst:${ipActor}:${b}`,
        severity: 'error',
        summary: `${authFailuresForActor} auth failures from ${ipActor} in ${merged.windowMs / 1000}s`,
        detail: { actor: ipActor, count: authFailuresForActor },
      });
    }

    if (keyActor && event.orgId && orgsByKey.size >= merged.crossTenantThreshold) {
      fired.push({
        signal: 'cross_tenant_access',
        fingerprint: `cross_tenant_access:${keyActor}:${b}`,
        severity: 'critical',
        summary: `API key referenced ${orgsByKey.size} distinct orgs in ${merged.windowMs / 1000}s`,
        detail: { apiKeyId: keyActor, orgs: [...orgsByKey] },
      });
    }

    if (event.argsBytes > merged.oversizedArgsThreshold) {
      const actor = event.apiKeyId ?? event.clientIp ?? 'unknown';
      fired.push({
        signal: 'oversized_args',
        fingerprint: `oversized_args:${actor}:${event.toolName}:${b}`,
        severity: 'warning',
        summary: `Tool ${event.toolName} received ${event.argsBytes}-byte payload`,
        detail: { tool: event.toolName, bytes: event.argsBytes, actor },
      });
    }

    if (
      event.outcome === 'rate_limited' &&
      ipActor &&
      rateLimitsForActor >= merged.rateLimitStormThreshold
    ) {
      fired.push({
        signal: 'rate_limit_storm',
        fingerprint: `rate_limit_storm:${ipActor}:${b}`,
        severity: 'warning',
        summary: `${rateLimitsForActor} rate-limit hits from ${ipActor} in ${merged.windowMs / 1000}s`,
        detail: { actor: ipActor, count: rateLimitsForActor },
      });
    }

    const emitted: AnomalyAlert[] = [];
    for (const alert of fired) {
      if (!shouldEmit(alert.fingerprint)) continue;
      emitted.push(alert);
      if (emit) {
        try { emit(alert); } catch (err) { console.error('[anomaly] emit failed:', err); }
      }
    }
    return emitted;
  }

  return {
    ingest,
    snapshot: () => ({ events: events.length, dedupe: dedupe.size }),
  };
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV4_ANYWHERE_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// IPv6: two alternations — compressed (contains `::`) or full (8 groups).
// The compressed alt greedy-matches `(hex:){2+}(:hex*){1+}`; the full alt
// matches `(hex:){3,7}hex`. Deliberately anchored via surrounding regex —
// no `\b` because `:` breaks word boundaries around `::`.
const IPV6_ANYWHERE_RE = /(?:[0-9a-fA-F]{1,4}:){2,}(?::[0-9a-fA-F]{0,4})+|(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}/g;
const LONG_OPAQUE_ID_RE = /[a-zA-Z0-9_-]{9,}/g;
const IP_SENTINEL = '[IP_REDACTED]';
// Substituted for `[IP_REDACTED]` during the opaque-ID pass so the
// sentinel's internal characters aren't themselves truncated.
const SENTINEL_PLACEHOLDER = '\u0000IPR\u0000';

/** Replace IPv4 with a constant sentinel + truncate apiKeyId to a
 *  non-reversible prefix. Constitution 1.4 applies to all Sentry events
 *  regardless of runtime. Same scrubber runs on `tags.fingerprint` so
 *  the indexed label does not leak raw identifiers. */
function scrubValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (IPV4_RE.test(value)) return '[IP_REDACTED]';
  if (key === 'apiKeyId') return `key:${value.slice(0, 4)}…`;
  return value;
}

function scrubAlertDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) out[k] = scrubValue(k, v);
  return out;
}

/** Redact free-form strings (summary, message) before shipping to Sentry.
 *  Summaries are built with template literals that can embed raw IPs or
 *  apiKeyIds (e.g. "5 auth failures from 10.0.0.5 in 60s"); CLAUDE.md §1.4
 *  applies to Sentry `message` the same as `extra`. Walks the whole string
 *  rather than anchoring like `scrubValue`. IP sentinel is swapped for a
 *  placeholder during the opaque-id pass so the opaque-id regex does not
 *  eat the sentinel's own internal characters. */
export function scrubFreeText(text: string): string {
  const withIpsRedacted = text
    .replace(IPV4_ANYWHERE_RE, IP_SENTINEL)
    .replace(IPV6_ANYWHERE_RE, IP_SENTINEL);
  return withIpsRedacted
    .split(IP_SENTINEL).join(SENTINEL_PLACEHOLDER)
    .replace(LONG_OPAQUE_ID_RE, (m) => `${m.slice(0, 4)}…`)
    .split(SENTINEL_PLACEHOLDER).join(IP_SENTINEL);
}

/** Redact a fingerprint that embeds a raw IP or apiKeyId. Fingerprints
 *  look like `signal:actor:bucket`; if the actor segment is an IP we
 *  replace it, if it looks like a long opaque id we truncate it. */
function scrubFingerprint(fp: string): string {
  const parts = fp.split(':');
  if (parts.length < 2) return fp;
  for (let i = 1; i < parts.length - 1; i++) {
    if (IPV4_RE.test(parts[i])) parts[i] = '[IP_REDACTED]';
    else if (parts[i].length > 8 && /^[a-zA-Z0-9_-]+$/.test(parts[i])) {
      parts[i] = `${parts[i].slice(0, 4)}…`;
    }
  }
  return parts.join(':');
}

/** Minimal Sentry envelope POST — the edge worker does not ship
 *  `@sentry/node` (worker-incompatible). Call via `ctx.waitUntil` so a
 *  slow Sentry response never blocks the MCP response. */
export async function sendToSentry(dsn: string, alert: AnomalyAlert): Promise<void> {
  const match = dsn.match(SENTRY_DSN_RE);
  if (!match) throw new Error('invalid Sentry DSN');
  const [, key, host, projectId] = match;

  const payload = {
    message: scrubFreeText(alert.summary),
    level: alert.severity,
    logger: 'mcp-anomaly',
    tags: { signal: alert.signal, fingerprint: scrubFingerprint(alert.fingerprint) },
    extra: scrubAlertDetail(alert.detail),
  };

  await fetch(`https://${host}/api/${projectId}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_key=${key}, sentry_version=7`,
    },
    body: JSON.stringify(payload),
  });
}
