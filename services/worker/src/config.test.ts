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

  it('rejects production without FRONTEND_URL (SCRUM-534)', async () => {
    const saved = { ...process.env };

    process.env.NODE_ENV = 'production';
    // gitleaks:allow — test fixture, satisfies min-length validator only
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.API_KEY_HMAC_SECRET = 'test-hmac-secret';
    delete process.env.FRONTEND_URL;

    vi.resetModules();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./config.js')).rejects.toThrow('Invalid worker configuration');

    consoleError.mockRestore();

    Object.assign(process.env, saved);
    vi.resetModules();
  });

  it('accepts production when FRONTEND_URL is set (SCRUM-534)', async () => {
    const saved = { ...process.env };

    process.env.NODE_ENV = 'production';
    // gitleaks:allow — test fixture, satisfies min-length validator only
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.API_KEY_HMAC_SECRET = 'test-hmac-secret';
    process.env.FRONTEND_URL = 'https://app.arkova.ai';

    vi.resetModules();

    const mod = await import('./config.js');
    expect(mod.config.frontendUrl).toBe('https://app.arkova.ai');

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

/**
 * Shared test helpers — Sonar-flagged 62%+ duplication on the SCRUM-1257 +
 * SCRUM-1258 blocks (each test repeated the same save/assign/reset/restore
 * boilerplate 14-18 lines). Centralised here so each test focuses on the
 * env-override that's actually under test. /simplify carry-over (PR #565).
 */

// gitleaks:allow — test fixtures, satisfy min-length validators only
const PROD_BASE_ENV = {
  CRON_SECRET: 'test-cron-secret-1234',
  API_KEY_HMAC_SECRET: 'test-hmac-secret',
  FRONTEND_URL: 'https://app.arkova.ai',
} as const;

const PROD_MAINNET_ENV = {
  ...PROD_BASE_ENV,
  NODE_ENV: 'production',
  BITCOIN_NETWORK: 'mainnet',
  ENABLE_PROD_NETWORK_ANCHORING: 'true',
} as const;

// R1-4 vars that leak forward via Object.assign(saved) restore. Each test
// helper explicitly clears these at the top to guarantee hermetic isolation.
const LEAKY_ENV_KEYS = [
  'ENABLE_DRIVE_OAUTH',
  'ENABLE_DRIVE_WEBHOOK',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'INTEGRATION_STATE_HMAC_SECRET',
  'ENABLE_DOCUSIGN_OAUTH',
  'ENABLE_DOCUSIGN_WEBHOOK',
  'DOCUSIGN_INTEGRATION_KEY',
  'DOCUSIGN_CLIENT_SECRET',
  'DOCUSIGN_CONNECT_HMAC_SECRET',
  'ENABLE_ATS_WEBHOOK',
  'ADOBE_SIGN_CLIENT_SECRET',
  'CHECKR_WEBHOOK_SECRET',
  'VEREMARK_WEBHOOK_SECRET',
  'ENABLE_VEREMARK_WEBHOOK',
  'MIDDESK_API_KEY',
  'MIDDESK_WEBHOOK_SECRET',
  'BUILD_SHA',
  'BITCOIN_TREASURY_WIF',
  'GCP_KMS_KEY_RESOURCE_NAME',
  'KMS_PROVIDER',
];

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { ...process.env };
  const restoreKeys = new Set([...LEAKY_ENV_KEYS, ...Object.keys(overrides)]);
  for (const k of LEAKY_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, testEnv);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of restoreKeys) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    vi.resetModules();
  }
}

async function expectConfigToReject(overrides: Record<string, string | undefined>): Promise<void> {
  await withEnv(overrides, async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('./config.js')).rejects.toThrow('Invalid worker configuration');
    consoleError.mockRestore();
  });
}

async function withConfig<T>(
  overrides: Record<string, string | undefined>,
  assertions: (mod: typeof import('./config.js')) => Promise<T> | T,
): Promise<T> {
  return withEnv(overrides, async () => {
    const mod = await import('./config.js');
    return assertions(mod);
  });
}

/**
 * SCRUM-1257 (R1-3) — kmsProvider default 'aws' → 'gcp' + fail-loud production guard.
 *
 * Why: forensic 2/8 found that an accidental `--remove-env-vars=KMS_PROVIDER` on
 * Cloud Run would (a) select the AWS branch via the silent default, (b) fail KMS
 * init because no AWS account exists, (c) fall through to MockChainClient — anchors
 * would silently "succeed" in mock mode. We do not have AWS in production
 * (memory/feedback_no_aws.md). This guard makes that misconfiguration fail at boot.
 */
