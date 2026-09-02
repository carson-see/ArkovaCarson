/**
 * MCP Server Tools Tests
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TOOL_DEFINITIONS, handleToolCall } from './index.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('Tool Definitions', () => {
  it('should define exactly the 6 registered tools', () => {
    // Exact-name ratchet: adding or removing a tool must update this list
    // deliberately. The 4 nessie_-prefixed tools (NCE-19) were removed
    // 2026-09-02 — three 401'd for every real caller (the worker's
    // /compliance/* routes require a Supabase JWT and explicitly reject
    // `Bearer ak_…`, which is all this server ever sends) and the fourth
    // (nessie_ask) was already a standing 503 by founder directive. See
    // sdks/mcp-server/agents.md.
    expect(TOOL_DEFINITIONS.map(t => t.name)).toEqual([
      'arkova_verify_anchor',
      'arkova_anchor_status',
      'arkova_search_anchors',
      'arkova_create_attestation',
      'arkova_batch_verify',
      'arkova_verify_signature',
    ]);
  });

  it('should have valid input schemas', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required.length).toBeGreaterThan(0);
    }
  });

  it('should use an arkova_ namespace prefix on all tool names (DX-04)', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^arkova_/);
    }
  });

  it('should include arkova_verify_signature for Phase III', () => {
    const sigTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_verify_signature');
    expect(sigTool).toBeDefined();
    expect(sigTool?.inputSchema.required).toContain('signature_id');
  });

  // CLAUDE.md §1.3 bans crypto/blockchain terminology in user-visible strings
  // (Wallet, Gas, Hash, Block, Transaction, Crypto, Blockchain, Bitcoin,
  // Testnet, Mainnet, UTXO, Broadcast). Tool name/description text is sent
  // verbatim to every connected MCP client (tools/list) — it is user-visible
  // the same way UI copy is.
  it('should not use §1.3-banned terminology in any tool name or description', () => {
    const banned = /\b(wallet|gas|hash|block|transaction|crypto|blockchain|bitcoin|testnet|mainnet|utxo|broadcast)\b/i;
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name, `tool name "${tool.name}"`).not.toMatch(banned);
      expect(tool.description, `${tool.name} description: "${tool.description}"`).not.toMatch(banned);
      for (const [propName, prop] of Object.entries(tool.inputSchema.properties)) {
        expect(prop.description, `${tool.name}.${propName} description: "${prop.description}"`).not.toMatch(banned);
      }
    }
  });

  // F8 — "credential" in an agent tool namespace reads as authentication
  // secrets, not as a verified record (this is the same failure mode that
  // caused the 2026-09-02 tool rename — see agents.md). No tool NAME may
  // contain "credential", and no description or property description may
  // contain "credentials" (plural) at all. `credential_type` survives only
  // as a literal API field name, never in prose.
  it('should not use "credential" in any tool name', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name.toLowerCase(), `tool name "${tool.name}"`).not.toContain('credential');
    }
  });

  it('should not use "credentials" (plural) anywhere in tool or property descriptions', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.toLowerCase(), `${tool.name} description: "${tool.description}"`).not.toContain('credentials');
      for (const [propName, prop] of Object.entries(tool.inputSchema.properties)) {
        expect(prop.description.toLowerCase(), `${tool.name}.${propName} description: "${prop.description}"`).not.toContain('credentials');
      }
    }
  });

  // F6 — the API only ever matches public_id; there is no fingerprint
  // lookup path on /api/v1/verify/:publicId. Drop the false claim.
  it('should not claim public_id can be a document fingerprint', () => {
    const verifyTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_verify_anchor')!;
    const statusTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_anchor_status')!;
    expect(verifyTool.description.toLowerCase()).not.toContain('fingerprint');
    expect(verifyTool.inputSchema.properties.public_id.description.toLowerCase()).not.toContain('fingerprint');
    expect(statusTool.description.toLowerCase()).not.toContain('fingerprint');
    expect(statusTool.inputSchema.properties.public_id.description.toLowerCase()).not.toContain('fingerprint');
  });

  // F12 — the route only calls requireAuth (any authenticated caller), not
  // an org-admin check. The old description overclaimed a privilege
  // requirement that doesn't exist server-side.
  it('should not overclaim organization admin privileges are required to attest', () => {
    const attestTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_create_attestation')!;
    expect(attestTool.description).not.toContain('Requires organization admin privileges');
  });

  // F2 — CreateAttestationSchema requires attester_name and a non-empty
  // claims array server-side; the tool must expose and require both.
  it('should require attester_name and claims for arkova_create_attestation', () => {
    const attestTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_create_attestation')!;
    expect(attestTool.inputSchema.properties.attester_name).toBeDefined();
    expect(attestTool.inputSchema.properties.claims).toBeDefined();
    expect(attestTool.inputSchema.required).toContain('attester_name');
    expect(attestTool.inputSchema.required).toContain('claims');
  });

  // D6/F7 — SYNC_THRESHOLD=20 server-side; above that the worker returns
  // 202 + job_id with no results and this tool cannot fetch them.
  it('should cap arkova_batch_verify at 20 public IDs', () => {
    const batchTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_batch_verify')!;
    expect(batchTool.inputSchema.properties.public_ids.maxItems).toBe(20);
    expect(batchTool.description).toContain('up to 20 public IDs');
    expect(batchTool.description).toContain('results returned inline');
  });
});

describe('handleToolCall', () => {
  it('should handle arkova_verify_anchor', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ public_id: 'ARK-X', status: 'SECURED' }),
    });

    const result = await handleToolCall('arkova_verify_anchor', { public_id: 'ARK-X' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-X');
    expect(result.content[0].text).toContain('SECURED');
  });

  it('should handle 404 gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await handleToolCall('arkova_verify_anchor', { public_id: 'NONE' });

    expect(result.content[0].text).toContain('not found');
  });

  it('should handle arkova_search_anchors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ public_id: 'ARK-1' }] }),
    });

    const result = await handleToolCall('arkova_search_anchors', { query: 'test', limit: '3' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-1');
  });

  // F3 — a disabled semantic-search capability must not read as an empty
  // result. Mirror the disclosure pattern previously used for nessie_ask.
  it('discloses a disabled search capability instead of swallowing the 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'service_unavailable', message: 'Semantic search is not currently enabled' }),
    });

    const result = await handleToolCall('arkova_search_anchors', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disabled');
    expect(result.content[0].text).toContain('NOT an empty result');
    expect(result.content[0].text).toContain('Semantic search is not currently enabled');
  });

  it('still reports an ordinary search failure distinctly from "disabled"', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await handleToolCall('arkova_search_anchors', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('500');
    expect(result.content[0].text).not.toContain('disabled');
  });

  // F10 — non-numeric limit must not become `limit=NaN` on the wire.
  it('falls back to the default limit of 5 when limit is not numeric', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await handleToolCall('arkova_search_anchors', { query: 'test', limit: 'not-a-number' });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=5');
    expect(calledUrl).not.toContain('NaN');
  });

  it('falls back to the default limit of 5 when limit is omitted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await handleToolCall('arkova_search_anchors', { query: 'test' } as Record<string, string>);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=5');
  });

  it('should handle arkova_verify_signature', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ valid: true, signature_id: 'ARK-SIG-1', checks: {} }),
    });

    const result = await handleToolCall('arkova_verify_signature', { signature_id: 'ARK-SIG-1' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-SIG-1');
  });

  // F4 — a disabled AdES signature capability must not read as "not found"
  // or as a negative verification result.
  it('discloses a disabled signature capability instead of swallowing the 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'AdES signature service is not currently enabled', code: 'ADES_SIGNATURES_DISABLED' }),
    });

    const result = await handleToolCall('arkova_verify_signature', { signature_id: 'ARK-SIG-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disabled');
    expect(result.content[0].text).toContain('NOT a "not found" or negative verification result');
    expect(result.content[0].text).toContain('ADES_SIGNATURES_DISABLED');
  });

  it('still reports an ordinary signature-verification failure distinctly from "disabled"', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await handleToolCall('arkova_verify_signature', { signature_id: 'ARK-SIG-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('500');
    expect(result.content[0].text).not.toContain('disabled');
  });

  it('should handle arkova_batch_verify', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ public_id: 'ARK-1', status: 'SECURED' }] }),
    });

    const result = await handleToolCall('arkova_batch_verify', { public_ids: '["ARK-1"]' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-1');
  });

  it('should reject invalid batch verify input', async () => {
    const result = await handleToolCall('arkova_batch_verify', { public_ids: 'not-json' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid JSON');
  });

  // D6/F7 — above SYNC_THRESHOLD=20 the worker returns 202+job_id with no
  // results; the tool must reject before making that call.
  it('should reject more than 20 public IDs in a single batch', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `ARK-${i}`);
    const result = await handleToolCall('arkova_batch_verify', { public_ids: JSON.stringify(ids) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('20');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should accept exactly 20 public IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    const ids = Array.from({ length: 20 }, (_, i) => `ARK-${i}`);

    const result = await handleToolCall('arkova_batch_verify', { public_ids: JSON.stringify(ids) });

    expect(result.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should return error for unknown tool', async () => {
    const result = await handleToolCall('nonexistent_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await handleToolCall('arkova_verify_anchor', { public_id: 'X' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused');
  });
});

// F2/F11 — arkova_create_attestation must expose + require attester_name
// and a non-empty claims array (the worker's CreateAttestationSchema 400s
// without them), pass both through, and surface the worker's `details`
// array on a validation failure.
describe('handleToolCall — arkova_create_attestation', () => {
  it('passes attester_name and parsed claims through in the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ public_id: 'ARK-ATT-1', status: 'DRAFT' }),
    });

    const result = await handleToolCall('arkova_create_attestation', {
      attestation_type: 'VERIFICATION',
      subject_identifier: 'ARK-DOC-1',
      attester_name: 'Jane Attester',
      claims: JSON.stringify([{ claim: 'Employed 2020-2024', evidence: 'HR letter' }]),
      summary: 'Employment verified',
    });

    expect(result.isError).toBeFalsy();
    const [, requestInit] = mockFetch.mock.calls[0];
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.attester_name).toBe('Jane Attester');
    expect(body.claims).toEqual([{ claim: 'Employed 2020-2024', evidence: 'HR letter' }]);
  });

  it('rejects invalid JSON for claims without calling the API', async () => {
    const result = await handleToolCall('arkova_create_attestation', {
      attestation_type: 'VERIFICATION',
      subject_identifier: 'ARK-DOC-1',
      attester_name: 'Jane Attester',
      claims: 'not-json',
      summary: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid JSON');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an empty claims array without calling the API', async () => {
    const result = await handleToolCall('arkova_create_attestation', {
      attestation_type: 'VERIFICATION',
      subject_identifier: 'ARK-DOC-1',
      attester_name: 'Jane Attester',
      claims: '[]',
      summary: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces the worker\'s validation details array on a 400', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'validation_error',
        details: [{ field: 'attester_name', message: 'String must contain at least 1 character(s)' }],
      }),
    });

    const result = await handleToolCall('arkova_create_attestation', {
      attestation_type: 'VERIFICATION',
      subject_identifier: 'ARK-DOC-1',
      attester_name: '',
      claims: JSON.stringify([{ claim: 'x' }]),
      summary: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('attester_name');
    expect(result.content[0].text).toContain('String must contain at least 1 character(s)');
  });
});
