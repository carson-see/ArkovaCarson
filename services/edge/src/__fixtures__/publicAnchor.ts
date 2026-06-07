/**
 * Shared test fixture for the `get_public_anchor` RPC contract.
 *
 * The KEYS here come VERBATIM from the SECURITY DEFINER function in
 * `supabase/migrations/0311_scrum1599_public_anchor_provenance.sql`
 * (the `jsonb_build_object(...)` body, lines ~16-93). This is the ONLY
 * sanctioned source of RPC-shaped test rows for edge/worker MCP tests.
 *
 * Why this exists: the prior MCP tests hand-authored mock rows with the
 * WRONG keys (`org_name`, `chain_tx_id`, `created_at` as anchor time,
 * `recipient_hash`, `issued_at`, `expires_at`). Those wrong keys masked
 * BUG-2 (shapeAnchorRow read keys the RPC never emits, so every mapped
 * field silently fell back to its default). Tests that mint their own
 * row shapes can drift away from the migration; this fixture cannot —
 * it is pinned to the real contract.
 *
 * Real keys emitted by get_public_anchor (see 0311):
 *   verified, status, issuer_name, credential_type, issued_date,
 *   expiry_date, anchor_timestamp, bitcoin_block, network_receipt_id,
 *   merkle_proof_hash, record_uri, public_id, fingerprint, filename,
 *   file_size, issuer_public_id, metadata, created_at, secured_at,
 *   issued_at, revoked_at, superseded_at, revocation_reason, expires_at,
 *   source_url, source_provider, verification_level,
 *   evidence_package_hash, source_payload_hash, fetched_at,
 *   recipient_identifier  (+ optional jurisdiction)
 *
 * The migration distinguishes the gated network-observed time
 * (`anchor_timestamp` / `secured_at` = `a.chain_timestamp`, only set when
 * status != PENDING) from the row-creation time (`created_at`). It also
 * distinguishes the public-safe `recipient_identifier` (a sha256 hex of
 * the raw recipient) from the never-emitted `recipient_hash`.
 */

export interface PublicAnchorRow {
  verified: boolean;
  status: string;
  issuer_name: string;
  credential_type: string;
  issued_date: string | null;
  expiry_date: string | null;
  anchor_timestamp: string | null;
  bitcoin_block: number | null;
  network_receipt_id: string | null;
  merkle_proof_hash: string | null;
  record_uri: string;
  public_id: string;
  fingerprint: string;
  filename: string | null;
  file_size: number | null;
  issuer_public_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  secured_at: string | null;
  issued_at: string | null;
  revoked_at: string | null;
  superseded_at: string | null;
  revocation_reason: string | null;
  expires_at: string | null;
  source_url: string | null;
  source_provider: string | null;
  verification_level: string | null;
  evidence_package_hash: string | null;
  source_payload_hash: string | null;
  fetched_at: string | null;
  recipient_identifier: string;
  jurisdiction?: string;
  [key: string]: unknown;
}

/**
 * Build a SECURED `get_public_anchor` RPC row with realistic defaults.
 * Pass `overrides` to flip status / null out gated fields / change values.
 *
 * Defaults model a fully-anchored (SECURED → ACTIVE) credential: the
 * gated fields (`anchor_timestamp`, `secured_at`, `network_receipt_id`,
 * `bitcoin_block`) are populated, exactly as the migration emits them
 * for a non-PENDING anchor.
 */
export function realPublicAnchorRow(
  overrides: Partial<PublicAnchorRow> = {},
): PublicAnchorRow {
  return {
    verified: true,
    status: 'ACTIVE',
    issuer_name: 'University of Michigan',
    credential_type: 'DEGREE',
    issued_date: '2026-01-01T00:00:00Z',
    expiry_date: '2030-01-01T00:00:00Z',
    anchor_timestamp: '2026-04-11T10:00:00Z',
    bitcoin_block: 880000,
    network_receipt_id: 'a'.repeat(63) + '1', // 64-char hex-like tx id
    merkle_proof_hash: null,
    record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
    public_id: 'ARK-2026-001',
    fingerprint: 'f'.repeat(64),
    filename: 'degree.pdf',
    file_size: 102400,
    issuer_public_id: 'org_umich',
    metadata: {},
    created_at: '2026-04-10T09:00:00Z',
    secured_at: '2026-04-11T10:00:00Z',
    issued_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    superseded_at: null,
    revocation_reason: null,
    expires_at: '2030-01-01T00:00:00Z',
    source_url: null,
    source_provider: null,
    verification_level: null,
    evidence_package_hash: null,
    source_payload_hash: null,
    fetched_at: null,
    recipient_identifier: 'b'.repeat(64),
    ...overrides,
  };
}

/**
 * Build a PENDING `get_public_anchor` RPC row. Models the migration's
 * gating: for status PENDING the network-observed fields are NULL
 * (`anchor_timestamp`, `secured_at`, `network_receipt_id`,
 * `bitcoin_block` are all CASE-gated to NULL when status = PENDING).
 */
export function pendingPublicAnchorRow(
  overrides: Partial<PublicAnchorRow> = {},
): PublicAnchorRow {
  return realPublicAnchorRow({
    verified: false,
    status: 'PENDING',
    anchor_timestamp: null,
    secured_at: null,
    network_receipt_id: null,
    bitcoin_block: null,
    ...overrides,
  });
}
