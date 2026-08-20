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
  handleVerifyDocument,
  handleAgentVerify,
  handleNessieQuery,
  handleSearchCredentials,
  SEARCH_MODE_SEMANTIC,
  SEARCH_MODE_LEXICAL,
  TOOL_DEFINITIONS,
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
  // BUG-008/027: `nessieEnabled` is fail-closed (absent === disabled). The
  // pre-existing suites below exercise the ENABLED behaviour, so the shared
  // fixture turns it on explicitly; the disabled contract has its own describe
  // block, which omits/clears it.
  nessieEnabled: true,
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

  // ── SCRUM-2226: bitcoin_block propagation ──────────────────────────
  // The `get_public_anchor` RPC emits `bitcoin_block`
  // (= a.chain_block_height, gated to NULL for PENDING — see migration
  // 0311_scrum1599_public_anchor_provenance.sql line ~34). The BUG-2 key
  // realignment fixed the six mismatched keys but never surfaced this
  // seventh field: the mapper silently dropped the on-chain block height,
  // so the public verification envelope could not show *which* block
  // confirmed the anchor. These two cases lock the field into the
  // contract and gate it the same way the RPC does.
  it('propagates bitcoin_block from a SECURED row into the envelope', () => {
    const row = realPublicAnchorRow({ bitcoin_block: 840000 });

    const shaped = shapeAnchorRow(row);

    // Currently dropped: shapeAnchorRow never reads/emits bitcoin_block.
    expect(shaped.bitcoin_block).toBe(840000);
  });

  it('yields null bitcoin_block on a PENDING row (gated like the RPC)', () => {
    const row = pendingPublicAnchorRow();

    const shaped = shapeAnchorRow(row);

    // PENDING anchors have no confirmed block yet — the RPC gates
    // bitcoin_block to NULL, so the mapper must surface null (not omit it).
    expect(shaped.bitcoin_block).toBeNull();
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
    // PENDING is surfaced as a first-class in-flight status (not collapsed to
    // UNKNOWN) so a genuinely-found in-flight anchor doesn't read not-found.
    expect(shaped.status).toBe('PENDING');
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

// ── BUG-1: verify-by-fingerprint via get_public_anchor_by_fingerprint ─
//
// handleVerifyDocument used to fetch
//   /rest/v1/public_records?content_hash=eq...&select=...public_id...
// which 400s in prod (the select column set / table shape is wrong) and,
// even when it didn't, returned a non-canonical shape. PR-2 re-points it at
// the SECURITY DEFINER RPC get_public_anchor_by_fingerprint and maps secured
// results through shapeAnchorRow. Unlike public_id verification, fingerprint
// lookup intentionally hides in-flight anchors so it cannot expose pending
// content-hash existence globally.
//
// ── SCOPE OF THE TWO "filtered by RPC" TESTS BELOW (read before trusting them)
//
// The PENDING and SUBMITTED cases below assert that THIS EDGE LAYER maps a
// `{error:'Record not found'}` RPC response to a `status:'UNKNOWN'` envelope.
// They do NOT — and structurally cannot — assert that the RPC actually filters
// those statuses: the filtering is supplied by `mockFetch`, not observed.
//
// That gap was not theoretical. Production drifted from migration 0339 to
// `status IN ('SECURED','SUBMITTED','PENDING')` with no migration on main
// recording it, making 3 PENDING + 48,149 SUBMITTED anchors confirmable by an
// anonymous caller — while these tests stayed green, because the fixture kept
// asserting the premise the database had stopped honouring. Migration 0386
// restores the invariant.
//
// The database half is now pinned against the REAL function by
// `tests/rls/fingerprint-lookup-secured-only.test.ts` (live anon client, live
// Postgres). Keep both: this file owns the edge layer's mapping, that file owns
// the SQL predicate. A mock may stand in for a collaborator, never for the
// invariant under test — when the assertion is "the database refuses to
// answer", the database has to be the one refusing.

const FP = 'f'.repeat(64);

describe('handleVerifyDocument (BUG-1: RPC by fingerprint)', () => {
  it('SECURED fingerprint → verified:true, ACTIVE, non-null public_id + receipt + record_uri', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        realPublicAnchorRow({
          public_id: 'ARK-2026-001',
          network_receipt_id: 'tx-secured-fp',
        }),
    });

    const result = await handleVerifyDocument({ content_hash: FP }, CONFIG);
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe('ACTIVE');
    expect(parsed.public_id).toBe('ARK-2026-001');
    expect(parsed.network_receipt_id).toBe('tx-secured-fp');
    expect(parsed.record_uri).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('hits the RPC get_public_anchor_by_fingerprint, NOT /rest/v1/public_records?...public_id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => realPublicAnchorRow(),
    });

    await handleVerifyDocument({ content_hash: FP }, CONFIG);

    const url = String(mockFetch.mock.calls[0][0]);
    const init = mockFetch.mock.calls[0][1] ?? {};
    expect(url).toContain('/rest/v1/rpc/get_public_anchor_by_fingerprint');
    expect(init.method).toBe('POST');
    // Negative guard: must NOT use the old broken public_records query.
    expect(url).not.toContain('/rest/v1/public_records');
    expect(url).not.toContain('select=');
  });

  it('lowercases a mixed-case fingerprint before sending it to the RPC', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => realPublicAnchorRow(),
    });

    const mixed = 'A'.repeat(32) + 'b'.repeat(32);
    await handleVerifyDocument({ content_hash: mixed }, CONFIG);

    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.p_fingerprint).toBe(mixed.toLowerCase());
  });

  it('unknown fingerprint (RPC returns {error}) → verified:false, status UNKNOWN, NOT an error result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Record not found' }),
    });

    const result = await handleVerifyDocument({ content_hash: FP }, CONFIG);
    // Crucial: this is HTTP-200-equivalent, not a 400/error tool result.
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.status).toBe('UNKNOWN');
    expect(parsed.network_receipt_id).toBeNull();
    expect(parsed.public_id).toBeNull();
    // Contract parity with the worker's not-found body: echo the lowercased
    // fingerprint that was looked up.
    expect(parsed.fingerprint).toBe(FP);
  });

  it('echoes the lowercased fingerprint on the UNKNOWN envelope (case-normalized)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Record not found' }),
    });

    const mixed = 'A'.repeat(32) + 'b'.repeat(32);
    const result = await handleVerifyDocument({ content_hash: mixed }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fingerprint).toBe(mixed.toLowerCase());
  });

  it('PENDING fingerprint filtered by RPC → UNKNOWN, not an existence leak', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Record not found' }),
    });

    const result = await handleVerifyDocument({ content_hash: FP }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.status).toBe('UNKNOWN');
    expect(parsed.public_id).toBeNull();
    expect(parsed.network_receipt_id).toBeNull();
    expect(parsed.anchor_timestamp).toBeNull();
  });

  it('SUBMITTED fingerprint filtered by RPC → UNKNOWN until secured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Record not found' }),
    });

    const result = await handleVerifyDocument({ content_hash: FP }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.status).toBe('UNKNOWN');
    expect(parsed.public_id).toBeNull();
    expect(parsed.network_receipt_id).toBeNull();
  });
});

