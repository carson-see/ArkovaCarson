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
import { Agent, fetch as undiciFetch } from 'undici';
import ws from 'ws';
import { config } from '../config.js';
import { logger } from './logger.js';
import type { TypeSafeDatabase } from '../types/database-overrides.js';

let client: SupabaseClient<TypeSafeDatabase> | null = null;

/** QA-PERF-3: Track whether PgBouncer pooler is active */
let poolerActive = false;

// ─── WH-1 (ARKOVA-WORKER-C): resilient outbound transport ─────────────────
// Root cause of the "TypeError: fetch failed" webhook drops: supabase-js was
// created with NO custom fetch/dispatcher, so every PostgREST + RPC call used
// Node's global undici agent. On CPU-throttled Cloud Run, idle keep-alive
// sockets to `*.supabase.co` are closed by the far side between request bursts;
// the next call reuses the dead socket and undici throws `TypeError: fetch
// failed` (cause ECONNRESET / UND_ERR_SOCKET / "other side closed"). supabase-js
// surfaces that as a hard error with no retry, so the webhook idempotency lookup
// + delivery-log write (and every other worker DB call) fail. We install a
// dedicated dispatcher with a short keep-alive TTL so sockets are recycled well
// before they rot, and wrap fetch so a *connection-level* failure on an
// IDEMPOTENT (read) request retries ONCE on a fresh socket. Response-level HTTP
// errors are NOT retried — that is the caller's concern; and non-idempotent
// writes (POST/PATCH/DELETE) are NEVER auto-retried, because a transport error
// can also fire AFTER the server committed (independent chain/treasury + DBA
// review, SCRUM-2899 — a retried write could double-apply a credit deduction or
// billing row). See RETRYABLE_METHODS. Writes are protected by the short
// keep-alive recycling plus their own call-site idempotency guards.

/** Dedicated dispatcher for the Supabase REST/RPC client. Bounded pool + short
 * keep-alive so a throttled instance recycles idle sockets before they rot. */
const SUPABASE_FETCH_AGENT = new Agent({
  connections: 64,
  keepAliveTimeout: 4_000, // recycle idle sockets after 4s (well under far-side close)
  keepAliveMaxTimeout: 10_000,
});

/** Connection-level (transport) failure signatures — no HTTP response arrived.
 * `UND_ERR_SOCKET` (undici "other side closed") is included; bare `UND_ERR` is
 * NOT, so an intentional caller abort (`UND_ERR_ABORTED`) is never treated as
 * transient (independent DBA review, SCRUM-2899). */
const CONNECTION_ERROR_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|UND_ERR_SOCKET|other side closed|terminated/i;

/**
 * Only idempotent HTTP methods may be auto-retried. A retried POST/PATCH/DELETE
 * (RPC, INSERT, UPDATE) could DOUBLE-APPLY if the socket died AFTER PostgREST
 * committed but before the response was read — undici cannot distinguish that
 * from a never-sent request. Independent chain/treasury review (SCRUM-2899)
 * found this would turn a latent double-credit-deduction + duplicate-billing
 * hazard live. Reads (GET/HEAD) are idempotent, so the rotten-socket auto-heal —
 * the actual "TypeError: fetch failed" fix, which hits the webhook idempotency
 * SELECT — applies to them safely. Writes instead rely on the short keep-alive
 * recycling to avoid rot, and on their own idempotency guards (unique keys /
 * reference_ids / compare-and-swap) at the call site.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when `err` (or any nested `cause`) looks like a transport-level failure
 * where no HTTP response was received — safe to retry on a fresh socket.
 * Exported for unit testing (db.test.ts).
 */
export function isTransientConnectionError(err: unknown): boolean {
  const parts: string[] = [];
  const collect = (e: unknown, depth: number): void => {
    if (e == null || depth > 4) return;
    if (typeof e === 'string') {
      parts.push(e);
      return;
    }
    if (e instanceof Error) {
      parts.push(e.message);
      const code = (e as { code?: string }).code;
      if (typeof code === 'string') parts.push(code);
      collect((e as { cause?: unknown }).cause, depth + 1);
    }
  };
  collect(err, 0);
  return parts.length > 0 && CONNECTION_ERROR_RE.test(parts.join(' '));
}

/**
 * Wrap a base fetch so a connection-level failure is retried ONCE on a fresh
 * socket (via the bounded dispatcher). Exported so db.test.ts can drive the
 * retry semantics without opening a real socket.
 */
