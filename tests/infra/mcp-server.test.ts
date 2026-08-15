/**
 * Tests for the Arkova MCP Server (P8-S19).
 *
 * Validates tool registration, input validation, and response format.
 * Tests run against the shared logic module (not the CF Worker runtime).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TOOL_DEFINITIONS,
  handleVerifyCredential,
  handleSearchCredentials,
  handleAnchorDocument,
  handleVerifyDocument,
  type VerifyInput,
  type SearchInput,
} from '../../services/edge/src/mcp-tools';

describe('MCP Tool Definitions', () => {
  it('exports verify_credential tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'verify_credential');
    expect(tool).toBeDefined();
    expect(tool!.description).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('public_id');
  });

  it('exports search_credentials tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'search_credentials');
    expect(tool).toBeDefined();
    expect(tool!.description).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('query');
  });

  it('all tools have required fields', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('handleVerifyCredential', () => {
  it('returns verification result for a valid public_id', async () => {
    const input: VerifyInput = { public_id: 'ARK-2026-001' };
    const result = await handleVerifyCredential(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      userId: 'test-user',
    });

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty('type', 'text');
  });

  it('returns error for empty public_id', async () => {
    const input: VerifyInput = { public_id: '' };
    const result = await handleVerifyCredential(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      userId: 'test-user',
    });

    expect(result.isError).toBe(true);
  });
});

describe('handleSearchCredentials', () => {
  it('returns search results for a query', async () => {
    const input: SearchInput = { query: 'University of Michigan degree' };
    const result = await handleSearchCredentials(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      userId: 'test-user',
    });

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });

  it('returns error for empty query', async () => {
    const input: SearchInput = { query: '' };
    const result = await handleSearchCredentials(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      userId: 'test-user',
    });

    expect(result.isError).toBe(true);
  });

  it('respects max_results limit', async () => {
    const input: SearchInput = { query: 'degree', max_results: 5 };
    const result = await handleSearchCredentials(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      userId: 'test-user',
    });

    expect(result).toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// BUG-028 — anchor_document promised a handle it never returned.
// ---------------------------------------------------------------------------

describe('BUG-028 — anchor_document submission receipt contract', () => {
  const CONFIG = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'test-key',
    userId: 'test-user',
  };
  const FINGERPRINT = 'a'.repeat(64);
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  /** Parse the JSON payload out of a ToolResult's text content. */
  function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  /**
   * Stands in for Supabase on the real code path: the `mcp_anchor_document`
   * RPC does not exist in any migration, so PostgREST 404s and the handler
   * falls through to a direct INSERT on `public_records`. The returned row is
   * the ACTUAL table shape — note there is no `public_id`, which is the whole
   * bug.
   */
  function supabaseStub(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      if (url.includes('/rpc/mcp_anchor_document')) {
        return new Response('{"message":"Could not find the function"}', { status: 404 });
      }
      if (url.includes('/public_records')) {
        return new Response(JSON.stringify([{
          id: '9f1c0b6e-0000-4000-8000-000000000001',
          source: 'mcp',
          source_id: FINGERPRINT,
          record_type: 'document',
          content_hash: FINGERPRINT,
          anchor_id: null,
          metadata: {},
          created_at: '2026-08-15T00:00:00Z',
        }]), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('public_records genuinely has no public_id column (why null is the honest answer)', () => {
    // If a future migration adds public_id to public_records, this fails and
    // whoever adds it must revisit the receipt contract rather than leaving a
    // permanently-null field in an agent-facing response.
    const baseline = readFileSync(
      resolve(__dirname, '../../supabase/migrations/00000000000000_baseline_at_main_HEAD.sql'),
      'utf8',
    );
    const createTable = baseline.match(
      /CREATE TABLE IF NOT EXISTS "public"\."public_records" \(([\s\S]*?)\n\)/,
    );
    expect(createTable).not.toBeNull();
    expect(createTable![1]).not.toContain('public_id');
    expect(createTable![1]).toContain('content_hash');
  });

  it('returns public_id as an explicit null, not a silently dropped key', async () => {
    globalThis.fetch = supabaseStub() as unknown as typeof fetch;

    const result = await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG);
    const body = payload(result as { content: Array<{ text: string }> });

    // Before the fix this read `record?.public_id` — always undefined, so
    // JSON.stringify removed the key and an agent could not tell "no id yet"
    // from "field forgotten".
    expect('public_id' in body).toBe(true);
    expect(body.public_id).toBeNull();
    expect(body.status).toBe('submitted');
  });

  it('names the handle the documented follow-up actually accepts', async () => {
    globalThis.fetch = supabaseStub() as unknown as typeof fetch;

    const body = payload(
      await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG) as { content: Array<{ text: string }> },
    );

    expect(body.content_hash).toBe(FINGERPRINT);
    expect(body.verify_with).toEqual({ tool: 'verify_document', content_hash: FINGERPRINT });
    expect(String(body.message)).toContain('verify_document');
    expect(String(body.message)).toContain('content_hash');
  });

  it('the instructed follow-up resolves: verify_document accepts the receipt handle', async () => {
    globalThis.fetch = supabaseStub() as unknown as typeof fetch;
    const receipt = payload(
      await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG) as { content: Array<{ text: string }> },
    );
    const handle = (receipt.verify_with as { content_hash: string }).content_hash;

    // Not yet anchored → the fingerprint RPC returns "Record not found",
    // which must surface as a decidable UNKNOWN envelope, NOT a tool error.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'Record not found' }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const followUp = await handleVerifyDocument({ content_hash: handle }, CONFIG);

    expect(followUp.isError).toBeFalsy();
    const verified = payload(followUp as { content: Array<{ text: string }> });
    expect(verified.status).toBe('UNKNOWN');
    expect(verified.fingerprint).toBe(FINGERPRINT);
  });

  it('the already_submitted path returns the same shape, not a different one', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/public_records?content_hash=eq.')) {
        return new Response(JSON.stringify([{
          id: '9f1c0b6e-0000-4000-8000-000000000001',
          content_hash: FINGERPRINT,
          anchor_id: null,
        }]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const body = payload(
      await handleAnchorDocument(
        { content_hash: FINGERPRINT, idempotency_key: '11111111-2222-3333-4444-555555555555' },
        CONFIG,
      ) as { content: Array<{ text: string }> },
    );

    expect(body.status).toBe('already_submitted');
    expect('public_id' in body).toBe(true);
    expect(body.public_id).toBeNull();
    expect(body.verify_with).toEqual({ tool: 'verify_document', content_hash: FINGERPRINT });
  });

  it('never leaks the internal public_records UUID as a substitute identifier', async () => {
    globalThis.fetch = supabaseStub() as unknown as typeof fetch;

    const raw = (await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG))
      .content[0].text;

    expect(raw).not.toContain('9f1c0b6e-0000-4000-8000-000000000001');
    expect(raw).not.toContain('"id"');
  });

  it('the tool description no longer promises a public identifier it cannot return', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'anchor_document');
    expect(tool).toBeDefined();

    // R-7 claims gate / §1.5: state what is measured vs asserted vs NOT.
    expect(tool!.description).not.toContain('public identifier for later verification');
    expect(tool!.description).toContain('verify_document');
    expect(tool!.description).toContain('content_hash');
    expect(tool!.description.toLowerCase()).toContain('asynchronous');
  });
});
