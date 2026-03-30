/**
 * MCP Tools Handler Tests (P8-S19 + PH1-SDK-03)
 *
 * Tests for the MCP tool handler functions defined in services/edge/src/mcp-tools.ts.
 * Imports the actual handlers — no inline reimplementations.
 *
 * No real API calls — mocks fetch globally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves it fine at runtime
import {
  handleNessieQuery,
  handleAnchorDocument,
  handleVerifyDocument,
  handleVerifyCredential,
  handleSearchCredentials,
  TOOL_DEFINITIONS,
} from '../../edge/src/mcp-tools.js';

const CONFIG = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseKey: 'test-key',
};

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────

describe('TOOL_DEFINITIONS', () => {
  it('exports 5 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(5);
  });

  it('all tools have name, description, and inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required.length).toBeGreaterThan(0);
    }
  });
});

// ── handleVerifyCredential ────────────────────────────────────────────

describe('handleVerifyCredential', () => {
  it('returns error if public_id is empty', async () => {
    const result = await handleVerifyCredential({ public_id: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('returns verified result for SECURED anchor', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        org_name: 'Test Org',
        credential_type: 'DEGREE',
        created_at: '2026-01-01',
      }),
    });

    const result = await handleVerifyCredential({ public_id: 'ARK-2026-001' }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe('ACTIVE');
  });

  it('returns not found for failed lookup', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await handleVerifyCredential({ public_id: 'ARK-MISSING' }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
  });
});

// ── handleSearchCredentials ───────────────────────────────────────────

describe('handleSearchCredentials', () => {
  it('returns error if query is empty', async () => {
    const result = await handleSearchCredentials({ query: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('returns empty results array when no matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });
    const result = await handleSearchCredentials({ query: 'nonexistent' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it('maps results correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { public_id: 'ARK-001', title: 'Test', credential_type: 'DEGREE', status: 'SECURED', created_at: '2026-01-01' },
      ]),
    });
    const result = await handleSearchCredentials({ query: 'test', max_results: 5 }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].rank).toBe(1);
    expect(parsed.results[0].status).toBe('ACTIVE');
  });
});

// ── handleNessieQuery ─────────────────────────────────────────────────

describe('handleNessieQuery (PH1-SDK-03)', () => {
  it('returns error if query is empty', async () => {
    const result = await handleNessieQuery({ query: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('returns results from Nessie endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ public_record_id: 'rec-1', similarity: 0.91 }]),
    });

    const result = await handleNessieQuery({ query: 'apple annual report' }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
  });

  it('handles fetch failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await handleNessieQuery({ query: 'test' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('passes mode and limit to RPC', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });

    await handleNessieQuery({ query: 'test', mode: 'context', limit: 5 }, CONFIG);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_mode).toBe('context');
    expect(body.p_limit).toBe(5);
  });

  it('caps limit at 50', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });

    await handleNessieQuery({ query: 'test', limit: 999 }, CONFIG);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_limit).toBe(50);
  });
});

// ── handleAnchorDocument ──────────────────────────────────────────────

describe('handleAnchorDocument (PH1-SDK-03)', () => {
  const validHash = 'a'.repeat(64);

  it('returns error if content_hash is empty', async () => {
    const result = await handleAnchorDocument({ content_hash: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('rejects non-SHA-256 content_hash', async () => {
    const result = await handleAnchorDocument({ content_hash: 'not-a-hash' }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SHA-256');
  });

  it('submits anchor request successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ id: 'anchor-1', public_id: 'ARK-2026-999' }]),
    });

    const result = await handleAnchorDocument(
      { content_hash: validHash, record_type: 'patent_grant', source: 'uspto' },
      CONFIG,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('submitted');
    expect(parsed.content_hash).toBe(validHash);
    expect(parsed.public_id).toBe('ARK-2026-999');
  });

  it('handles API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => 'duplicate key',
    });
    const result = await handleAnchorDocument({ content_hash: validHash }, CONFIG);
    expect(result.isError).toBe(true);
  });
});

// ── handleVerifyDocument ──────────────────────────────────────────────

describe('handleVerifyDocument (PH1-SDK-03)', () => {
  const validHash = 'b'.repeat(64);

  it('returns error if content_hash is empty', async () => {
    const result = await handleVerifyDocument({ content_hash: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('rejects non-SHA-256 content_hash', async () => {
    const result = await handleVerifyDocument({ content_hash: 'xyz' }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SHA-256');
  });

  it('returns verified=false when no record found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });
    const result = await handleVerifyDocument({ content_hash: validHash }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
  });

  it('returns anchor proof when document is anchored', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'rec-1',
        source: 'edgar',
        source_url: 'https://sec.gov/filing/123',
        record_type: '10-K',
        title: 'Apple Annual Report',
        content_hash: validHash,
        metadata: { chain_tx_id: 'tx-123', merkle_root: 'root-abc' },
        anchor_id: 'anchor-1',
      }]),
    });

    const result = await handleVerifyDocument({ content_hash: validHash }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe('ANCHORED');
    expect(parsed.anchor_proof.chain_tx_id).toBe('tx-123');
  });

  it('returns PENDING when not yet anchored', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'rec-2',
        source: 'mcp',
        content_hash: validHash,
        metadata: {},
        anchor_id: null,
      }]),
    });

    const result = await handleVerifyDocument({ content_hash: validHash }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.anchor_proof).toBeNull();
  });
});

// ── Timeout handling ──────────────────────────────────────────────────

describe('timeout handling', () => {
  it('reports timeout on AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortError);

    const result = await handleVerifyCredential({ public_id: 'ARK-001' }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
  });
});

// ── Fetch includes AbortSignal ────────────────────────────────────────

describe('fetch signal', () => {
  it('passes AbortSignal to fetch calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'SECURED', created_at: '2026-01-01' }),
    });

    await handleVerifyCredential({ public_id: 'ARK-001' }, CONFIG);
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
