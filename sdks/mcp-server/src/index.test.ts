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
  it('should define exactly the 10 registered tools', () => {
    // Exact-name ratchet: adding or removing a tool must update this list
    // deliberately. 6 arkova_ verification tools (PH2-AGENT-06 / SCRUM-403,
    // arkova_verify_signature added in Phase III) + 4 nessie_ compliance
    // intelligence tools (NCE-19). Was pinned at 6 (PH2-AGENT-06); NCE-19 added
    // the 4 nessie_-prefixed tools without updating this assertion, so it
    // silently regressed to failing on every run until #2244 fixed it on main.
    expect(TOOL_DEFINITIONS.map(t => t.name)).toEqual([
      'arkova_verify_credential',
      'arkova_credential_status',
      'arkova_search_credentials',
      'arkova_create_attestation',
      'arkova_batch_verify',
      'nessie_compliance_score',
      'nessie_gap_analysis',
      'nessie_ask',
      'nessie_cross_reference',
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

  it('should use an arkova_ or nessie_ namespace prefix on all tool names (DX-04)', () => {
    // DX-04 namespace consistency: arkova_ for verification tools,
    // nessie_ for the NCE-19 compliance intelligence tools.
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^(arkova|nessie)_/);
    }
  });

  it('should prefix exactly 6 tools arkova_ and 4 tools nessie_', () => {
    const arkovaTools = TOOL_DEFINITIONS.filter((t) => t.name.startsWith('arkova_'));
    const nessieTools = TOOL_DEFINITIONS.filter((t) => t.name.startsWith('nessie_'));
    expect(arkovaTools).toHaveLength(6);
    expect(nessieTools).toHaveLength(4);
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
  // the same way UI copy is. Found live in this file during npm-publish
  // clean-room verification (2026-08-18): two descriptions said "Bitcoin
  // anchor status" / "Bitcoin anchor information" — fixed to "network" to
  // match the SDK README's existing house style.
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
});

describe('handleToolCall', () => {
  it('should handle arkova_verify_credential', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ public_id: 'ARK-X', status: 'SECURED' }),
    });

    const result = await handleToolCall('arkova_verify_credential', { public_id: 'ARK-X' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-X');
    expect(result.content[0].text).toContain('SECURED');
  });

  it('should handle 404 gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await handleToolCall('arkova_verify_credential', { public_id: 'NONE' });

    expect(result.content[0].text).toContain('not found');
  });

  it('should handle arkova_search_credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ public_id: 'ARK-1' }] }),
    });

    const result = await handleToolCall('arkova_search_credentials', { query: 'test', limit: '3' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ARK-1');
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

  it('should handle nessie_compliance_score', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ score: 87, grade: 'B', missing: [] }),
    });

    const result = await handleToolCall('nessie_compliance_score', { jurisdiction: 'US-CA', industry: 'accounting' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('87');
  });

  it('should handle nessie_gap_analysis', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ gaps: [{ document: 'W-9', priority: 'required' }] }),
    });

    const result = await handleToolCall('nessie_gap_analysis', { jurisdiction: 'US-NY', industry: 'legal' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('W-9');
  });

  it('should handle nessie_ask', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ answer: 'Analysis complete', citations: [] }),
    });

    const result = await handleToolCall('nessie_ask', { query: 'What licenses do I need?', task: 'compliance_qa' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Analysis complete');
  });

  it('should handle nessie_cross_reference', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inconsistencies: [], compared: 2 }),
    });

    const result = await handleToolCall('nessie_cross_reference', { anchor_ids: '["a1","a2"]' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('compared');
  });

  it('should reject nessie_cross_reference with fewer than 2 anchor IDs', async () => {
    const result = await handleToolCall('nessie_cross_reference', { anchor_ids: '["only-one"]' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Minimum 2');
  });

  it('should return error for unknown tool', async () => {
    const result = await handleToolCall('nonexistent_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await handleToolCall('arkova_verify_credential', { public_id: 'X' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused');
  });

  // NCE-19 added 4 nessie_-prefixed tools with zero test coverage (found
  // during npm-publish clean-room verification, 2026-08-18). Basic smoke
  // coverage for the three that don't depend on the disabled Nessie
  // embeddings flag (score/gap/cross-reference are deterministic
  // rule-based compliance calculators server-side — see
  // services/worker/src/compliance/score-calculator.ts, no AI/embedding
  // call in that path).
  it('should handle nessie_compliance_score', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ score: 82, grade: 'B' }),
    });

    const result = await handleToolCall('nessie_compliance_score', { jurisdiction: 'US-CA', industry: 'legal' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('82');
  });

  it('should handle nessie_gap_analysis', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ gaps: [] }),
    });

    const result = await handleToolCall('nessie_gap_analysis', { jurisdiction: 'US-CA', industry: 'legal' });

    expect(result.isError).toBeFalsy();
  });

  it('should reject nessie_cross_reference with fewer than 2 anchor IDs', async () => {
    const result = await handleToolCall('nessie_cross_reference', { anchor_ids: '["only-one"]' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Minimum 2 anchor IDs');
  });

  it('should handle nessie_ask success path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ answer: 'Revenue was $394B.', citations: [] }),
    });

    const result = await handleToolCall('nessie_ask', { query: 'What was Apple revenue?' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('394B');
  });

  // Regression test for a real, verified-in-prod condition: Nessie is
  // OFF in production (founder directive) — GET /api/v1/nessie/query
  // gates on the ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag
  // (services/worker/src/api/v1/nessie-query.ts) and, when disabled,
  // returns 503 { error: 'Nessie query endpoint is not enabled' }. Before
  // this fix, handleNessieAsk discarded that body and returned the generic
  // "Nessie query API returned 503" — leaving the caller with no idea *why*
  // (feature gate vs. outage vs. bad input). Surface the server's message.
  it('should surface the server error message when nessie_ask is disabled (503)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'Nessie query endpoint is not enabled' }),
    });

    const result = await handleToolCall('nessie_ask', { query: 'What was Apple revenue?' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nessie query endpoint is not enabled');
  });

  it('should fall back to a generic message when nessie_ask errors without a JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    });

    const result = await handleToolCall('nessie_ask', { query: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('500');
  });
});

