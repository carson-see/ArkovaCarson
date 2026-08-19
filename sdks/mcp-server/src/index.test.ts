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
    // intelligence tools (NCE-19).
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

  it('should include arkova_verify_signature for Phase III', () => {
    const sigTool = TOOL_DEFINITIONS.find(t => t.name === 'arkova_verify_signature');
    expect(sigTool).toBeDefined();
    expect(sigTool?.inputSchema.required).toContain('signature_id');
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
});
