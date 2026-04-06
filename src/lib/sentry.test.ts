/**
 * Tests for frontend Sentry PII scrubbing.
 *
 * Constitution 1.4: No user emails, document fingerprints, or API keys in Sentry.
 * Constitution 1.6: Documents never leave the user's device.
 */

import { describe, it, expect } from 'vitest';
import { scrubPiiFromEvent, scrubPiiFromBreadcrumb } from './sentry';

describe('Frontend scrubPiiFromEvent', () => {
  it('strips email addresses from exception messages', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Failed to load profile for user@example.com',
          },
        ],
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.exception?.values?.[0]?.value).not.toContain('user@example.com');
    expect(scrubbed?.exception?.values?.[0]?.value).toContain('[EMAIL]');
  });

  it('strips SHA-256 fingerprints from messages', () => {
    const event = {
      message: 'Duplicate fingerprint: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('[FINGERPRINT]');
  });

  it('strips SSN patterns', () => {
    const event = {
      message: 'Validation error: SSN 999-88-7777 is invalid',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('[SSN]');
    expect(scrubbed?.message).not.toContain('999-88-7777');
  });

  it('strips authorization headers', () => {
    const event = {
      request: {
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9...',
        },
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.headers?.authorization).toBe('[FILTERED]');
  });

  it('strips request body to prevent document data leakage', () => {
    const event = {
      request: {
        data: '{"document_bytes":"base64encodedPDF..."}',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.data).toBe('[FILTERED]');
  });

  it('strips user context email', () => {
    const event = {
      user: {
        id: '123',
        email: 'user@example.com',
        username: 'testuser',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.user?.email).toBeUndefined();
    expect(scrubbed?.user?.id).toBe('123');
  });

  it('strips phone numbers from strings (PII-08)', () => {
    const event = {
      message: 'User phone: +44 20 7946 0958 and (555) 123-4567',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('7946 0958');
    expect(scrubbed?.message).not.toContain('123-4567');
    expect(scrubbed?.message).toContain('[PHONE]');
  });

  it('strips IPv4 addresses from strings (PII-08)', () => {
    const event = {
      message: 'Request from 10.0.0.55 blocked',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('10.0.0.55');
    expect(scrubbed?.message).toContain('[IP_ADDR]');
  });

  it('scrubs PII from event tags (PII-09)', () => {
    const event = {
      message: 'Test',
      tags: {
        environment: 'production',
        contact: 'user@example.com',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.tags?.environment).toBe('production');
    expect(scrubbed?.tags?.contact).toContain('[EMAIL]');
  });

  it('returns null for null events', () => {
    expect(scrubPiiFromEvent(null)).toBeNull();
  });
});

describe('Frontend scrubPiiFromBreadcrumb', () => {
  it('strips tokens from URLs in fetch breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://example.supabase.co/auth?access_token=secret123',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.url).not.toContain('secret123');
  });

  it('removes body from fetch breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://api.example.com/anchors',
        body: '{"fingerprint":"sha256hash"}',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.body).toBeUndefined();
  });
});
