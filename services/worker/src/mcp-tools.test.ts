/**
 * MCP Tools Handler Tests (P8-S19 + PH1-SDK-03)
 *
 * Tests for the MCP tool handler functions defined in services/edge/src/mcp-tools.ts.
 * Imports the actual handlers — no inline reimplementations.
 *
 * No real API calls — mocks fetch globally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
 
// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves it fine at runtime
import {
  handleNessieQuery,
  handleAnchorDocument,
  handleVerifyDocument,
  handleVerifyCredential,
  handleSearchCredentials,
  handleVerifyBatch,
  handleAgentSearch,
  handleAgentVerify,
  handleAgentListOrgs,
  handleAgentGetAnchor,
  handleAgentGetOrganization,
  TOOL_DEFINITIONS,
} from '../../edge/src/mcp-tools.js';

const CONFIG = {
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

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────

const EXPECTED_TOOL_NAMES = [
  'verify_credential',
  'search_credentials',
  'nessie_query',
  'anchor_document',
  'verify_document',
  'verify_batch',
  'search',
  'verify',
  'list_orgs',
  'get_anchor',
  'get_organization',
  'get_record',
  'get_fingerprint',
  'get_document',
  'oracle_batch_verify',
  'list_agents',
];

describe('TOOL_DEFINITIONS', () => {
  it('exports legacy, v2, oracle, and agent registry tools', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('all tools have name, description, and inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it('exposes verify_batch and v2 agent aliases', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('verify_batch');
    expect(names).toEqual(expect.arrayContaining([
      'search',
      'verify',
      'list_orgs',
      'get_anchor',
      'get_organization',
      'get_record',
      'get_fingerprint',
      'get_document',
    ]));
  });

  it('publishes full array contracts for batch public_id inputs', () => {
    const verifyBatch = TOOL_DEFINITIONS.find((tool) => tool.name === 'verify_batch');
    const oracleBatch = TOOL_DEFINITIONS.find((tool) => tool.name === 'oracle_batch_verify');

    expect(verifyBatch?.inputSchema.properties.public_ids).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', pattern: '^ARK-[A-Z0-9-]{3,60}$', maxLength: 64 },
    });
    expect(oracleBatch?.inputSchema.properties.public_ids).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 25,
      items: { type: 'string', pattern: '^ARK-[A-Z0-9-]{3,60}$', maxLength: 64 },
    });
  });

  it('publishes anchor_document idempotency_key in the advertised tool schema', () => {
    const anchorDocument = TOOL_DEFINITIONS.find((tool) => tool.name === 'anchor_document');

    expect(anchorDocument?.inputSchema.properties.idempotency_key).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    expect(anchorDocument?.inputSchema.required).toEqual(['content_hash']);
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

// ── Agent v2 aliases (SCRUM-1107) ─────────────────────────────────────

describe('agent v2 MCP aliases', () => {
  it('search(q,type=org,limit) searches the caller-scoped organization memberships', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        role: 'admin',
        organizations: {
          id: 'internal-org-uuid',
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          description: 'Acme description',
          domain: 'acme.com',
          website_url: 'https://acme.com',
        },
      }]),
    });

    const result = await handleAgentSearch({ q: 'acme', type: 'org', limit: 5 }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      results: [{
        type: 'org',
        public_id: 'org_acme',
        score: 1,
        snippet: 'Acme Corp',
        metadata: {
          description: 'Acme description',
          domain: 'acme.com',
          website_url: 'https://acme.com',
        },
      }],
      next_cursor: null,
    });
    expect(JSON.stringify(parsed)).not.toContain('internal-org-uuid');
    expect(mockFetch.mock.calls[0][0]).toContain('/rest/v1/org_members');
    expect(mockFetch.mock.calls[0][0]).toContain('user_id=eq.test-user-id');
    expect(mockFetch.mock.calls[0][0]).not.toContain('select=id');
  });

  it('search(q,type=record,limit) caps the REST v2 limit parameter at the search RPC ceiling', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        public_id: 'ARK-REC-ABC',
        title: 'Test record',
        credential_type: 'LICENSE',
        status: 'SECURED',
        created_at: '2026-01-01',
      }]),
    });

    const result = await handleAgentSearch({ q: 'license', type: 'record', limit: 75 }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      results: [{
        type: 'record',
        public_id: 'ARK-REC-ABC',
        score: 1,
        snippet: 'Test record',
        metadata: {
          credential_type: 'LICENSE',
          status: 'SECURED',
        },
      }],
      next_cursor: null,
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ p_limit: 50 });
  });

  it('search(q,type=fingerprint) returns the REST v2 SearchResponse shape', async () => {
    const fingerprint = 'd'.repeat(64);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'internal-record-id',
        public_id: 'ARK-FP-ABC',
        anchor_id: 'anchor-internal-id',
        source: 'mcp',
        source_url: null,
        record_type: 'document',
        title: 'Fingerprint.pdf',
        content_hash: fingerprint,
        metadata: {},
      }]),
    });

    const result = await handleAgentSearch({ q: fingerprint, type: 'fingerprint' }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      results: [{
        type: 'fingerprint',
        public_id: 'ARK-FP-ABC',
        score: 1,
        snippet: 'Fingerprint.pdf',
        metadata: { status: 'ANCHORED' },
      }],
      next_cursor: null,
    });
    expect(JSON.stringify(parsed)).not.toContain('internal-record-id');
  });

  it('verify(fingerprint) delegates to document verification', async () => {
    const validHash = 'c'.repeat(64);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'rec-1',
        source: 'mcp',
        content_hash: validHash,
        metadata: {},
        anchor_id: null,
      }]),
    });

    const result = await handleAgentVerify({ fingerprint: validHash }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('PENDING');
  });

  it('get_anchor(public_id) delegates to public anchor lookup', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        org_name: 'Test Org',
        credential_type: 'LICENSE',
        created_at: '2026-01-01',
      }),
    });

    const result = await handleAgentGetAnchor({ public_id: 'ARK-LIC-ABC' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
  });

  it('get_record (alias of handleAgentGetAnchor) returns the public-safe verify shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        public_id: 'ARK-DOC-REC1',
        org_name: 'Test Org',
        credential_type: 'DOCUMENT',
        created_at: '2026-01-01',
        chain_tx_id: 'tx-receipt-123',
      }),
    });

    const result = await handleAgentGetAnchor({ public_id: 'ARK-DOC-REC1' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.network_receipt_id).toBe('tx-receipt-123');
    // shapeAnchorRow contract: public-safe envelope, no internal `id`
    // field leaks even when prod adds it to the RPC response.
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('record_id');
  });

  it('get_document (alias of handleAgentGetAnchor) returns the public-safe verify shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        public_id: 'ARK-DOC-DOC1',
        org_name: 'Test Org',
        credential_type: 'DOCUMENT',
        created_at: '2026-01-02',
      }),
    });

    const result = await handleAgentGetAnchor({ public_id: 'ARK-DOC-DOC1' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('record_id');
  });

  it('list_orgs scopes the query by authenticated user id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        role: 'ORG_ADMIN',
        organizations: {
          id: 'org-1',
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          domain: 'acme.com',
          website_url: 'https://acme.com',
          verification_status: 'VERIFIED',
        },
      }]),
    });

    const result = await handleAgentListOrgs(CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.organizations[0]).toMatchObject({ public_id: 'org_acme', role: 'ORG_ADMIN' });
    expect(parsed.organizations[0]).not.toHaveProperty('id');
    expect(JSON.stringify(parsed)).not.toContain('org-1');
    const requestUrl = String(mockFetch.mock.calls[0][0]);
    expect(requestUrl).toContain('user_id=eq.test-user-id');
    expect(decodeURIComponent(requestUrl)).not.toContain('organizations(id,');
  });

  it('get_organization(public_id) uses a dedicated query, scopes by caller, and never leaks internal id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        organizations: {
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          description: 'Test organization',
          domain: 'acme.com',
          website_url: 'https://acme.com',
          verification_status: 'VERIFIED',
        },
      }]),
    });

    const result = await handleAgentGetOrganization({ public_id: 'org_acme' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);

    // Public-safe contract: must contain description, must NOT contain
    // the internal `id` column nor the membership `role` (those leak
    // through if the handler reuses list_orgs).
    expect(parsed).toEqual({
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      description: 'Test organization',
      domain: 'acme.com',
      website_url: 'https://acme.com',
      verification_status: 'VERIFIED',
    });
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('role');

    // Caller-scope assertion: user_id MUST filter the membership rows,
    // and the embedded organization MUST be filtered by public_id —
    // otherwise an out-of-scope public_id could match a sibling row.
    const requestUrl = String(mockFetch.mock.calls[0][0]);
    expect(requestUrl).toContain('user_id=eq.test-user-id');
    expect(decodeURIComponent(requestUrl)).toContain('organizations.public_id=eq.org_acme');
  });

  it('get_organization returns not-found when caller has no matching membership', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const result = await handleAgentGetOrganization({ public_id: 'org_outside_scope' }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('was not found');
  });

  it('get_fingerprint (handleAgentVerify) strips record_id from the underlying verify shape', async () => {
    const fingerprint = 'a'.repeat(64);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'internal-record-id',
        public_id: 'ARK-DOC-ABC',
        anchor_id: 'anchor-internal-id',
        source: 'mcp',
        source_url: null,
        record_type: 'document',
        title: 'Some doc',
        content_hash: fingerprint,
        metadata: {},
      }]),
    });

    const result = await handleAgentVerify({ fingerprint }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);

    // Public-safe contract: response must NOT include the internal
    // public_records.id (CodeRabbit Major: get_fingerprint leaks
    // internal record_id).
    expect(parsed).not.toHaveProperty('record_id');
    expect(JSON.stringify(parsed)).not.toContain('internal-record-id');
    expect(parsed.verified).toBe(true);
    expect(parsed.public_id).toBe('ARK-DOC-ABC');
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
    expect(parsed).not.toHaveProperty('record_id');
  });

  it('uses idempotency_key for 5-minute retry dedupe without leaking internal ids', async () => {
    const retryKey = ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ id: 'internal-rec-1', public_id: 'ARK-2026-999' }]),
    });

    const result = await handleAnchorDocument(
      {
        content_hash: validHash,
        idempotency_key: retryKey,
      },
      CONFIG,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('already_submitted');
    expect(parsed.public_id).toBe('ARK-2026-999');
    expect(parsed).not.toHaveProperty('record_id');
    expect(JSON.stringify(parsed)).not.toContain('internal-rec-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/rest/v1/public_records');
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

// ── INT-02: handleVerifyBatch ─────────────────────────────────────────

describe('handleVerifyBatch (INT-02)', () => {
  it('returns error when public_ids is empty', async () => {
    const result = await handleVerifyBatch({ public_ids: [] }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
  });

  it('returns error when public_ids exceeds 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `ARK-${i}`);
    const result = await handleVerifyBatch({ public_ids: ids }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at most 100');
  });

  it('returns error when any id is empty/whitespace', async () => {
    const result = await handleVerifyBatch({ public_ids: ['ARK-1', '   '] }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
  });

  it('verifies all credentials and returns results in input order', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        org_name: 'University of Michigan',
        credential_type: 'DEGREE',
        created_at: '2026-04-11T10:00:00Z',
        chain_tx_id: 'tx-1',
      }),
    });

    const result = await handleVerifyBatch(
      { public_ids: ['ARK-2026-001', 'ARK-2026-002', 'ARK-2026-003'] },
      CONFIG,
    );
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(3);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].public_id).toBe('ARK-2026-001');
    expect(parsed.results[1].public_id).toBe('ARK-2026-002');
    expect(parsed.results[2].public_id).toBe('ARK-2026-003');
    expect(parsed.results[0].verified).toBe(true);
    expect(parsed.results[0].status).toBe('ACTIVE');
    expect(parsed.results[0].issuer_name).toBe('University of Michigan');
  });

  it('each batch result carries recipient_identifier field for shape parity with single handler', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        org_name: 'Org',
        credential_type: 'DEGREE',
        created_at: '2026-04-11T10:00:00Z',
        recipient_hash: 'hash-123',
      }),
    });
    const result = await handleVerifyBatch({ public_ids: ['ARK-1'] }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0]).toHaveProperty('recipient_identifier');
    expect(parsed.results[0].recipient_identifier).toBe('hash-123');
  });

  it('marks individual lookup as not verified on HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'SECURED', org_name: 'X', credential_type: 'DEGREE', created_at: '' }),
    });

    const result = await handleVerifyBatch(
      { public_ids: ['ARK-missing', 'ARK-found'] },
      CONFIG,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0].verified).toBe(false);
    expect(parsed.results[0].error).toContain('not found');
    expect(parsed.results[1].verified).toBe(true);
  });

  it('handles single-item batch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'SECURED', org_name: 'X', credential_type: 'DEGREE', created_at: '' }),
    });
    const result = await handleVerifyBatch({ public_ids: ['ARK-1'] }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
  });

  it('handles 100-item batch (max allowed)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'SECURED', org_name: 'X', credential_type: 'DEGREE', created_at: '' }),
    });
    const ids = Array.from({ length: 100 }, (_, i) => `ARK-${i}`);
    const result = await handleVerifyBatch({ public_ids: ids }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(100);
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
