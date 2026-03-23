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
  bitcoinNetwork: z.enum(['signet', 'testnet', 'testnet4', 'mainnet']).default('signet'),
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
  /** PERF-7: Maximum fee rate in sat/vB — anchor is queued if live rate exceeds this */
  bitcoinMaxFeeRate: z.coerce.number().positive().optional(),

  // Bitcoin mainnet KMS signing (Constitution 1.1)
  /** KMS provider selection: 'aws' or 'gcp' (default: 'aws') */
  kmsProvider: z.enum(['aws', 'gcp']).default('aws'),
  /** AWS KMS key ID for mainnet transaction signing */
  bitcoinKmsKeyId: z.string().optional(),
  /** AWS region for KMS key */
  bitcoinKmsRegion: z.string().optional(),
  /** GCP KMS key resource name for mainnet transaction signing (MVP-29) */
  gcpKmsKeyResourceName: z.string().optional(),
  /** GCP project ID for KMS (optional — defaults to application default) */
  gcpKmsProjectId: z.string().optional(),

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

  // Feature flags (z.coerce.boolean treats "false" as true — use preprocess)
  useMocks: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** Gates real Bitcoin chain calls (Constitution 1.9) */
  enableProdNetworkAnchoring: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // AI Intelligence (P8)
  /** Gemini API key for AI extraction (Constitution 4A: PII-stripped metadata only) */
  geminiApiKey: z.string().optional(),
  /** Gemini model for extraction (default: gemini-2.0-flash) */
  geminiModel: z.string().optional(),
  /** Gemini embedding model (default: text-embedding-004) */
  geminiEmbeddingModel: z.string().optional(),
  /** AI provider selection: gemini, cloudflare, replicate, mock */
  aiProvider: z.string().optional(),

  // Cron job authentication (AUTH-01)
  /** Shared secret for cron job endpoints — alternative to OIDC when Cloud Scheduler is not used */
  cronSecret: z.string().min(16).optional(),
  /** Expected OIDC audience for Cloud Scheduler tokens (typically the Cloud Run service URL) */
  cronOidcAudience: z.string().url().optional(),

  // Email (BETA-03)
  /** Resend API key for transactional emails */
  resendApiKey: z.string().min(1).optional(),
  /** Verified sender email address */
  emailFrom: z.string().email().default('noreply@arkova.ai'),

  // Verification API (P4.5)
  /** HMAC-SHA256 secret for API key hashing (Constitution 1.4) — never logged */
  apiKeyHmacSecret: z.string().min(1).optional(),
  /** CORS origins for /api/v1/* endpoints (comma-separated) */
  corsAllowedOrigins: z.string().optional(),

  // x402 Payment Protocol (PH1-PAY-01)
  /** x402 facilitator URL for payment verification */
  x402FacilitatorUrl: z.string().url().optional(),
  /** USDC receiving address on Base */
  arkovaUsdcAddress: z.string().optional(),
  /** x402 network identifier (default: Base Sepolia testnet) */
  x402Network: z.string().default('eip155:84532'),

  // Nessie Training Pipeline (PH1-DATA)
  /** SEC EDGAR User-Agent (required by SEC) */
  edgarUserAgent: z.string().optional(),
  /** Output path for training data JSONL exports */
  trainingDataOutputPath: z.string().optional(),
}).superRefine((cfg, ctx) => {
  // Fail fast: production must have at least one cron auth method configured
  if (cfg.nodeEnv === 'production' && !cfg.cronSecret && !cfg.cronOidcAudience) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Production requires CRON_SECRET or CRON_OIDC_AUDIENCE — cron endpoints would be unreachable without auth',
      path: ['cronSecret'],
    });
  }
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
    bitcoinMaxFeeRate: process.env.BITCOIN_MAX_FEE_RATE,
    kmsProvider: process.env.KMS_PROVIDER,
    bitcoinKmsKeyId: process.env.BITCOIN_KMS_KEY_ID,
    bitcoinKmsRegion: process.env.BITCOIN_KMS_REGION,
    gcpKmsKeyResourceName: process.env.GCP_KMS_KEY_RESOURCE_NAME,
    gcpKmsProjectId: process.env.GCP_KMS_PROJECT_ID,
    chainApiUrl: process.env.CHAIN_API_URL,
    chainApiKey: process.env.CHAIN_API_KEY,
    chainNetwork: process.env.CHAIN_NETWORK,
    frontendUrl: process.env.FRONTEND_URL,
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    sentryDsn: process.env.SENTRY_DSN,
    useMocks: process.env.USE_MOCKS,
    enableProdNetworkAnchoring: process.env.ENABLE_PROD_NETWORK_ANCHORING,
    apiKeyHmacSecret: process.env.API_KEY_HMAC_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL,
    geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL,
    aiProvider: process.env.AI_PROVIDER,
    cronSecret: process.env.CRON_SECRET,
    cronOidcAudience: process.env.CRON_OIDC_AUDIENCE,
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    x402FacilitatorUrl: process.env.X402_FACILITATOR_URL,
    arkovaUsdcAddress: process.env.ARKOVA_USDC_ADDRESS,
    x402Network: process.env.X402_NETWORK,
    edgarUserAgent: process.env.EDGAR_USER_AGENT,
    trainingDataOutputPath: process.env.TRAINING_DATA_OUTPUT_PATH,
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.EMAIL_FROM,
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
  testnet4: 'Test Environment',
  mainnet: 'Production Network',
} as const;

export function getNetworkDisplayName(network: 'signet' | 'testnet' | 'testnet4' | 'mainnet'): string {
  return NETWORK_DISPLAY_NAMES[network];
}
