/**
 * Verification tests for Sentry PII scrubbing compliance.
 *
 * These tests simulate real-world error scenarios and verify that
 * no PII reaches the Sentry event payload. They serve as the
 * "trigger a dummy error to verify PII is scrubbed" acceptance test.
 */

import { describe, it, expect } from 'vitest';
import { scrubPiiFromEvent } from './sentry.js';

describe('Sentry PII Verification — Simulated Error Scenarios', () => {
  it('VERIFY: anchor processing error with user email is scrubbed', () => {
    // Simulates: processPendingAnchors throws with user context
    const event = {
      exception: {
        values: [
          {
            type: 'AnchorProcessingError',
            value: 'Failed to process anchor for user admin_demo@arkova.local — insufficient credits',
          },
        ],
      },
      extra: {
        user_id: '550e8400-e29b-41d4-a716-446655440000',
        org_id: 'b2c3d4e5-f6a7-4901-8345-678901234567',
        fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
      request: {
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
          'content-type': 'application/json',
        },
        data: '{"file_fingerprint_sha256":"abc","recipient_email":"student@university.edu"}',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);

    // Email scrubbed from exception message
    expect(scrubbed?.exception?.values?.[0]?.value).not.toContain('@arkova.local');
    expect(scrubbed?.exception?.values?.[0]?.value).toContain('[EMAIL]');

    // Sensitive extras scrubbed
    expect(scrubbed?.extra?.user_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.org_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.fingerprint).toBe('[FILTERED]');

    // Auth header scrubbed
    expect(scrubbed?.request?.headers?.authorization).toBe('[FILTERED]');
    expect(scrubbed?.request?.headers?.['content-type']).toBe('application/json');

    // Request body scrubbed (may contain document data)
    expect(scrubbed?.request?.data).toBe('[FILTERED]');
  });

  it('VERIFY: Stripe webhook error does not leak customer email', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'StripeWebhookError',
            value: 'checkout.session.completed failed for customer@example.com — no matching user',
          },
        ],
      },
      extra: {
        email: 'customer@example.com',
        api_key: 'sk_live_abc123xyz',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);

    expect(scrubbed?.exception?.values?.[0]?.value).not.toContain('customer@example.com');
    expect(scrubbed?.extra?.email).toBe('[FILTERED]');
    expect(scrubbed?.extra?.api_key).toBe('[FILTERED]');
  });

  it('VERIFY: SSN in error context is scrubbed', () => {
    const event = {
      message: 'Validation failed: field contains SSN pattern 123-45-6789',
      extra: {
        action: 'validate_metadata',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);

    expect(scrubbed?.message).not.toContain('123-45-6789');
    expect(scrubbed?.message).toContain('[SSN]');
    // Non-sensitive extras preserved
    expect(scrubbed?.extra?.action).toBe('validate_metadata');
  });

  it('VERIFY: document fingerprint hash is scrubbed from messages', () => {
    const event = {
      message: 'Duplicate anchor detected for fingerprint a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    const scrubbed = scrubPiiFromEvent(event);

    expect(scrubbed?.message).toContain('[FINGERPRINT]');
    expect(scrubbed?.message).not.toMatch(/[a-f0-9]{64}/);
  });

  it('VERIFY: API key patterns are scrubbed', () => {
    const event = {
      message: 'Rate limit exceeded for key ak_live_xyzzy123abc456 on /api/v1/verify',
    };

    const scrubbed = scrubPiiFromEvent(event);

    expect(scrubbed?.message).not.toContain('ak_live_xyzzy123abc456');
    expect(scrubbed?.message).toContain('[API_KEY]');
  });
});
