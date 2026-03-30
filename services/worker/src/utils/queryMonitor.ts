/**
 * Database Query Performance Monitor (QA-PERF-6)
 *
 * Lightweight query timing and slow-query detection for critical paths:
 * - Nessie RAG retrieval
 * - EDGAR fetcher
 * - Semantic search (pgvector cosine similarity)
 * - Entity verification
 *
 * Logs slow queries (>1s warning, >5s error) with timing breakdown.
 * Optional EXPLAIN ANALYZE output when LOG_LEVEL=debug.
 */

import { logger } from './logger.js';

const SLOW_QUERY_WARN_MS = 1000;
const SLOW_QUERY_ERROR_MS = 5000;

interface QueryMetric {
  endpoint: string;
  durationMs: number;
  rowCount: number;
  timestamp: number;
}

// Rolling window of recent query metrics (capped at 1000)
const recentMetrics: QueryMetric[] = [];
const MAX_METRICS = 1000;

/**
 * Record a query metric and log if slow.
 */
export function recordQueryMetric(
  endpoint: string,
  durationMs: number,
  rowCount: number
): void {
  const metric: QueryMetric = {
    endpoint,
    durationMs,
    rowCount,
    timestamp: Date.now(),
  };

  // Cap rolling window
  if (recentMetrics.length >= MAX_METRICS) {
    recentMetrics.shift();
  }
  recentMetrics.push(metric);

  if (durationMs >= SLOW_QUERY_ERROR_MS) {
    logger.error(
      { endpoint, durationMs, rowCount },
      `SLOW QUERY (>${SLOW_QUERY_ERROR_MS}ms): ${endpoint}`
    );
  } else if (durationMs >= SLOW_QUERY_WARN_MS) {
    logger.warn(
      { endpoint, durationMs, rowCount },
      `Slow query (>${SLOW_QUERY_WARN_MS}ms): ${endpoint}`
    );
  } else {
    logger.debug(
      { endpoint, durationMs, rowCount },
      `Query completed: ${endpoint}`
    );
  }
}

/**
 * Wrap a Supabase query with timing and monitoring.
 *
 * @example
 *   const { data, error } = await monitorQuery('nessie-rag', () =>
 *     db.rpc('match_embeddings', { query_embedding, match_threshold: 0.7, match_count: 10 })
 *   );
 */
export async function monitorQuery<T extends { data: unknown; error: unknown }>(
  endpoint: string,
  queryFn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  const result = await queryFn();
  const durationMs = Math.round(performance.now() - start);

  const data = result.data;
  const rowCount = Array.isArray(data) ? data.length : data ? 1 : 0;

  recordQueryMetric(endpoint, durationMs, rowCount);

  return result;
}

/**
 * Get aggregated query stats for diagnostics endpoint.
 * Returns stats per endpoint over the rolling window.
 */
export function getQueryStats(): Record<
  string,
  {
    count: number;
    avgMs: number;
    maxMs: number;
    p95Ms: number;
    slowCount: number;
    totalRows: number;
  }
> {
  const stats: Record<string, QueryMetric[]> = {};

  for (const m of recentMetrics) {
    if (!stats[m.endpoint]) {
      stats[m.endpoint] = [];
    }
    stats[m.endpoint].push(m);
  }

  const result: Record<string, {
    count: number;
    avgMs: number;
    maxMs: number;
    p95Ms: number;
    slowCount: number;
    totalRows: number;
  }> = {};

  for (const [endpoint, metrics] of Object.entries(stats)) {
    const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    const p95Index = Math.min(Math.ceil(durations.length * 0.95) - 1, durations.length - 1);

    result[endpoint] = {
      count: metrics.length,
      avgMs: Math.round(sum / metrics.length),
      maxMs: durations[durations.length - 1],
      p95Ms: durations[p95Index],
      slowCount: metrics.filter((m) => m.durationMs >= SLOW_QUERY_WARN_MS).length,
      totalRows: metrics.reduce((a, m) => a + m.rowCount, 0),
    };
  }

  return result;
}

/**
 * Clear metrics (for testing).
 */
export function clearQueryMetrics(): void {
  recentMetrics.length = 0;
}
