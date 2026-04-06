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
  it('should define 6 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });

  it('should have valid input schemas', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required.length).toBeGreaterThan(0);
    }
  });

  it('should use arkova_ prefix on all tool names (DX-04)', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^arkova_/);
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
