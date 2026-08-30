/**
 * Circuit breaker regression suite (PR #2269 soak-plan gap, CTO decision 2026-08-18)
 *
 * The gap this file exists to close: `UpstashRateLimitStore.increment()` is on
 * the blocking hot path (`rateLimit()` -> `enforceShared()` awaits it before
 * calling `next()`), and every attempt pays up to `REDIS_TIMEOUT_MS` (2s) via
 * `AbortSignal.timeout` before the internal catch falls back to the local
 * bucket. During a FULL Upstash outage that 2s tax lands on every rate-limited
 * request, indefinitely, because nothing ever stops the store from retrying
 * Redis on every single call.
 *
 * The breaker's only job is to stop wasting that 2s once a run of failures
 * makes the next one overwhelmingly likely. It is a LATENCY SHIELD, not a
 * correctness mechanism: state is per-instance (see the class doc in
 * `upstashRateLimit.ts`), and the shared counter was already fail-open before
 * this change — `fallbackIncrement()` still counts locally, so a broken
 * breaker cannot turn the limiter into "unlimited". These tests only assert
 * WHEN the store attempts Redis, not whether the count itself is right (that
 * invariant is `upstashRateLimit.distributed.test.ts`'s job).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { UpstashRateLimitStore } from './upstashRateLimit.js';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';

/**
 * Toggleable fetch stand-in. `state.up === false` rejects every call
 * (simulating a full Upstash outage); `state.up === true` returns a
 * steady-state pipeline reply (INCR result + a positive PTTL, so the
 * self-heal PEXPIRE branch never fires and each successful attempt is
 * exactly one fetch call — matching the "single round trip" contract
 * pinned in upstashRateLimit.distributed.test.ts).
 */
function makeFetch(state: { up: boolean }) {
  return vi.fn(async () => {
    if (!state.up) throw new Error('ECONNREFUSED (simulated Upstash outage)');
    return new Response(JSON.stringify([{ result: 1 }, { result: 60_000 }]), { status: 200 });
  });
}

describe('UpstashRateLimitStore — circuit breaker', () => {
  it('opens after 5 consecutive failures and stops calling Redis on the 6th attempt', async () => {
    const state = { up: false };
    const fetchSpy = makeFetch(state);
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchSpy);

    for (let i = 0; i < 5; i++) {
      await store.increment('ip:breaker-open', 60_000, Date.now());
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // 6th call: breaker OPEN — must skip Redis entirely, no new fetch, no 2s wait.
    await store.increment('ip:breaker-open', 60_000, Date.now());
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('does NOT trip on 4 consecutive failures — the 5th call still attempts Redis', async () => {
    const state = { up: false };
    const fetchSpy = makeFetch(state);
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchSpy);

    for (let i = 0; i < 4; i++) {
      await store.increment('ip:boundary', 60_000, Date.now());
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Breaker was still CLOSED going into the 5th call, so it attempted Redis
    // (and that failure is what actually trips it, for the NEXT call).
    await store.increment('ip:boundary', 60_000, Date.now());
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('still returns a valid fail-open entry (so §1.10 headers keep working) while the breaker is open', async () => {
    const state = { up: false };
    const fetchSpy = makeFetch(state);
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchSpy);

    for (let i = 0; i < 5; i++) {
      await store.increment('ip:headers', 60_000, Date.now());
    }
    const callsBeforeSkip = fetchSpy.mock.calls.length;

    const entry = await store.increment('ip:headers', 60_000, Date.now());

    // No new Redis call...
    expect(fetchSpy).toHaveBeenCalledTimes(callsBeforeSkip);
    // ...but the caller (enforceShared in rateLimit.ts) still gets a real
    // entry to build X-RateLimit-Limit/Remaining/Reset from — the fallback
    // bucket kept counting straight through the outage.
    expect(entry.count).toBe(6);
    expect(Number.isFinite(entry.resetAt)).toBe(true);
    expect(entry.resetAt).toBeGreaterThan(Date.now());
  });

  it('half-open recovery: probes once after 30s, a successful probe closes the breaker', async () => {
    const state = { up: false };
    const fetchSpy = makeFetch(state);
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchSpy);

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.increment('ip:half-open', 60_000, t0);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Still inside the 30s recovery window — stays open, no probe attempted.
    await store.increment('ip:half-open', 60_000, t0 + 10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Redis recovers AND 30s have elapsed — this call is the one probe.
    state.up = true;
    const probeEntry = await store.increment('ip:half-open', 60_000, t0 + 31_000);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(probeEntry.count).toBe(1); // the mocked INCR result — a real Redis round trip happened

    // Breaker closed by the successful probe — the very next call goes
    // straight to Redis again, no skip.
    await store.increment('ip:half-open', 60_000, t0 + 31_500);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });

  it('half-open recovery: a failed probe re-opens for another 30s without needing 5 more failures', async () => {
    const state = { up: false };
    const fetchSpy = makeFetch(state);
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchSpy);

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.increment('ip:half-open-fail', 60_000, t0);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Probe attempt after 30s — Redis is still down, so the probe itself fails.
    await store.increment('ip:half-open-fail', 60_000, t0 + 31_000);
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // Immediately after the failed probe: back to OPEN. A single failed probe
    // re-opens outright — it does not need to re-accumulate 5 failures.
    await store.increment('ip:half-open-fail', 60_000, t0 + 31_100);
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // A full 30s after the RE-open (not the original open): second probe.
    state.up = true;
    await store.increment('ip:half-open-fail', 60_000, t0 + 61_100);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });
});