export function createResilientFetch(
  baseFetch: typeof undiciFetch,
  dispatcher: Agent,
): typeof undiciFetch {
  const resilient: typeof undiciFetch = async (input, init) => {
    const opts = { ...(init ?? {}), dispatcher };
    // Default to GET (supabase-js omits `method` for SELECTs); only idempotent
    // methods are eligible for the auto-retry (see RETRYABLE_METHODS).
    const method = String((opts as { method?: unknown }).method ?? 'GET').toUpperCase();
    try {
      return await baseFetch(input, opts);
    } catch (err) {
      if (RETRYABLE_METHODS.has(method) && isTransientConnectionError(err)) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), method },
          'Supabase read transport failure — retrying once on a fresh socket (WH-1 / ARKOVA-WORKER-C)',
        );
        return await baseFetch(input, opts);
      }
      throw err;
    }
  };
  return resilient;
}

/**
 * QA-PERF-3: Configure Supabase client with PgBouncer-compatible settings.
 * When SUPABASE_POOLER_URL is set, uses PgBouncer (port 6543, transaction mode)
 * to prevent connection exhaustion under concurrent load.
 *
 * Validates pooler URL format: must use port 6543 for transaction mode.
 */
export function getDb(): SupabaseClient<TypeSafeDatabase> {
  if (!client) {
    const poolerUrl = process.env.SUPABASE_POOLER_URL;

    // WH-2: SUPABASE_POOLER_URL becomes the PostgREST REST base URL (first arg to
    // createClient). It is ONLY valid as a REST base when it is an http(s) origin.
    // A Postgres connection string (`postgres://…:6543` / `postgresql://…`) passes
    // the old port-6543 check and silently becomes the REST base — every PostgREST
    // call then POSTs to a `postgres://` URL and throws `fetch failed`. Guard the
    // scheme: only http(s) pooler URLs are accepted as the REST base; anything
    // else is logged and ignored, falling back to the canonical config.supabaseUrl.
    // (Not set on prod today — this is a preventive footgun guard.)
    let dbUrl = config.supabaseUrl;
    if (poolerUrl) {
      try {
        const url = new URL(poolerUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          logger.error(
            { scheme: url.protocol },
            'SUPABASE_POOLER_URL is not an http(s) URL (looks like a Postgres connection string) — ' +
              'it cannot be a PostgREST REST base; ignoring it and using the direct REST URL',
          );
        } else {
          dbUrl = poolerUrl;
          poolerActive = true;
          // Validate pooler URL uses port 6543 (transaction mode)
          if (url.port && url.port !== '6543') {
            logger.warn(
              { port: url.port },
              'SUPABASE_POOLER_URL does not use port 6543 — expected transaction mode pooling',
            );
          }
          logger.info('Using PgBouncer pooler connection (QA-PERF-3)');
        }
      } catch {
        logger.error('SUPABASE_POOLER_URL is not a valid URL — falling back to direct connection');
      }
    }

    client = createClient<TypeSafeDatabase>(dbUrl, config.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema: 'public',
      },
      global: {
        // WH-1 (ARKOVA-WORKER-C): resilient transport for every PostgREST + RPC
        // call — retries once on a rotten keep-alive socket. This is the fix that
        // ends the "TypeError: fetch failed" webhook idempotency-lookup +
        // delivery-log write failures; the existing delivery.ts retries inherit
        // fresh-socket semantics for free.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: createResilientFetch(undiciFetch, SUPABASE_FETCH_AGENT) as any,
      },
      // Node 20 lacks native WebSocket; supabase-js 2.105.4+ requires
      // an explicit ws transport on Node < 22 for @supabase/realtime-js.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realtime: { transport: ws as any },
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
  // WH-2: report the ACTUAL applied state (poolerActive), not mere env presence.
  // A rejected postgres:// pooler URL falls back to the direct REST base, so
  // reporting 'pooler' off env alone would contradict isPoolerActive().
  const poolerUrl = process.env.SUPABASE_POOLER_URL;
  return poolerActive && poolerUrl
    ? { mode: 'pooler', url: poolerUrl.replace(/\/\/[^@]+@/, '//***@') } // mask credentials
    : { mode: 'direct', url: config.supabaseUrl.replace(/\/\/[^@]+@/, '//***@') };
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
