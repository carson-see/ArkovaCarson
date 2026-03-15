/**
 * Chain Client Factory (Async)
 *
 * Returns appropriate chain client based on configuration.
 * - Test/mock mode: MockChainClient (always)
 * - Signet/testnet with ENABLE_PROD_NETWORK_ANCHORING: BitcoinChainClient (WIF signing)
 * - Mainnet with ENABLE_PROD_NETWORK_ANCHORING: BitcoinChainClient (KMS signing)
 * - All other cases: MockChainClient (safe fallback)
 *
 * Uses an async factory pattern because KMS key initialization requires
 * network calls. Call `initChainClient()` once at startup, then use
 * `getInitializedChainClient()` synchronously in hot paths.
 *
 * Constitution refs:
 *   - 1.1: bitcoinjs-lib + AWS KMS (target)
 *   - 1.4: Treasury keys never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *
 * Stories: P7-TS-05, P7-TS-12, P7-TS-13, CRIT-2
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import type { ChainClient, ChainIndexLookup, IndexEntry } from './types.js';
import * as bitcoin from 'bitcoinjs-lib';
import { MockChainClient } from './mock.js';
import { BitcoinChainClient } from './signet.js';
import { createUtxoProvider } from './utxo-provider.js';
import { createSigningProvider } from './signing-provider.js';
import { createFeeEstimator } from './fee-estimator.js';

// ─── Supabase-backed ChainIndexLookup (P7-TS-13 + DH-05 Cache) ──────

/** DH-05: Cache entry with TTL */
interface CacheEntry {
  value: IndexEntry | null;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * O(1) fingerprint verification via the `anchor_chain_index` table.
 *
 * DH-05: Includes TTL-based in-memory cache (default 5 min).
 * Fingerprints are immutable once anchored, so caching is safe.
 */
export class SupabaseChainIndexLookup implements ChainIndexLookup {
  private _cache = new Map<string, CacheEntry>();
  private _ttlMs: number;

  constructor(ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    this._ttlMs = ttlMs;
  }

  async lookupFingerprint(fingerprint: string): Promise<IndexEntry | null> {
    // Normalize to lowercase — fingerprints are stored lowercase
    const normalizedFingerprint = fingerprint.toLowerCase();

    // DH-05: Check cache first
    const cached = this._cache.get(normalizedFingerprint);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Cache miss or expired — query DB
    const { data, error } = await db
      .from('anchor_chain_index')
      .select('chain_tx_id, chain_block_height, chain_block_timestamp, confirmations, anchor_id')
      .eq('fingerprint_sha256', normalizedFingerprint)
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn({ fingerprint, error }, 'Chain index lookup failed — falling back to UTXO scan');
      return null;
    }

    const result = data
      ? {
          chainTxId: data.chain_tx_id,
          blockHeight: data.chain_block_height,
          blockTimestamp: data.chain_block_timestamp,
          confirmations: data.confirmations,
          anchorId: data.anchor_id,
        }
      : null;

    // Cache the result (including null/miss)
    this._cache.set(normalizedFingerprint, {
      value: result,
      expiresAt: Date.now() + this._ttlMs,
    });

    return result;
  }

  /** Clear the cache (for testing or manual invalidation) */
  clearCache(): void {
    this._cache.clear();
  }

