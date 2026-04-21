/**
 * MCP tool-argument schema registry tests — MCP-SEC-07 / SCRUM-984.
 *
 * Validates that every registered tool rejects malformed input with the
 * structured error envelope and accepts canonical inputs. The registry
 * is the single boundary for MCP tool arguments; a missing test here
 * means a tool handler can be reached with untyped args.
 */

import { describe, expect, it } from 'vitest';

// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves at runtime
import {
  MCP_TOOL_SCHEMAS,
  validateToolArgs,
  validationErrorToToolResult,
  type McpToolName,
} from '../../edge/src/mcp-tool-schemas.js';

const VALID_PUBLIC_ID = 'ARK-DEG-ABCDEF';
const VALID_HASH = 'a'.repeat(64);

describe('MCP_TOOL_SCHEMAS registry', () => {
  it('covers every tool that mcp-server.ts exposes', () => {
    const names: McpToolName[] = Object.keys(MCP_TOOL_SCHEMAS) as McpToolName[];
    expect(names).toEqual(
      expect.arrayContaining([
        'verify_credential',
        'search_credentials',
        'nessie_query',
        'anchor_document',
        'verify_document',
        'verify_batch',
        'oracle_batch_verify',
        'list_agents',
      ]),
    );
  });
});

describe('validateToolArgs — unknown tool', () => {
  it('returns UNKNOWN_TOOL without throwing', () => {
    const result = validateToolArgs('not_a_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN_TOOL');
      expect(result.error.issues).toEqual([]);
    }
  });
});

describe('validateToolArgs — verify_credential', () => {
  it('accepts a canonical public_id', () => {
    const result = validateToolArgs('verify_credential', { public_id: VALID_PUBLIC_ID });
    expect(result.ok).toBe(true);
  });

  it('rejects a lowercase public_id with INVALID_ARGS', () => {
    const result = validateToolArgs('verify_credential', { public_id: 'ark-deg-abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(result.error.issues[0].path).toBe('public_id');
    }
  });

  it('rejects extra fields in strict mode', () => {
    const result = validateToolArgs('verify_credential', {
      public_id: VALID_PUBLIC_ID,
      injected: 'x',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects missing public_id', () => {
    const result = validateToolArgs('verify_credential', {});
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    const result = validateToolArgs('verify_credential', 'not-an-object');
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — search_credentials', () => {
  it('accepts query + optional max_results', () => {
    const result = validateToolArgs('search_credentials', { query: 'registered nurse', max_results: 5 });
    expect(result.ok).toBe(true);
  });

  it('rejects empty query', () => {
    const result = validateToolArgs('search_credentials', { query: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects max_results > 50', () => {
    const result = validateToolArgs('search_credentials', { query: 'x', max_results: 500 });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — nessie_query', () => {
  it('accepts mode=retrieval', () => {
    const result = validateToolArgs('nessie_query', { query: 'FCRA', mode: 'retrieval' });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown mode', () => {
    const result = validateToolArgs('nessie_query', { query: 'x', mode: 'other' });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — anchor_document', () => {
  it('accepts content_hash only', () => {
    const result = validateToolArgs('anchor_document', { content_hash: VALID_HASH });
    expect(result.ok).toBe(true);
  });

  it('rejects a too-short hash', () => {
    const result = validateToolArgs('anchor_document', { content_hash: 'abc' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-URL source_url', () => {
    const result = validateToolArgs('anchor_document', {
      content_hash: VALID_HASH,
      source_url: 'not a url',
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — verify_document', () => {
  it('accepts a valid SHA-256 hash', () => {
    const result = validateToolArgs('verify_document', { content_hash: VALID_HASH });
    expect(result.ok).toBe(true);
  });

  it('rejects non-hex characters', () => {
    const result = validateToolArgs('verify_document', { content_hash: 'Z'.repeat(64) });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — verify_batch', () => {
  it('accepts an array of 1-100 public_ids', () => {
    const result = validateToolArgs('verify_batch', { public_ids: [VALID_PUBLIC_ID] });
    expect(result.ok).toBe(true);
  });

  it('rejects empty array', () => {
    const result = validateToolArgs('verify_batch', { public_ids: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid ID within the array', () => {
    const result = validateToolArgs('verify_batch', { public_ids: [VALID_PUBLIC_ID, 'not-valid'] });
    expect(result.ok).toBe(false);
  });

  it('rejects > 100 entries', () => {
    const big = Array.from({ length: 101 }, () => VALID_PUBLIC_ID);
    const result = validateToolArgs('verify_batch', { public_ids: big });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — oracle_batch_verify', () => {
  it('caps at 25 entries', () => {
    const over = Array.from({ length: 26 }, () => VALID_PUBLIC_ID);
    const result = validateToolArgs('oracle_batch_verify', { public_ids: over });
    expect(result.ok).toBe(false);
  });
});

describe('validateToolArgs — list_agents', () => {
  it('accepts empty object', () => {
    const result = validateToolArgs('list_agents', {});
    expect(result.ok).toBe(true);
  });

  it('rejects any argument (strict schema)', () => {
    const result = validateToolArgs('list_agents', { status: 'active' });
    expect(result.ok).toBe(false);
  });
});

describe('validationErrorToToolResult', () => {
  it('returns an MCP error envelope without leaking internal state', () => {
    const result = validateToolArgs('verify_credential', { public_id: 'lowercase' });
    if (result.ok) throw new Error('expected failure');

    const envelope = validationErrorToToolResult(result.error);
    expect(envelope.isError).toBe(true);
    expect(envelope.content).toHaveLength(1);
    const body = JSON.parse(envelope.content[0].text) as {
      error: string;
      tool: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('INVALID_ARGS');
    expect(body.tool).toBe('verify_credential');
    expect(body.issues.length).toBeGreaterThan(0);
    // No `received` field, no stack traces, no internal paths.
    expect(envelope.content[0].text).not.toContain('ZodError');
    expect(envelope.content[0].text).not.toContain('received');
  });
});
