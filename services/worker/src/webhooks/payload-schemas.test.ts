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
  AnchorSupersededPayloadSchema,
  AnchorBatchSecuredPayloadSchema,
  CredentialIssuedPayloadSchema,
  CredentialVerifiedPayloadSchema,
  CredentialStatusChangedPayloadSchema,
  ComplianceDocumentExpiringPayloadSchema,
  AttestationCreatedPayloadSchema,
  AttestationRevokedPayloadSchema,
  BANNED_PAYLOAD_KEYS,
  findBannedPayloadKeys,
  isBannedPayloadKey,
  LEGACY_UNREGISTERED_EVENT_TYPES,
  PAYLOAD_SCHEMAS_BY_EVENT_TYPE,
  validateWebhookPayload,
  SUBORG_NOTE_MAX,
  WebhookPayloadValidationError,
} from './payload-schemas.js';
import { BANNED_RESPONSE_KEYS } from '../api/v1/response-schemas.js';

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

describe('AnchorExpiredPayloadSchema (SCRUM-1735)', () => {
  // anchor.expired fires when a SECURED anchor crosses anchors.expires_at (lifecycle
  // transition SECURED → EXPIRED, sourced from anchorExpirySweep cron). Same
  // public-only contract as anchor.revoked; on-chain fields stay populated since
  // the anchor was secured before expiring.
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    expired_at: '2026-04-26T00:00:00Z',
    expires_at: '2026-04-26T00:00:00Z',
    status: 'EXPIRED' as const,
  };

  it('accepts an EXPIRED payload with public-only fields', () => {
    expect(AnchorExpiredPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts org_public_id when provided', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, org_public_id: 'pub_org_xyz' }).success).toBe(true);
  });

  it('rejects an EXPIRED payload that includes the internal anchor_id UUID (CLAUDE.md §6)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, anchor_id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes the raw fingerprint (CLAUDE.md §1.6)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes user_id', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, user_id: '550e8400-e29b-41d4-a716-446655440001' }).success).toBe(false);
  });

  it('rejects an EXPIRED payload that includes the internal org_id UUID', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, org_id: '550e8400-e29b-41d4-a716-446655440002' }).success).toBe(false);
  });

  it('rejects status other than EXPIRED', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, status: 'REVOKED' }).success).toBe(false);
  });

  it('rejects non-ISO expired_at', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, expired_at: '2026-04-26 00:00:00' }).success).toBe(false);
  });

  it('rejects non-ISO expires_at', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, expires_at: 'not-a-date' }).success).toBe(false);
  });

  // Same on-chain invariant as SECURED: an anchor can only expire after being
  // secured on-chain, so chain_tx_id and chain_block_height must be populated.
  it('rejects null chain_tx_id (on-chain invariant — EXPIRED can only follow SECURED)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, chain_tx_id: null }).success).toBe(false);
  });

  it('rejects null chain_block_height (on-chain invariant)', () => {
    expect(AnchorExpiredPayloadSchema.safeParse({ ...valid, chain_block_height: null }).success).toBe(false);
  });
});

describe('AnchorSupersededPayloadSchema (SCRUM-2937)', () => {
  // anchor.superseded fires when a SECURED anchor is atomically replaced by a
  // re-issued child (SECURED → SUPERSEDED, from the supersede_anchor RPC behind
  // POST /api/anchor/:id/supersede). Closes the webhook↔dashboard parity gap:
  // headless partners had no supersession signal while the dashboard shows the
  // full version chain. Public-only contract, on-chain fields populated (can
  // only follow SECURED).
  const valid = {
    public_id: 'abc123',
    chain_tx_id: 'fake-tx-id',
    chain_block_height: 850000,
    superseded_at: '2026-07-22T00:00:00Z',
    status: 'SUPERSEDED' as const,
  };

  it('accepts a SUPERSEDED payload with public-only fields', () => {
    expect(AnchorSupersededPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the optional superseded_by_public_id child slug', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, superseded_by_public_id: 'ARK-2026-CHILD' }).success,
    ).toBe(true);
  });

  it('accepts a null superseded_by_public_id (child slug not yet resolvable)', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, superseded_by_public_id: null }).success,
    ).toBe(true);
  });

  it('accepts an optional supersession_reason', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, supersession_reason: 'corrected transcript' }).success,
    ).toBe(true);
  });

  it('accepts org_public_id when provided', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, org_public_id: 'pub_org_xyz' }).success).toBe(true);
  });

  it('rejects a supersession_reason over 500 chars', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, supersession_reason: 'a'.repeat(501) }).success,
    ).toBe(false);
  });

  it('rejects a SUPERSEDED payload that includes the internal anchor_id UUID (CLAUDE.md §6)', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, anchor_id: '550e8400-e29b-41d4-a716-446655440000' }).success,
    ).toBe(false);
  });

  it('rejects a SUPERSEDED payload that includes the raw fingerprint (CLAUDE.md §1.6)', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) }).success).toBe(false);
  });

  it('rejects a SUPERSEDED payload that includes user_id', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, user_id: '550e8400-e29b-41d4-a716-446655440001' }).success,
    ).toBe(false);
  });

  it('rejects a SUPERSEDED payload that includes the internal org_id UUID', () => {
    expect(
      AnchorSupersededPayloadSchema.safeParse({ ...valid, org_id: '550e8400-e29b-41d4-a716-446655440002' }).success,
    ).toBe(false);
  });

  it('rejects status other than SUPERSEDED', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, status: 'REVOKED' }).success).toBe(false);
  });

  it('rejects non-ISO superseded_at', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, superseded_at: '2026-07-22 00:00:00' }).success).toBe(false);
  });

  // On-chain invariant: SUPERSEDED can only follow SECURED, so the chain fields
  // must be populated (same as EXPIRED).
  it('rejects null chain_tx_id (on-chain invariant — SUPERSEDED can only follow SECURED)', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, chain_tx_id: null }).success).toBe(false);
  });

  it('rejects null chain_block_height (on-chain invariant)', () => {
    expect(AnchorSupersededPayloadSchema.safeParse({ ...valid, chain_block_height: null }).success).toBe(false);
  });
});