describe('SCRUM-1257 kmsProvider default + fail-loud guard', () => {
  it('defaults kmsProvider to "gcp" when KMS_PROVIDER unset', async () => {
    await withConfig({ KMS_PROVIDER: undefined }, (mod) => {
      expect(mod.config.kmsProvider).toBe('gcp');
    });
  });

  it('rejects production mainnet anchoring when KMS_PROVIDER is unset', async () => {
    await expectConfigToReject({
      ...PROD_MAINNET_ENV,
      KMS_PROVIDER: undefined,
      BITCOIN_TREASURY_WIF: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
    });
  });

  it('rejects production mainnet anchoring when neither WIF nor GCP KMS key is set', async () => {
    await expectConfigToReject({
      ...PROD_MAINNET_ENV,
      KMS_PROVIDER: 'gcp',
      BITCOIN_TREASURY_WIF: undefined,
      GCP_KMS_KEY_RESOURCE_NAME: undefined,
    });
  });

  it('accepts production mainnet anchoring with KMS_PROVIDER=gcp + WIF', async () => {
    await withConfig(
      {
        ...PROD_MAINNET_ENV,
        KMS_PROVIDER: 'gcp',
        BITCOIN_TREASURY_WIF: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
      },
      (mod) => {
        expect(mod.config.kmsProvider).toBe('gcp');
        expect(mod.config.bitcoinNetwork).toBe('mainnet');
      },
    );
  });

  it('accepts production mainnet anchoring with KMS_PROVIDER=gcp + GCP_KMS_KEY_RESOURCE_NAME', async () => {
    await withConfig(
      {
        ...PROD_MAINNET_ENV,
        KMS_PROVIDER: 'gcp',
        GCP_KMS_KEY_RESOURCE_NAME:
          'projects/arkova1/locations/us-central1/keyRings/anchoring/cryptoKeys/treasury',
        BITCOIN_TREASURY_WIF: undefined,
      },
      (mod) => {
        expect(mod.config.kmsProvider).toBe('gcp');
        expect(mod.config.gcpKmsKeyResourceName).toContain('keyRings/anchoring');
      },
    );
  });

  it('does not require KMS config when ENABLE_PROD_NETWORK_ANCHORING is false', async () => {
    await withConfig(
      {
        ...PROD_BASE_ENV,
        NODE_ENV: 'production',
        BITCOIN_NETWORK: 'mainnet',
        ENABLE_PROD_NETWORK_ANCHORING: 'false',
        KMS_PROVIDER: undefined,
        BITCOIN_TREASURY_WIF: undefined,
        GCP_KMS_KEY_RESOURCE_NAME: undefined,
      },
      (mod) => {
        expect(mod.config.enableProdNetworkAnchoring).toBe(false);
        expect(mod.config.kmsProvider).toBe('gcp');
      },
    );
  });

  it('does not require KMS config when bitcoinNetwork is signet (test environment)', async () => {
    await withConfig(
      {
        ...PROD_BASE_ENV,
        NODE_ENV: 'production',
        BITCOIN_NETWORK: 'signet',
        ENABLE_PROD_NETWORK_ANCHORING: 'true',
        KMS_PROVIDER: undefined,
        BITCOIN_TREASURY_WIF: undefined,
        GCP_KMS_KEY_RESOURCE_NAME: undefined,
      },
      (mod) => {
        expect(mod.config.bitcoinNetwork).toBe('signet');
      },
    );
  });
});

/**
 * SCRUM-1258 (R1-4) — vendor connector cross-field guards.
 *
 * Why: a typo in any of these vendor-secret pairs would silently disable a
 * connector. Route-level "503 vendor_gated" handles the request-time safety;
 * these guards catch the misconfiguration at boot.
 */
