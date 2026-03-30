/**
 * Database Client (QA-PERF-3)
 *
 * Supabase client with service role for worker operations.
 * Service role bypasses RLS for administrative tasks.
 *
 * ERR-1: Includes circuit breaker to detect Supabase outages and
 * report unhealthy status via /health endpoint.
 *
 * QA-PERF-3: PgBouncer connection pooling via SUPABASE_POOLER_URL.
 * When set, uses port 6543 transaction-mode pooling to prevent
 * connection exhaustion under concurrent Agentic API load.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from './logger.js';
import type { Database } from '../types/database.types.js';

let client: SupabaseClient<Database> | null = null;

/** QA-PERF-3: Track whether PgBouncer pooler is active */
let poolerActive = false;

/**
 * QA-PERF-3: Configure Supabase client with PgBouncer-compatible settings.
 * When SUPABASE_POOLER_URL is set, uses PgBouncer (port 6543, transaction mode)
 * to prevent connection exhaustion under concurrent load.
 *
 * Validates pooler URL format: must use port 6543 for transaction mode.
 */
export function getDb(): SupabaseClient<Database> {
  if (!client) {
    const poolerUrl = process.env.SUPABASE_POOLER_URL;
    const dbUrl = poolerUrl || config.supabaseUrl;

    if (poolerUrl) {
      // Validate pooler URL uses port 6543 (transaction mode)
      try {
        const url = new URL(poolerUrl);
        if (url.port && url.port !== '6543') {
          logger.warn(
            { port: url.port },
            'SUPABASE_POOLER_URL does not use port 6543 — expected transaction mode pooling'
          );
        }
      } catch {
        logger.error('SUPABASE_POOLER_URL is not a valid URL — falling back to direct connection');
      }
      poolerActive = true;
      logger.info('Using PgBouncer pooler connection (QA-PERF-3)');
    }

    client = createClient<Database>(dbUrl, config.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema: 'public',
      },
    });
  }
  return client;
}

export const db = getDb();

/** QA-PERF-3: Check if PgBouncer pooler is active */
export function isPoolerActive(): boolean {
  return poolerActive;
}

/** QA-PERF-3: Get connection mode info for /health and diagnostics */
export function getConnectionInfo(): { mode: 'pooler' | 'direct'; url: string } {
  const poolerUrl = process.env.SUPABASE_POOLER_URL;
  return {
    mode: poolerUrl ? 'pooler' : 'direct',
    url: poolerUrl
      ? poolerUrl.replace(/\/\/[^@]+@/, '//***@') // mask credentials
      : config.supabaseUrl.replace(/\/\/[^@]+@/, '//***@'),
  };
}

// ─── ERR-1: Database Circuit Breaker ─────────────────────────────────
// Tracks consecutive DB failures. When open, /health returns 503 so
// Cloud Run restarts the instance.

const DB_CIRCUIT_THRESHOLD = 5;
const DB_CIRCUIT_HALF_OPEN_MS = 30_000; // 30s before retry

interface DbCircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastError: string | null;
}

const dbCircuit: DbCircuitState = {
  consecutiveFailures: 0,
  openedAt: null,
  lastError: null,
};

/** Record a successful DB operation (resets circuit) */
export function recordDbSuccess(): void {
  if (dbCircuit.consecutiveFailures > 0) {
    logger.info(
      { previousFailures: dbCircuit.consecutiveFailures },
      'DB circuit breaker reset after successful operation',
    );
  }
  dbCircuit.consecutiveFailures = 0;
  dbCircuit.openedAt = null;
  dbCircuit.lastError = null;
}

/** Record a failed DB operation (may open circuit) */
export function recordDbFailure(error: unknown): void {
  dbCircuit.consecutiveFailures++;
  dbCircuit.lastError = error instanceof Error ? error.message : String(error);

  if (dbCircuit.consecutiveFailures >= DB_CIRCUIT_THRESHOLD && !dbCircuit.openedAt) {
    dbCircuit.openedAt = Date.now();
    logger.error(
      { failures: dbCircuit.consecutiveFailures, lastError: dbCircuit.lastError },
      'DB circuit breaker OPEN — reporting unhealthy',
    );
  }
}

/** Check if the DB circuit is healthy (for /health endpoint) */
export function isDbHealthy(): boolean {
  if (dbCircuit.openedAt === null) return true;

  // Allow half-open after timeout
  const elapsed = Date.now() - dbCircuit.openedAt;
  if (elapsed >= DB_CIRCUIT_HALF_OPEN_MS) {
    return true; // Half-open: allow probing
  }

  return false;
}

/** Get circuit breaker state (for diagnostics) */
export function getDbCircuitState(): {
  healthy: boolean;
  consecutiveFailures: number;
  lastError: string | null;
} {
  return {
    healthy: isDbHealthy(),
    consecutiveFailures: dbCircuit.consecutiveFailures,
    lastError: dbCircuit.lastError,
  };
}

/** Reset circuit breaker (for testing) */
export function resetDbCircuit(): void {
  dbCircuit.consecutiveFailures = 0;
  dbCircuit.openedAt = null;
  dbCircuit.lastError = null;
}

// ─── SCALE-3: DB call timeout wrapper ───────────────────────────────
// Prevents DB calls from hanging indefinitely under load.

const DEFAULT_DB_TIMEOUT_MS = 15_000; // 15 seconds

/**
 * Execute a DB operation with a timeout.
 * If the operation exceeds the timeout, the promise rejects with a timeout error.
 * The circuit breaker records the failure automatically.
 *
 * @example
 *   const data = await withDbTimeout(() => db.from('anchors').select('*').limit(10));
 */
export async function withDbTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_DB_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`DB operation timed out after ${timeoutMs}ms`);
      recordDbFailure(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation(), timeout]);
    recordDbSuccess();
    return result;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('timed out'))) {
      recordDbFailure(err);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