describe('validateWebhookPayload helper — anchor.superseded (SCRUM-2937)', () => {
  it('routes anchor.superseded through AnchorSupersededPayloadSchema (NOT bypassed)', () => {
    const result = validateWebhookPayload('anchor.superseded', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      superseded_at: '2026-07-22T00:00:00Z',
      status: 'SUPERSEDED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });

  it('fails validation (does NOT bypass) when anchor.superseded carries a banned anchor_id', () => {
    const result = validateWebhookPayload('anchor.superseded', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      superseded_at: '2026-07-22T00:00:00Z',
      status: 'SUPERSEDED',
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
  });
});

describe('credential.status_changed — SECURED→SUPERSEDED (SCRUM-2937)', () => {
  // Guards the exact payload the supersede producer (api/anchor-lineage.ts)
  // ships. Without SUPERSEDED in the enum this fails validation → the real
  // dispatchWebhookEvent throws → the credential event silently never delivers.
  // This test exercises the REAL schema (not a dispatcher mock) so the enum
  // gap can't regress.
  it('accepts the SECURED→SUPERSEDED transition via the real validator', () => {
    const result = validateWebhookPayload('credential.status_changed', {
      public_id: 'abc123',
      credential_type: 'transcript',
      previous_status: 'SECURED',
      new_status: 'SUPERSEDED',
      changed_at: '2026-07-22T00:00:00Z',
      reason: 'corrected transcript',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });
});

describe('validateWebhookPayload helper — anchor.expired (SCRUM-1735)', () => {
  it('routes anchor.expired through AnchorExpiredPayloadSchema (NOT bypassed)', () => {
    const result = validateWebhookPayload('anchor.expired', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      expired_at: '2026-04-26T00:00:00Z',
      expires_at: '2026-04-26T00:00:00Z',
      status: 'EXPIRED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });

  it('rejects anchor.expired with anchor_id leak via the helper', () => {
    const result = validateWebhookPayload('anchor.expired', {
      public_id: 'abc123',
      chain_tx_id: 'fake-tx-id',
      chain_block_height: 850000,
      expired_at: '2026-04-26T00:00:00Z',
      expires_at: '2026-04-26T00:00:00Z',
      status: 'EXPIRED',
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
      expect(result.error.eventType).toBe('anchor.expired');
    }
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
    recipient_public_id: 'pub_user_def456',
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

  it('accepts a null org_public_id (org-less issuance) and null recipient_public_id (org-level attestations)', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, org_public_id: null }).success).toBe(true);
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, recipient_public_id: null }).success).toBe(true);
  });

  it('rejects a payload that includes anchor_id UUID (CLAUDE.md §6)', () => {
    const result = CredentialIssuedPayloadSchema.safeParse({ ...valid, anchor_id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that includes raw fingerprint (CLAUDE.md §1.6)', () => {
    const result = CredentialIssuedPayloadSchema.safeParse({ ...valid, fingerprint: 'a'.repeat(64) });
    expect(result.success).toBe(false);
  });

  it('rejects user_id, org_id, and recipient_user_id leaks', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, user_id: 'u' }).success).toBe(false);
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, org_id: 'o' }).success).toBe(false);
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, recipient_user_id: 'r' }).success).toBe(false);
  });

  it('rejects status other than ISSUED', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, status: 'SECURED' }).success).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, issued_at: '2026-05-08 00:00:00' }).success).toBe(false);
  });

  // SCRUM-1743 review feedback: boundary tests for credential_type.
  it('rejects empty credential_type', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, credential_type: '' }).success).toBe(false);
  });

  it('rejects credential_type longer than 64 chars', () => {
    expect(CredentialIssuedPayloadSchema.safeParse({ ...valid, credential_type: 'a'.repeat(65) }).success).toBe(false);
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

  // SCRUM-1743 review feedback: terminal-only outcomes. PENDING / SUBMITTED
  // are non-terminal; emitting credential.verified for them is incoherent.
  it('accepts each terminal verified status (SECURED/REVOKED/EXPIRED)', () => {
    for (const status of ['SECURED', 'REVOKED', 'EXPIRED'] as const) {
      expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, status }).success).toBe(true);
    }
  });

  it('rejects non-terminal statuses (PENDING, SUBMITTED) — verification implies a final answer', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, status: 'PENDING' }).success).toBe(false);
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, status: 'SUBMITTED' }).success).toBe(false);
  });

  it('accepts an optional verifier_country (ISO 3166-1 alpha-2)', () => {
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: 'US' }).success).toBe(true);
    expect(CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: 'GB' }).success).toBe(true);
  });

  it('rejects malformed verifier_country (lowercase, digits, length, IP)', () => {
    for (const bad of ['us', 'USA', 'U1', '!!', '', '192.168.1.1']) {
      const result = CredentialVerifiedPayloadSchema.safeParse({ ...valid, verifier_country: bad });
      expect(result.success).toBe(false);
    }
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

  // SCRUM-1743 review feedback: a status_changed event with same previous/new
  // is a no-op and should never be emitted.
  it('rejects when previous_status === new_status (no-op transition)', () => {
    const noop = { ...valid, previous_status: 'SECURED' as const, new_status: 'SECURED' as const };
    const result = CredentialStatusChangedPayloadSchema.safeParse(noop);
    expect(result.success).toBe(false);
  });

  it('accepts a recipient_public_id (re-issuance / inherited status case)', () => {
    expect(CredentialStatusChangedPayloadSchema.safeParse({ ...valid, recipient_public_id: 'pub_user_def' }).success).toBe(true);
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

  // SUPERSEDED by the CTO review of SCRUM-3982 (ruling Z2). This used to assert
  // that an unknown event type passed unvalidated, on the premise that nothing
  // could subscribe to one. That premise is false — `create_webhook_endpoint`
  // and the `webhook_endpoints` RLS write policies both accept arbitrary
  // `events` strings — so the bypass was a live delivery of an unchecked
  // payload. Unknown types now fail closed.
  it('REFUSES an unknown event type rather than passing it through unvalidated', () => {
    const result = validateWebhookPayload('payment.subscription_updated', {
      anything: 'goes',
      stripe_subscription_id: 'sub_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not registered/i);
  });

  // PR #567 CodeRabbit minor fix, hardened by the SCRUM-3982 CTO review (Z2).
  // #567 made a typo'd event type OBSERVABLE (`bypassed: true` + a debug log)
  // because it could not be made fatal at the time. It can now: a caps-typo
  // dispatch is refused outright instead of shipping unvalidated.
  it('refuses a typo of a registered event type (was: bypassed with a debug log)', () => {
    const result = validateWebhookPayload('anchor.SUBMITTED', { public_id: 'x' });
    expect(result.ok).toBe(false);
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

/**
 * BUG-002 (2026-08 soak). `compliance.document_expiring` was EMITTED by
 * `POST /cron/check-credential-expiry` but never REGISTERED here. Two
 * consequences, and the second is the security one:
 *
 *   1. `VALID_WEBHOOK_EVENTS` is derived from `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`,
 *      so no endpoint could subscribe and every dispatch matched zero endpoints.
 *   2. An unregistered event type takes the `bypassed` branch of
 *      `validateWebhookPayload` — no schema, no check. The emit site was
 *      shipping `anchor_id` (the internal UUID, CLAUDE.md §6) in the data block,
 *      one subscription away from being deliverable.
 *
 * Registering the type is what makes (2) impossible, not just what makes the
 * feature work.
 */
describe('ComplianceDocumentExpiringPayloadSchema (BUG-002)', () => {
  const valid = {
    public_id: 'ARK-SEC-VMQ3R8',
    credential_type: 'LICENSE',
    status: 'SECURED' as const,
    expires_at: '2026-08-22T00:00:00Z',
    days_remaining: 7,
    warning_level: '7_day' as const,
    label: 'CPA License',
  };

  it('accepts a clean advance-warning payload', () => {
    expect(ComplianceDocumentExpiringPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects anchor_id — the exact field the unregistered emit site was shipping', () => {
    const leaked = { ...valid, anchor_id: '550e8400-e29b-41d4-a716-446655440000' };
    expect(ComplianceDocumentExpiringPayloadSchema.safeParse(leaked).success).toBe(false);
  });

  it.each(['fingerprint', 'org_id', 'user_id'])('rejects the banned field %s', (field) => {
    expect(
      ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, [field]: 'x' }).success,
    ).toBe(false);
  });

  it('requires status SECURED — an already-expired record is not "expiring"', () => {
    for (const status of ['EXPIRED', 'REVOKED', 'PENDING']) {
      expect(ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, status }).success).toBe(false);
    }
  });

  it('requires days_remaining to be a positive integer', () => {
    for (const days of [0, -1, 3.5]) {
      expect(
        ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, days_remaining: days }).success,
      ).toBe(false);
    }
  });

  it('constrains warning_level to the checker windows', () => {
    for (const level of ['7_day', '30_day', '60_day', '90_day']) {
      expect(
        ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, warning_level: level }).success,
      ).toBe(true);
    }
    expect(
      ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, warning_level: '1_day' }).success,
    ).toBe(false);
  });

  it('requires an ISO 8601 expires_at', () => {
    expect(
      ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, expires_at: '2026-08-22' }).success,
    ).toBe(false);
  });

  it('allows a null credential_type rather than inventing one', () => {
    // `anchors.credential_type` is nullable. The pre-fix emit site substituted
    // 'OTHER', asserting a classification nobody measured (CLAUDE.md §1.5).
    expect(
      ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, credential_type: null }).success,
    ).toBe(true);
    const { credential_type: _omitted, ...withoutType } = valid;
    expect(ComplianceDocumentExpiringPayloadSchema.safeParse(withoutType).success).toBe(true);
  });

  it('allows a null label and caps its length', () => {
    expect(ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, label: null }).success).toBe(true);
    expect(
      ComplianceDocumentExpiringPayloadSchema.safeParse({ ...valid, label: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('is registered, so the type is subscribable and no longer bypasses validation', () => {
    expect(Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)).toContain('compliance.document_expiring');

    const clean = validateWebhookPayload('compliance.document_expiring', valid);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.bypassed).toBeUndefined();

    const leaked = validateWebhookPayload('compliance.document_expiring', {
      ...valid,
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.error.eventType).toBe('compliance.document_expiring');
  });
});

