/**
 * Tests for SCRUM-1152 — Verification API schema alignment for proof packets.
 *
 * AC:
 *   - Map proof packet fields to `{ verified, issuer, credential_type,
 *     issued_date, status, anchor_timestamp, network_receipt, record_uri }`.
 *   - Identify extra compliance-inbox fields needed beyond core verification.
 *   - Add contract tests / schema snapshots.
 *   - Document any breaking-change risks.
 */
import { describe, expect, it } from 'vitest';
import {
  toVerificationView,
  PROOF_PACKET_VERIFICATION_VIEW_FIELDS,
  CIBA_EXTENSION_FIELDS,
} from './proof-packet-verification-view.js';

const SAMPLE_PACKET = {
  schema_version: 1,
  execution: { id: 'exec-1', status: 'SUCCEEDED', attempt_count: 1, error: null },
  source_event: { trigger_type: 'ESIGN_COMPLETED', vendor: 'docusign', external_file_id: 'env-123', filename: 'msa.pdf', sender_email: 'signer@example.com', payload: {} },
  rule: { id: 'rule-1', name: 'Auto-secure MSAs', description: null, trigger_type: 'ESIGN_COMPLETED', action_type: 'AUTO_ANCHOR', action_config: {} },
  action: { type: 'AUTO_ANCHOR', outcome: 'webhook_delivered', output_payload: {} },
  timestamps: {
    event_received_at: '2026-04-24T11:55:00Z',
    execution_created_at: '2026-04-24T11:59:59Z',
    action_started_at: '2026-04-24T12:00:00Z',
    action_completed_at: '2026-04-24T12:00:01Z',
  },
  anchor_receipt: {
    public_id: 'pid_acmemsa1',
    status: 'SECURED',
    fingerprint: 'sha256:abc',
    bitcoin_tx_id: 'txid_abc',
    block_height: 800001,
    verification_uri: 'https://app.arkova.io/verify/pid_acmemsa1',
  },
  lineage: { previous: [], revoked_at: null, revocation_reason: null, superseded_by_public_id: null },
  actor: { user_id: 'user-1' },
  generated_at: '2026-04-24T12:00:02Z',
};

describe('toVerificationView (SCRUM-1152)', () => {
  it('maps every required Phase 1.5 verification field', () => {
    const view = toVerificationView(SAMPLE_PACKET);
    expect(view).toMatchObject({
      verified: true,
      status: 'ACTIVE',
      credential_type: 'ESIGN_COMPLETED',
      anchor_timestamp: '2026-04-24T12:00:01Z',
      network_receipt_id: 'txid_abc',
      bitcoin_block: 800001,
      record_uri: 'https://app.arkova.io/verify/pid_acmemsa1',
    });
  });

  it('maps SECURED → ACTIVE, REVOKED → REVOKED, SUPERSEDED → SUPERSEDED, anything else → PENDING', () => {
    const cases = [
      ['SECURED', 'ACTIVE'],
      ['REVOKED', 'REVOKED'],
      ['SUPERSEDED', 'SUPERSEDED'],
      ['PENDING', 'PENDING'],
      ['BROADCASTING', 'PENDING'],
      ['UNKNOWN', 'PENDING'],
    ];
    for (const [anchorStatus, expected] of cases) {
      const packet = { ...SAMPLE_PACKET, anchor_receipt: { ...SAMPLE_PACKET.anchor_receipt, status: anchorStatus } };
      expect(toVerificationView(packet).status).toBe(expected);
    }
  });

  it('verified=false when no anchor receipt', () => {
    const packet = {
      ...SAMPLE_PACKET,
      anchor_receipt: {
        public_id: null,
        status: 'not_anchored',
        fingerprint: null,
        bitcoin_tx_id: null,
        block_height: null,
        verification_uri: null,
      },
    };
    const view = toVerificationView(packet);
    expect(view.verified).toBe(false);
    expect(view.status).toBe('PENDING');
    expect(view.network_receipt_id).toBeNull();
  });

  it('omits jurisdiction when null (CLAUDE.md §1.8 frozen schema rule)', () => {
    const view = toVerificationView(SAMPLE_PACKET);
    expect('jurisdiction' in view).toBe(false);
  });

  it('exposes ciba extension under a dedicated `ciba` key (separated from frozen verification fields)', () => {
    const view = toVerificationView(SAMPLE_PACKET);
    expect(view.ciba).toBeDefined();
    expect(view.ciba?.execution_id).toBe('exec-1');
    expect(view.ciba?.rule_name).toBe('Auto-secure MSAs');
    expect(view.ciba?.action_outcome).toBe('webhook_delivered');
  });

  it('PROOF_PACKET_VERIFICATION_VIEW_FIELDS lists exactly the frozen verification keys', () => {
    expect(PROOF_PACKET_VERIFICATION_VIEW_FIELDS).toEqual([
      'verified',
      'status',
      'credential_type',
      'issued_date',
      'expiry_date',
      'anchor_timestamp',
      'bitcoin_block',
      'network_receipt_id',
      'record_uri',
      'fingerprint',
    ]);
  });

  it('CIBA_EXTENSION_FIELDS documents the extra fields proof packets carry beyond the verification schema', () => {
    expect(CIBA_EXTENSION_FIELDS).toEqual(
      expect.arrayContaining(['execution_id', 'rule_id', 'rule_name', 'action_outcome']),
    );
  });

  it('snapshot — full output for the sample packet stays stable', () => {
    expect(toVerificationView(SAMPLE_PACKET)).toMatchInlineSnapshot(`
      {
        "anchor_timestamp": "2026-04-24T12:00:01Z",
        "bitcoin_block": 800001,
        "ciba": {
          "action_outcome": "webhook_delivered",
          "execution_id": "exec-1",
          "rule_id": "rule-1",
          "rule_name": "Auto-secure MSAs",
          "trigger_type": "ESIGN_COMPLETED",
          "vendor": "docusign",
        },
        "credential_type": "ESIGN_COMPLETED",
        "expiry_date": null,
        "fingerprint": "sha256:abc",
        "issued_date": "2026-04-24T11:55:00Z",
        "network_receipt_id": "txid_abc",
        "record_uri": "https://app.arkova.io/verify/pid_acmemsa1",
        "status": "ACTIVE",
        "verified": true,
      }
    `);
  });
});
