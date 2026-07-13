/**
 * Fee Estimator Interface + Implementations
 *
 * Abstracts fee rate estimation so that BitcoinChainClient can work with:
 *   - A static rate (e.g., 1 sat/vbyte for Signet)
 *   - A live rate from mempool.space API (for mainnet)
 *
 * Constitution refs:
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *
 * Story: CRIT-2 (Bitcoin chain client completion)
 */

import { logger } from '../utils/logger.js';

// ─── Interface ──────────────────────────────────────────────────────────

export interface FeeEstimator {
  /** Estimate the current fee rate in sat/vbyte. */
  estimateFee(): Promise<number>;

  /** Estimator display name for logging. */
  readonly name: string;
}

// ─── Static Fee Estimator ───────────────────────────────────────────────

/**
 * Returns a fixed fee rate. Suitable for Signet (1 sat/vbyte minimum)
 * or any environment where a static rate is acceptable.
 */
export class StaticFeeEstimator implements FeeEstimator {
  readonly name = 'Static';
  private readonly rate: number;

  constructor(rateSatPerVbyte: number = 1) {
    if (rateSatPerVbyte < 1) {
      throw new Error('Fee rate must be at least 1 sat/vbyte');
    }
    this.rate = rateSatPerVbyte;
  }

  async estimateFee(): Promise<number> {
    return this.rate;
  }
}

// ─── Mempool.space Fee Estimator ────────────────────────────────────────

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 5000;

export interface MempoolFeeEstimatorConfig {
  /** Base URL for Mempool API (e.g., https://mempool.space/api) */
  baseUrl?: string;
  /** Fallback rate in sat/vbyte if the API call fails */
  fallbackRate?: number;
  /** Target speed: 'fastest' | 'halfHour' | 'hour' | 'economy'. Default: 'halfHour' */
  target?: MempoolFeeTarget;
  /** Request timeout in milliseconds. Default: 5000 (5s). */
  timeoutMs?: number;
}

export type MempoolFeeTarget = 'fastest' | 'halfHour' | 'hour' | 'economy';

/** Default Mempool.space API endpoint (mainnet) */
const DEFAULT_MEMPOOL_URL = 'https://mempool.space/api';

/** Default fallback fee rate in sat/vbyte */
const DEFAULT_FALLBACK_RATE = 5;

/** Map from target name to mempool.space JSON field */
const TARGET_FIELD_MAP: Record<MempoolFeeTarget, string> = {
  fastest: 'fastestFee',
  halfHour: 'halfHourFee',
  hour: 'hourFee',
  economy: 'economyFee',
};

/**
 * Fee estimator backed by the mempool.space `/v1/fees/recommended` API.
 *
 * Fetches live fee rates for Bitcoin mainnet (or Signet/testnet with
 * custom baseUrl). Falls back to a static rate on API failure.
 *
 * API docs: https://mempool.space/docs/api/rest#get-recommended-fees
 */
export class MempoolFeeEstimator implements FeeEstimator {
  readonly name = 'Mempool.space';
  private readonly baseUrl: string;
  private readonly fallbackRate: number;
  private readonly target: MempoolFeeTarget;
  private readonly timeoutMs: number;

  constructor(config: MempoolFeeEstimatorConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_MEMPOOL_URL).replace(/\/$/, '');
    const fallback = config.fallbackRate ?? DEFAULT_FALLBACK_RATE;
    if (typeof fallback !== 'number' || !Number.isFinite(fallback) || fallback < 1) {
      throw new Error(`Fallback fee rate must be a finite number >= 1, got: ${fallback}`);
    }
    this.fallbackRate = fallback;
    this.target = config.target ?? 'halfHour';
    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`timeoutMs must be a positive finite number, got: ${timeout}`);
    }
    this.timeoutMs = timeout;
  }

  async estimateFee(): Promise<number> {
    const url = `${this.baseUrl}/v1/fees/recommended`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        logger.warn(
          { status: response.status, url },
          'Mempool fee API returned non-OK status — using fallback',
        );
        return this.fallbackRate;
      }

      const data = (await response.json()) as Record<string, number>;
      const field = TARGET_FIELD_MAP[this.target];
      const rate = data[field];

      if (typeof rate !== 'number' || rate < 1) {
        logger.warn(
          { field, rate, data },
          'Mempool fee API returned invalid rate — using fallback',
        );
        return this.fallbackRate;
      }

      logger.debug({ target: this.target, rate }, 'Mempool fee estimate');
      return rate;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.warn(
          { url, timeoutMs: this.timeoutMs },
          'Mempool fee API request timed out — using fallback',
        );
      } else {
        logger.warn(
          { error, url },
          'Mempool fee API request failed — using fallback',
        );
      }
      return this.fallbackRate;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─── Batch fee-ceiling primitive (SCRUM-2592) ───────────────────────────────

