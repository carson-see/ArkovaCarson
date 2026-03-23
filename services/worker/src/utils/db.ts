/**
 * Database Client
 *
 * Supabase client with service role for worker operations.
 * Service role bypasses RLS for administrative tasks.
 *
 * ERR-1: Includes circuit breaker to detect Supabase outages and
 * report unhealthy status via /health endpoint.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from './logger.js';
import type { Database } from '../types/database.types.js';

let client: SupabaseClient<Database> | null = null;

export function getDb(): SupabaseClient<Database> {
  if (!client) {
    client = createClient<Database>(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return client;
}

export const db = getDb();

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