  /** Get current cache size (for monitoring) */
  get cacheSize(): number {
    return this._cache.size;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────

let _chainClient: ChainClient | null = null;

/**
 * Initialize the chain client singleton. Call once at startup.
 *
 * Async because KMS key initialization (mainnet) requires a network call
 * to fetch the public key. Signet/mock paths resolve synchronously inside
 * the async wrapper.
 */
export async function initChainClient(): Promise<ChainClient> {
  _chainClient = await createChainClient();
  return _chainClient;
}

/**
 * Get the initialized chain client. Throws if `initChainClient()` has
 * not been called yet.
 *
 * Use this in hot paths (e.g., `processAnchor`) to avoid repeated
 * factory calls.
 */
export function getInitializedChainClient(): ChainClient {
  if (!_chainClient) {
    throw new Error(
      'Chain client not initialized — call initChainClient() at startup',
    );
  }
  return _chainClient;
}

// ─── Factory ──────────────────────────────────────────────────────────

/**
 * Create a chain client based on current configuration.
 * Exported for testing — prefer `initChainClient()` in production code.
 */
export async function createChainClient(): Promise<ChainClient> {
  // Always use mock in test mode or when explicitly configured
  if (config.useMocks || config.nodeEnv === 'test') {
    logger.info('Using MockChainClient (test/mock mode)');
    return new MockChainClient();
  }

  // Real chain client requires the feature flag
  if (!config.enableProdNetworkAnchoring) {
    logger.info('Using MockChainClient (ENABLE_PROD_NETWORK_ANCHORING is false)');
    return new MockChainClient();
  }

  // Chain index for O(1) verification
  const chainIndex = new SupabaseChainIndexLookup();

  // ── Signet / testnet ──────────────────────────────────────────────

  if (config.bitcoinNetwork === 'signet' || config.bitcoinNetwork === 'testnet') {
    if (!config.bitcoinTreasuryWif) {
      logger.error('BITCOIN_TREASURY_WIF required for Signet chain client — falling back to mock');
      return new MockChainClient();
    }

    // Validate provider config
    if (config.bitcoinUtxoProvider === 'rpc' && !config.bitcoinRpcUrl) {
      logger.error('BITCOIN_RPC_URL required for RPC UTXO provider — falling back to mock');
      return new MockChainClient();
    }

    const utxoProvider = createUtxoProvider({
      type: config.bitcoinUtxoProvider,
      rpcUrl: config.bitcoinRpcUrl,
      rpcAuth: config.bitcoinRpcAuth,
      mempoolApiUrl: config.mempoolApiUrl,
    });

    const signingProvider = await createSigningProvider({
      type: 'wif',
      wif: config.bitcoinTreasuryWif,
    });

    const feeEstimator = createFeeEstimator({
      strategy: config.bitcoinFeeStrategy ?? 'static',
      staticRate: config.bitcoinStaticFeeRate,
      fallbackRate: config.bitcoinFallbackFeeRate,
    });

    logger.info(
      {
        network: config.bitcoinNetwork,
        utxoProvider: utxoProvider.name,
        feeEstimator: feeEstimator.name,
      },
      'Using BitcoinChainClient (Signet)',
    );

    return new BitcoinChainClient({
      signingProvider,
      feeEstimator,
      utxoProvider,
      chainIndex,
    });
  }

  // ── Mainnet ───────────────────────────────────────────────────────

  if (config.bitcoinNetwork === 'mainnet') {
    if (!config.bitcoinKmsKeyId) {
      logger.error('BITCOIN_KMS_KEY_ID required for mainnet chain client — falling back to mock');
      return new MockChainClient();
    }

    // Validate provider config
    if (config.bitcoinUtxoProvider === 'rpc' && !config.bitcoinRpcUrl) {
      logger.error('BITCOIN_RPC_URL required for RPC UTXO provider — falling back to mock');
      return new MockChainClient();
    }

    const utxoProvider = createUtxoProvider({
      type: config.bitcoinUtxoProvider,
      rpcUrl: config.bitcoinRpcUrl,
      rpcAuth: config.bitcoinRpcAuth,
      mempoolApiUrl: config.mempoolApiUrl,
    });

    const signingProvider = await createSigningProvider({
      type: 'kms',
      kmsKeyId: config.bitcoinKmsKeyId,
      kmsRegion: config.bitcoinKmsRegion,
    });

    const feeEstimator = createFeeEstimator({
      strategy: config.bitcoinFeeStrategy ?? 'mempool',
      fallbackRate: config.bitcoinFallbackFeeRate,
    });

    logger.info(
      {
        network: 'mainnet',
        utxoProvider: utxoProvider.name,
        feeEstimator: feeEstimator.name,
      },
      'Using BitcoinChainClient (Mainnet + KMS)',
    );

    return new BitcoinChainClient({
      signingProvider,
      feeEstimator,
      utxoProvider,
      chainIndex,
      network: bitcoin.networks.bitcoin,
    });
  }

  return new MockChainClient();
}

// ─── Legacy export (backward compat) ──────────────────────────────────
// Deprecated: use getInitializedChainClient() instead.
// Kept for any remaining sync references during migration.
export function getChainClient(): ChainClient {
  if (_chainClient) {
    return _chainClient;
  }
  throw new Error(
    'getChainClient() called before initChainClient() — call initChainClient() at startup',
  );
}
