/**
 * scripts/staging/ai-eval/reliability.ts — first-class Gemini reliability
 * characterization for the AI soak.
 *
 * The founders report continual "too many requests" (429), timeouts, and FALSE
 * READINGS every time they use Gemini in prod. This module classifies every AI
 * call into a reliability bucket and reports the 429 / timeout / false-reading
 * rates as first-class results — the soak's headline reliability evidence.
 *
 * What each bucket means against the real worker code:
 *   ok                clean 2xx from a real provider (gemini/nessie/…)
 *   false_reading     2xx but `degraded:true` or `provider:'fast-fallback'` —
 *                     the extract endpoint's 4.5s latency budget
 *                     (AI_EXTRACTION_LATENCY_BUDGET_MS) expired and it returned a
 *                     low-confidence regex guess that LOOKS like an answer but
 *                     is not real inference. THIS is the "false reading".
 *   rate_limited      HTTP 429 (aiRateLimiter or upstream Gemini quota surfacing)
 *   server_unavailable HTTP 503 — Gemini circuit breaker open (5 consecutive
 *                     failures → 60s cooldown) or the AI gate closed
 *   server_error      other 5xx (extraction_failed etc.)
 *   client_timeout    the harness's own request deadline elapsed (Gemini hung
 *                     past our client timeout — a stricter timeout signal than
 *                     the server's 4.5s budget)
 *   transport_error   status 0, non-timeout (connection reset/refused)
 *   client_error      4xx other than 429 (e.g. 400 on the oversized variant)
 */

import type { AiCallResult } from './ai-client.js';

export type ReliabilityClass =
  | 'ok'
  | 'false_reading'
  | 'rate_limited'
  | 'server_unavailable'
  | 'server_error'
  | 'client_timeout'
  | 'transport_error'
  | 'client_error';

const NON_LIVE_PROVIDERS = new Set(['mock', 'fast-fallback', 'cache']);

function isDegraded(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as { degraded?: unknown; provider?: unknown };
  if (b.degraded === true) return true;
  if (typeof b.provider === 'string' && NON_LIVE_PROVIDERS.has(b.provider)) return true;
  return false;
}

export function classifyReliability(outcome: AiCallResult): ReliabilityClass {
  if (outcome.status === 0) {
    return outcome.clientTimedOut ? 'client_timeout' : 'transport_error';
  }
  if (outcome.status === 429) return 'rate_limited';
  if (outcome.status === 503) return 'server_unavailable';
  if (outcome.status >= 500) return 'server_error';
  if (outcome.status >= 400) return 'client_error';
  // 2xx — but a degraded/fast-fallback body is a false reading, not a real ok.
  if (isDegraded(outcome.body)) return 'false_reading';
  return 'ok';
}

const ALL_CLASSES: ReliabilityClass[] = [
  'ok',
  'false_reading',
  'rate_limited',
  'server_unavailable',
  'server_error',
  'client_timeout',
  'transport_error',
  'client_error',
];

export interface ReliabilityStats {
  total: number;
  counts: Record<ReliabilityClass, number>;
}

export function newReliabilityStats(): ReliabilityStats {
  const counts = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<ReliabilityClass, number>;
  return { total: 0, counts };
}

export function recordReliability(stats: ReliabilityStats, outcome: AiCallResult): ReliabilityClass {
  const klass = classifyReliability(outcome);
  stats.total++;
  stats.counts[klass]++;
  return klass;
}

export interface ReliabilityReport {
  total: number;
  counts: Record<ReliabilityClass, number>;
  /** 429 rate — the "too many requests" headline. */
  rate429: number;
  /** timeout-family rate: client_timeout + server_unavailable (circuit/timeout). */
  timeoutRate: number;
  /** false-reading rate: degraded/fast-fallback 2xx that look like real answers. */
  falseReadingRate: number;
  /** 5xx (excluding 503) rate. */
  serverErrorRate: number;
  /** everything that is not a clean ok. */
  unreliableRate: number;
}

export function reliabilityReport(stats: ReliabilityStats): ReliabilityReport {
  const t = Math.max(stats.total, 1);
  const c = stats.counts;
  return {
    total: stats.total,
    counts: c,
    rate429: c.rate_limited / t,
    timeoutRate: (c.client_timeout + c.server_unavailable) / t,
    falseReadingRate: c.false_reading / t,
    serverErrorRate: c.server_error / t,
    unreliableRate: (stats.total - c.ok) / t,
  };
}
