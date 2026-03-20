/**
 * Unit tests for worker configuration
 *
 * HARDENING-5: Zod validation, defaults, error handling, network display names.
 * Updated for Bitcoin Signet config fields (CRIT-2 / P7-TS-05).
 *
 * NOTE: config.ts calls loadConfig() at module level, which validates env vars
 * via Zod. We set required env vars BEFORE importing so the singleton loads.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Set required env vars before config.ts module-level execution
const testEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  CHAIN_API_URL: 'https://chain.test',
  CHAIN_API_KEY: 'chain-key',
  NODE_ENV: 'test',
  USE_MOCKS: 'true',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(testEnv)) {
    process.env[key] = value;
  }
});

// Dynamic import after env setup — use top-level so tests can reference
let config: Record<string, unknown>;
let getNetworkDisplayName: (network: 'signet' | 'testnet' | 'mainnet') => string;
let NETWORK_DISPLAY_NAMES: Record<string, string>;

beforeAll(async () => {
  const mod = await import('./config.js');
  config = mod.config;
  getNetworkDisplayName = mod.getNetworkDisplayName;
  NETWORK_DISPLAY_NAMES = mod.NETWORK_DISPLAY_NAMES;
});

describe('NETWORK_DISPLAY_NAMES', () => {
  it('maps signet to Constitution-compliant name', () => {
    expect(NETWORK_DISPLAY_NAMES.signet).toBe('Test Environment');
  });

  it('maps testnet to Constitution-compliant name', () => {
    expect(NETWORK_DISPLAY_NAMES.testnet).toBe('Test Environment');
  });

  it('maps mainnet to Constitution-compliant name', () => {
    expect(NETWORK_DISPLAY_NAMES.mainnet).toBe('Production Network');
  });

  it('has exactly four entries', () => {
    expect(Object.keys(NETWORK_DISPLAY_NAMES)).toHaveLength(4);
  });
});

describe('getNetworkDisplayName', () => {
  it('returns "Test Environment" for signet', () => {
    expect(getNetworkDisplayName('signet')).toBe('Test Environment');
  });

  it('returns "Test Environment" for testnet', () => {
    expect(getNetworkDisplayName('testnet')).toBe('Test Environment');
  });

  it('returns "Production Network" for mainnet', () => {
    expect(getNetworkDisplayName('mainnet')).toBe('Production Network');
  });
});

describe('loadConfig validation', () => {
  it('throws on invalid configuration', async () => {
    // Save original env vars
    const saved = { ...process.env };

    // Remove required vars
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    // vi.resetModules forces a fresh import, re-running loadConfig()
    vi.resetModules();

    // Suppress console.error during this test
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./config.js')).rejects.toThrow('Invalid worker configuration');

    consoleError.mockRestore();

    // Restore env and reset modules so other tests still work
    Object.assign(process.env, saved);
    vi.resetModules();
  });
});

describe('config singleton', () => {
  it('exports a config object with expected shape', () => {
    expect(config).toBeDefined();
    expect(typeof config.port).toBe('number');
    expect(['development', 'test', 'production']).toContain(config.nodeEnv);
    expect(['debug', 'info', 'warn', 'error']).toContain(config.logLevel);
    expect(typeof config.supabaseUrl).toBe('string');
    expect(typeof config.supabaseServiceKey).toBe('string');
    expect(typeof config.stripeSecretKey).toBe('string');
    expect(typeof config.stripeWebhookSecret).toBe('string');
    expect(['signet', 'testnet', 'testnet4', 'mainnet']).toContain(config.bitcoinNetwork);
    expect(typeof config.useMocks).toBe('boolean');
    expect(typeof config.enableProdNetworkAnchoring).toBe('boolean');
  });

  it('uses default port when WORKER_PORT not set', () => {
    expect(config.port).toBe(3001);
  });

  it('reads env vars correctly', () => {
    expect(config.supabaseUrl).toBe('https://test.supabase.co');
    expect(config.nodeEnv).toBe('test');
    expect(config.useMocks).toBe(true);
  });

  it('defaults enableProdNetworkAnchoring to false', () => {
    expect(config.enableProdNetworkAnchoring).toBe(false);
  });

  it('defaults bitcoinNetwork to signet', () => {
    expect(config.bitcoinNetwork).toBe('signet');
  });

  it('bitcoin config fields are optional when useMocks is true', () => {
    // These should be undefined since we didn't set them
    expect(config.bitcoinTreasuryWif).toBeUndefined();
    expect(config.bitcoinRpcUrl).toBeUndefined();
  });
});
