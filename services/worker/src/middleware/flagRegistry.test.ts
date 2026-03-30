/**
 * Tests for FeatureFlagRegistry (ARCH-5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules before importing
vi.mock('../config.js', () => ({
  config: {
    useMocks: true,
    enableProdNetworkAnchoring: false,
  },
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: [
            { id: 'ENABLE_VERIFICATION_API', value: true },
            { id: 'ENABLE_AI_EXTRACTION', value: false },
            { id: 'ENABLE_SEMANTIC_SEARCH', value: true },
            { id: 'ENABLE_AI_FRAUD', value: false },
            { id: 'ENABLE_AI_REPORTS', value: false },
          ],
          error: null,
        }),
      }),
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { flagRegistry } from './flagRegistry.js';

describe('FeatureFlagRegistry', () => {
  beforeEach(() => {
    flagRegistry._reset();
  });

  it('loads env and DB flags on init', async () => {
    await flagRegistry.init();

    // Env flags
    expect(flagRegistry.getFlag('USE_MOCKS')).toBe(true);
    expect(flagRegistry.getFlag('ENABLE_PROD_NETWORK_ANCHORING')).toBe(false);

    // DB flags
    expect(flagRegistry.getFlag('ENABLE_VERIFICATION_API')).toBe(true);
    expect(flagRegistry.getFlag('ENABLE_AI_EXTRACTION')).toBe(false);
    expect(flagRegistry.getFlag('ENABLE_SEMANTIC_SEARCH')).toBe(true);
  });

  it('returns false for unknown flags', async () => {
    await flagRegistry.init();
    // Unknown flag should return false (fail-closed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(flagRegistry.getFlag('UNKNOWN_FLAG' as any)).toBe(false);
  });

  it('getAllFlags returns snapshot', async () => {
    await flagRegistry.init();
    const flags = flagRegistry.getAllFlags();

    expect(flags).toHaveProperty('USE_MOCKS');
    expect(flags).toHaveProperty('ENABLE_VERIFICATION_API');
    expect(flags.USE_MOCKS.source).toBe('env');
    expect(flags.ENABLE_VERIFICATION_API.source).toBe('db');
  });
});
