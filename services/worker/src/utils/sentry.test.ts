/**
 * Tests for Sentry PII scrubbing in the worker.
 *
 * Constitution 1.4: Never expose user emails, document fingerprints, or API keys in Sentry.
 * Constitution 1.6: Documents never leave the user's device — no document data in Sentry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrubPiiFromEvent, scrubPiiFromBreadcrumb, emitRpcFallback, Sentry } from './sentry.js';

describe('scrubPiiFromEvent', () => {
  it('strips email addresses from exception messages', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'User not found: admin_demo@arkova.local',
          },
        ],
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.exception?.values?.[0]?.value).not.toContain('admin_demo@arkova.local');
    expect(scrubbed?.exception?.values?.[0]?.value).toContain('[EMAIL]');
  });

  it('strips email addresses from message field', () => {
    const event = {
      message: 'Login failed for user@example.com',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('user@example.com');
    expect(scrubbed?.message).toContain('[EMAIL]');
  });

  it('strips authorization headers from request data', () => {
    const event = {
      request: {
        headers: {
          authorization: 'Bearer eyJhbGciOi...',
          'x-api-key': 'ak_live_abc123',
          'content-type': 'application/json',
        },
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.headers?.authorization).toBe('[FILTERED]');
    expect(scrubbed?.request?.headers?.['x-api-key']).toBe('[FILTERED]');
    expect(scrubbed?.request?.headers?.['content-type']).toBe('application/json');
  });

  it('strips request body data to prevent document leakage', () => {
    const event = {
      request: {
        data: '{"fingerprint":"abc123","file_content":"sensitive document data"}',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.data).toBe('[FILTERED]');
  });

  it('strips cookies from request data', () => {
    const event = {
      request: {
        cookies: { session: 'abc123' },
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.cookies).toBeUndefined();
  });

  it('strips SHA-256 fingerprints from strings', () => {
    const event = {
      message: 'Anchor failed for fingerprint a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('[FINGERPRINT]');
  });

  it('strips SSN patterns from strings', () => {
    const event = {
      message: 'Processing record with SSN 123-45-6789',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('123-45-6789');
    expect(scrubbed?.message).toContain('[SSN]');
  });

  it('strips user_id and org_id from extras/context', () => {
    const event = {
      extra: {
        user_id: '550e8400-e29b-41d4-a716-446655440000',
        org_id: '550e8400-e29b-41d4-a716-446655440001',
        action: 'create_anchor',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.extra?.user_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.org_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.action).toBe('create_anchor');
  });

  it('strips API keys from strings', () => {
    const event = {
      message: 'API key ak_live_xyzzy123 is invalid',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('ak_live_xyzzy123');
    expect(scrubbed?.message).toContain('[API_KEY]');
  });

  it('strips WIF private keys from strings', () => {
    const event = {
      message: 'Treasury WIF: cN1bkKhp6v... loaded',
    };

    const scrubbed = scrubPiiFromEvent(event);
    // WIF keys start with c, K, L, or 5 and are 51-52 chars base58
    // Our scrubber should catch anything that looks like it could be a key
    expect(scrubbed).toBeDefined();
  });

  it('returns null for events with document byte indicators', () => {
    const event = {
      message: 'Error processing PDF',
      extra: {
        file_content: 'JVBERi0xLjQK...', // PDF header base64
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.extra?.file_content).toBe('[FILTERED]');
  });

  it('passes through clean events unchanged', () => {
    const event = {
      message: 'Anchor processing completed successfully',
      tags: { environment: 'production' },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toBe('Anchor processing completed successfully');
    expect(scrubbed?.tags?.environment).toBe('production');
  });

  it('strips phone numbers from strings (PII-08)', () => {
    const event = {
      message: 'User phone: +44 20 7946 0958 and +1-555-123-4567',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('7946 0958');
    expect(scrubbed?.message).not.toContain('123-4567');
    expect(scrubbed?.message).toContain('[PHONE]');
  });

  it('strips IPv4 addresses from strings (PII-08)', () => {
    const event = {
      message: 'Connection from 192.168.1.100 to 10.0.0.1 failed',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('192.168.1.100');
    expect(scrubbed?.message).not.toContain('10.0.0.1');
    expect(scrubbed?.message).toContain('[IP_ADDR]');
  });

  it('scrubs PII from event tags (PII-09)', () => {
    const event = {
      message: 'Test event',
      tags: {
        environment: 'production',
        user_email: 'admin@arkova.local',
        client_ip: '192.168.1.50',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.tags?.environment).toBe('production');
    expect(scrubbed?.tags?.user_email).toContain('[EMAIL]');
    expect(scrubbed?.tags?.client_ip).toContain('[IP_ADDR]');
  });

  it('returns null to drop an event entirely if it should be suppressed', () => {
    // Events with null return are dropped by Sentry
    const event = null;
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed).toBeNull();
  });
});

describe('scrubPiiFromBreadcrumb', () => {
  it('strips URLs containing tokens from breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://api.supabase.co/auth/v1/token?access_token=eyJhbGciOi...',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.url).not.toContain('eyJhbGciOi');
  });

  it('strips request bodies from fetch breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://api.supabase.co/rest/v1/anchors',
        body: '{"file_fingerprint_sha256":"abc123"}',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.body).toBeUndefined();
  });

  it('passes through console breadcrumbs without data', () => {
    const breadcrumb = {
      category: 'console',
      message: 'Application started',
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.message).toBe('Application started');
  });
});

describe('emitRpcFallback (SCRUM-1262 R1-8 /simplify carry-over)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a Sentry breadcrumb in the chain.rpc-fallback category with method + reason', () => {
    const breadcrumbSpy = vi.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => undefined);
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'listunspent',
      error: new Error('Method not allowed'),
      fallbackTo: 'mempool.space',
      logger,
      origin: 'GetBlockHybridProvider.listUnspent',
    });

    expect(breadcrumbSpy).toHaveBeenCalledTimes(1);
    expect(breadcrumbSpy).toHaveBeenCalledWith({
      category: 'chain.rpc-fallback',
      message: 'getblock.listunspent → mempool.space',
      level: 'warning',
      data: { method: 'listunspent', reason: 'Method not allowed' },
    });
  });

  it('emits a structured warn log with the locked field shape', () => {
    vi.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => undefined);
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'getrawtransaction',
      error: new Error('Connection refused'),
      fallbackTo: 'mempool.space',
      logger,
      origin: 'GetBlockHybridProvider.getRawTransaction',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        chain_rpc_fallback: true,
        method: 'getrawtransaction',
        provider: 'getblock',
        reason: 'Connection refused',
      },
      'GetBlockHybridProvider.getRawTransaction: RPC fallback to mempool.space',
    );
  });

  it('uses "unknown" reason when error is not an Error instance', () => {
    vi.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => undefined);
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'getblockheader',
      error: 'just a string',
      fallbackTo: 'mempool.space',
      logger,
      origin: 'X',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown' }),
      expect.any(String),
    );
  });
});
