/**
 * URL builder tests (SCRUM-637)
 *
 * Centralized URL helpers dedupe the `${config.frontendUrl}/...` template
 * literal sprinkled across 20+ production call sites (billing, attestations,
 * verify, GRC adapters, recipients, pipeline-health, etc.).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import {
  buildVerifyUrl,
  buildAttestationVerifyUrl,
  buildRecordUrl,
  buildActivateUrl,
  buildBillingSuccessUrl,
  buildBillingCancelUrl,
  buildBillingPortalReturnUrl,
  buildPipelineDashboardUrl,
} from './urls.js';

describe('URL builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildVerifyUrl', () => {
    it('builds a verify URL from a public_id', () => {
      expect(buildVerifyUrl('pub_abc123')).toBe('https://app.arkova.ai/verify/pub_abc123');
    });

    it('tolerates empty public_id (matches existing anchor-submit.ts behaviour)', () => {
      expect(buildVerifyUrl('')).toBe('https://app.arkova.ai/verify/');
    });

    it('coerces null/undefined to empty string', () => {
      expect(buildVerifyUrl(null)).toBe('https://app.arkova.ai/verify/');
      expect(buildVerifyUrl(undefined)).toBe('https://app.arkova.ai/verify/');
    });
  });

  describe('buildAttestationVerifyUrl', () => {
    it('builds an attestation verify URL', () => {
      expect(buildAttestationVerifyUrl('att_xyz')).toBe(
        'https://app.arkova.ai/verify/attestation/att_xyz'
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
        'https://app.arkova.ai/activate?token=a%20b%2Bc%2Fd'
      );
    });
  });

  describe('buildBillingSuccessUrl', () => {
    it('includes the Stripe session_id placeholder', () => {
      expect(buildBillingSuccessUrl()).toBe(
        'https://app.arkova.ai/billing/success?session_id={CHECKOUT_SESSION_ID}'
      );
    });
  });

  describe('buildBillingCancelUrl', () => {
    it('builds the billing cancel URL', () => {
      expect(buildBillingCancelUrl()).toBe('https://app.arkova.ai/billing/cancel');
    });
  });

  describe('buildBillingPortalReturnUrl', () => {
    it('points at /settings', () => {
      expect(buildBillingPortalReturnUrl()).toBe('https://app.arkova.ai/settings');
    });
  });

  describe('buildPipelineDashboardUrl', () => {
    it('points at /admin/pipeline', () => {
      expect(buildPipelineDashboardUrl()).toBe('https://app.arkova.ai/admin/pipeline');
    });
  });
});
