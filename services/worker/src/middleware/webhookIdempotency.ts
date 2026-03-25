/**
 * Webhook Idempotency Helper (INFRA-002)
 *
 * Prevents duplicate webhook processing by checking an idempotency key
 * before processing. If the key exists, returns the cached response.
 *
 * Usage:
 *   const result = await checkIdempotency(store, key, 'stripe');
 *   if (result.duplicate) return cachedResponse(result);
 *   // ... process webhook ...
 *   await markProcessed(store, key, 'stripe', 200, responseBody);
 */

/** Result of an idempotency check */
export interface IdempotencyCheckResult {
  duplicate: boolean;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
}

/** Injectable store for testing */
export interface IdempotencyStore {
  tryInsert(key: string, source: string): Promise<boolean>;
  getExisting(key: string): Promise<{ response_status: number | null; response_body: Record<string, unknown> | null } | null>;
  markProcessed(key: string, responseStatus: number, responseBody?: Record<string, unknown>): Promise<void>;
  cleanup(olderThanDays: number): Promise<number>;
}

/**
 * Check if a webhook with this idempotency key has already been processed.
 *
 * @param store - Injectable persistence layer
 * @param key - Idempotency key (e.g., Stripe event ID, x402 tx hash)
 * @param source - Source identifier ('stripe', 'x402', etc.)
 * @returns Whether this is a duplicate and cached response if available
 */
export async function checkIdempotency(
  store: IdempotencyStore,
  key: string,
  source: string,
): Promise<IdempotencyCheckResult> {
  // Try to insert — if it succeeds, this is a new webhook
  const inserted = await store.tryInsert(key, source);

  if (inserted) {
    return { duplicate: false };
  }

  // Key already exists — check for cached response
  const existing = await store.getExisting(key);

  return {
    duplicate: true,
    responseStatus: existing?.response_status ?? undefined,
    responseBody: existing?.response_body ?? undefined,
  };
}

/**
 * Mark a webhook as processed with its response.
 *
 * @param store - Injectable persistence layer
 * @param key - Idempotency key
 * @param responseStatus - HTTP status code of the response
 * @param responseBody - Optional response body to cache
 */
export async function markProcessed(
  store: IdempotencyStore,
  key: string,
  responseStatus: number,
  responseBody?: Record<string, unknown>,
): Promise<void> {
  await store.markProcessed(key, responseStatus, responseBody);
}

/**
 * Clean up old idempotency records.
 *
 * @param store - Injectable persistence layer
 * @param olderThanDays - Remove records older than this many days (default: 7)
 * @returns Number of records removed
 */
export async function cleanupIdempotencyRecords(
  store: IdempotencyStore,
  olderThanDays: number = 7,
): Promise<number> {
  return store.cleanup(olderThanDays);
}
