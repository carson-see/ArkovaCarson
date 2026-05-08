/**
 * Unit tests for the SCRUM-1740 sandbox provisioning script.
 * Pure-function tests around HMAC computation + arg parsing.
 */
import { describe, it, expect } from 'vitest';
import { hmacApiKey, parseCliArgs, loadConfig } from './provision-sandbox-org.js';

describe('SCRUM-1740 — sandbox provisioning script', () => {
  describe('hmacApiKey', () => {
    it('produces a 64-char hex digest (SHA-256)', () => {
      const out = hmacApiKey('ak_test_xyz', 'secret');
      expect(out).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input + secret', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret');
      const b = hmacApiKey('ak_test_xyz', 'secret');
      expect(a).toBe(b);
    });

    it('changes the digest when the raw key changes (no collision)', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret');
      const b = hmacApiKey('ak_test_xyZ', 'secret');
      expect(a).not.toBe(b);
    });

    it('changes the digest when the secret rotates', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret-1');
      const b = hmacApiKey('ak_test_xyz', 'secret-2');
      expect(a).not.toBe(b);
    });
  });

  /**
   * CodeRabbit PR #738 review: cover parseCliArgs (Zod-validated CLI
   * surface) and loadConfig (fail-closed staging guard).
   */
  describe('parseCliArgs (Zod validation)', () => {
    const ok = ['node', 'script', '--partner=hakichain', '--anchors=10', '--credits=5'];
    // SonarCloud duplication: lift the repeated `argv` builder into a
    // helper so the per-case test bodies don't repeat the
    // `[...ok.slice(0, 2), '--partner=p', '--anchors=X', '--credits=Y']`
    // shape verbatim.
    const argv = (overrides: Record<string, string>): string[] => {
      const merged = { partner: 'p', anchors: '10', credits: '5', ...overrides };
      return [
        'node',
        'script',
        `--partner=${merged.partner}`,
        `--anchors=${merged.anchors}`,
        `--credits=${merged.credits}`,
      ];
    };

    it('accepts a valid invocation', () => {
      expect(parseCliArgs(ok)).toEqual({ partner: 'hakichain', anchors: 10, credits: 5 });
    });

    it('coerces numeric strings to integers', () => {
      const r = parseCliArgs(argv({}));
      expect(typeof r.anchors).toBe('number');
      expect(typeof r.credits).toBe('number');
    });

    it('rejects partner slugs with whitespace, uppercase, or HTML metacharacters', () => {
      expect(() => parseCliArgs(argv({ partner: 'Haki Chain' }))).toThrow();
      expect(() => parseCliArgs(argv({ partner: 'HakiChain' }))).toThrow();
      expect(() => parseCliArgs(argv({ partner: '<script>' }))).toThrow();
    });

    it('rejects non-numeric anchors / credits (no truncation of "10foo")', () => {
      expect(() => parseCliArgs(argv({ anchors: '10foo' }))).toThrow();
      expect(() => parseCliArgs(argv({ credits: 'NaN' }))).toThrow();
    });

    it('rejects negative or zero anchors', () => {
      expect(() => parseCliArgs(argv({ anchors: '0' }))).toThrow();
      expect(() => parseCliArgs(argv({ anchors: '-1' }))).toThrow();
    });

    it('accepts credits=0', () => {
      const r = parseCliArgs(argv({ credits: '0' }));
      expect(r.credits).toBe(0);
    });

    it('accepts a valid owner-email and rejects malformed', () => {
      expect(parseCliArgs([...ok, '--owner-email=ops@hakichain.com']).ownerEmail).toBe('ops@hakichain.com');
      expect(() => parseCliArgs([...ok, '--owner-email=not-an-email'])).toThrow();
    });
  });

  describe('loadConfig (CRITICAL: fail-closed staging guard)', () => {
    it('returns staging config when both STAGING_* vars are set', () => {
      const cfg = loadConfig({
        STAGING_SUPABASE_URL: 'https://staging.example.com',
        STAGING_SUPABASE_SERVICE_ROLE_KEY: 'srk',
        API_KEY_HMAC_SECRET: 'hmac',
      });
      expect(cfg.url).toBe('https://staging.example.com');
      expect(cfg.serviceRoleKey).toBe('srk');
    });

    it('throws when staging vars are missing AND ALLOW_PROD_PROVISIONING is not set', () => {
      expect(() => loadConfig({
        SUPABASE_URL: 'https://prod.example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'srk-prod',
        API_KEY_HMAC_SECRET: 'hmac',
      })).toThrow(/STAGING_SUPABASE_URL.*required/i);
    });

    it('throws when ALLOW_PROD_PROVISIONING=false (any non-"true" value)', () => {
      expect(() => loadConfig({
        SUPABASE_URL: 'https://prod.example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'srk-prod',
        API_KEY_HMAC_SECRET: 'hmac',
        ALLOW_PROD_PROVISIONING: 'false',
      })).toThrow(/STAGING_SUPABASE_URL.*required/i);
    });

    it('returns prod config when ALLOW_PROD_PROVISIONING is exactly "true"', () => {
      const cfg = loadConfig({
        SUPABASE_URL: 'https://prod.example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'srk-prod',
        API_KEY_HMAC_SECRET: 'hmac',
        ALLOW_PROD_PROVISIONING: 'true',
      });
      expect(cfg.url).toBe('https://prod.example.com');
    });

    it('throws when API_KEY_HMAC_SECRET is missing regardless of other vars', () => {
      expect(() => loadConfig({
        STAGING_SUPABASE_URL: 'https://staging.example.com',
        STAGING_SUPABASE_SERVICE_ROLE_KEY: 'srk',
      })).toThrow(/API_KEY_HMAC_SECRET/);
    });

    it('does NOT silently fall through to non-staging when partial staging vars are set', () => {
      // Only STAGING_SUPABASE_URL set without the key — must NOT use staging URL with prod key
      expect(() => loadConfig({
        STAGING_SUPABASE_URL: 'https://staging.example.com',
        SUPABASE_URL: 'https://prod.example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'srk-prod',
        API_KEY_HMAC_SECRET: 'hmac',
      })).toThrow(/STAGING_SUPABASE_URL.*required/i);
    });
  });
});
