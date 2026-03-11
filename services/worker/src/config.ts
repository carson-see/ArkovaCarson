/**
 * Worker Configuration
 *
 * Environment-based configuration for the anchoring worker service.
 * All secrets are loaded from environment variables.
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

  // Chain API
  chainApiUrl: z.string().url(),
  chainApiKey: z.string().min(1),
  chainNetwork: z.enum(['testnet', 'mainnet']).default('testnet'),

  // Frontend
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Feature flags
  useMocks: z.coerce.boolean().default(false),
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
    chainApiUrl: process.env.CHAIN_API_URL,
    chainApiKey: process.env.CHAIN_API_KEY,
    chainNetwork: process.env.CHAIN_NETWORK,
    frontendUrl: process.env.FRONTEND_URL,
    useMocks: process.env.USE_MOCKS,
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
 * Network display names per Constitution terminology
 */
export const NETWORK_DISPLAY_NAMES = {
  testnet: 'Test Environment',
  mainnet: 'Production Network',
} as const;

export function getNetworkDisplayName(network: 'testnet' | 'mainnet'): string {
  return NETWORK_DISPLAY_NAMES[network];
}
