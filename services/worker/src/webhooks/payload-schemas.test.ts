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
  AnchorBatchSecuredPayloadSchema,
  CredentialIssuedPayloadSchema,
  CredentialVerifiedPayloadSchema,
  CredentialStatusChangedPayloadSchema,
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

// =============================================================================
// SCRUM-1743: credential lifecycle event schemas (contract layer).
// Emit-point wiring is split into Phase-2 follow-up tickets — these tests lock
// the payload contract so future emit code can't accidentally leak banned
// fields. Same allowlist rules as anchor.* events: public_id-only, no internal
// UUIDs, no fingerprint.
// =============================================================================

describe('CredentialIssuedPayloadSchema (SCRUM-1743)', () => {
  const valid = {
    public_id: 'cred_abc123',
    org_public_id: 'pub_org_xyz',
    credential_type: 'DEGREE',
    status: 'ISSUED' as const,
    issued_at: '2026-05-08T00:00:00Z',
  };

  it('accepts a payload with only public-allowed fields', () => {
    expect(CredentialIssuedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an optional expires_at', () => {
    const result = CredentialIssuedPayloadSchema.safeParse({ ...valid, expires_at: '2027-05-08T00:00:00Z' });
    expect(result.success).toBe(true);
  });

  it('accepts a null org_public_id (org-less issuance)', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, org_public_id: null }).success).toBe(true);
  });

  it('rejects a payload that includes anchor_id UUID (CLAUDE.md §6)', () => {
    const result = CredentialIssuedPayloadSchema.safeParse({ ...valid, anchor_id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that includes raw fingerprint (CLAUDE.md §1.6)', () => {
    const result = CredentialIssuedPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) });
    expect(result.success).toBe(false);
  });

  it('rejects user_id and org_id leaks', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, user_id: 'u' }).success).toBe(false);
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, org_id: 'o' }).success).toBe(false);
  });

  it('rejects status other than ISSUED', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, status: 'SECURED' }).success).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, issued_at: '2026-05-08 00:00:00' }).success).toBe(false);
  });
});

describe('CredentialVerifiedPayloadSchema (SCRUM-1743)', () => {
  const valid = {
    public_id: 'cred_abc123',
    credential_type: 'LICENSE',
    status: 'SECURED' as const,
    verified_at: '2026-05-08T00:00:00Z',
  };

  it('accepts a payload with only public-allowed fields', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts each verified status (SECURED/PENDING/REVOKED/EXPIRED)', () => {
    for (const status of ['SECURED', 'PENDING', 'REVOKED', 'EXPIRED'] as const) {
      expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, status }).success).toBe(true);
    }
  });

  it('accepts an optional verifier_country (ISO 3166-1 alpha-2)', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: 'US' }).success).toBe(true);
  });

  it('rejects a verifier_country longer than 2 chars (no IPs, no full country names)', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: 'USA' }).success).toBe(false);
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: '192.168.1.1' }).success).toBe(false);
  });

  it('rejects banned fields (anchor_id, fingerprint, user_id, org_id, verifier_ip)', () => {
    for (const banned of ['anchor_id', 'fingerprint', 'user_id', 'org_id', 'verifier_ip'] as const) {
      const result = CredentialVerifiedPayloadSchema.safeParse({ ...valid, [banned]: 'leak' });
      expect(result.success).toBe(false);
    }
  });

  it('rejects an unknown status value', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, status: 'CANCELLED' }).success).toBe(false);
  });
});

describe('CredentialStatusChangedPayloadSchema (SCRUM-1743)', () => {
  const valid = {
    public_id: 'cred_abc123',
    credential_type: 'CERTIFICATE',
    previous_status: 'SECURED' as const,
    new_status: 'REVOKED' as const,
    changed_at: '2026-05-08T00:00:00Z',
  };

  it('accepts a payload with only public-allowed fields', () => {
    expect(CredentialStatusChangedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an optional reason capped at 500 chars', () => {
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, reason: 'Issuer revocation' }).success).toBe(true);
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, reason: 'a'.repeat(500) }).success).toBe(true);
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, reason: 'a'.repeat(501) }).success).toBe(false);
  });

  it('rejects banned fields (anchor_id, fingerprint, user_id, org_id)', () => {
    for (const banned of ['anchor_id', 'fingerprint', 'user_id', 'org_id'] as const) {
      const result = CredentialStatusChangedPayloadSchema.safeParse({ ...valid, [banned]: 'leak' });
      expect(result.success).toBe(false);
    }
  });

  it('rejects unknown status values in either previous or new', () => {
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, previous_status: 'NOPE' }).success).toBe(false);
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, new_status: 'NOPE' }).success).toBe(false);
  });

  it('rejects non-ISO changed_at', () => {
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, changed_at: 'yesterday' }).success).toBe(false);
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

  // SCRUM-1743: credential.* events flow through the same dispatcher and must
  // be subject to the same allowlist enforcement.
  it('SCRUM-1743: credential.issued passes validation when payload is clean', () => {
    const result = validateWebhookPayload('credential.issued', {
      public_id: 'cred_abc123',
      credential_type: 'DEGREE',
      status: 'ISSUED',
      issued_at: '2026-05-08T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });

  it('SCRUM-1743: credential.verified rejects banned fields end-to-end', () => {
    const result = validateWebhookPayload('credential.verified', {
      public_id: 'cred_abc123',
      credential_type: 'LICENSE',
      status: 'SECURED',
      verified_at: '2026-05-08T00:00:00Z',
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
      expect(result.error.eventType).toBe('credential.verified');
    }
  });

  it('SCRUM-1743: credential.status_changed accepts a clean payload with reason', () => {
    const result = validateWebhookPayload('credential.status_changed', {
      public_id: 'cred_abc123',
      credential_type: 'CERTIFICATE',
      previous_status: 'SECURED',
      new_status: 'REVOKED',
      changed_at: '2026-05-08T00:00:00Z',
      reason: 'Issuer revocation',
    });
    expect(result.ok).toBe(true);
  });
});
