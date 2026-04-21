/**
 * MCP anomaly detection — MCP-SEC-09 / SCRUM-987.
 *
 * Rolling-window heuristics over recent MCP tool invocations. Every
 * tool call from `withTelemetry` passes an `AnomalyEvent` through
 * `ingest()`; when any heuristic fires we emit a Sentry event (+
 * optional PagerDuty webhook) so exploitation attempts surface in
 * minutes instead of post-mortem.
 *
 * Heuristics currently wired:
 *   1. **rapid_tool_cycling** — same API key hits > N distinct tools in
 *      a short window (cred-stuffer fingerprinting behaviour).
 *   2. **auth_failure_burst** — > N auth failures from the same IP/key
 *      within a window (credential brute force).
 *   3. **cross_tenant_access** — API key issues requests referencing
 *      public IDs from > N distinct orgs (potential enumeration).
 *   4. **oversized_args** — a single tool invocation exceeds the byte
 *      budget for that tool (possible prompt-injection payload).
 *   5. **rate_limit_storm** — same key gets throttled > N times in a
 *      window (tells us a bad actor is ignoring 429s).
 *
 * Dedupe: a signal fingerprint (`${signal}:${key}:${minuteBucket}`) is
 * tracked for five minutes so a single burst doesn't trigger a page
 * storm in Sentry.
 *
 * Pure TypeScript — no Workers runtime APIs. Clock + Sentry emitter are
 * injected so tests are fully hermetic.
 */

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
  /** `success` | `tool_error` | `rate_limited` | `auth_failed`. */
  outcome: 'success' | 'tool_error' | 'rate_limited' | 'auth_failed';
  /** Size of the JSON-encoded tool arguments, in bytes. */
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
  /** Window length in ms for rolling heuristics. Default: 60s. */
  windowMs?: number;
  /** Dedupe period in ms — same fingerprint won't re-alert within this. */
  dedupeMs?: number;
  /** Rapid-cycle: distinct tools by one key in `windowMs` before we fire. */
  rapidToolCycleThreshold?: number;
  /** Auth-failure-burst threshold per key/IP in `windowMs`. */
  authFailureThreshold?: number;
  /** Cross-tenant: distinct org IDs per key before we fire. */
  crossTenantThreshold?: number;
  /** Bytes above which a single invocation is considered oversized. */
  oversizedArgsThreshold?: number;
  /** Rate-limited hits per key before we fire. */
  rateLimitStormThreshold?: number;
  /** Emitter is injected so tests can capture alerts. */
  emit?: (alert: AnomalyAlert) => void;
  /** Clock — defaults to `Date.now`. */
  now?: () => number;
}

interface StoredEvent extends AnomalyEvent {}

/** Default thresholds — tuned for conservative alerting. */
const DEFAULTS: Required<Omit<AnomalyDetectorConfig, 'emit' | 'now'>> = {
  windowMs: 60_000,
  dedupeMs: 5 * 60_000,
  rapidToolCycleThreshold: 6,
  authFailureThreshold: 5,
  crossTenantThreshold: 3,
  oversizedArgsThreshold: 16 * 1024,
  rateLimitStormThreshold: 20,
};

/**
 * Create a detector. The returned object is the public surface used by
 * `withTelemetry` in mcp-server.ts.
 */
