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
  handleAgentGetRecord,
  handleAgentGetFingerprint,
  handleAgentGetDocument,
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

describe('TOOL_DEFINITIONS', () => {
  it('exports legacy tools plus v2 agent aliases', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(14);
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
  it('search(q,type=org) calls the public org search RPC', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'org-1',
        public_id: 'org_acme',
        display_name: 'Acme Corp',
        domain: 'acme.com',
        website_url: 'https://acme.com',
        verification_status: 'VERIFIED',
      }]),
    });

    const result = await handleAgentSearch({ q: 'acme', type: 'org', max_results: 5 }, CONFIG);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      results: [expect.objectContaining({ type: 'org', public_id: 'org_acme', score: 1 })],
      next_cursor: null,
    });
    expect(parsed.results[0]).not.toHaveProperty('id');
    expect(JSON.stringify(parsed)).not.toContain('org-1');
    expect(mockFetch.mock.calls[0][0]).toContain('/rest/v1/rpc/search_organizations_public');
  });

  it('search(q,type=record) honors the OpenAPI 100-result ceiling', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });

    const result = await handleAgentSearch({ q: 'degree', type: 'record', max_results: 100 }, CONFIG);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ results: [], next_cursor: null });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ p_query: 'degree', p_limit: 100 });
  });

  it('verify(fingerprint) returns the REST v2 verification envelope', async () => {
    const validHash = 'c'.repeat(64);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        id: 'rec-1',
        public_id: 'ARK-DOC-ABC',
        source: 'mcp',
        title: 'Credential.pdf',
        content_hash: validHash,
        metadata: { chain_tx_id: 'tx-1', anchored_at: '2026-04-24T12:00:00Z' },
        anchor_id: 'anchor-1',
      }]),
    });

    const result = await handleAgentVerify({ fingerprint: validHash }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      verified: true,
      status: 'ACTIVE',
      fingerprint: validHash,
      public_id: 'ARK-DOC-ABC',
      title: 'Credential.pdf',
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
    });
    expect(parsed).not.toHaveProperty('record_id');
    expect(parsed).not.toHaveProperty('anchor_proof');
  });

  it('get_anchor(public_id) returns public anchor metadata without legacy-only fields', async () => {
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
    expect(parsed.public_id).toBe('ARK-LIC-ABC');
    expect(parsed).not.toHaveProperty('recipient_identifier');
  });

  it('rejects malformed get_* identifiers before network lookup', async () => {
    const badHash = 'not-a-hash';

    expect((await handleAgentGetAnchor({ public_id: 'bad-id' }, CONFIG)).isError).toBe(true);
    expect((await handleAgentGetRecord({ public_id: 'bad-id' }, CONFIG)).isError).toBe(true);
    expect((await handleAgentGetDocument({ public_id: 'bad-id' }, CONFIG)).isError).toBe(true);
    expect((await handleAgentGetOrganization({ public_id: 'bad id' }, CONFIG)).isError).toBe(true);
    expect((await handleAgentGetFingerprint({ fingerprint: badHash }, CONFIG)).isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('list_orgs scopes the query by authenticated user id and omits internal ids', async () => {
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
    expect(parsed.organizations[0]).toMatchObject({ public_id: 'org_acme' });
    expect(parsed.organizations[0]).not.toHaveProperty('id');
    expect(parsed.organizations[0]).not.toHaveProperty('role');
    expect(JSON.stringify(parsed)).not.toContain('org-1');
    expect(mockFetch.mock.calls[0][0]).toContain('user_id=eq.test-user-id');
    expect(mockFetch.mock.calls[0][0]).toContain('organizations%28public_id%2Cdisplay_name%2Cdomain%2Cwebsite_url%2Cverification_status%29');
  });

  it('get_organization(public_id) scopes through org_members and omits internal ids', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{
        organizations: {
          id: 'org-1',
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          description: 'Verified healthcare org',
          domain: 'acme.com',
          website_url: 'https://acme.com',
          verification_status: 'VERIFIED',
          industry_tag: 'healthcare',
          org_type: 'employer',
          location: 'Detroit, MI',
          logo_url: null,
        },
      }]),
    });

    const result = await handleAgentGetOrganization({ public_id: 'org_acme' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      industry_tag: 'healthcare',
    });
    expect(parsed).not.toHaveProperty('id');
    expect(JSON.stringify(parsed)).not.toContain('org-1');
    expect(mockFetch.mock.calls[0][0]).toContain('user_id=eq.test-user-id');
    expect(mockFetch.mock.calls[0][0]).toContain('organizations.public_id=eq.org_acme');
  });

  it('get_record(public_id) returns detail without legacy-only fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'SECURED',
        public_id: 'ARK-DOC-ABC',
        fingerprint: 'a'.repeat(64),
        title: 'Contract.pdf',
        description: 'Signed agreement',
        org_name: 'Acme Corp',
        credential_type: 'LEGAL',
        sub_type: 'contract',
        issued_at: '2026-04-01',
        expires_at: null,
        created_at: '2026-04-24T12:00:00Z',
        chain_tx_id: 'tx-1',
        chain_confirmations: 6,
        parent_public_id: null,
        version_number: 2,
      }),
    });

    const result = await handleAgentGetRecord({ public_id: 'ARK-DOC-ABC' }, CONFIG);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      title: 'Contract.pdf',
      issuer_name: 'Acme Corp',
      parent_public_id: null,
    });
    expect(parsed).not.toHaveProperty('recipient_identifier');
    expect(parsed).not.toHaveProperty('id');
  });

  it('get_fingerprint and get_document return SCRUM-1132 detail envelopes', async () => {
    const fingerprint = 'd'.repeat(64);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          public_id: 'ARK-DOC-FP',
          title: 'Credential.pdf',
          content_hash: fingerprint,
          metadata: { chain_tx_id: 'tx-1', anchored_at: '2026-04-24T12:00:00Z' },
          anchor_id: 'anchor-1',
        }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'SECURED',
          public_id: 'ARK-DOC-FP',
          fingerprint,
          filename: 'Credential.pdf',
          org_name: 'Acme Corp',
          credential_type: 'LEGAL',
          created_at: '2026-04-24T12:00:00Z',
          chain_confirmations: 6,
          file_mime: 'application/pdf',
          file_size: 12345,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'SECURED',
          public_id: 'ARK-DOC-ABC',
          fingerprint,
          filename: 'Credential.pdf',
          org_name: 'Acme Corp',
          credential_type: 'LEGAL',
          created_at: '2026-04-24T12:00:00Z',
          file_mime: 'application/pdf',
          file_size: 12345,
        }),
      });

    const fingerprintResult = await handleAgentGetFingerprint({ fingerprint }, CONFIG);
    const documentResult = await handleAgentGetDocument({ public_id: 'ARK-DOC-ABC' }, CONFIG);
    const fingerprintParsed = JSON.parse(fingerprintResult.content[0].text);
    const documentParsed = JSON.parse(documentResult.content[0].text);

    expect(fingerprintParsed).toMatchObject({
      verified: true,
      status: 'ACTIVE',
      fingerprint,
      public_id: 'ARK-DOC-FP',
      issuer_name: 'Acme Corp',
      file_mime: 'application/pdf',
      file_size: 12345,
    });
    expect(documentParsed).toMatchObject({
      public_id: 'ARK-DOC-ABC',
      file_mime: 'application/pdf',
      file_size: 12345,
    });
  });

  it('get_fingerprint reports an error when the detail envelope cannot be loaded', async () => {
    const fingerprint = 'e'.repeat(64);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          public_id: 'ARK-DOC-FP',
          title: 'Credential.pdf',
          content_hash: fingerprint,
          metadata: { chain_tx_id: 'tx-1', anchored_at: '2026-04-24T12:00:00Z' },
          anchor_id: 'anchor-1',
        }]),
      })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const result = await handleAgentGetFingerprint({ fingerprint }, CONFIG);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Fingerprint detail lookup failed: HTTP 500');
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
