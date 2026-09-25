/**
 * E2E_ADMIN_RATELIMIT_BYPASS safety contract.
 *
 * The bypass skips the 10 req/min `checkout` limiter for `adminRouter` only.
 * CLAUDE.md §1.1 records that the in-code limiters are the ONLY real limits —
 * there is no Cloudflare rate limiting on arkova.ai — so the property worth
 * testing is not that the bypass works, but that it CANNOT work in
 * production. The load-bearing tests here are the negative ones.
 *
 * config.ts validates env at module load, so required vars are set before the
 * dynamic import (same idiom as config.test.ts).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

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
  for (const [key, value] of Object.entries(testEnv)) process.env[key] = value;
});

type MutableConfig = { e2eAdminRateLimitBypass: unknown; nodeEnv: string };

/**
 * The helper reads the live `config` singleton, so these tests mutate its
 * fields rather than re-importing a mocked module. That keeps the test honest
 * about the real config shape: if `e2eAdminRateLimitBypass` were renamed or
 * dropped, this would fail rather than pass against a stale mock.
 */
async function withConfig(patch: Partial<MutableConfig>) {
  const mod = await import('./config.js');
  const cfg = mod.config as unknown as MutableConfig;
  const saved = { e2eAdminRateLimitBypass: cfg.e2eAdminRateLimitBypass, nodeEnv: cfg.nodeEnv };
  Object.assign(cfg, patch);
  return { active: mod.adminRateLimitBypassActive, restore: () => Object.assign(cfg, saved) };
}

let restoreLast: (() => void) | undefined;
afterEach(() => {
  restoreLast?.();
  restoreLast = undefined;
});

describe('adminRateLimitBypassActive — fails closed', () => {
  it('is OFF by default, so an unset variable never disables the limiter', async () => {
    const { active, restore } = await withConfig({});
    restoreLast = restore;
    expect(active()).toBe(false);
  });

  it('is OFF in production EVEN WHEN the flag is set — a leaked env var is inert', async () => {
    const { active, restore } = await withConfig({
      e2eAdminRateLimitBypass: true,
      nodeEnv: 'production',
    });
    restoreLast = restore;
    // The load-bearing assertion. If this flips, a misconfigured deploy
    // silently removes rate limiting from every admin route, with nothing
    // downstream to catch it.
    expect(active()).toBe(false);
  });

  it('is OFF in production when the flag is unset (both halves false)', async () => {
    const { active, restore } = await withConfig({
      e2eAdminRateLimitBypass: false,
      nodeEnv: 'production',
    });
    restoreLast = restore;
    expect(active()).toBe(false);
  });

  it('is ON only outside production with the flag explicitly set', async () => {
    for (const env of ['test', 'development']) {
      const { active, restore } = await withConfig({
        e2eAdminRateLimitBypass: true,
        nodeEnv: env,
      });
      expect(active(), `expected bypass active in ${env}`).toBe(true);
      restore();
    }
  });

  it('requires the flag to be exactly true — a truthy string does not enable it', async () => {
    const { active, restore } = await withConfig({
      e2eAdminRateLimitBypass: 'true',
      nodeEnv: 'test',
    });
    restoreLast = restore;
    expect(active()).toBe(false);
  });
});

describe('the E2E path keeps a real limiter, not an absent one', () => {
  it('uses a raised-ceiling limiter so X-RateLimit-* headers are still emitted', async () => {
    // Regression guard for a fix that did not fix: skipping the limiter sets
    // NO rate-limit headers, and e2e/connectors.spec.ts's headroom probe
    // throws "malformed rate-limit headers" when x-ratelimit-remaining is
    // absent. So the E2E path must be a HIGHER CEILING, never a bypass.
    const src = await readFile(
      new URL('./routes/admin.ts', import.meta.url),
      'utf8',
    );
    // The E2E branch must hand off to a limiter, not call next() directly.
    expect(src).toMatch(/adminRateLimitBypassActive\(\)\)\s*\{\s*adminE2eCeilingLimiter\(req, res, next\);/);
    expect(src).not.toMatch(/adminRateLimitBypassActive\(\)\)\s*\{\s*next\(\);/);
    // And that limiter's ceiling must exceed what the suite needs (>= 16),
    // with a wide margin for four specs sharing one ::1 bucket.
    const max = Number(/scope: 'checkout-e2e'[\s\S]*?/.test(src)
      ? (src.match(/maxRequests:\s*(\d+),\s*\n\s*scope: 'checkout-e2e'/) ?? [])[1]
      : NaN);
    expect(max).toBeGreaterThanOrEqual(100);
  });
});