export function createAnomalyDetector(config: AnomalyDetectorConfig = {}): {
  ingest: (event: AnomalyEvent) => AnomalyAlert[];
  /** For tests + diagnostics. */
  snapshot: () => { events: number; dedupe: number };
} {
  const merged = { ...DEFAULTS, ...config };
  const now = config.now ?? (() => Date.now());
  const emit = config.emit;

  const events: StoredEvent[] = [];
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

  function build(
    signal: AnomalySignal,
    keyPart: string,
    severity: AnomalyAlert['severity'],
    summary: string,
    detail: Record<string, unknown>,
  ): AnomalyAlert {
    const bucket = Math.floor(now() / merged.windowMs);
    return {
      signal,
      fingerprint: `${signal}:${keyPart}:${bucket}`,
      severity,
      summary,
      detail,
    };
  }

  function checkRapidCycling(ev: AnomalyEvent): AnomalyAlert | null {
    if (!ev.apiKeyId) return null;
    const windowStart = now() - merged.windowMs;
    const tools = new Set<string>();
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      if (e.apiKeyId === ev.apiKeyId) tools.add(e.toolName);
    }
    if (tools.size < merged.rapidToolCycleThreshold) return null;
    return build('rapid_tool_cycling', ev.apiKeyId, 'warning',
      `API key cycled across ${tools.size} tools in ${merged.windowMs / 1000}s`,
      { apiKeyId: ev.apiKeyId, tools: [...tools] });
  }

  function checkAuthFailureBurst(ev: AnomalyEvent): AnomalyAlert | null {
    if (ev.outcome !== 'auth_failed') return null;
    const actor = ev.apiKeyId ?? ev.clientIp;
    if (!actor) return null;
    const windowStart = now() - merged.windowMs;
    let count = 0;
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      if (e.outcome !== 'auth_failed') continue;
      if ((e.apiKeyId ?? e.clientIp) === actor) count++;
    }
    if (count < merged.authFailureThreshold) return null;
    return build('auth_failure_burst', actor, 'error',
      `${count} auth failures from ${actor} in ${merged.windowMs / 1000}s`,
      { actor, count });
  }

  function checkCrossTenant(ev: AnomalyEvent): AnomalyAlert | null {
    if (!ev.apiKeyId || !ev.orgId) return null;
    const windowStart = now() - merged.windowMs;
    const orgs = new Set<string>();
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      if (e.apiKeyId === ev.apiKeyId && e.orgId) orgs.add(e.orgId);
    }
    if (orgs.size < merged.crossTenantThreshold) return null;
    return build('cross_tenant_access', ev.apiKeyId, 'critical',
      `API key referenced ${orgs.size} distinct orgs in ${merged.windowMs / 1000}s`,
      { apiKeyId: ev.apiKeyId, orgs: [...orgs] });
  }

  function checkOversizedArgs(ev: AnomalyEvent): AnomalyAlert | null {
    if (ev.argsBytes <= merged.oversizedArgsThreshold) return null;
    const actor = ev.apiKeyId ?? ev.clientIp ?? 'unknown';
    return build('oversized_args', `${actor}:${ev.toolName}`, 'warning',
      `Tool ${ev.toolName} received ${ev.argsBytes}-byte payload`,
      { tool: ev.toolName, bytes: ev.argsBytes, actor });
  }

  function checkRateLimitStorm(ev: AnomalyEvent): AnomalyAlert | null {
    if (ev.outcome !== 'rate_limited') return null;
    const actor = ev.apiKeyId ?? ev.clientIp;
    if (!actor) return null;
    const windowStart = now() - merged.windowMs;
    let count = 0;
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      if (e.outcome === 'rate_limited' && (e.apiKeyId ?? e.clientIp) === actor) count++;
    }
    if (count < merged.rateLimitStormThreshold) return null;
    return build('rate_limit_storm', actor, 'warning',
      `${count} rate-limit hits from ${actor} in ${merged.windowMs / 1000}s`,
      { actor, count });
  }

  function ingest(event: AnomalyEvent): AnomalyAlert[] {
    events.push(event);
    trimWindow();

    const fired: AnomalyAlert[] = [];
    const candidates = [
      checkRapidCycling(event),
      checkAuthFailureBurst(event),
      checkCrossTenant(event),
      checkOversizedArgs(event),
      checkRateLimitStorm(event),
    ];
    for (const alert of candidates) {
      if (!alert) continue;
      if (!shouldEmit(alert.fingerprint)) continue;
      fired.push(alert);
      if (emit) {
        try { emit(alert); } catch (err) { console.error('[anomaly] emit failed:', err); }
      }
    }
    return fired;
  }

  return {
    ingest,
    snapshot: () => ({ events: events.length, dedupe: dedupe.size }),
  };
}

/**
 * Minimal Sentry "capture" wire — the edge worker can post to Sentry's
 * envelope endpoint directly without the full SDK. Use fire-and-forget
 * via `ctx.waitUntil` so a slow Sentry response never blocks the MCP
 * response.
 */
export async function sendToSentry(
  dsn: string,
  alert: AnomalyAlert,
): Promise<void> {
  // DSN parsing: https://<key>@<host>/<project>
  const match = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!match) throw new Error('invalid Sentry DSN');
  const [, key, host, projectId] = match;

  const payload = {
    message: alert.summary,
    level: alert.severity,
    logger: 'mcp-anomaly',
    tags: { signal: alert.signal, fingerprint: alert.fingerprint },
    extra: alert.detail,
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
