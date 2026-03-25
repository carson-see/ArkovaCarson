/**
 * INFRA-002: Webhook Idempotency Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkIdempotency,
  markProcessed,
  cleanupIdempotencyRecords,
} from '../webhookIdempotency.js';
import type { IdempotencyStore } from '../webhookIdempotency.js';

/** In-memory mock store */
function createMockStore(): IdempotencyStore & { entries: Map<string, { source: string; response_status: number | null; response_body: Record<string, unknown> | null; created_at: Date }> } {
  const entries = new Map<string, { source: string; response_status: number | null; response_body: Record<string, unknown> | null; created_at: Date }>();

  return {
    entries,
    tryInsert: vi.fn().mockImplementation(async (key: string, source: string) => {
      if (entries.has(key)) return false;
      entries.set(key, { source, response_status: null, response_body: null, created_at: new Date() });
      return true;
    }),
    getExisting: vi.fn().mockImplementation(async (key: string) => {
      return entries.get(key) ?? null;
    }),
    markProcessed: vi.fn().mockImplementation(async (key: string, status: number, body?: Record<string, unknown>) => {
      const entry = entries.get(key);
      if (entry) {
        entry.response_status = status;
        entry.response_body = body ?? null;
      }
    }),
    cleanup: vi.fn().mockImplementation(async (olderThanDays: number) => {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.created_at < cutoff) {
          entries.delete(key);
          removed++;
        }
      }
      return removed;
    }),
  };
}

describe('INFRA-002: checkIdempotency', () => {
  it('returns duplicate=false for new keys', async () => {
    const store = createMockStore();
    const result = await checkIdempotency(store, 'evt_123', 'stripe');

    expect(result.duplicate).toBe(false);
    expect(store.tryInsert).toHaveBeenCalledWith('evt_123', 'stripe');
  });

  it('returns duplicate=true for existing keys', async () => {
    const store = createMockStore();

    // First call — new
    await checkIdempotency(store, 'evt_123', 'stripe');

    // Second call — duplicate
    const result = await checkIdempotency(store, 'evt_123', 'stripe');
    expect(result.duplicate).toBe(true);
  });

  it('returns cached response for processed duplicates', async () => {
    const store = createMockStore();

    await checkIdempotency(store, 'evt_123', 'stripe');
    await markProcessed(store, 'evt_123', 200, { status: 'ok' });

    const result = await checkIdempotency(store, 'evt_123', 'stripe');
    expect(result.duplicate).toBe(true);
    expect(result.responseStatus).toBe(200);
    expect(result.responseBody).toEqual({ status: 'ok' });
  });

  it('handles concurrent duplicate keys correctly', async () => {
    const store = createMockStore();

    // Simulate two concurrent checks
    const [r1, r2] = await Promise.all([
      checkIdempotency(store, 'evt_concurrent', 'x402'),
      checkIdempotency(store, 'evt_concurrent', 'x402'),
    ]);

    // Exactly one should be new, one should be duplicate
    const newCount = [r1, r2].filter((r) => !r.duplicate).length;
    const dupCount = [r1, r2].filter((r) => r.duplicate).length;

    expect(newCount).toBe(1);
    expect(dupCount).toBe(1);
  });
});

describe('INFRA-002: markProcessed', () => {
  it('stores response status and body', async () => {
    const store = createMockStore();

    await checkIdempotency(store, 'evt_123', 'stripe');
    await markProcessed(store, 'evt_123', 200, { processed: true });

    expect(store.markProcessed).toHaveBeenCalledWith('evt_123', 200, { processed: true });
    expect(store.entries.get('evt_123')?.response_status).toBe(200);
  });

  it('works without response body', async () => {
    const store = createMockStore();

    await checkIdempotency(store, 'evt_123', 'stripe');
    await markProcessed(store, 'evt_123', 204);

    expect(store.entries.get('evt_123')?.response_status).toBe(204);
    expect(store.entries.get('evt_123')?.response_body).toBeNull();
  });
});

describe('INFRA-002: cleanupIdempotencyRecords', () => {
  it('removes old entries', async () => {
    const store = createMockStore();

    // Insert an old entry
    store.entries.set('old_evt', {
      source: 'stripe',
      response_status: 200,
      response_body: null,
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
    });

    store.entries.set('new_evt', {
      source: 'stripe',
      response_status: 200,
      response_body: null,
      created_at: new Date(), // now
    });

    const removed = await cleanupIdempotencyRecords(store, 7);

    expect(removed).toBe(1);
    expect(store.entries.has('old_evt')).toBe(false);
    expect(store.entries.has('new_evt')).toBe(true);
  });

  it('defaults to 7 days', async () => {
    const store = createMockStore();
    await cleanupIdempotencyRecords(store);
    expect(store.cleanup).toHaveBeenCalledWith(7);
  });
});