/**
 * Escalation thresholds for the dynamic batch fee ceiling. These MIRROR the
 * bands in `jobs/batch-anchor.ts:triggerC_computeFeeCeiling` — the batch-anchor
 * function remains the single source of truth; this primitive is a pure,
 * dependency-light mirror so the estimator layer can reason about the ceiling
 * without importing the DB-heavy batch-anchor module (which would create an
 * import cycle: chain/client → chain/fee-estimator → jobs/batch-anchor →
 * chain/client). The `fee-ceiling-parity.test.ts` suite pins byte-identical
 * output against the locked source-of-truth across a swept input space.
 */
const DYNAMIC_CEILING_2X_AGE_MS = 30 * 60 * 1000; // > 30 min → 2×
const DYNAMIC_CEILING_4X_AGE_MS = 60 * 60 * 1000; // > 60 min → 4×

export interface BatchFeeCeilingInput {
  /** Base ceiling in sat/vByte (the configured max fee threshold). */
  baseCeiling: number;
  /** Age of the oldest pending anchor in ms — scales the ceiling. */
  oldestPendingAgeMs: number;
  /**
   * Absolute hard cap in sat/vByte. INJECTED by the caller — this primitive
   * does NOT own or redefine the constant; batch-anchor's
   * `ABSOLUTE_FEE_CAP_SAT_PER_VB` is passed in at the wire-up call site so the
   * two never diverge.
   */
  absoluteCapSatPerVb: number;
}

/**
 * Compute the effective batch fee ceiling in sat/vByte.
 *
 * The ceiling scales with backlog age so a very-stale backlog still ships:
 *   - age ≤ 30 min      → baseCeiling (1×)
 *   - 30 min < age ≤ 1h → baseCeiling × 2
 *   - age > 1h          → baseCeiling × 4
 * clamped to `absoluteCapSatPerVb` (never exceeds the hard cap, and never goes
 * negative when baseCeiling is 0).
 *
 * Mirror of `triggerC_computeFeeCeiling` (batch-anchor.ts). Boundaries are
 * strict `>` so exactly 30 min stays 1× and exactly 60 min stays 2×.
 */
export function computeBatchFeeCeiling(input: BatchFeeCeilingInput): number {
  let ceiling = input.baseCeiling;
  if (input.oldestPendingAgeMs > DYNAMIC_CEILING_4X_AGE_MS) {
    ceiling = input.baseCeiling * 4;
  } else if (input.oldestPendingAgeMs > DYNAMIC_CEILING_2X_AGE_MS) {
    ceiling = input.baseCeiling * 2;
  }
  return Math.min(ceiling, input.absoluteCapSatPerVb);
}

// ─── Factory ────────────────────────────────────────────────────────────

export type FeeStrategy = 'static' | 'mempool';

export interface FeeEstimatorFactoryConfig {
  strategy: FeeStrategy;
  /** Static fee rate in sat/vbyte (used when strategy is 'static') */
  staticRate?: number;
  /** Mempool API base URL (used when strategy is 'mempool') */
  mempoolApiUrl?: string;
  /** Fallback fee rate if mempool API fails */
  fallbackRate?: number;
  /** Fee target for mempool strategy */
  target?: MempoolFeeTarget;
  /** Request timeout in milliseconds for mempool strategy. Default: 5000 */
  timeoutMs?: number;
}

/**
 * Create a fee estimator based on configuration.
 *
 * - 'static': Returns a fixed rate. For Signet/testnet.
 * - 'mempool': Fetches live rates from mempool.space. For mainnet.
 */
export function createFeeEstimator(
  factoryConfig: FeeEstimatorFactoryConfig,
): FeeEstimator {
  if (factoryConfig.strategy === 'static') {
    const rate = factoryConfig.staticRate ?? 1;
    logger.info({ strategy: 'static', rate }, 'Creating static fee estimator');
    return new StaticFeeEstimator(rate);
  }

  if (factoryConfig.strategy === 'mempool') {
    logger.info(
      {
        strategy: 'mempool',
        baseUrl: factoryConfig.mempoolApiUrl ?? DEFAULT_MEMPOOL_URL,
        target: factoryConfig.target ?? 'halfHour',
      },
      'Creating mempool fee estimator',
    );
    return new MempoolFeeEstimator({
      baseUrl: factoryConfig.mempoolApiUrl,
      fallbackRate: factoryConfig.fallbackRate,
      target: factoryConfig.target,
      timeoutMs: factoryConfig.timeoutMs,
    });
  }

  throw new Error(`Unknown fee strategy: ${factoryConfig.strategy}`);
}