// ─── SCRUM-3972: affiliated-organization lifecycle events ───────────────────

describe('suborg.* payload schemas (SCRUM-3972)', () => {
  const BASE = {
    public_id: 'ORG-CHILD-0001',
    display_name: 'Nairobi Legal Aid',
    parent_public_id: 'ORG-PARENT-0001',
    parent_approval_status: 'APPROVED' as const,
    occurred_at: '2026-09-12T10:00:00.000Z',
  };

  const CREDIT = {
    ...BASE,
    amount: 100,
    parent_balance: 900,
    child_balance: 100,
    note: 'Q3 allocation',
  };

  /**
   * The whole registered set, so a new suborg event added without its own
   * banned-field cases still gets swept by the shared assertions below.
   */
  const SUBORG_CASES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['suborg.created', BASE],
    ['suborg.approved', BASE],
    ['suborg.revoked', { ...BASE, parent_approval_status: 'REVOKED' }],
    ['suborg.credits_allocated', CREDIT],
    ['suborg.credits_reclaimed', { ...CREDIT, amount: -100, child_balance: 0, parent_balance: 1000 }],
    ['suborg.suspended', { ...BASE, reason: 'contract ended' }],
    ['suborg.offboarded', { ...BASE, reclaimed: 100, reason: 'contract ended' }],
  ];

  it('registers all seven, so each is subscribable and none bypasses validation', () => {
    const registered = Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE);
    for (const [eventType] of SUBORG_CASES) {
      expect(registered).toContain(eventType);
    }
    expect(SUBORG_CASES).toHaveLength(7);
  });

  it.each(SUBORG_CASES)('accepts a valid %s payload', (eventType, payload) => {
    const result = validateWebhookPayload(eventType, payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bypassed).toBeUndefined();
  });

  // CLAUDE.md §6 (internal UUIDs) + §1.6 (fingerprint). `parent_org_id` is the
  // one this family would most plausibly grow by accident, since it is the
  // field name the REST surface uses internally.
  it.each(SUBORG_CASES)(
    'rejects banned identifier fields on %s',
    (eventType, payload) => {
      for (const banned of [
        'anchor_id',
        'fingerprint',
        'user_id',
        'org_id',
        'parent_org_id',
        'child_org_id',
      ]) {
        const result = validateWebhookPayload(eventType, {
          ...payload,
          [banned]: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.ok, `${eventType} accepted banned field ${banned}`).toBe(false);
      }
    },
  );

  it.each(SUBORG_CASES)('rejects an unknown key on %s (strict mode)', (eventType, payload) => {
    expect(validateWebhookPayload(eventType, { ...payload, admin_email: 'a@b.test' }).ok).toBe(false);
    expect(validateWebhookPayload(eventType, { ...payload, domain: 'example.test' }).ok).toBe(false);
  });

  it.each(SUBORG_CASES)('rejects a non-ISO occurred_at on %s', (eventType, payload) => {
    expect(validateWebhookPayload(eventType, { ...payload, occurred_at: '2026-09-12' }).ok).toBe(false);
    expect(validateWebhookPayload(eventType, { ...payload, occurred_at: 1757671200000 }).ok).toBe(false);
  });

  it.each(SUBORG_CASES)('requires both public identifiers on %s', (eventType, payload) => {
    const { public_id: _p, ...noChild } = payload;
    expect(validateWebhookPayload(eventType, noChild).ok).toBe(false);
    const { parent_public_id: _q, ...noParent } = payload;
    expect(validateWebhookPayload(eventType, noParent).ok).toBe(false);
  });

  it.each(SUBORG_CASES)(
    'mirrors organizations_parent_approval_status_check on %s',
    (eventType, payload) => {
      // CHECK (parent_approval_status IS NULL OR parent_approval_status = ANY
      //        (ARRAY['PENDING','APPROVED','REVOKED']))
      for (const status of ['PENDING', 'APPROVED', 'REVOKED', null]) {
        expect(
          validateWebhookPayload(eventType, { ...payload, parent_approval_status: status }).ok,
          `${eventType} rejected DB-legal status ${String(status)}`,
        ).toBe(true);
      }
      // A value the database would refuse must not be expressible on the wire.
      expect(
        validateWebhookPayload(eventType, { ...payload, parent_approval_status: 'SUSPENDED' }).ok,
      ).toBe(false);
      // ...and the field is required, not merely nullable: omitting it would
      // let a consumer read "unknown" as "not affiliated".
      const { parent_approval_status: _s, ...omitted } = payload;
      expect(validateWebhookPayload(eventType, omitted).ok).toBe(false);
    },
  );

  it('pins the credit sign convention in the schema, not just the emit site', () => {
    // An "allocation" that moves nothing or moves credits backwards is a
    // reclaim mislabelled — a consumer reconciling balances would be wrong.
    expect(validateWebhookPayload('suborg.credits_allocated', { ...CREDIT, amount: 0 }).ok).toBe(false);
    expect(validateWebhookPayload('suborg.credits_allocated', { ...CREDIT, amount: -1 }).ok).toBe(false);
    expect(validateWebhookPayload('suborg.credits_reclaimed', { ...CREDIT, amount: 0 }).ok).toBe(false);
    expect(validateWebhookPayload('suborg.credits_reclaimed', { ...CREDIT, amount: 5 }).ok).toBe(false);
  });

  it('requires integer, non-negative balances', () => {
    expect(validateWebhookPayload('suborg.credits_allocated', { ...CREDIT, parent_balance: -1 }).ok).toBe(false);
    expect(validateWebhookPayload('suborg.credits_allocated', { ...CREDIT, child_balance: 1.5 }).ok).toBe(false);
  });

  it('treats an offboarding that reclaimed nothing as a real value, not a missing one', () => {
    expect(validateWebhookPayload('suborg.offboarded', { ...BASE, reclaimed: 0 }).ok).toBe(true);
    expect(validateWebhookPayload('suborg.offboarded', { ...BASE, reclaimed: -1 }).ok).toBe(false);
    // `reclaimed` is required — an offboarding that does not say what moved is
    // not reconcilable.
    expect(validateWebhookPayload('suborg.offboarded', BASE).ok).toBe(false);
  });

  it('allows null/absent optional prose and bounds its length', () => {
    expect(validateWebhookPayload('suborg.suspended', { ...BASE, reason: null }).ok).toBe(true);
    expect(validateWebhookPayload('suborg.suspended', BASE).ok).toBe(true);
    expect(validateWebhookPayload('suborg.suspended', { ...BASE, reason: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateWebhookPayload('suborg.credits_allocated', { ...CREDIT, note: null }).ok).toBe(true);
    // `note` is bounded by SUBORG_NOTE_MAX (513), not 500 — see the bound
    // reconciliation suite at the bottom of this file. `reason` above stays at
    // 500 because it is passed through uncomposed.
    expect(
      validateWebhookPayload('suborg.credits_allocated', {
        ...CREDIT,
        note: 'x'.repeat(SUBORG_NOTE_MAX + 1),
      }).ok,
    ).toBe(false);
    expect(
      validateWebhookPayload('suborg.credits_allocated', {
        ...CREDIT,
        note: 'x'.repeat(SUBORG_NOTE_MAX),
      }).ok,
    ).toBe(true);
  });
});

/**
 * CTO review 2026-09-12 — bound reconciliation between the REST contract and
 * the webhook contract.
 *
 * `POST /org/suborgs/offboard` accepts `reason: z.string().trim().max(500)` and
 * the handler emits `suborg.credits_reclaimed` with
 * `note = 'offboarding: ' + reason` — 13 characters longer. At the maximum
 * accepted reason the composed note is 513 characters, which the payload
 * schema rejected, and because `dispatchWebhookEvent` THROWS on schema
 * rejection the whole event was lost for an entirely valid request.
 */
describe('SCRUM-3972 — suborg note bound vs the offboard reason bound', () => {
  const base = {
    public_id: 'ORG-CHILD-0001',
    display_name: 'Affiliate Ltd',
    parent_public_id: 'ORG-PARENT-0001',
    parent_approval_status: 'APPROVED' as const,
    occurred_at: '2026-09-12T10:00:00.000Z',
    amount: -5,
    parent_balance: 105,
    child_balance: 0,
  };

  it('accepts the longest note the offboard route can compose', () => {
    const maxReason = 'r'.repeat(500);
    const note = `offboarding: ${maxReason}`;
    expect(note.length).toBe(513);
    const result = validateWebhookPayload('suborg.credits_reclaimed', { ...base, note });
    expect(result.ok).toBe(true);
  });

  it('still refuses a note beyond that bound', () => {
    const result = validateWebhookPayload('suborg.credits_reclaimed', {
      ...base,
      note: 'x'.repeat(SUBORG_NOTE_MAX + 1),
    });
    expect(result.ok).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * SCRUM-3982 — the banned-field ratchet.
 *
 * Before this change, `validateWebhookPayload` only checked payloads whose
 * event type was a key of `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`. Everything else
 * returned `{ ok: true, bypassed: true }` with no inspection at all — and that
 * is the path every historical leak of this class actually took. These tests
 * pin the scan running BEFORE the registry lookup, for registered and
 * unregistered types alike.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('BANNED_PAYLOAD_KEYS (SCRUM-3982)', () => {
  it('is BANNED_RESPONSE_KEYS plus fingerprint, in that order', () => {
    expect([...BANNED_PAYLOAD_KEYS]).toEqual([...BANNED_RESPONSE_KEYS, 'fingerprint']);
    // The four the file header has always named, still there after deriving.
    for (const key of ['anchor_id', 'fingerprint', 'org_id', 'user_id']) {
      expect(BANNED_PAYLOAD_KEYS).toContain(key);
    }
  });

  it('finds banned keys in payload order and ignores clean ones', () => {
    expect(findBannedPayloadKeys({ public_id: 'pub-1', fingerprint: 'a'.repeat(64) })).toEqual([
      'fingerprint',
    ]);
    expect(findBannedPayloadKeys({ anchor_id: 'x', public_id: 'p', org_id: 'y' })).toEqual([
      'anchor_id',
      'org_id',
    ]);
    expect(findBannedPayloadKeys({ public_id: 'pub-1', status: 'SECURED' })).toEqual([]);
  });

  it('treats any `_`-led key as internal-only (file header convention)', () => {
    expect(findBannedPayloadKeys({ public_id: 'p', _internal: 1 })).toEqual(['_internal']);
  });

  it('returns nothing for non-object input rather than throwing', () => {
    for (const input of [null, undefined, 'string', 42, ['fingerprint']]) {
      expect(findBannedPayloadKeys(input)).toEqual([]);
    }
  });

  it('names the offending key but never its value (the value IS the secret)', () => {
    const fingerprint = 'deadbeef'.repeat(8);
    const result = validateWebhookPayload('anchor.secured', { public_id: 'pub-1', fingerprint });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebhookPayloadValidationError);
    expect(result.error.message).toContain('fingerprint');
    expect(result.error.message).not.toContain(fingerprint);
  });
});

describe('validateWebhookPayload — banned keys refused on EVERY event type (SCRUM-3982)', () => {
  const REGISTERED = Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE);
  // The nine types with a real `dispatchWebhookEvent` call site in
  // services/worker/src but no entry in PAYLOAD_SCHEMAS_BY_EVENT_TYPE as of
  // this PR — minus the two it registers. Verified with
  // `git grep -n "dispatchWebhookEvent(" services/worker/src`.
  const UNREGISTERED = [
    'attestation.active',
    'anchor.revocation_anchored',
    'job.completed',
    'compliance.anchor_delayed',
    'compliance.certificate_expiring',
    'compliance.signature_revoked',
    'compliance.timestamp_coverage_low',
  ];

  it.each(REGISTERED.flatMap((type) => BANNED_PAYLOAD_KEYS.map((key) => [type, key] as const)))(
    'refuses %s carrying %s',
    (eventType, key) => {
      const result = validateWebhookPayload(eventType, { public_id: 'pub-1', [key]: 'leaked-value' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.eventType).toBe(eventType);
    },
  );

  it.each(UNREGISTERED.flatMap((type) => BANNED_PAYLOAD_KEYS.map((key) => [type, key] as const)))(
    'refuses UNREGISTERED %s carrying %s (this is the path the leaks took)',
    (eventType, key) => {
      const result = validateWebhookPayload(eventType, { public_id: 'pub-1', [key]: 'leaked-value' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.eventType).toBe(eventType);
    },
  );

  it('still passes a CLEAN unregistered payload with bypassed: true', () => {
    // Deliberate: the ban is on the FIELDS, not on being unregistered. Turning
    // unknown types into a blanket refusal would break every remaining
    // dispatch site at once for no subscriber benefit (nothing can subscribe
    // to an unregistered type anyway).
    const delayed = validateWebhookPayload('compliance.anchor_delayed', {
      pending_count: 3,
      oldest_pending_since: '2026-09-12T10:00:00Z',
      threshold_minutes: 60,
    });
    expect(delayed.ok).toBe(true);
    if (delayed.ok) expect(delayed.bypassed).toBe(true);

    // NOTE the `job_id` here: it IS an internal `batch_verification_jobs`
    // UUID, and it is NOT in BANNED_PAYLOAD_KEYS, so this payload passes. That
    // is a stated residual gap of this PR, pinned here so it cannot be
    // mistaken for coverage. Closing it means registering `job.completed` with
    // a public-id-only schema, which is follow-up work.
    const job = validateWebhookPayload('job.completed', {
      job_id: '550e8400-e29b-41d4-a716-446655440000',
      status: 'complete',
      total: 2,
      result_count: 2,
    });
    expect(job.ok).toBe(true);
    if (job.ok) expect(job.bypassed).toBe(true);
  });
});

describe('the three real leaking producer payloads are now refused (SCRUM-3982)', () => {
  // Each object below is copied verbatim from its producer's dispatch call.
  // Two of them live in T3 anchor-lifecycle files this PR deliberately does
  // NOT edit — the boundary is what stops them. Both call sites wrap the
  // dispatch in a non-fatal try/catch, so refusal costs a warn log, not a
  // failed job.

  it('services/worker/src/jobs/revocation.ts:141 — anchor.revocation_anchored (anchor_id + fingerprint)', () => {
    const result = validateWebhookPayload('anchor.revocation_anchored', {
      anchor_id: '550e8400-e29b-41d4-a716-446655440000',
      public_id: 'pub-001',
      fingerprint: 'a'.repeat(64),
      status: 'REVOKED',
      revocation_tx_id: 'tx-abc',
      revocation_block_height: 900_001,
      original_chain_tx_id: 'tx-orig',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const named = result.error.issues.map((i) => i.path.join('.'));
    expect(named).toContain('anchor_id');
    expect(named).toContain('fingerprint');
  });

  it('services/worker/src/jobs/attestationAnchor.ts:161 — attestation.active (fingerprint)', () => {
    const result = validateWebhookPayload('attestation.active', {
      public_id: 'ARK-ORG-VER-ABC123',
      attestation_type: 'VERIFICATION',
      status: 'ACTIVE',
      chain_tx_id: 'tx-abc',
      chain_timestamp: '2026-09-12T10:00:00Z',
      fingerprint: 'b'.repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('fingerprint');
  });

  it('services/worker/src/api/v1/attestations.ts — attestation.created as it was BEFORE this PR', () => {
    const result = validateWebhookPayload('attestation.created', {
      public_id: 'ARK-ORG-VER-ABC123',
      attestation_type: 'VERIFICATION',
      status: 'PENDING',
      fingerprint: 'c'.repeat(64),
      created_at: '2026-09-12T10:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('fingerprint');
  });
});

describe('AttestationCreatedPayloadSchema (SCRUM-3982)', () => {
  const valid = {
    public_id: 'ARK-ORG-VER-ABC123',
    attestation_type: 'VERIFICATION',
    status: 'PENDING',
    created_at: '2026-09-12T10:00:00Z',
  };

  it('accepts the payload the producer actually sends after the fingerprint drop', () => {
    expect(AttestationCreatedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an optional org_public_id, null included', () => {
    expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, org_public_id: 'org-1' }).success).toBe(true);
    expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, org_public_id: null }).success).toBe(true);
  });

  it('accepts DRAFT (the column default) and refuses every terminal status', () => {
    // public.attestation_status = DRAFT | PENDING | ACTIVE | REVOKED | EXPIRED
    // | CHALLENGED. A creation event can only carry a pre-anchoring state.
    expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, status: 'DRAFT' }).success).toBe(true);
    for (const status of ['ACTIVE', 'REVOKED', 'EXPIRED', 'CHALLENGED']) {
      expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, status }).success).toBe(false);
    }
  });

  it.each([...BANNED_PAYLOAD_KEYS, 'attestation_id', 'attester_user_id'])(
    'rejects the banned/internal key %s (.strict())',
    (key) => {
      expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, [key]: 'x' }).success).toBe(false);
    },
  );

  it('rejects any unknown key at all', () => {
    expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, claims: [] }).success).toBe(false);
  });

  it('requires an ISO 8601 created_at', () => {
    expect(AttestationCreatedPayloadSchema.safeParse({ ...valid, created_at: '2026-09-12' }).success).toBe(false);
  });

  it('is registered, so it no longer bypasses validation', () => {
    expect(Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)).toContain('attestation.created');
    const clean = validateWebhookPayload('attestation.created', valid);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.bypassed).toBeUndefined();
  });
});

