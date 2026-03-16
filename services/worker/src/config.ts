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
  /** JWT secret for local token verification — eliminates network call to Supabase auth */
  supabaseJwtSecret: z.string().min(1).optional(),

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

  // Bitcoin fee estimation
  /** Fee estimation strategy: 'static' (fixed rate) or 'mempool' (live API) */
  bitcoinFeeStrategy: z.enum(['static', 'mempool']).optional(),
  /** Static fee rate in sat/vB (used when bitcoinFeeStrategy is 'static') */
  bitcoinStaticFeeRate: z.coerce.number().positive().optional(),
  /** Fallback fee rate in sat/vB (used when live estimation fails) */
  bitcoinFallbackFeeRate: z.coerce.number().positive().optional(),

  // Bitcoin mainnet KMS signing (Constitution 1.1)
  /** AWS KMS key ID for mainnet transaction signing */
  bitcoinKmsKeyId: z.string().optional(),
  /** AWS region for KMS key */
  bitcoinKmsRegion: z.string().optional(),

  // Legacy chain API fields (kept for backward compat with existing tests)
  chainApiUrl: z.string().url().optional(),
  chainApiKey: z.string().optional(),
  chainNetwork: z.enum(['testnet', 'mainnet']).default('testnet'),

  // Frontend
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Cloudflare Tunnel (INFRA-01, ADR-002)
  /** Tunnel token — injected by secrets manager, never logged */
  cloudflareTunnelToken: z.string().optional(),
  /** Sentry DSN for error tracking (INFRA-01) */
  sentryDsn: z.string().url().optional(),

  // Feature flags
  useMocks: z.coerce.boolean().default(false),
  /** Gates real Bitcoin chain calls (Constitution 1.9) */
  enableProdNetworkAnchoring: z.coerce.boolean().default(false),

  // Verification API (P4.5)
  /** HMAC-SHA256 secret for API key hashing (Constitution 1.4) — never logged */
  apiKeyHmacSecret: z.string().min(1).optional(),
  /** CORS origins for /api/v1/* endpoints (comma-separated) */
  corsAllowedOrigins: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    port: process.env.WORKER_PORT ?? process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    bitcoinNetwork: process.env.BITCOIN_NETWORK,
    bitcoinRpcUrl: process.env.BITCOIN_RPC_URL,
    bitcoinRpcAuth: process.env.BITCOIN_RPC_AUTH,
    bitcoinTreasuryWif: process.env.BITCOIN_TREASURY_WIF,
    bitcoinUtxoProvider: process.env.BITCOIN_UTXO_PROVIDER,
    mempoolApiUrl: process.env.MEMPOOL_API_URL,
    bitcoinFeeStrategy: process.env.BITCOIN_FEE_STRATEGY,
    bitcoinStaticFeeRate: process.env.BITCOIN_STATIC_FEE_RATE,
    bitcoinFallbackFeeRate: process.env.BITCOIN_FALLBACK_FEE_RATE,
    bitcoinKmsKeyId: process.env.BITCOIN_KMS_KEY_ID,
    bitcoinKmsRegion: process.env.BITCOIN_KMS_REGION,
    chainApiUrl: process.env.CHAIN_API_URL,
    chainApiKey: process.env.CHAIN_API_KEY,
    chainNetwork: process.env.CHAIN_NETWORK,
    frontendUrl: process.env.FRONTEND_URL,
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    sentryDsn: process.env.SENTRY_DSN,
    useMocks: process.env.USE_MOCKS,
    enableProdNetworkAnchoring: process.env.ENABLE_PROD_NETWORK_ANCHORING,
    apiKeyHmacSecret: process.env.API_KEY_HMAC_SECRET,
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
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
