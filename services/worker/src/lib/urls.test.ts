/**
 * URL builder tests (SCRUM-637)
 *
 * Centralized URL helpers dedupe the `${config.frontendUrl}/...` template
 * literal sprinkled across 20+ production call sites (billing, attestations,
 * verify, GRC adapters, recipients, pipeline-health, etc.).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import {
  buildVerifyUrl,
  buildAttestationVerifyUrl,
  buildSignatureVerifyUrl,
  buildRecordUrl,
  buildActivateUrl,
  BILLING_SUCCESS_URL,
  BILLING_CANCEL_URL,
  BILLING_PORTAL_RETURN_URL,
  PIPELINE_DASHBOARD_URL,
} from './urls.js';

describe('URL builders', () => {
  describe('buildVerifyUrl', () => {
    it('builds a verify URL from a public_id', () => {
      expect(buildVerifyUrl('pub_abc123')).toBe('https://app.arkova.ai/verify/pub_abc123');
    });

    it('builds a verify URL from an ARK-prefixed public_id', () => {
      expect(buildVerifyUrl('ARK-SEC-A7X9K2')).toBe('https://app.arkova.ai/verify/ARK-SEC-A7X9K2');
    });
  });

  describe('buildAttestationVerifyUrl', () => {
    it('builds an attestation verify URL', () => {
      expect(buildAttestationVerifyUrl('att_xyz')).toBe(
        'https://app.arkova.ai/verify/attestation/att_xyz',
      );
    });
  });

  describe('buildSignatureVerifyUrl', () => {
    it('builds a signature verify URL', () => {
      expect(buildSignatureVerifyUrl('sig_abc')).toBe(
        'https://app.arkova.ai/verify/signature/sig_abc',
      );
    });
  });

  describe('buildRecordUrl', () => {
    it('builds a record URL from an internal anchor id', () => {
      expect(buildRecordUrl('uuid-123')).toBe('https://app.arkova.ai/records/uuid-123');
    });
  });

  describe('buildActivateUrl', () => {
    it('embeds the activation token as a query param', () => {
      expect(buildActivateUrl('token123')).toBe('https://app.arkova.ai/activate?token=token123');
    });

    it('URL-encodes tokens with special characters', () => {
      expect(buildActivateUrl('a b+c/d')).toBe(
        'https://app.arkova.ai/activate?token=a%20b%2Bc%2Fd',
      );
    });
  });

  describe('billing + pipeline constants', () => {
    it('BILLING_SUCCESS_URL includes the Stripe session_id placeholder', () => {
      expect(BILLING_SUCCESS_URL).toBe(
        'https://app.arkova.ai/billing/success?session_id={CHECKOUT_SESSION_ID}',
      );
    });

    it('BILLING_CANCEL_URL points at /billing/cancel', () => {
      expect(BILLING_CANCEL_URL).toBe('https://app.arkova.ai/billing/cancel');
    });

    it('BILLING_PORTAL_RETURN_URL points at /settings', () => {
      expect(BILLING_PORTAL_RETURN_URL).toBe('https://app.arkova.ai/settings');
    });

    it('PIPELINE_DASHBOARD_URL points at /admin/pipeline', () => {
      expect(PIPELINE_DASHBOARD_URL).toBe('https://app.arkova.ai/admin/pipeline');
    });
  });
});

// Separate module-load test: verifies the stripTrailingSlashes path handles
// URLs with one or many trailing slashes. Uses vi.resetModules + doMock so we
// can re-import urls.ts with a different config mock than the outer describe.
describe('URL builders — base URL normalization', () => {
  it.each([
    ['https://app.arkova.ai/', 'https://app.arkova.ai/verify/x'],
    ['https://app.arkova.ai///', 'https://app.arkova.ai/verify/x'],
    ['https://app.arkova.ai', 'https://app.arkova.ai/verify/x'],
  ])('strips trailing slashes from frontendUrl=%s', async (frontendUrl, expected) => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({ config: { frontendUrl } }));
    const { buildVerifyUrl } = await import('./urls.js');
    expect(buildVerifyUrl('x')).toBe(expected);
    vi.doUnmock('../config.js');
  });
});
