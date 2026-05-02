import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectMcpContractDrift,
  collectOpenApiAgentDrift,
  zodObjectKeys,
  zodRequiredKeys,
} from './check-api-contract-drift.js';
import type { ToolDefinition } from './check-api-contract-drift.js';

describe('check-api-contract-drift', () => {
  it('extracts Zod object keys and required keys', () => {
    const schema = z.object({
      q: z.string(),
      type: z.enum(['all', 'org']).optional(),
    }).strict();

    expect(zodObjectKeys(schema)).toEqual(['q', 'type']);
    expect(zodRequiredKeys(schema)).toEqual(['q']);
  });

  it('detects MCP definition/schema property drift', () => {
    const definitions: ToolDefinition[] = [
      {
        name: 'search',
        description: 'Search.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Query.' },
            limit: { type: 'number', description: 'Limit.' },
          },
          required: ['q'],
        },
      },
    ];

    const violations = collectMcpContractDrift(definitions, {
      search: z.object({ q: z.string(), max_results: z.number().optional() }).strict(),
    });

    expect(violations).toEqual([
      {
        source: 'mcp:search',
        message: 'tool definition properties limit,q differ from validator properties max_results,q',
      },
    ]);
  });

  it('requires every v2 OpenAPI agent operation to have a matching MCP schema', () => {
    const spec = {
      paths: {
        '/search': { get: { operationId: 'search', 'x-agent-usage': { tool_name: 'search' } } },
        '/verify/{fingerprint}': { get: { operationId: 'verify', 'x-agent-usage': { tool_name: 'verify' } } },
        '/anchors/{public_id}': { get: { operationId: 'get_anchor', 'x-agent-usage': { tool_name: 'get_anchor' } } },
        '/orgs': { get: { operationId: 'list_orgs', 'x-agent-usage': { tool_name: 'list_orgs' } } },
      },
    };

    const violations = collectOpenApiAgentDrift(spec, {
      search: z.object({ q: z.string() }),
      verify: z.object({ fingerprint: z.string() }),
      get_anchor: z.object({ public_id: z.string() }),
      list_orgs: z.object({}),
    });

    expect(violations).toEqual([]);
  });
});
