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

  // SCRUM-2249 (HARDEN-1-F): identifier scrubbing
  it('scrubs UUIDs in event.transaction (org_id leaks into transaction name)', () => {
    const event = {
      transaction: '/admin/organizations/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.transaction).toBe('/admin/organizations/[UUID]');
    expect(scrubbed?.transaction).not.toContain('3f8a9c2e');
  });

  it('does not over-scrub a normal route name in event.transaction', () => {
    const event = { transaction: '/dashboard/anchors' };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.transaction).toBe('/dashboard/anchors');
  });

  it('scrubs UUIDs in event.request.url', () => {
    const event = {
      request: {
        url: 'https://app.arkova.io/admin/organizations/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70/members',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.url).toBe('https://app.arkova.io/admin/organizations/[UUID]/members');
  });

  it('scrubs Supabase project-ref in auth-lock messages', () => {
    const event = {
      message:
        'GoTrue Navigator lock contention against https://ujtlwnoqfhtitcmsnrpq.supabase.co/auth/v1/token',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('https://[SUPABASE_PROJECT].supabase.co');
    expect(scrubbed?.message).not.toContain('ujtlwnoqfhtitcmsnrpq');
  });

  it('scrubs UUIDs in event tags', () => {
    const event = {
      message: 'Test',
      tags: { org: '3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70' },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.tags?.org).toBe('[UUID]');
  });
});

describe('initSentry CSP safety', () => {
  it('does not include replayIntegration (ARKOVA-FRONTEND-9: rrweb eval violates CSP)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sentrySource = fs.readFileSync(
      path.resolve(__dirname, './sentry.ts'),
      'utf-8',
    );
    // Guard: replayIntegration must not appear as an active call
    const activeReplayCalls = sentrySource
      .split('\n')
      .filter((line: string) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .filter((line: string) => /replayIntegration\s*\(/.test(line));

    expect(activeReplayCalls).toHaveLength(0);
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

  it('scrubs UUIDs from URLs in fetch breadcrumbs (SCRUM-2249)', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://app.arkova.io/admin/organizations/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.url).toBe('https://app.arkova.io/admin/organizations/[UUID]');
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
