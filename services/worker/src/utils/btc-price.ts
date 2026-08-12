/**
 * Cached BTC/USD quote reader (SCRUM-3128, BUG-2026-08-11).
 *
 * The ONLY sanctioned way for a request-path caller to obtain a BTC/USD
 * figure. There is exactly one oracle call in this service and the treasury
 * cache cron owns it (`jobs/treasury-cache.ts`, every 10 minutes, writing
 * `treasury_cache.btc_price_usd`). Everything else reads the cached value
 * through here.
 *
 * Why a reader instead of a fetch: the price feeds `middleware/
 * x402PaymentGate.ts`, which is mounted on 6+ `/api/v1` routes. A per-request
 * call to `mempool.space/api/v1/prices` would put a third-party HTTP
 * round-trip in front of every gated request and rate-limit us out of our own
 * pricing under load.
 *
 * Why null instead of a default: this value multiplies a charge. Every way the
 * cache can be unusable — absent row, `-1` non-mainnet sentinel, zero,
 * non-finite, unknown age, dead cron — returns null so the caller degrades to
 * a price it can defend, rather than silently billing off a wrong number. That
 * failure mode is the one this module exists to prevent: the caller it was
 * written for had `const btcPriceUsd = 60000` hardcoded.
 */

import { db } from './db.js';
import { logger } from './logger.js';

/**
 * Oldest quote we will price against.
 *
 * The cron refreshes every 10 minutes, so 6 h is ~36 consecutive failures —
 * comfortably past "a blip" and into "the cron is dead". Beyond that the
 * quote could be arbitrarily far from spot, and pricing money off it is worse
 * than dropping the component that needs it.
 */
export const BTC_PRICE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Process-local memo window. Bounded well under the cron's 10-minute refresh,
 * so the memo can never be meaningfully staler than the row it caches, while
 * still collapsing a request burst to a single DB read.
 */
export const BTC_PRICE_MEMO_TTL_MS = 60_000;

interface Memo {
  value: number | null;
  expiresAt: number;
}

let memo: Memo | null = null;
let inFlight: Promise<number | null> | null = null;

/**
 * A usable BTC/USD quote, or null when the value is not a price.
 *
 * mempool.space signals "no price data for this network" as `-1` with HTTP
 * 200, and a non-positive or non-finite price silently corrupts every
 * downstream USD figure. Shared with `jobs/treasury-cache.ts`, which validates
 * on the way IN — this module is the last line on the way OUT, so a row
 * written before the guard existed (or by a future writer) still cannot poison
 * a charge.
 */
export function normalizeBtcPrice(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Row age in ms, or null when `updated_at` is absent or unparseable. */
function ageMs(updatedAt: unknown): number | null {
  if (typeof updatedAt !== 'string') return null;
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? null : Date.now() - parsed;
}

async function readCachedBtcPriceUsd(): Promise<number | null> {
  const { data, error } = await db
    .from('treasury_cache')
    .select('btc_price_usd, updated_at')
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ error, reason: 'cache_read_failed' }, 'BTC/USD quote unavailable — treasury_cache read failed');
    return null;
  }

  if (!data) {
    logger.warn({ reason: 'no_cache_row' }, 'BTC/USD quote unavailable — treasury_cache is empty');
    return null;
  }

  const price = normalizeBtcPrice(data.btc_price_usd);
  if (price == null) {
    logger.warn(
      { reason: 'non_price_value', reported: data.btc_price_usd },
      'BTC/USD quote unavailable — treasury_cache holds a non-price value',
    );
    return null;
  }

  // Freshness is checked AFTER the value, so the log names the actual problem
  // when a dead cron has also left a bad value behind.
  const age = ageMs(data.updated_at);
  if (age == null) {
    logger.warn({ reason: 'unknown_age' }, 'BTC/USD quote rejected — treasury_cache row has no parseable updated_at');
    return null;
  }
  if (age > BTC_PRICE_MAX_AGE_MS) {
    logger.warn(
      { reason: 'stale_quote', ageMs: age, maxAgeMs: BTC_PRICE_MAX_AGE_MS },
      'BTC/USD quote rejected as stale — treasury cache cron may be down',
    );
    return null;
  }

  return price;
}

/**
 * Latest usable BTC/USD quote from `treasury_cache`, or null.
 *
 * Never issues an HTTP request. Memoized for {@link BTC_PRICE_MEMO_TTL_MS},
 * including the null result — an outage must not turn every gated request into
 * a DB read. Concurrent callers share one in-flight read.
 */
export async function getCachedBtcPriceUsd(): Promise<number | null> {
  if (memo && Date.now() < memo.expiresAt) {
    return memo.value;
  }

  inFlight ??= readCachedBtcPriceUsd()
    .catch((error: unknown) => {
      // A throw (as opposed to a PostgREST `error`) still has to memoize, or a
      // hard DB failure stampedes every request straight back into the driver.
      logger.warn(
        { errorName: error instanceof Error ? error.name : 'UnknownError', reason: 'cache_read_threw' },
        'BTC/USD quote unavailable — treasury_cache read threw',
      );
      return null;
    })
    .then((value) => {
      memo = { value, expiresAt: Date.now() + BTC_PRICE_MEMO_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