describe('SCRUM-1258 vendor connector cross-field guards', () => {
  // Production env that satisfies the unrelated guards (cron, hmac, frontend,
  // kms — covered by other tests). signet avoids the R1-3 mainnet-anchoring path.
  const PROD_SIGNET = {
    ...PROD_BASE_ENV,
    NODE_ENV: 'production',
    BITCOIN_NETWORK: 'signet',
    ENABLE_PROD_NETWORK_ANCHORING: 'false',
  } as const;

  it('rejects production with ENABLE_DRIVE_OAUTH=true and missing GOOGLE_OAUTH_CLIENT_ID', async () => {
    await expectConfigToReject({
      ...PROD_SIGNET,
      ENABLE_DRIVE_OAUTH: 'true',
      INTEGRATION_STATE_HMAC_SECRET: 'test-hmac',
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    });
  });

  it('rejects production with ENABLE_DRIVE_OAUTH=true and missing INTEGRATION_STATE_HMAC_SECRET', async () => {
    await expectConfigToReject({
      ...PROD_SIGNET,
      ENABLE_DRIVE_OAUTH: 'true',
      GOOGLE_OAUTH_CLIENT_ID: 'fake-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
      INTEGRATION_STATE_HMAC_SECRET: undefined,
    });
  });

  it('rejects when DOCUSIGN_INTEGRATION_KEY is set but DOCUSIGN_CLIENT_SECRET is missing', async () => {
    await expectConfigToReject({
      DOCUSIGN_INTEGRATION_KEY: 'fake-integration-key',
      DOCUSIGN_CLIENT_SECRET: undefined,
    });
  });

  it('rejects production with ENABLE_DOCUSIGN_OAUTH=true and missing DocuSign OAuth secrets', async () => {
    await expectConfigToReject({
      ...PROD_SIGNET,
      ENABLE_DOCUSIGN_OAUTH: 'true',
      DOCUSIGN_INTEGRATION_KEY: undefined,
      DOCUSIGN_CLIENT_SECRET: undefined,
    });
  });

  it('rejects production with ENABLE_DOCUSIGN_WEBHOOK=true and missing DOCUSIGN_CONNECT_HMAC_SECRET', async () => {
    await expectConfigToReject({
      ...PROD_SIGNET,
      ENABLE_DOCUSIGN_WEBHOOK: 'true',
      DOCUSIGN_CONNECT_HMAC_SECRET: undefined,
    });
  });

  it('rejects when ENABLE_VEREMARK_WEBHOOK=true but VEREMARK_WEBHOOK_SECRET is missing', async () => {
    await expectConfigToReject({
      ENABLE_VEREMARK_WEBHOOK: 'true',
      VEREMARK_WEBHOOK_SECRET: undefined,
    });
  });

  it('accepts production when Drive OAuth is fully configured', async () => {
    await withConfig(
      {
        ...PROD_SIGNET,
        ENABLE_DRIVE_OAUTH: 'true',
        GOOGLE_OAUTH_CLIENT_ID: 'fake-client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
        INTEGRATION_STATE_HMAC_SECRET: 'fake-hmac',
      },
      (mod) => {
        expect(mod.config.enableDriveOauth).toBe(true);
        expect(mod.config.googleOauthClientId).toBe('fake-client-id');
        expect(mod.config.integrationStateHmacSecret).toBe('fake-hmac');
      },
    );
  });

  it('rejects invalid BUILD_SHA (must be 40-char hex or "unknown")', async () => {
    await expectConfigToReject({ BUILD_SHA: 'not-a-sha' });
  });

  it('accepts BUILD_SHA="unknown" (Cloud Run pre-R0 image marker)', async () => {
    await withConfig({ BUILD_SHA: 'unknown' }, (mod) => {
      expect(mod.config.buildSha).toBe('unknown');
    });
  });

  it('accepts BUILD_SHA as 40-char hex (post-R0 deploy)', async () => {
    const sha = 'adc654d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8';
    await withConfig({ BUILD_SHA: sha }, (mod) => {
      expect(mod.config.buildSha).toBe(sha);
    });
  });
});

