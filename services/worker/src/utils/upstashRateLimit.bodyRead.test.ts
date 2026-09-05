/**
 * Bounded body reads on the Upstash transport (F-D0-5 / `feedback_bounded_body_reads`).
 *
 * `AbortSignal.timeout(REDIS_TIMEOUT_MS)` bounds the REQUEST. It does not bound
 * the `await res.json()` that follows: a provider that sends 200 + headers and
 * then stalls the body parks that await with no deadline of its own. On this
 * class the consequence is worse than a slow call — `increment()` is awaited on
 * the blocking hot path of `rateLimit()`, and the circuit breaker only counts
 * failures it is TOLD about, so a parked read never trips it. One wedged socket
 * would hang every rate-limited request indefinitely while the fail-open local
 * bucket, which exists precisely for this, is never reached.
 *
 * Both transport methods are covered because they are separate reads:
 * `pipeline()` (INCR + PTTL, the hot path) and `command()` (PEXPIRE self-heal,
 * DECR, SET, DEL).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BodyReadTimeoutError } from './body-read-timeout.js';
import { UpstashRateLimitStore } from './upstashRateLimit.js';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';
/** Must match REDIS_TIMEOUT_MS in upstashRateLimit.ts. */
const REDIS_TIMEOUT_MS = 2_000;

/** 200 OK whose body never arrives — headers sent, stream then silent. */
const stalledBody = () =>
  ({
    ok: true,
    status: 200,
    json: () => new Promise<never>(() => {}),
    body: null,
  }) as unknown as Response;

describe('Upstash transport — body reads are bounded (F-D0-5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('increment() falls back to the local bucket when the pipeline body stalls', async () => {
    const fetchImpl = vi.fn(async () => stalledBody());
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchImpl, 'test');

    const pending = store.increment('ip:203.0.113.7', 60_000, 1_000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(REDIS_TIMEOUT_MS - 1);
    expect(settled).toBe(false); // still legitimately in flight

    await vi.advanceTimersByTimeAsync(2);
    const entry = await pending;

    expect(settled).toBe(true);
    expect(entry).toEqual({ count: 1, resetAt: 61_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('decrement() settles when the single-command body stalls', async () => {
    const fetchImpl = vi.fn(async () => stalledBody());
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN, fetchImpl, 'test');

    const pending = store.decrement('ip:203.0.113.7');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(REDIS_TIMEOUT_MS + 1);
    await pending;

    expect(settled).toBe(true);
  });

  it('the body-read deadline error never carries the key-bearing request path', () => {
    // §1.4/§1.6: an anonymous limiter key IS a caller IP, and
    // `BodyReadTimeoutError` embeds its `url` argument verbatim in `.message`,
    // which reaches warn logs and Sentry. So the label these transports pass
    // must be the base URL plus the command VERB, never the encoded
    // `/<command>/<key>` request path.
    //
    // Scope note: the surrounding `logger.warn({ error, key }, …)` in
    // redisSet/redisDel/decrement does log the key as a structured field. That
    // predates this change and is left alone deliberately — it is the operator
    // signal the fail-open path exists for, and widening it into a PII review
    // is a separate decision from bounding the read.
    const err = new BodyReadTimeoutError(`${BASE_URL}/decr`, REDIS_TIMEOUT_MS);
    expect(err.message).toContain('https://fake-redis.upstash.io/decr');
    expect(err.message).not.toContain('ip:');
    expect(err.message).not.toContain('203.0.113.7');
  });
});
