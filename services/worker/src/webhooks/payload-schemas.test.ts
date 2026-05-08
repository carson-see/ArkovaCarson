/**
 * Tests for outbound webhook payload schemas (SCRUM-1268 R2-5).
 *
 * Locks the contract for `anchor.submitted` / `anchor.secured` / `anchor.revoked` /
 * `anchor.batch_secured` payloads:
 *   - public-only fields (`public_id`, `chain_tx_id`, etc.) accepted
 *   - banned fields (`anchor_id`, `fingerprint`, `user_id`, `org_id`) rejected
 *   - timestamp fields require ISO 8601 format
 *
 * If a future change drops `anchor_id` validation or adds it back to the
 * payload, these tests fail at PR time. CLAUDE.md §6 (no internal UUIDs)
 * + §1.6 (fingerprint client-side only) enforced via these schemas.
 */

import { describe, it, expect } from 'vitest';
import {
  AnchorSubmittedPayloadSchema,
  AnchorSecuredPayloadSchema,
  AnchorRevokedPayloadSchema,
  AnchorExpiredPayloadSchema,
  AnchorBatchSecuredPayloadSchema,
  validateWebhookPayload,
  WebhookPayloadValidationError,
} from './payload-schemas.js';

describe('AnchorSecuredPayloadSchema (SCRUM-1268)', () => {
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    chain_timestamp: '2026-04-26T00:00:00Z',
    secured_at: '2026-04-26T00:00:01Z',
    status: 'SECURED' as const,
  };

  it('accepts a payload with only public-allowed fields', () => {
    const result = AnchorSecuredPayloadSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a payload that includes the internal anchor_id UUID (CLAUDE.md §6)', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({
      ...valid,
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that includes the raw fingerprint (CLAUDE.md §1.6)', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({
      ...valid,
      fingerprint: 'a'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that includes user_id', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({
      ...valid,
      user_id: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that includes the internal org_id UUID', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({
      ...valid,
      org_id: '550e8400-e29b-41d4-a716-446655440002',
    });
    expect(result.success).toBe(false);
  });

  it('accepts org_public_id when provided', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, org_public_id: 'pub_org_xyz' });
    expect(result.success).toBe(true);
  });

  it('rejects non-ISO timestamps', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, secured_at: '2026-04-26 00:00:01' });
    expect(result.success).toBe(false);
  });

  it('rejects status other than SECURED', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, status: 'SUBMITTED' });
    expect(result.success).toBe(false);
  });

  // PR #567 CodeRabbit P1 fix: SECURED ⇒ on-chain invariant. The base fields
  // allow null chain_tx_id / chain_block_height for `anchor.submitted` (no tx
  // yet), but SECURED is the post-confirmation state and must have both.
  it('PR #567 fix: rejects null chain_tx_id on SECURED status (on-chain invariant)', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, chain_tx_id: null });
    expect(result.success).toBe(false);
  });

  it('PR #567 fix: rejects null chain_block_height on SECURED status', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, chain_block_height: null });
    expect(result.success).toBe(false);
  });

  it('PR #567 fix: rejects empty chain_tx_id on SECURED status', () => {
    const result = AnchorSecuredPayloadSchema.safeParse({ ...valid, chain_tx_id: '' });
    expect(result.success).toBe(false);
  });
});

describe('AnchorSubmittedPayloadSchema', () => {
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: null,
    submitted_at: '2026-04-26T00:00:00Z',
    status: 'SUBMITTED' as const,
  };

  it('accepts a SUBMITTED payload with null chain_block_height', () => {
    const result = AnchorSubmittedPayloadSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a SUBMITTED payload that includes anchor_id', () => {
    const result = AnchorSubmittedPayloadSchema.safeParse({ ...valid, anchor_id: 'uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects a SUBMITTED payload that includes fingerprint', () => {
    const result = AnchorSubmittedPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) });
    expect(result.success).toBe(false);
  });
});

describe('AnchorRevokedPayloadSchema', () => {
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    revoked_at: '2026-04-26T00:00:00Z',
    status: 'REVOKED' as const,
  };

  it('accepts a REVOKED payload with optional revocation_reason', () => {
    expect(AnchorRevokedPayloadSchema.safeParse(valid).success).toBe(true);
    expect(AnchorRevokedPayloadSchema.safeParse({ ...valid, revocation_reason: 'expired' }).success).toBe(true);
  });

  it('rejects a REVOKED payload with internal fields', () => {
    expect(AnchorRevokedPayloadSchema.safeParse({ ...valid, anchor_id: 'uuid' }).success).toBe(false);
    expect(AnchorRevokedPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) }).success).toBe(false);
  });
});

