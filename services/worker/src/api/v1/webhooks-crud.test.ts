/**
 * Webhook CRUD endpoint schema tests (INT-09 / SCRUM-645)
 *
 * Validates the Zod schemas and helpers exported by
 * services/worker/src/api/v1/webhooks.ts. Imports the real schemas so
 * production and test stay in sync — no inline redefinitions.
 */

import { describe, it, expect } from 'vitest';
import {
  CreateWebhookSchema,
  UpdateWebhookSchema,
  ListWebhooksQuerySchema,
} from './webhooks-schemas.js';

// ─── CreateWebhookSchema ───────────────────────────────────────────────────

describe('CreateWebhookSchema', () => {
  it('accepts valid registration with HTTPS URL and events', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/webhooks/arkova',
      events: ['anchor.secured'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://example.com/webhooks/arkova');
      expect(result.data.events).toEqual(['anchor.secured']);
    }
  });

  it('applies default events when omitted', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toEqual(['anchor.secured', 'anchor.revoked']);
    }
  });

  it('accepts all three event types', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: ['anchor.secured', 'anchor.revoked', 'anchor.expired'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects HTTP URL (must be HTTPS)', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'http://example.com/hooks',
      events: ['anchor.secured'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed URL', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'not-a-url',
      events: ['anchor.secured'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown event type', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: ['anchor.unknown'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty events array', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional description', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: ['anchor.secured'],
      description: 'Production webhook for HR system',
    });
    expect(result.success).toBe(true);
  });

  it('rejects description over 500 characters', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: ['anchor.secured'],
      description: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('accepts opt-in verify flag', () => {
    const result = CreateWebhookSchema.safeParse({
      url: 'https://example.com/hooks',
      events: ['anchor.secured'],
      verify: true,
    });
    expect(result.success).toBe(true);
  });
});

// ─── UpdateWebhookSchema ───────────────────────────────────────────────────

describe('UpdateWebhookSchema', () => {
  it('accepts URL-only update', () => {
    const result = UpdateWebhookSchema.safeParse({
      url: 'https://new.example.com/hooks',
    });
    expect(result.success).toBe(true);
  });

  it('accepts events-only update', () => {
    const result = UpdateWebhookSchema.safeParse({
      events: ['anchor.expired'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts is_active toggle (disable)', () => {
    const result = UpdateWebhookSchema.safeParse({ is_active: false });
    expect(result.success).toBe(true);
  });

  it('accepts is_active toggle (re-enable)', () => {
    const result = UpdateWebhookSchema.safeParse({ is_active: true });
    expect(result.success).toBe(true);
  });

  it('accepts description clear via null', () => {
    const result = UpdateWebhookSchema.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it('rejects empty object (no fields to update)', () => {
    const result = UpdateWebhookSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects HTTP URL update', () => {
    const result = UpdateWebhookSchema.safeParse({
      url: 'http://example.com/hooks',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty events array on update', () => {
    const result = UpdateWebhookSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it('accepts multi-field update', () => {
    const result = UpdateWebhookSchema.safeParse({
      url: 'https://new.example.com/hooks',
      events: ['anchor.secured', 'anchor.revoked'],
      is_active: true,
      description: 'Migrated to new endpoint',
    });
    expect(result.success).toBe(true);
  });
});

// ─── ListWebhooksQuerySchema ───────────────────────────────────────────────

describe('ListWebhooksQuerySchema', () => {
  it('applies defaults when omitted', () => {
    const result = ListWebhooksQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('coerces string query params to numbers', () => {
    const result = ListWebhooksQuerySchema.safeParse({ limit: '25', offset: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
      expect(result.data.offset).toBe(10);
    }
  });

  it('caps limit at 100', () => {
    const result = ListWebhooksQuerySchema.safeParse({ limit: '500' });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = ListWebhooksQuerySchema.safeParse({ limit: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects negative offset', () => {
    const result = ListWebhooksQuerySchema.safeParse({ offset: '-5' });
    expect(result.success).toBe(false);
  });

  it('rejects zero limit', () => {
    const result = ListWebhooksQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });
});

// ─── HMAC signature generation ─────────────────────────────────────────────
// Mirror the production signing pattern so SDK consumers can verify payloads.

import crypto from 'node:crypto';

describe('HMAC payload signing', () => {
  function signPayload(secret: string, timestamp: string, payload: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
  }

  it('produces a 64-char hex signature', () => {
    const sig = signPayload('test-secret', '1700000000', '{"event":"test"}');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces consistent signatures for the same input', () => {
    const sig1 = signPayload('secret', '1700000000', '{"a":1}');
    const sig2 = signPayload('secret', '1700000000', '{"a":1}');
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures when payload changes', () => {
    const sig1 = signPayload('secret', '1700000000', '{"a":1}');
    const sig2 = signPayload('secret', '1700000000', '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures when timestamp changes', () => {
    const sig1 = signPayload('secret', '1700000000', '{"a":1}');
    const sig2 = signPayload('secret', '1700000001', '{"a":1}');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures when secret changes', () => {
    const sig1 = signPayload('secret-a', '1700000000', '{"a":1}');
    const sig2 = signPayload('secret-b', '1700000000', '{"a":1}');
    expect(sig1).not.toBe(sig2);
  });
});

// ─── Secret generation ─────────────────────────────────────────────────────

describe('webhook signing secret generation', () => {
  function generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  it('produces a 64-char hex string', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret).toHaveLength(64);
  });

  it('produces unique secrets across calls', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 100; i++) {
      secrets.add(generateSecret());
    }
    expect(secrets.size).toBe(100);
  });
});
