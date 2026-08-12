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
import {
  mempoolApiBaseForNetwork,
  resolveMempoolApiBase,
} from '../utils/mempool-url.js';

// ─── Interface ──────────────────────────────────────────────────────────

/**
 * Where an estimate's number actually came from.
 *
 * - `live`     — the estimator KNOWS this rate. A real API reading, or a
 *                statically-configured rate (signet's flat 1 sat/vB is the
 *                truth for that network, not a degraded substitute).
 * - `fallback` — the estimator does NOT know the rate. The API failed and a
 *                configured default was substituted so the caller had a
 *                number to work with.
 */
export type FeeEstimateSource = 'live' | 'fallback';

/** Why a fallback was substituted. Present only when source is 'fallback'. */
export type FeeFallbackReason =
  | 'http_error'
  | 'invalid_rate'
  | 'timeout'
  | 'network_error';

export interface FeeEstimate {
  /** Fee rate in sat/vbyte. */
  rate: number;
  /** Whether `rate` is known or substituted. */
  source: FeeEstimateSource;
  /** Populated only when `source === 'fallback'`. */
  reason?: FeeFallbackReason;
}

export interface FeeEstimator {
  /**
   * Estimate the current fee rate in sat/vbyte.
   *
   * SCRUM-3128: this form is LOSSY — it cannot distinguish "the API said 5"
   * from "the API failed and we substituted 5". Safe for advisory/display
   * uses (logging, pricing hints, dashboards). **Any gate whose degraded
   * mode must not be "allow" has to use `estimateFeeDetailed()` instead** —
   * see the fee ceiling in `jobs/anchor.ts`.
   */
  estimateFee(): Promise<number>;

  /**
   * Estimate the fee rate AND report whether the number is a real reading or
   * a substituted fallback (SCRUM-3128 / BUG-2026-08-11).
   *
   * Required on the interface, deliberately: this is the question every cost
   * gate has to ask, and an optional method is one a call site can silently
   * forget — which is precisely how the ECON-1 fail-open survived.
   */
  estimateFeeDetailed(): Promise<FeeEstimate>;

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

  /**
   * Always `live`. A static rate is a KNOWN rate — it is the configured truth
   * for the network, not a substitute for a reading that failed. Reporting it
   * as `fallback` would make a fail-closed cost gate defer every signet/dev
   * anchor forever.
   */
  async estimateFeeDetailed(): Promise<FeeEstimate> {
    return { rate: this.rate, source: 'live' };
  }
}

// ─── Mempool.space Fee Estimator ────────────────────────────────────────

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 5000;

export interface MempoolFeeEstimatorConfig {
  /**
   * Explicit Mempool API base, already carrying the `/api` segment (e.g.
   * `https://mempool.space/signet/api`). Wins over `network` when both are
   * set. Leave unset and pass `network` instead unless you have an
   * operator-supplied override.
   */
  baseUrl?: string;
  /**
   * Bitcoin network. Selects the per-network base via
   * `mempoolApiBaseForNetwork()` when `baseUrl` is not given. Pass
   * `config.bitcoinNetwork`.
   *
   * BUG-2026-08-11: this used to not exist, and the constructor defaulted to
   * the mainnet base unconditionally. `/v1/fees/recommended` is
   * network-scoped, so every direct construction on a non-mainnet deployment
   * silently read mainnet's rates.
   */
  network?: string;
  /** Fallback rate in sat/vbyte if the API call fails */
  fallbackRate?: number;
  /** Target speed: 'fastest' | 'halfHour' | 'hour' | 'economy'. Default: 'halfHour' */
  target?: MempoolFeeTarget;
  /** Request timeout in milliseconds. Default: 5000 (5s). */
  timeoutMs?: number;
}

export type MempoolFeeTarget = 'fastest' | 'halfHour' | 'hour' | 'economy';

