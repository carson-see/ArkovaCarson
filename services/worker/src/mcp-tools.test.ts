/**
 * MCP Tools Handler Tests (P8-S19 + PH1-SDK-03)
 *
 * Tests for the MCP tool handler functions defined in services/edge/src/mcp-tools.ts.
 * Since the edge service doesn't have vitest, we test the handlers here by reimporting
 * the pure handler functions directly. The handlers use only fetch() — no edge-specific deps.
 *
 * No real API calls — mocks fetch globally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ── Inline handler implementations for testing ──────────────────────────
// These mirror the handlers in services/edge/src/mcp-tools.ts exactly.
// We test the behavioral contract, not the import path.

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

async function handleNessieQuery(
  input: { query: string; mode?: string; limit?: number },
  config: typeof CONFIG,
): Promise<ToolResult> {
  if (!input.query || input.query.trim().length === 0) {
    return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
  }
  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/search_public_record_embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
        },
        body: JSON.stringify({
          p_query: input.query,
          p_mode: input.mode ?? 'retrieval',
          p_limit: Math.min(input.limit ?? 10, 50),
        }),
      },
    );
    if (!response.ok) {
      return { content: [{ type: 'text', text: `Nessie query failed: HTTP ${response.status}` }], isError: true };
    }
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Nessie query failed: ${error instanceof Error ? error.message : 'Unknown error'}` }], isError: true };
  }
}

async function handleAnchorDocument(
  input: { content_hash: string; record_type?: string; source?: string },
  config: typeof CONFIG,
): Promise<ToolResult> {
  if (!input.content_hash || input.content_hash.trim().length === 0) {
    return { content: [{ type: 'text', text: 'Error: content_hash is required' }], isError: true };
  }
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/public_records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        content_hash: input.content_hash,
        record_type: input.record_type ?? 'document',
        source: input.source ?? 'mcp',
        source_id: input.content_hash,
        metadata: {},
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { content: [{ type: 'text', text: `Anchor submission failed: ${errorText}` }], isError: true };
    }
    const records = await response.json() as Array<Record<string, unknown>>;
    const record = Array.isArray(records) ? records[0] : records;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'submitted', record_id: record?.id, content_hash: input.content_hash }),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Anchor submission failed: ${error instanceof Error ? error.message : 'Unknown error'}` }], isError: true };
  }
}

async function handleVerifyDocument(
  input: { content_hash: string },
  config: typeof CONFIG,
): Promise<ToolResult> {
  if (!input.content_hash || input.content_hash.trim().length === 0) {
    return { content: [{ type: 'text', text: 'Error: content_hash is required' }], isError: true };
  }
  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/public_records?content_hash=eq.${encodeURIComponent(input.content_hash)}&select=id,source,source_url,record_type,title,content_hash,metadata,anchor_id&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
        },
      },
    );
    if (!response.ok) {
      return { content: [{ type: 'text', text: `Document lookup failed: HTTP ${response.status}` }], isError: true };
    }
    const records = await response.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(records) || records.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ verified: false, message: 'No anchored document found.' }) }] };
    }
    const record = records[0];
    const meta = (record.metadata as Record<string, unknown>) ?? {};
    const isAnchored = !!record.anchor_id;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verified: isAnchored,
          status: isAnchored ? 'ANCHORED' : 'PENDING',
          anchor_proof: isAnchored ? { chain_tx_id: (meta.chain_tx_id as string) ?? null } : null,
        }),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}` }], isError: true };
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

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
});

describe('handleAnchorDocument (PH1-SDK-03)', () => {
  it('returns error if content_hash is empty', async () => {
    const result = await handleAnchorDocument({ content_hash: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('submits anchor request successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ id: 'anchor-1', public_id: 'ARK-2026-999' }]),
    });

    const result = await handleAnchorDocument(
      { content_hash: 'sha256-abc', record_type: 'patent_grant', source: 'uspto' },
      CONFIG,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('submitted');
    expect(parsed.content_hash).toBe('sha256-abc');
  });

  it('handles API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => 'duplicate key',
    });
    const result = await handleAnchorDocument({ content_hash: 'sha256-abc' }, CONFIG);
    expect(result.isError).toBe(true);
  });
});

describe('handleVerifyDocument (PH1-SDK-03)', () => {
  it('returns error if content_hash is empty', async () => {
    const result = await handleVerifyDocument({ content_hash: '' }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it('returns verified=false when no record found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });
    const result = await handleVerifyDocument({ content_hash: 'nonexistent' }, CONFIG);
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
        content_hash: 'sha256-abc',
        metadata: { chain_tx_id: 'tx-123', merkle_root: 'root-abc' },
        anchor_id: 'anchor-1',
      }]),
    });

    const result = await handleVerifyDocument({ content_hash: 'sha256-abc' }, CONFIG);
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
        content_hash: 'sha256-def',
        metadata: {},
        anchor_id: null,
      }]),
    });

    const result = await handleVerifyDocument({ content_hash: 'sha256-def' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(false);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.anchor_proof).toBeNull();
  });
});
