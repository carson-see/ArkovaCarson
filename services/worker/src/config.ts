/**
 * Worker Configuration
 *
 * Environment-based configuration for the anchoring worker service.
 * All secrets are loaded from environment variables.
 *
 * Constitution refs:
 *   - 1.4: Treasury/signing keys server-side only, loaded from env vars, never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().default(3001),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database
  supabaseUrl: z.string().url(),
  supabaseServiceKey: z.string().min(1),

  // Stripe
  stripeSecretKey: z.string().min(1),
  stripeWebhookSecret: z.string().min(1),

  // Bitcoin chain
  bitcoinNetwork: z.enum(['signet', 'testnet', 'mainnet']).default('signet'),
  bitcoinRpcUrl: z.string().url().optional(),
  bitcoinRpcAuth: z.string().optional(),
  /** Treasury WIF — loaded from env, NEVER logged (Constitution 1.4) */
  bitcoinTreasuryWif: z.string().optional(),
  /** UTXO provider: 'rpc' (requires bitcoinRpcUrl) or 'mempool' (no node needed) */
  bitcoinUtxoProvider: z.enum(['rpc', 'mempool']).default('mempool'),
  /** Mempool.space API URL override (defaults to Signet endpoint) */
  mempoolApiUrl: z.string().url().optional(),

  // Legacy chain API fields (kept for backward compat with existing tests)
  chainApiUrl: z.string().url().optional(),
  chainApiKey: z.string().optional(),
  chainNetwork: z.enum(['testnet', 'mainnet']).default('testnet'),

  // Frontend
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Feature flags
  useMocks: z.coerce.boolean().default(false),
  /** Gates real Bitcoin chain calls (Constitution 1.9) */
  enableProdNetworkAnchoring: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    port: process.env.WORKER_PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    bitcoinNetwork: process.env.BITCOIN_NETWORK,
    bitcoinRpcUrl: process.env.BITCOIN_RPC_URL,
    bitcoinRpcAuth: process.env.BITCOIN_RPC_AUTH,
    bitcoinTreasuryWif: process.env.BITCOIN_TREASURY_WIF,
    bitcoinUtxoProvider: process.env.BITCOIN_UTXO_PROVIDER,
    mempoolApiUrl: process.env.MEMPOOL_API_URL,
    chainApiUrl: process.env.CHAIN_API_URL,
    chainApiKey: process.env.CHAIN_API_KEY,
    chainNetwork: process.env.CHAIN_NETWORK,
    frontendUrl: process.env.FRONTEND_URL,
    useMocks: process.env.USE_MOCKS,
    enableProdNetworkAnchoring: process.env.ENABLE_PROD_NETWORK_ANCHORING,
  });

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    throw new Error('Invalid worker configuration');
  }

  return result.data;
}

// Export singleton config
export const config = loadConfig();

/**
 * Network display names per Constitution terminology (Section 1.3)
 */
export const NETWORK_DISPLAY_NAMES = {
  signet: 'Test Environment',
  testnet: 'Test Environment',
  mainnet: 'Production Network',
} as const;

export function getNetworkDisplayName(network: 'signet' | 'testnet' | 'mainnet'): string {
  return NETWORK_DISPLAY_NAMES[network];
}