/**
 * No module-level default base any more. The mainnet fallback lives in
 * `mempoolApiBaseForNetwork()` alone (BUG-2026-08-11) — a private constant
 * here is precisely what let this file drift onto a mainnet-only default
 * while `chain/utxo-provider.ts` was already per-network.
 */

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
 * Fetches live fee rates for the configured network. Pass `network` (or an
 * explicit `baseUrl`); with neither, it defaults to mainnet. Falls back to a
 * static rate on API failure.
 *
 * `/v1/fees/recommended` is network-scoped — signet reports a flat 1 sat/vB
 * while mainnet reports real congestion — so a mainnet default read on a
 * signet deployment is not a cosmetic error: it drives fee-ceiling and
 * submit/defer gates off the wrong chain (BUG-2026-08-11).
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
    // BUG-2026-08-11: the default is per-network, not a static mainnet base.
    // It has to be correct HERE and not only in createFeeEstimator — four
    // call sites construct this class directly (jobs/anchor.ts fee ceiling,
    // jobs/feeAwareScheduler.ts submit gate x2, middleware/x402PaymentGate.ts
    // pricing), and the factory-level parity ratchet cannot see any of them.
    this.baseUrl = (
      config.baseUrl ?? mempoolApiBaseForNetwork(config.network)
    ).replace(/\/$/, '');
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

  /**
   * Lossy form — see the note on `FeeEstimator.estimateFee`. Kept as a thin
   * wrapper so advisory callers are unchanged; gates must use the detailed
   * form.
   */
  async estimateFee(): Promise<number> {
    return (await this.estimateFeeDetailed()).rate;
  }

  async estimateFeeDetailed(): Promise<FeeEstimate> {
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
        return this.fallback('http_error');
      }

      const data = (await response.json()) as Record<string, number>;
      const field = TARGET_FIELD_MAP[this.target];
      const rate = data[field];

      if (typeof rate !== 'number' || rate < 1) {
        logger.warn(
          { field, rate, data },
          'Mempool fee API returned invalid rate — using fallback',
        );
        return this.fallback('invalid_rate');
      }

      logger.debug({ target: this.target, rate }, 'Mempool fee estimate');
      return { rate, source: 'live' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.warn(
          { url, timeoutMs: this.timeoutMs },
          'Mempool fee API request timed out — using fallback',
        );
        return this.fallback('timeout');
      }
      logger.warn(
        { error, url },
        'Mempool fee API request failed — using fallback',
      );
      return this.fallback('network_error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private fallback(reason: FeeFallbackReason): FeeEstimate {
    return { rate: this.fallbackRate, source: 'fallback', reason };
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
  /**
   * Bitcoin network, used to pick the per-network mempool.space base when
   * strategy is 'mempool' and no explicit `mempoolApiUrl` is set. Pass
   * `config.bitcoinNetwork`. Defaults to mainnet when omitted, matching the
   * factory's historical behaviour.
   */
  network?: string;
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
    // SCRUM-3016: this estimator builds requests as `${baseUrl}/v1/fees/...`
    // — it never appends `/api` itself, so `baseUrl` must already carry it.
    // resolveMempoolApiBase normalizes a MEMPOOL_API_URL set WITHOUT a
    // trailing /api (the OTHER convention some sibling consumers expect —
    // see mempool-url.ts) up to the form this estimator needs.
    //
    // BUG-2026-08-11: the fallback used to be the hardcoded mainnet base, so
    // a signet/testnet deployment on this strategy read MAINNET fee rates.
    // `/v1/fees/recommended` is network-scoped — signet reports a flat
    // 1 sat/vB while mainnet reports real congestion — so the INEFF-5
    // FORCE_DYNAMIC_FEE_ESTIMATION rehearsal in chain/client.ts was
    // validating the fee path against the wrong chain entirely.
    const baseUrl = resolveMempoolApiBase(
      factoryConfig.mempoolApiUrl,
      mempoolApiBaseForNetwork(factoryConfig.network),
    );
    logger.info(
      {
        strategy: 'mempool',
        network: factoryConfig.network ?? 'mainnet',
        baseUrl,
        target: factoryConfig.target ?? 'halfHour',
      },
      'Creating mempool fee estimator',
    );
    return new MempoolFeeEstimator({
      baseUrl,
      fallbackRate: factoryConfig.fallbackRate,
      target: factoryConfig.target,
      timeoutMs: factoryConfig.timeoutMs,
    });
  }

  throw new Error(`Unknown fee strategy: ${factoryConfig.strategy}`);
}