// SCRUM-1258 (R1-4) batch 2 — feature flags, ARIZE, treasury alerts.
describe('SCRUM-1258 batch 2 — feature flags + observability + treasury', () => {
  it('absorbs every ENABLE_* feature flag with sane defaults', async () => {
    await withConfig({}, (mod) => {
      const c = mod.config as Record<string, unknown>;
      expect(c.enableAiFallback).toBe(false);
      expect(c.enableVerificationApi).toBe(true);
      expect(c.enableVertexAi).toBe(false);
      expect(c.enableRulesEngine).toBe(true);
      expect(c.enableQueueReminders).toBe(true);
      expect(c.enableTreasuryAlerts).toBe(true);
      expect(c.enableWebhookHmac).toBe(true);
      expect(c.enableRuleActionDispatcher).toBe(true);
      expect(c.enableAllocationRollover).toBe(false);
      expect(c.enableVisualFraudDetection).toBe(false);
      expect(c.enableGrcIntegrations).toBe(false);
      expect(c.enableDriveWebhook).toBe(false);
      expect(c.enableDocusignOauth).toBe(false);
      expect(c.enableDocusignWebhook).toBe(false);
      expect(c.enableAtsWebhook).toBe(false);
      expect(c.enableAdesSignatures).toBe(false);
      expect(c.enableDemoInjector).toBe(false);
      expect(c.enableSyntheticData).toBe(false);
      expect(c.enableNessieRagRecommendations).toBe(false);
      expect(c.enableMultimodalEmbeddings).toBe(false);
      expect(c.enableCloudLoggingSink).toBe(false);
      expect(c.enableWorkspaceRenewal).toBe(false);
    });
  });

  it('coerces ENABLE_* env strings to booleans', async () => {
    await withConfig(
      {
        ENABLE_VISUAL_FRAUD_DETECTION: 'true',
        ENABLE_DEMO_INJECTOR: 'false',
        ENABLE_GRC_INTEGRATIONS: 'true',
        ENABLE_DRIVE_WEBHOOK: 'true',
        ENABLE_DOCUSIGN_OAUTH: 'true',
        ENABLE_DOCUSIGN_WEBHOOK: 'false',
        ENABLE_ATS_WEBHOOK: 'true',
      },
      (mod) => {
        const c = mod.config as Record<string, unknown>;
        expect(c.enableVisualFraudDetection).toBe(true);
        expect(c.enableDemoInjector).toBe(false);
        expect(c.enableGrcIntegrations).toBe(true);
        expect(c.enableDriveWebhook).toBe(true);
        expect(c.enableDocusignOauth).toBe(true);
        expect(c.enableDocusignWebhook).toBe(false);
        expect(c.enableAtsWebhook).toBe(true);
      },
    );
  });

  it('absorbs ARIZE_* observability vars', async () => {
    await withConfig(
      {
        ARIZE_TRACING_ENABLED: 'true',
        ARIZE_API_KEY: 'arize-key',
        ARIZE_SPACE_ID: 'space-id',
        ARIZE_OTLP_ENDPOINT: 'https://otlp.arize.com/v1',
        ARIZE_PROJECT_NAME: 'arkova-ai-providers',
      },
      (mod) => {
        const c = mod.config as Record<string, unknown>;
        expect(c.arizeTracingEnabled).toBe(true);
        expect(c.arizeApiKey).toBe('arize-key');
        expect(c.arizeSpaceId).toBe('space-id');
        expect(c.arizeOtlpEndpoint).toBe('https://otlp.arize.com/v1');
        expect(c.arizeProjectName).toBe('arkova-ai-providers');
      },
    );
  });

  it('rejects ARIZE_TRACING_ENABLED=true without ARIZE_API_KEY + ARIZE_SPACE_ID', async () => {
    await expectConfigToReject({
      ARIZE_TRACING_ENABLED: 'true',
      ARIZE_API_KEY: undefined,
      ARIZE_SPACE_ID: undefined,
    });
  });

  it('absorbs TREASURY_LOW_BALANCE_USD with default 50', async () => {
    await withConfig({}, (mod) => {
      const c = mod.config as Record<string, unknown>;
      expect(c.treasuryLowBalanceUsd).toBe(50);
    });
    await withConfig({ TREASURY_LOW_BALANCE_USD: '125.5' }, (mod) => {
      const c = mod.config as Record<string, unknown>;
      expect(c.treasuryLowBalanceUsd).toBe(125.5);
    });
  });

  it('rejects production prod-network anchoring with treasury alerts on but no channel', async () => {
    await expectConfigToReject({
      ...PROD_BASE_ENV,
      NODE_ENV: 'production',
      BITCOIN_NETWORK: 'mainnet',
      ENABLE_PROD_NETWORK_ANCHORING: 'true',
      KMS_PROVIDER: 'gcp',
      BITCOIN_TREASURY_WIF: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
      ENABLE_TREASURY_ALERTS: 'true',
      SLACK_TREASURY_WEBHOOK_URL: undefined,
      TREASURY_ALERT_EMAIL: undefined,
    });
  });

  it('rejects production with ENABLE_DEMO_INJECTOR=true (audit-data contamination guard)', async () => {
    await expectConfigToReject({
      ...PROD_BASE_ENV,
      NODE_ENV: 'production',
      ENABLE_DEMO_INJECTOR: 'true',
    });
  });

  it('rejects production with ENABLE_SYNTHETIC_DATA=true', async () => {
    await expectConfigToReject({
      ...PROD_BASE_ENV,
      NODE_ENV: 'production',
      ENABLE_SYNTHETIC_DATA: 'true',
    });
  });
});
