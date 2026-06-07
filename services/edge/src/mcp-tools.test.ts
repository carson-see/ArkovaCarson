/**
 * Edge MCP tools — unit tests (Story D harness, BUG-2, BUG-3b).
 *
 * Plain-node Vitest. `fetch` is mocked per-test; the functions under test
 * are pure-ish (config in, fetch out). RPC-shaped rows ONLY ever come from
 * `realPublicAnchorRow` / `pendingPublicAnchorRow` (the migration-pinned
 * fixture) — never hand-authored — so a key drift in the fixture or the
 * mapper is caught here instead of being masked by wrong-key mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  shapeAnchorRow,
  handleVerifyCredential,
  handleVerifyBatch,
  handleNessieQuery,
  type SupabaseConfig,
} from './mcp-tools.js';
import {
  realPublicAnchorRow,
  pendingPublicAnchorRow,
} from './__fixtures__/publicAnchor.js';

const CONFIG: SupabaseConfig = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseKey: 'test-key',
  userId: 'test-user-id',
};

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── BUG-2: shapeAnchorRow key realignment ────────────────────────────

describe('shapeAnchorRow (BUG-2 key realignment)', () => {
  it('round-trips a SECURED row with non-null receipt, issuer, dates, anchor_timestamp', () => {
    const row = realPublicAnchorRow({
      issuer_name: 'Acme University',
      network_receipt_id: 'tx-receipt-abc',
      anchor_timestamp: '2026-04-11T10:00:00Z',
      issued_date: '2026-01-02T00:00:00Z',
      expiry_date: '2031-01-02T00:00:00Z',
      recipient_identifier: 'c'.repeat(64),
    });

    const shaped = shapeAnchorRow(row);

    expect(shaped.verified).toBe(true);
    expect(shaped.status).toBe('ACTIVE');
    // These were all silently defaulting before the fix:
    expect(shaped.issuer_name).toBe('Acme University');
    expect(shaped.network_receipt_id).toBe('tx-receipt-abc');
    expect(shaped.anchor_timestamp).toBe('2026-04-11T10:00:00Z');
    expect(shaped.issued_date).toBe('2026-01-02T00:00:00Z');
    expect(shaped.expiry_date).toBe('2031-01-02T00:00:00Z');
    expect(shaped.recipient_identifier).toBe('c'.repeat(64));
  });

  it('does NOT read the legacy wrong keys (org_name/chain_tx_id/created_at/recipient_hash/issued_at/expires_at)', () => {
    // A row that ONLY carries the old wrong keys must map to defaults —
    // proving the mapper no longer reads them.
    const wrongKeyRow: Record<string, unknown> = {
      status: 'ACTIVE',
      org_name: 'Should Be Ignored',
      chain_tx_id: 'ignored-tx',
      created_at: '2020-01-01T00:00:00Z',
      recipient_hash: 'ignored-hash',
      issued_at: '2019-01-01T00:00:00Z',
      expires_at: '2021-01-01T00:00:00Z',
    };

    const shaped = shapeAnchorRow(wrongKeyRow);

    expect(shaped.issuer_name).toBe('Unknown');
    expect(shaped.network_receipt_id).toBeNull();
    expect(shaped.anchor_timestamp).toBeNull();
    expect(shaped.recipient_identifier).toBe('');
    expect(shaped.issued_date).toBeNull();
    expect(shaped.expiry_date).toBeNull();
  });

  it('yields nulls for gated fields on a PENDING row (anchor_timestamp default null, not empty string)', () => {
    const row = pendingPublicAnchorRow();

    const shaped = shapeAnchorRow(row);

    expect(shaped.verified).toBe(false);
    expect(shaped.status).toBe('UNKNOWN'); // PENDING not in mapStatus -> UNKNOWN
    expect(shaped.network_receipt_id).toBeNull();
    expect(shaped.anchor_timestamp).toBeNull();
    // issuer/dates still present on the row even while gated fields are null
    expect(shaped.issuer_name).toBe('University of Michigan');
  });

  it('echoes public_id only when provided (batch contract)', () => {
    const row = realPublicAnchorRow();
    expect(shapeAnchorRow(row)).not.toHaveProperty('public_id');
    expect(shapeAnchorRow(row, 'ARK-XYZ')).toMatchObject({ public_id: 'ARK-XYZ' });
  });

  it('never leaks internal id / record_id even if the RPC row carries them', () => {
    const row = realPublicAnchorRow({ id: 'internal-uuid', record_id: 'rec-uuid' } as never);
    const shaped = shapeAnchorRow(row);
    expect(shaped).not.toHaveProperty('id');
    expect(shaped).not.toHaveProperty('record_id');
  });
});

// ── handleVerifyCredential via the real fixture ──────────────────────

describe('handleVerifyCredential (real RPC fixture)', () => {
  it('maps a SECURED row to truthful, value-asserting envelope', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => realPublicAnchorRow({ network_receipt_id: 'tx-secured-1' }),
    });

    const result = await handleVerifyCredential({ public_id: 'ARK-2026-001' }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe('ACTIVE');
    expect(parsed.issuer_name).toBe('University of Michigan');
    expect(parsed.network_receipt_id).toBe('tx-secured-1');
    expect(parsed.anchor_timestamp).toBe('2026-04-11T10:00:00Z');
  });

  it('maps a PENDING row to unverified with null gated fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => pendingPublicAnchorRow(),
    });

    const result = await handleVerifyCredential({ public_id: 'ARK-PENDING' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.network_receipt_id).toBeNull();
    expect(parsed.anchor_timestamp).toBeNull();
  });
});

// ── handleVerifyBatch via the real fixture ───────────────────────────

describe('handleVerifyBatch (real RPC fixture)', () => {
  it('preserves input order and carries the truthful issuer/receipt per row', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        realPublicAnchorRow({
          issuer_name: 'University of Michigan',
          network_receipt_id: 'tx-batch-1',
          recipient_identifier: 'd'.repeat(64),
        }),
    });

    const result = await handleVerifyBatch(
      { public_ids: ['ARK-2026-001', 'ARK-2026-002'] },
      CONFIG,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.results[0].public_id).toBe('ARK-2026-001');
    expect(parsed.results[1].public_id).toBe('ARK-2026-002');
    expect(parsed.results[0].issuer_name).toBe('University of Michigan');
    expect(parsed.results[0].network_receipt_id).toBe('tx-batch-1');
    expect(parsed.results[0].recipient_identifier).toBe('d'.repeat(64));
  });
});

// ── BUG-3b: lowercase nessie source literals ─────────────────────────

describe('nessieTextFallback source casing (BUG-3b)', () => {
  const seededRow = {
    id: 'rec-1',
    title: 'Apple Inc. 10-K',
    source: 'edgar',
    source_url: 'https://sec.gov/x',
    record_type: '10-K',
    content_hash: 'e'.repeat(64),
    anchor_id: 'anchor-1',
    created_at: '2026-01-01T00:00:00Z',
  };

  it('emits a LOWERCASE source=eq.edgar filter for a SEC-filing query and returns the seeded row', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [seededRow],
    });

    // No `ai` -> handleNessieQuery returns the text-fallback result directly.
    const result = await handleNessieQuery({ query: 'Apple SEC filing' }, CONFIG);
    expect(result.isError).toBeUndefined();

    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('source=eq.edgar');
    expect(url).not.toContain('source=eq.EDGAR');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].source).toBe('edgar');
  });

  it('emits lowercase literals in the multi-source source=in.(...) branch', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // "patent" + "research" -> uspto + openalex -> in.(...) branch.
    await handleNessieQuery({ query: 'patent research publication' }, CONFIG);

    const url = decodeURIComponent(String(mockFetch.mock.calls[0][0]));
    expect(url).toContain('source=in.(uspto,openalex)');
    expect(url).not.toContain('USPTO');
    expect(url).not.toContain('OPENALEX');
  });

  it('uspto, federal_register literals are lowercase', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await handleNessieQuery({ query: 'federal regulation' }, CONFIG);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('source=eq.federal_register');
  });
});
