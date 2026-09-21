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
  it('exports arkova_verify_anchor tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'arkova_verify_anchor');
    expect(tool).toBeDefined();
    expect(tool!.description).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('public_id');
  });

  it('exports arkova_search_anchors tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'arkova_search_anchors');
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
// BUG-028 — arkova_anchor_document promised a handle it never returned.
// ---------------------------------------------------------------------------

describe('BUG-028 — arkova_anchor_document submission receipt contract', () => {
  const CONFIG = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'test-key',
    userId: 'test-user',
    workerBaseUrl: 'https://worker.test',
    callerApiKey: 'ak_test_secret',
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

  function workerStub(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://worker.test/api/v1/anchor');
      expect(init?.headers).toMatchObject({ 'X-API-Key': 'ak_test_secret' });
      return new Response(JSON.stringify({
        public_id: 'ark_test_receipt',
        status: 'PENDING',
        action: 'queue',
        idempotent: false,
        fingerprint: FINGERPRINT,
        ...overrides,
      }), { status: 200 });
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

  it('returns the canonical worker public_id without a direct-database fallback', async () => {
    const fetchStub = workerStub();
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const result = await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG);
    const body = payload(result as { content: Array<{ text: string }> });

    expect('public_id' in body).toBe(true);
    expect(body.public_id).toBe('ark_test_receipt');
    expect(body.status).toBe('PENDING');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('returns the fingerprint handle accepted by the documented follow-up', async () => {
    globalThis.fetch = workerStub() as unknown as typeof fetch;

    const body = payload(
      await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG) as { content: Array<{ text: string }> },
    );

    expect(body.fingerprint).toBe(FINGERPRINT);
    expect(body).not.toHaveProperty('verify_with');
    expect(body).not.toHaveProperty('content_hash');
  });

  it('the instructed follow-up resolves: arkova_verify_document accepts the receipt handle', async () => {
    globalThis.fetch = workerStub() as unknown as typeof fetch;
    const receipt = payload(
      await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG) as { content: Array<{ text: string }> },
    );
    const handle = receipt.fingerprint as string;

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

  it('passes through the canonical idempotent receipt without relabeling it', async () => {
    globalThis.fetch = workerStub({
      status: 'PENDING',
      idempotent: true,
    }) as unknown as typeof fetch;

    const body = payload(
      await handleAnchorDocument(
        { content_hash: FINGERPRINT, idempotency_key: '11111111-2222-3333-4444-555555555555' },
        CONFIG,
      ) as { content: Array<{ text: string }> },
    );

    expect(body.status).toBe('PENDING');
    expect(body.idempotent).toBe(true);
    expect('public_id' in body).toBe(true);
    expect(body.public_id).toBe('ark_test_receipt');
    expect(body.fingerprint).toBe(FINGERPRINT);
  });

  it('does not synthesize a legacy internal database identifier', async () => {
    globalThis.fetch = workerStub() as unknown as typeof fetch;

    const raw = (await handleAnchorDocument({ content_hash: FINGERPRINT }, CONFIG))
      .content[0].text;

    expect(raw).not.toContain('9f1c0b6e-0000-4000-8000-000000000001');
    expect(raw).not.toContain('"id"');
  });

  it('the tool description no longer promises a public identifier it cannot return', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'arkova_anchor_document');
    expect(tool).toBeDefined();

    // R-7 claims gate / §1.5: state what is measured vs asserted vs NOT.
    expect(tool!.description).not.toContain('public identifier for later verification');
    expect(tool!.description).toContain('arkova_verify_document');
    expect(tool!.description).toContain('content_hash');
    expect(tool!.description.toLowerCase()).toContain('asynchronous');
  });
});