describe('AnchorExpiredPayloadSchema', () => {
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    expired_at: '2026-04-26T00:00:00Z',
    status: 'EXPIRED' as const,
  };

  it('accepts an EXPIRED payload with only public-allowed fields', () => {
    expect(AnchorExpiredPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an EXPIRED payload with optional expiry_reason', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, expiry_reason: 'expires_at_passed' }).success).toBe(true);
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, expiry_reason: null }).success).toBe(true);
  });

  it('rejects an EXPIRED payload that includes anchor_id (CLAUDE.md §6)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, anchor_id: 'uuid' }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes the raw fingerprint (CLAUDE.md §1.6)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes user_id', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, user_id: '550e8400-e29b-41d4-a716-446655440001' }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes org_id', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, org_id: '550e8400-e29b-41d4-a716-446655440002' }).success).toBe(false);
  });

  it('rejects non-ISO expired_at timestamps', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, expired_at: '2026-04-26 00:00:00' }).success).toBe(false);
  });

  it('rejects status other than EXPIRED', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, status: 'REVOKED' }).success).toBe(false);
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, status: 'SECURED' }).success).toBe(false);
  });
});

describe('AnchorBatchSecuredPayloadSchema', () => {
  const valid = {
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    chain_timestamp: '2026-04-26T00:00:00Z',
    secured_at: '2026-04-26T00:00:01Z',
    anchor_count: 3,
    public_ids: ['abc123', 'def456', 'ghi789'],
  };

  it('accepts a batch payload with public_ids array', () => {
    expect(AnchorBatchSecuredPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a batch payload that includes any anchor_id UUIDs in the array name', () => {
    const result = AnchorBatchSecuredPayloadSchema.safeParse({ ...valid, anchor_ids: ['uuid'] });
    expect(result.success).toBe(false);
  });

  it('rejects a batch payload that exceeds the 20K cap', () => {
    const tooMany = Array.from({ length: 20_001 }, (_, i) => `id-${i}`);
    const result = AnchorBatchSecuredPayloadSchema.safeParse({ ...valid, public_ids: tooMany });
    expect(result.success).toBe(false);
  });
});

describe('validateWebhookPayload helper', () => {
  it('returns ok:true for a clean anchor.secured payload', () => {
    const result = validateWebhookPayload('anchor.secured', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      chain_timestamp: '2026-04-26T00:00:00Z',
      secured_at: '2026-04-26T00:00:01Z',
      status: 'SECURED',
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with WebhookPayloadValidationError when anchor_id leaks into anchor.secured', () => {
    const result = validateWebhookPayload('anchor.secured', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      chain_timestamp: '2026-04-26T00:00:00Z',
      secured_at: '2026-04-26T00:00:01Z',
      status: 'SECURED',
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
      expect(result.error.eventType).toBe('anchor.secured');
    }
  });

  it('returns ok:true for a clean anchor.expired payload (closes pre-fix bypass gap)', () => {
    const result = validateWebhookPayload('anchor.expired', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      expired_at: '2026-04-26T00:00:00Z',
      status: 'EXPIRED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });

  it('returns ok:false when anchor_id leaks into anchor.expired (regression: pre-fix this silently bypassed validation)', () => {
    const result = validateWebhookPayload('anchor.expired', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      expired_at: '2026-04-26T00:00:00Z',
      status: 'EXPIRED',
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
      expect(result.error.eventType).toBe('anchor.expired');
    }
  });

  it('passes through unknown event types without validation', () => {
    const result = validateWebhookPayload('payment.subscription_updated', {
      anything: 'goes',
      stripe_subscription_id: 'sub_test',
    });
    expect(result.ok).toBe(true);
  });

  // PR #567 CodeRabbit minor fix
  it('PR #567 fix: flags unknown event types via `bypassed: true` so callers can debug-log the gap', () => {
    const result = validateWebhookPayload('anchor.SUBMITTED', { public_id: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBe(true);
  });

  it('PR #567 fix: known event types return ok WITHOUT a bypassed flag (still validated)', () => {
    const result = validateWebhookPayload('anchor.secured', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      chain_timestamp: '2026-04-26T00:00:00Z',
      secured_at: '2026-04-26T00:00:01Z',
      status: 'SECURED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });
});