describe('handleAgentVerify (BUG-1: strips internal ids)', () => {
  it('returns the canonical shape with no record_id / internal id leak', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        realPublicAnchorRow({ public_id: 'ARK-2026-001' } as never),
    });

    const result = await handleAgentVerify({ fingerprint: FP }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.public_id).toBe('ARK-2026-001');
    expect(parsed).not.toHaveProperty('record_id');
    expect(parsed).not.toHaveProperty('id');
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

// ── BUG-3a (PR-3): re-route vector search through the worker (Gemini-space) ──
//
// The edge used to embed queries with Cloudflare bge-base and hit the
// pgvector RPC directly — but the index is built in Gemini space, so those
// neighbours were meaningless. PR-3 proxies the query to the worker's single
// Gemini embedder and FORWARDS THE CALLER'S API KEY (org-scoping + per-caller
// rate limits preserved — never a shared service-account key).

describe('handleNessieQuery worker proxy (BUG-3a)', () => {
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

  // Config carrying the worker base URL + the caller's raw API key. When
  // `workerBaseUrl` is set the proxy path is active; the caller key is what
  // the worker uses to org-scope + rate-limit.
  const PROXY_CONFIG: SupabaseConfig = {
    ...CONFIG,
    workerBaseUrl: 'https://worker.test.internal',
    callerApiKey: 'ak_live_caller_secret_key',
  };

  const workerResult = {
    record_id: 'rec-gemini-1',
    source: 'edgar',
    source_url: 'https://sec.gov/y',
    record_type: '10-K',
    title: 'Tesla Inc. 10-K',
    relevance_score: 0.91,
    anchor_proof: {
      chain_tx_id: 'a'.repeat(64),
      content_hash: 'b'.repeat(64),
      explorer_url: 'https://mempool.space/tx/' + 'a'.repeat(64),
      verify_url: 'https://app.arkova.ai/verify/ARK-DOC-XYZ',
    },
    metadata: {},
  };

  it('(a) calls the worker /api/v1/nessie/query URL with the forwarded X-API-Key (caller key, not service-role)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [workerResult], count: 1, query: 'Tesla filings' }),
    });

    await handleNessieQuery({ query: 'Tesla filings' }, PROXY_CONFIG);

    // The first call must be to the worker, not the Supabase RPC.
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('https://worker.test.internal/api/v1/nessie/query');
    expect(url).toContain('q=Tesla');

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Forwarded caller key — NOT the supabase service-role key.
    expect(headers['X-API-Key']).toBe('ak_live_caller_secret_key');
    expect(headers['X-API-Key']).not.toBe(CONFIG.supabaseKey);
    // Must NOT embed with Cloudflare bge-base anymore: no Supabase RPC hit.
    expect(url).not.toContain('search_public_record_embeddings');
  });

  it('(b) maps a worker hit with results → mode + non-zero total + results with citations/similarity', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [workerResult], count: 1, query: 'Tesla filings' }),
    });

    const result = await handleNessieQuery(
      { query: 'Tesla filings', mode: 'retrieval', limit: 5 },
      PROXY_CONFIG,
    );
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe('retrieval');
    expect(parsed.total).toBe(1);
    expect(parsed.results).toHaveLength(1);
    // Output contract: similarity + the anchor citation survive the mapping.
    expect(parsed.results[0].similarity).toBe(0.91);
    expect(parsed.results[0].source).toBe('edgar');
    expect(parsed.results[0].anchor_proof.verify_url).toBe(
      'https://app.arkova.ai/verify/ARK-DOC-XYZ',
    );
  });

  it('(b2) mode=context → maps worker {answer, citations, confidence} envelope (NOT total:0)', async () => {
    // The worker's mode=context branch returns a synthesized answer + citations
    // with NO top-level `results` field. The edge must preserve the answer +
    // citations instead of reading only `results` (which silently dropped them).
    const workerContextResponse = {
      answer: 'Tesla reported total revenue of $96.8B in its FY2024 10-K filing.',
      citations: [
        {
          record_id: 'rec-gemini-1',
          source: 'edgar',
          source_url: 'https://sec.gov/y',
          title: 'Tesla Inc. 10-K',
          relevance_score: 0.91,
          anchor_proof: {
            chain_tx_id: 'a'.repeat(64),
            content_hash: 'b'.repeat(64),
            explorer_url: 'https://mempool.space/tx/' + 'a'.repeat(64),
            verify_url: 'https://app.arkova.ai/verify/ARK-DOC-XYZ',
          },
          excerpt: 'Total revenues were $96,773 million for the year ended December 31, 2024.',
        },
      ],
      confidence: 0.87,
      model: 'gemini-2.0',
      query: 'Tesla revenue 2024',
      task_type: 'compliance_qa',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => workerContextResponse,
    });

    const result = await handleNessieQuery(
      { query: 'Tesla revenue 2024', mode: 'context', limit: 5 },
      PROXY_CONFIG,
    );
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe('context');
    // Regression guard: the synthesized answer must survive (was dropped → empty).
    expect(parsed.answer).toContain('$96.8B');
    expect(parsed.confidence).toBe(0.87);
    // Citations carry through with similarity + anchor proof + excerpt.
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.citations[0].similarity).toBe(0.91);
    expect(parsed.citations[0].anchor_proof.verify_url).toBe(
      'https://app.arkova.ai/verify/ARK-DOC-XYZ',
    );
    expect(parsed.citations[0].excerpt).toContain('$96,773 million');
    // Must NOT report total:0 when a real answer + citations were returned.
    expect(parsed.total).toBe(1);
    expect(parsed.total).not.toBe(0);
  });

  it('(b3) mode=context worker graceful-fallback (emits results) → maps as retrieval', async () => {
    // The worker can fall back to retrieval inside context mode on a generation
    // failure, emitting {results, fallback:true}. The edge must map those.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [workerResult], count: 1, query: 'Tesla filings', fallback: true }),
    });

    const result = await handleNessieQuery(
      { query: 'Tesla filings', mode: 'context', limit: 5 },
      PROXY_CONFIG,
    );
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe('context');
    expect(parsed.total).toBe(1);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].similarity).toBe(0.91);
  });

  it('(b4) allows worker context generation to exceed the Supabase fetch timeout', async () => {
    vi.useFakeTimers();

    const workerContextResponse = {
      answer: 'Tesla reported total revenue of $96.8B in its FY2024 10-K filing.',
      citations: [
        {
          record_id: 'rec-gemini-1',
          source: 'edgar',
          source_url: 'https://sec.gov/y',
          title: 'Tesla Inc. 10-K',
          relevance_score: 0.91,
          anchor_proof: {
            chain_tx_id: 'a'.repeat(64),
            content_hash: 'b'.repeat(64),
            explorer_url: 'https://mempool.space/tx/' + 'a'.repeat(64),
            verify_url: 'https://app.arkova.ai/verify/ARK-DOC-XYZ',
          },
          excerpt: 'Total revenues were $96,773 million for the year ended December 31, 2024.',
        },
      ],
      confidence: 0.87,
      model: 'gemini-2.0',
      query: 'Tesla revenue 2024',
      task_type: 'compliance_qa',
    };

    mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        let settled = false;
        signal?.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({
            ok: true,
            json: async () => workerContextResponse,
          });
        }, 14_000);
      });
    });

    try {
      const pending = handleNessieQuery(
        { query: 'Tesla revenue 2024', mode: 'context', limit: 5 },
        PROXY_CONFIG,
      );

      await vi.advanceTimersByTimeAsync(14_000);
      const result = await pending;
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.mode).toBe('context');
      expect(parsed.total).toBe(1);
      expect(parsed.citations).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) worker error → graceful text fallback (does not throw, returns text_fallback)', async () => {
    // 1st call: worker proxy fails. 2nd call: text-fallback Supabase query.
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, json: async () => [seededRow] });

    const result = await handleNessieQuery({ query: 'Apple SEC filing' }, PROXY_CONFIG);
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe('text_fallback');
    expect(parsed.total).toBe(1);

    // The fallback call hit the Supabase public_records endpoint.
    const fallbackUrl = String(mockFetch.mock.calls[1][0]);
    expect(fallbackUrl).toContain('/rest/v1/public_records');
  });

  it('(d) never logs the caller API key', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Force the worker path to throw so error logging runs, then fall back.
    mockFetch.mockReset();
    mockFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: async () => [seededRow] });

    await handleNessieQuery({ query: 'Apple SEC filing' }, PROXY_CONFIG);

    const allLogged = [...errSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(allLogged).not.toContain('ak_live_caller_secret_key');

    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── search_credentials: real semantic path + truthful mode label ──────────
//
// The tool advertised "semantic similarity matching" on six public surfaces
// while BOTH code paths were lexical: the `search_public_credentials` RPC is
// an ILIKE `%query%` scan, and its fallback is a direct-table ILIKE on
// filename/description. Nothing was gated by ENABLE_SEMANTIC_SEARCH, so
// flipping that flag could not have made the claim true.
//
// The fix mirrors the nessie BUG-3a discipline: proxy the vector path to the
// worker's single Gemini embedder (the model that actually built
// `credential_embeddings`) and NEVER embed at the edge. Every payload now
// carries `search_mode` so a lexical substring hit can no longer masquerade
// as a vector match.

describe('handleSearchCredentials — semantic path + search_mode labelling', () => {
  const SEARCH_PROXY_CONFIG: SupabaseConfig = {
    ...CONFIG,
    workerBaseUrl: 'https://worker.test.internal',
    callerApiKey: 'ak_live_search_caller_secret',
  };

  const workerHit = {
    verified: true,
    status: 'SECURED',
    issuer_name: 'University of Michigan',
    credential_type: 'DEGREE',
    issued_date: '2026-01-02',
    expiry_date: null,
    anchor_timestamp: '2026-02-03T10:00:00Z',
    record_uri: 'https://app.arkova.ai/verify/ARK-DEG-001',
    similarity: 0.88,
  };

  it('(a) proxies to the worker /api/v1/verify/search with the caller X-API-Key and reports semantic_vector', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [workerHit], count: 1, query: 'michigan cs degree' }),
    });

    const result = await handleSearchCredentials(
      { query: 'michigan cs degree' },
      SEARCH_PROXY_CONFIG,
    );

    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('/api/v1/verify/search');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(
      'ak_live_search_caller_secret',
    );
    // Never the service-role/supabase key.
    expect(JSON.stringify(init.headers)).not.toContain('test-key');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.search_mode).toBe(SEARCH_MODE_SEMANTIC);
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].similarity).toBe(0.88);
    expect(parsed.results[0].public_id).toBe('ARK-DEG-001');
    expect(parsed.results[0].issuer_name).toBe('University of Michigan');
  });

  it('(b) a zero-hit semantic response stays semantic and does NOT fall through to lexical', async () => {
    // An empty embeddings index returns count:0. That is a real semantic
    // answer of "no matches" — silently re-running a substring scan would
    // relabel a lexical result as semantic.
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], count: 0, query: 'nothing' }),
    });

    const result = await handleSearchCredentials({ query: 'nothing' }, SEARCH_PROXY_CONFIG);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.search_mode).toBe(SEARCH_MODE_SEMANTIC);
    expect(parsed.total).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('(c) worker 503 (ENABLE_SEMANTIC_SEARCH gate closed) → lexical fallback, labelled lexical_substring', async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'service_unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            public_id: 'ARK-DEG-002',
            title: 'transcript.pdf',
            credential_type: 'DEGREE',
            status: 'SECURED',
            created_at: '2026-02-03T10:00:00Z',
          },
        ],
      });

    const result = await handleSearchCredentials({ query: 'transcript' }, SEARCH_PROXY_CONFIG);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.search_mode).toBe(SEARCH_MODE_LEXICAL);
    expect(parsed.total).toBe(1);
    // No fabricated relevance score on the lexical path.
    expect(parsed.results[0].similarity).toBeUndefined();
    expect(String(mockFetch.mock.calls[1][0])).toContain('/rest/v1/rpc/search_public_credentials');
  });

  it('(d) unconfigured worker (no base URL / key) goes straight to lexical and never claims semantic', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const result = await handleSearchCredentials({ query: 'anything' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.search_mode).toBe(SEARCH_MODE_LEXICAL);
    // Only the Supabase RPC was called — no worker round-trip attempted.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/rest/v1/rpc/');
  });

  it('(e) REGRESSION: the direct-table ILIKE fallback is never labelled semantic', async () => {
    // RPC fails → direct-table ILIKE on filename/description. This is the
    // path the claims audit flagged; it must self-identify as lexical.
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'gate closed' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'statement timeout' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            public_id: 'ARK-DEG-003',
            filename: 'michigan-degree.pdf',
            credential_type: 'DEGREE',
            status: 'SECURED',
            created_at: '2026-02-03T10:00:00Z',
          },
        ],
      });

    const result = await handleSearchCredentials({ query: 'michigan' }, SEARCH_PROXY_CONFIG);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.search_mode).toBe(SEARCH_MODE_LEXICAL);
    expect(parsed.search_mode).not.toBe(SEARCH_MODE_SEMANTIC);
    expect(String(mockFetch.mock.calls[2][0])).toContain('/rest/v1/anchors?');
  });

  it('(f) clamps max_results to the worker limit ceiling of 20', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], count: 0 }),
    });

    await handleSearchCredentials({ query: 'q', max_results: 50 }, SEARCH_PROXY_CONFIG);

    const url = decodeURIComponent(String(mockFetch.mock.calls[0][0]));
    expect(url).toContain('limit=20');
  });

  it('(g) never logs the caller API key on the fallback path', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetch.mockReset();
    mockFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    await handleSearchCredentials({ query: 'q' }, SEARCH_PROXY_CONFIG);

    const allLogged = [...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(allLogged).not.toContain('ak_live_search_caller_secret');

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('(h) the advertised tool description documents search_mode instead of promising semantic unconditionally', async () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'search_credentials');
    expect(def).toBeDefined();
    // The description must tell an agent how to tell the two modes apart.
    expect(def!.description).toContain('search_mode');
    expect(def!.description).toContain('lexical_substring');
    expect(def!.description).toContain('semantic_vector');
  });
});

