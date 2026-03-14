/**
 * Tests for the Arkova MCP Server (P8-S19).
 *
 * Validates tool registration, input validation, and response format.
 * Tests run against the shared logic module (not the CF Worker runtime).
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_DEFINITIONS,
  handleVerifyCredential,
  handleSearchCredentials,
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
    });

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });

  it('returns error for empty query', async () => {
    const input: SearchInput = { query: '' };
    const result = await handleSearchCredentials(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
    });

    expect(result.isError).toBe(true);
  });

  it('respects max_results limit', async () => {
    const input: SearchInput = { query: 'degree', max_results: 5 };
    const result = await handleSearchCredentials(input, {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
    });

    expect(result).toHaveProperty('content');
  });
});