describe('AttestationRevokedPayloadSchema (SCRUM-3982)', () => {
  const valid = {
    public_id: 'ARK-ORG-VER-ABC123',
    status: 'REVOKED',
    revocation_reason: 'Issued in error',
    revoked_at: '2026-09-12T10:00:00Z',
  };

  it('accepts the payload the (not-yet-reachable) producer would send', () => {
    expect(AttestationRevokedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('mirrors the route guard on revocation_reason: min 3, no upper bound', () => {
    // PATCH /api/v1/attestations/:publicId/revoke rejects reason.length < 3 and
    // imposes no maximum. A `.max()` here that the route does not enforce would
    // turn a long-but-valid revocation into a refused dispatch.
    expect(AttestationRevokedPayloadSchema.safeParse({ ...valid, revocation_reason: 'ab' }).success).toBe(false);
    expect(AttestationRevokedPayloadSchema.safeParse({ ...valid, revocation_reason: 'abc' }).success).toBe(true);
    expect(
      AttestationRevokedPayloadSchema.safeParse({ ...valid, revocation_reason: 'x'.repeat(5_000) }).success,
    ).toBe(true);
  });

  it('accepts the optional attestation_type and org_public_id', () => {
    expect(
      AttestationRevokedPayloadSchema.safeParse({ ...valid, attestation_type: 'AUDIT', org_public_id: 'org-1' })
        .success,
    ).toBe(true);
    expect(
      AttestationRevokedPayloadSchema.safeParse({ ...valid, attestation_type: null, org_public_id: null }).success,
    ).toBe(true);
  });

  it('rejects any status other than REVOKED', () => {
    for (const status of ['PENDING', 'ACTIVE', 'EXPIRED']) {
      expect(AttestationRevokedPayloadSchema.safeParse({ ...valid, status }).success).toBe(false);
    }
  });

  it.each([...BANNED_PAYLOAD_KEYS, 'attestation_id'])(
    'rejects the banned/internal key %s (.strict())',
    (key) => {
      expect(AttestationRevokedPayloadSchema.safeParse({ ...valid, [key]: 'x' }).success).toBe(false);
    },
  );

  it('requires an ISO 8601 revoked_at', () => {
    expect(AttestationRevokedPayloadSchema.safeParse({ ...valid, revoked_at: 'yesterday' }).success).toBe(false);
  });

  it('is registered, so it no longer bypasses validation', () => {
    expect(Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)).toContain('attestation.revoked');
    const clean = validateWebhookPayload('attestation.revoked', valid);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.bypassed).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * CTO review of SCRUM-3982 (rulings Z2/Z3/Z4) — hardening the ratchet.
 *
 * The first cut of this PR had three holes that the review found by reading
 * the producers and the subscription path rather than the diff:
 *
 *  Z3  The ban list was four hand-written keys. `api/v1/response-schemas.ts`
 *      already maintains a longer list for the SAME class of leak on API
 *      response bodies, and a webhook payload is a strictly more exposed
 *      surface than a response body (it is PUSHED to a third-party URL).
 *      Compound spellings (`document_fingerprint`) and camelCase (`orgId`)
 *      also walked straight through an exact-match `Set.has()`.
 *  AB6 The scan was top-level only, while `jobs/attestationAnchor.ts` nests a
 *      `metadata` object. A banned key one level down was invisible.
 *  Z2/RA3 "nothing can subscribe to an unregistered type" is FALSE. The
 *      `/api/v1/webhooks` route does restrict `events` to the registry, but
 *      `create_webhook_endpoint` (SECURITY DEFINER, granted to
 *      `authenticated`) inserts `p_events` unvalidated, and
 *      `webhook_endpoints_insert_org` / `_update_org` let any ORG_ADMIN write
 *      the column directly through PostgREST. There is no CHECK constraint.
 *      So an unregistered type IS deliverable, and "bypass" was a real hole.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('BANNED_PAYLOAD_KEYS derives from the response-body ban list (Z3)', () => {
  it('is a superset of BANNED_RESPONSE_KEYS plus fingerprint', () => {
    for (const key of BANNED_RESPONSE_KEYS) {
      expect(isBannedPayloadKey(key)).toBe(true);
    }
    expect(isBannedPayloadKey('fingerprint')).toBe(true);
  });

  it.each([
    'document_fingerprint',
    'evidence_fingerprint',
    'anchor_fingerprint',
    'certificate_fingerprint',
    'new_fingerprint',
    'fingerprint_sha256',
  ])('bans the compound spelling %s', (key) => {
    expect(isBannedPayloadKey(key)).toBe(true);
  });

  it.each(['anchorId', 'orgId', 'userId', 'documentFingerprint', 'attesterOrgId'])(
    'bans the camelCase spelling %s',
    (key) => {
      expect(isBannedPayloadKey(key)).toBe(true);
    },
  );

  it.each(['attester_org_id', 'previous_user_id', 'source_anchor_id'])(
    'bans the qualified spelling %s',
    (key) => {
      expect(isBannedPayloadKey(key)).toBe(true);
    },
  );

  it.each([
    // Explicitly allowed by the file header — a blanket `*_id` ban would take
    // these out and break every registered anchor payload.
    'public_id',
    'org_public_id',
    'chain_tx_id',
    'revocation_tx_id',
    'original_chain_tx_id',
    // Residual gap, deliberately NOT banned (Z2): these are internal UUIDs on
    // the seven legacy unregistered types. Banning them here would refuse live
    // dispatches; the fix is to register those types with public-id schemas
    // (SCRUM-5063), not to widen the key ban under them.
    'job_id',
    'certificate_id',
    'signature_id',
  ])('leaves %s alone', (key) => {
    expect(isBannedPayloadKey(key)).toBe(false);
  });
});

describe('findBannedPayloadKeys scans nested objects and arrays (AB6)', () => {
  it('finds a banned key one level down and reports its path', () => {
    expect(
      findBannedPayloadKeys({ public_id: 'p', metadata: { fingerprint: 'a'.repeat(64) } }),
    ).toEqual(['metadata.fingerprint']);
  });

  it('finds a banned key inside an array of objects', () => {
    expect(
      findBannedPayloadKeys({ items: [{ public_id: 'p' }, { anchor_id: 'uuid' }] }),
    ).toEqual(['items.1.anchor_id']);
  });

  it('does not recurse past a banned key (the whole subtree is refused anyway)', () => {
    expect(findBannedPayloadKeys({ org_id: { user_id: 'x' } })).toEqual(['org_id']);
  });

  it('terminates on a cyclic payload instead of blowing the stack', () => {
    const cyclic: Record<string, unknown> = { public_id: 'p' };
    cyclic.self = cyclic;
    expect(() => findBannedPayloadKeys(cyclic)).not.toThrow();
  });
});

describe('unregistered event types fail closed (Z2)', () => {
  it('refuses an event type that is neither registered nor a known legacy type', () => {
    const result = validateWebhookPayload('partner.created', { public_id: 'pub-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.eventType).toBe('partner.created');
      expect(result.error.message).toMatch(/not registered/i);
    }
  });

  it('refuses a typo of a registered type rather than bypassing it', () => {
    const result = validateWebhookPayload('anchor.SECURED', { public_id: 'pub-1' });
    expect(result.ok).toBe(false);
  });

  it.each([...LEGACY_UNREGISTERED_EVENT_TYPES])(
    'still bypasses the known legacy type %s so no live dispatch site breaks',
    (eventType) => {
      const result = validateWebhookPayload(eventType, { public_id: 'pub-1', status: 'ok' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.bypassed).toBe(true);
    },
  );

  it('pins the legacy allowlist to exactly the seven types with a live dispatch site', () => {
    // `git grep -n "dispatchWebhookEvent(" services/worker/src`, minus the 12
    // registered types. This list is a RATCHET: entries come off it as
    // SCRUM-5063 registers each type. Nothing is ever added.
    expect([...LEGACY_UNREGISTERED_EVENT_TYPES].sort()).toEqual([
      'anchor.revocation_anchored',
      'attestation.active',
      'compliance.anchor_delayed',
      'compliance.certificate_expiring',
      'compliance.signature_revoked',
      'compliance.timestamp_coverage_low',
      'job.completed',
    ]);
  });
});

describe('one authority per event type (Z4)', () => {
  it('reports the SCHEMA error for a registered type, not a key-scan error', () => {
    // `.strict()` is the authority for a registered type. Running the key scan
    // first meant a banned key produced a generic scan message where the
    // schema would have said `unrecognized_keys`, and a payload that was both
    // banned-key-free and schema-invalid reported nothing useful.
    const result = validateWebhookPayload('anchor.secured', {
      public_id: 'pub-1',
      fingerprint: 'a'.repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('no registered schema declares a nested object, so .strict() is a complete guard', () => {
    // The key scan does not run for registered types (Z4). That is only safe
    // while every registered schema is a FLAT object of primitives — `.strict()`
    // rejects unknown keys at the top level only. If a future schema declares a
    // nested object or a z.record, this test goes red and the scan must be
    // re-introduced for that schema.
    // Walk the zod def tree by `type` discriminator rather than `instanceof`:
    // the registry holds a mix of ZodObject and refined wrappers, and the class
    // identities are not part of zod's public contract across minor versions.
    const shapeOf = (schema: unknown): Record<string, unknown> | null => {
      let node = schema as { def?: Record<string, unknown> };
      for (let i = 0; i < 8 && node?.def; i++) {
        if (node.def.type === 'object') return node.def.shape as Record<string, unknown>;
        node = (node.def.innerType ?? node.def.schema) as { def?: Record<string, unknown> };
      }
      return null;
    };
    // "Nests keys" means the value can CARRY KEYS a scan would have to look at.
    // `z.array(z.string())` (anchor.batch_secured.public_ids) cannot; an array
    // of objects can, so recurse into the element type.
    const KEY_BEARING = new Set(['object', 'record', 'map', 'tuple', 'interface']);
    const nestsKeys = (node: unknown, depth = 0): boolean => {
      const def = (node as { def?: Record<string, unknown> })?.def;
      if (!def || depth > 8) return false;
      if (KEY_BEARING.has(String(def.type))) return true;
      for (const child of [def.innerType, def.schema, def.element, def.valueType]) {
        if (child && nestsKeys(child, depth + 1)) return true;
      }
      return false;
    };

    for (const [eventType, schema] of Object.entries(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)) {
      const shape = shapeOf(schema);
      expect(`${eventType} shape=${shape ? 'found' : 'MISSING'}`).toBe(`${eventType} shape=found`);
      for (const [field, def] of Object.entries(shape as Record<string, unknown>)) {
        const nests = nestsKeys(def);
        expect(`${eventType}.${field} nests=${nests}`).toBe(`${eventType}.${field} nests=false`);
      }
    }
  });
});