// ─── BUG-008 / BUG-027: nessie_query must fail CLOSED ────────────────────────

/**
 * CTO ruling R-1 STRENGTHENED
 * (`docs/staging/fullsoak-2026-08/cto-claims-rulings-2026-08-12.md`).
 *
 * Nessie is permanently disabled by standing founder directive. The worker
 * endpoint answered HTTP 200 with a success shape — and this edge tool made it
 * worse: on ANY non-2xx from the worker it degraded to `nessieTextFallback`, a
 * lexical scan of public_records, and returned `{total, results}`. So even once
 * the worker started refusing, the MCP tool would have answered as though a
 * disabled capability had run. Fail-open, twice over.
 *
 * Contract pinned here: a disabled Nessie produces a result an agent can
 * recognise as disabled — `isError`, `enabled:false`, a stable code — carrying
 * NONE of the keys that mean "it ran" (`total`/`results`/`answer`/`confidence`/
 * `citations`), and it does NOT fall back to text search.
 */
describe('handleNessieQuery — capability disabled (BUG-008/027)', () => {
  const DISABLED_CONFIG: SupabaseConfig = {
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    userId: 'test-user-id',
    // nessieEnabled deliberately ABSENT — absence must mean disabled.
  };

  const SUCCESS_SHAPE_KEYS = ['total', 'results', 'answer', 'confidence', 'citations'];

  it('treats an ABSENT flag as disabled (fail closed, not fail open)', async () => {
    const result = await handleNessieQuery({ query: 'anything' }, DISABLED_CONFIG);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ code: 'nessie_disabled', enabled: false });
  });

  it('does NOT hit the network at all when disabled', async () => {
    await handleNessieQuery({ query: 'anything' }, DISABLED_CONFIG);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT degrade to the lexical text fallback (the fail-open path)', async () => {
    const result = await handleNessieQuery({ query: 'Apple SEC filing' }, DISABLED_CONFIG);

    const parsed = JSON.parse(result.content[0].text);
    for (const key of SUCCESS_SHAPE_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it('stays disabled even when a worker + caller key ARE configured', async () => {
    const result = await handleNessieQuery(
      { query: 'Tesla filings' },
      {
        ...DISABLED_CONFIG,
        workerBaseUrl: 'https://worker.test.internal',
        callerApiKey: 'ak_live_x',
      },
    );

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('PROPAGATES the worker disabled envelope instead of falling back to text search', async () => {
    // Edge flag on, worker flag off — the worker is the authority, and its
    // "disabled" must survive the hop rather than become a lexical answer.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({
        error: 'capability_disabled',
        code: 'nessie_disabled',
        capability: 'nessie',
        enabled: false,
        message: 'disabled',
      }),
    });

    const result = await handleNessieQuery(
      { query: 'Tesla filings' },
      {
        ...CONFIG,
        workerBaseUrl: 'https://worker.test.internal',
        callerApiKey: 'ak_live_caller_secret_key',
      },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ code: 'nessie_disabled', enabled: false });
    for (const key of SUCCESS_SHAPE_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }
    // Exactly one call — the worker probe. No Supabase text-fallback query.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still falls back to text search on an ORDINARY worker failure (500) — that is not "disabled"', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    const result = await handleNessieQuery(
      { query: 'Apple SEC filing' },
      {
        ...CONFIG,
        workerBaseUrl: 'https://worker.test.internal',
        callerApiKey: 'ak_live_caller_secret_key',
      },
    );

    // Degraded but honest: a transient worker fault is not a disabled
    // capability, so the labelled lexical fallback is still the right answer.
    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── BUG-026: search_credentials must describe what it actually does ─────────

/**
 * Reproduced on the rig: the non-word fragment `aten` matched
 * `Patent_Application_AI_Method.pdf` (a substring hit), an English paraphrase
 * of the same document returned 0, and the worker's semantic endpoint answered
 * 503 `Semantic search is not currently enabled`. Meanwhile the published
 * description LED with "Uses semantic (vector) similarity matching".
 *
 * The fix is descriptive, not behavioural — no semantic search is implemented
 * here. What is pinned: the description states the served behaviour first, and
 * does not assert semantic matching as the unconditional default.
 */
describe('search_credentials tool description — honest by default (BUG-026)', () => {
  const def = () => TOOL_DEFINITIONS.find((t) => t.name === 'search_credentials')!;

  it('names lexical substring matching as what the tool does', () => {
    expect(def().description.toLowerCase()).toContain('substring');
  });

  it('does not assert unconditional semantic/vector matching', () => {
    const description = def().description;
    // The old lead sentence, and its server-card twin. Any phrasing that says
    // the tool "uses" semantic matching, full stop, is the BUG-026 claim.
    expect(description).not.toMatch(/uses semantic \(vector\) similarity matching/i);
    expect(description).not.toMatch(/uses semantic similarity matching/i);
  });

  it('describes the semantic path as conditional, not as the default', () => {
    // The vector path needs a configured worker AND an open
    // ENABLE_SEMANTIC_SEARCH gate — neither of which the caller controls.
    expect(def().description).toMatch(/\b(only when|when the|if the)\b/i);
  });
});
