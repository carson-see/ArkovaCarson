/**
 * Proof Packet → Verification API view (SCRUM-1152)
 *
 * Phase 1.5 of the Verification API freezes the response schema. Audit
 * proof packets (SCRUM-1149) carry the same underlying facts plus
 * compliance-inbox-specific extensions. This module is the canonical
 * mapping from the proof-packet shape to the frozen verification fields,
 * with CIBA-specific extras isolated under a `ciba` sub-object so that:
 *
 *   1. Future agents calling the verification API see a predictable shape
 *      regardless of whether the underlying record was anchored via the
 *      classic flow or via a CIBA rule action.
 *   2. Compliance operators get the full execution + rule + outcome
 *      context without retrofitting the frozen verification schema.
 *
 * Breaking-change risk if `PROOF_PACKET_VERIFICATION_VIEW_FIELDS` ever
 * needs to drop a field: that's a v2 of the verification API per CLAUDE.md
 * §1.8 ("Verification API schema is frozen once published").
 */

interface ProofPacketAnchorReceipt {
  public_id: string | null;
  status: string;
  fingerprint: string | null;
  bitcoin_tx_id: string | null;
  block_height: number | null;
  verification_uri: string | null;
}

interface ProofPacketTimestamps {
  event_received_at: string | null;
  execution_created_at: string;
  action_started_at: string | null;
  action_completed_at: string | null;
}

interface ProofPacketRule {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  action_type: string;
}

interface ProofPacketAction {
  type: string | null;
  outcome: string | null;
}

interface ProofPacketSourceEvent {
  trigger_type: string;
  vendor: string | null;
}

interface ProofPacketShape {
  schema_version: number;
  execution: { id: string };
  source_event: ProofPacketSourceEvent | null;
  rule: ProofPacketRule | null;
  action: ProofPacketAction;
  timestamps: ProofPacketTimestamps;
  anchor_receipt: ProofPacketAnchorReceipt;
  lineage: { revoked_at: string | null };
}

export const PROOF_PACKET_VERIFICATION_VIEW_FIELDS = [
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
] as const;

export const CIBA_EXTENSION_FIELDS = [
  'execution_id',
  'rule_id',
  'rule_name',
  'action_outcome',
  'trigger_type',
  'vendor',
] as const;

type VerificationStatus = 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING';

function mapStatus(anchorStatus: string): VerificationStatus {
  switch (anchorStatus.toUpperCase()) {
    case 'SECURED':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}

export interface VerificationView {
  verified: boolean;
  status: VerificationStatus;
  credential_type: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  anchor_timestamp: string | null;
  bitcoin_block: number | null;
  network_receipt_id: string | null;
  record_uri: string | null;
  fingerprint: string | null;
  ciba?: {
    execution_id: string;
    rule_id: string | null;
    rule_name: string | null;
    action_outcome: string | null;
    trigger_type: string | null;
    vendor: string | null;
  };
}

export function toVerificationView(packet: ProofPacketShape): VerificationView {
  const anchored = Boolean(packet.anchor_receipt.public_id) && packet.anchor_receipt.status !== 'not_anchored';
  const status = anchored ? mapStatus(packet.anchor_receipt.status) : 'PENDING';
  return {
    verified: anchored && status === 'ACTIVE',
    status,
    credential_type: packet.source_event?.trigger_type ?? null,
    issued_date: packet.timestamps.event_received_at ?? null,
    expiry_date: null,
    anchor_timestamp: packet.timestamps.action_completed_at ?? null,
    bitcoin_block: packet.anchor_receipt.block_height,
    network_receipt_id: packet.anchor_receipt.bitcoin_tx_id,
    record_uri: packet.anchor_receipt.verification_uri,
    fingerprint: packet.anchor_receipt.fingerprint,
    ciba: {
      execution_id: packet.execution.id,
      rule_id: packet.rule?.id ?? null,
      rule_name: packet.rule?.name ?? null,
      action_outcome: packet.action.outcome ?? null,
      trigger_type: packet.source_event?.trigger_type ?? null,
      vendor: packet.source_event?.vendor ?? null,
    },
  };
}