/**
 * BUG-008/027 — CTO ruling R-1 STRENGTHENED.
 *
 * `nessie_ask` calls the worker in `mode=context`. Before the worker was gated,
 * that returned HTTP 200 and
 * `{"answer":"No relevant verified documents were found…","confidence":0}` —
 * which this tool passed through verbatim. An agent reads that as a completed
 * search over an empty corpus, not as "the feature is off".
 */
describe('nessie_ask — disabled must not read as an empty answer', () => {
  const disabledBody = {
    error: 'capability_disabled',
    code: 'nessie_disabled',
    capability: 'nessie',
    enabled: false,
    message: 'The Nessie intelligence query capability is disabled and is not being served.',
  };

  it('flags the disabled capability as an error, not a result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve(disabledBody),
    });

    const result = await handleToolCall('nessie_ask', { query: 'any compliance question' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disabled');
  });

  it('says explicitly that this is NOT an empty result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve(disabledBody),
    });

    const result = await handleToolCall('nessie_ask', { query: 'q' });

    expect(result.content[0].text).toContain('NOT an empty result');
    // The fluent no-documents sentence must never appear on the disabled path.
    expect(result.content[0].text).not.toContain('No relevant verified documents were found');
    expect(result.content[0].text).not.toContain('"confidence": 0');
  });

  it('still reports an ordinary upstream failure distinctly from "disabled"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'boom' }),
    });

    const result = await handleToolCall('nessie_ask', { query: 'q' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('500');
    expect(result.content[0].text).not.toContain('disabled');
  });

  it('advertises the disabled state in the published tool description', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'nessie_ask');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('DISABLED');
  });
});
