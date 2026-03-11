/**
 * Chain Client Factory
 *
 * Returns appropriate chain client based on configuration.
 * - Test/mock mode: MockChainClient (always)
 * - Signet with ENABLE_PROD_NETWORK_ANCHORING: SignetChainClient
 * - All other cases: MockChainClient (safe fallback)
 *
 * Constitution refs:
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *   - 1.4: Treasury keys never logged
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ChainClient } from './types.js';
import { MockChainClient } from './mock.js';
import { SignetChainClient } from './signet.js';

export function getChainClient(): ChainClient {
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

  // Signet chain client
  if (config.bitcoinNetwork === 'signet' || config.bitcoinNetwork === 'testnet') {
    if (!config.bitcoinTreasuryWif) {
      logger.error('BITCOIN_TREASURY_WIF required for Signet chain client — falling back to mock');
      return new MockChainClient();
    }

    if (!config.bitcoinRpcUrl) {
      logger.error('BITCOIN_RPC_URL required for Signet chain client — falling back to mock');
      return new MockChainClient();
    }

    logger.info({ network: config.bitcoinNetwork }, 'Using SignetChainClient');
    return new SignetChainClient({
      treasuryWif: config.bitcoinTreasuryWif,
      rpcUrl: config.bitcoinRpcUrl,
      rpcAuth: config.bitcoinRpcAuth,
    });
  }

  // Mainnet — not yet implemented (Phase 2)
  if (config.bitcoinNetwork === 'mainnet') {
    logger.error('Mainnet chain client not yet implemented — falling back to mock');
    return new MockChainClient();
  }

  return new MockChainClient();
}

export const chainClient = getChainClient();
