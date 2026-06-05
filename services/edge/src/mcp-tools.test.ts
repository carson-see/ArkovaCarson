/**
 * Edge worker unit tests — shapeAnchorRow (SCRUM-2226).
 *
 * @vitest-environment node
 *
 * FIRST test for the edge worker's own vitest harness. `shapeAnchorRow` is a
 * PURE mapper (no network, no Workers-runtime binding), so it runs under the
 * plain Node environment.
 *
 * --- RED TEST (TDD rule 1) ---
 * This captures the SCRUM-2226 bug: `shapeAnchorRow` reads keys that the
 * `get_public_anchor` RPC NEVER emits.
 *
 *   mapper reads        | RPC actually emits
 *   --------------------|--------------------------
 *   data.org_name       | data.issuer_name
 *   data.chain_tx_id    | data.network_receipt_id
 *   data.recipient_hash | data.recipient_identifier
 *   data.issued_at      | data.issued_date
 *   data.expires_at     | data.expiry_date
 *   data.created_at     | data.anchor_timestamp
 *
 * Because of the key mismatch the mapper falls back to its defaults
 * (`issuer_name: 'Unknown'`, `network_receipt_id: null`), silently dropping
 * real verification data. This test MUST FAIL against current code and is
 * the red half of the SCRUM-2226 fix. DO NOT fix the mapper here — the fix
 * is separate implementation work.
 */
import { describe, it, expect } from 'vitest';

import { shapeAnchorRow } from './mcp-tools';

/**
 * Real-world output shape of the `/rest/v1/rpc/get_public_anchor` RPC, taken
 * from the verification envelope contract (the same keys the worker's
 * get_public_anchor SQL function returns).
 */
const REAL_RPC_ROW = {
  status: 'SECURED',
  issuer_name: 'Acme University',
  network_receipt_id: 'abcd1234...tx',
  bitcoin_block: 840000,
  issued_date: '2026-01-01',
  expiry_date: null,
  anchor_timestamp: '2026-01-02T00:00:00Z',
  recipient_identifier: '',
  public_id: 'ARK-DOC-ABC',
} as const;

describe('shapeAnchorRow (SCRUM-2226 — get_public_anchor key mapping)', () => {
  it('maps the real RPC row keys into the verification envelope', () => {
    const out = shapeAnchorRow({ ...REAL_RPC_ROW });

    // Currently fails: mapper reads data.org_name → defaults to 'Unknown'.
    expect(out.issuer_name).toBe('Acme University');

    // Currently fails: mapper reads data.chain_tx_id → defaults to null.
    expect(out.network_receipt_id).toBe('abcd1234...tx');

    // Currently fails: mapper never reads/propagates bitcoin_block at all.
    expect(out.bitcoin_block).toBe(840000);

    // This one already passes (status key matches), asserted for completeness.
    expect(out.status).toBe('ACTIVE');
    expect(out.verified).toBe(true);
  });
});
