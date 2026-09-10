import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectMcpContractDrift,
  collectOpenApiAgentDrift,
  collectOpenApiAgentOperations,
  zodObjectKeys,
  zodRequiredKeys,
} from './check-api-contract-drift.js';
import type { ToolDefinition } from './check-api-contract-drift.js';
import { TOOL_DEFINITIONS } from '../../services/edge/src/mcp-tools';
import { MCP_TOOL_SCHEMAS } from '../../services/edge/src/mcp-tool-schemas';
import { openApiV2Spec } from '../../services/worker/src/api/v2/openapi';

describe('check-api-contract-drift', () => {
  it('keeps the actual REST operation IDs aligned with namespaced MCP tools and validators', () => {
    expect([
      ...collectMcpContractDrift(TOOL_DEFINITIONS, MCP_TOOL_SCHEMAS),
      ...collectOpenApiAgentDrift(openApiV2Spec, MCP_TOOL_SCHEMAS),
    ]).toEqual([]);
  });
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
        '/search': { get: { operationId: 'search', 'x-agent-usage': { tool_name: 'arkova_search' } } },
        '/verify/{fingerprint}': { get: { operationId: 'verify', 'x-agent-usage': { tool_name: 'arkova_verify' } } },
        '/anchors/{public_id}': { get: { operationId: 'get_anchor', 'x-agent-usage': { tool_name: 'arkova_get_anchor' } } },
        '/orgs': { get: { operationId: 'list_orgs', 'x-agent-usage': { tool_name: 'arkova_list_orgs' } } },
      },
    };

    const violations = collectOpenApiAgentDrift(spec, {
      arkova_search: z.object({ q: z.string() }),
      arkova_verify: z.object({ fingerprint: z.string() }),
      arkova_get_anchor: z.object({ public_id: z.string() }),
      arkova_list_orgs: z.object({}),
    });

    expect(violations).toEqual([]);
  });

  it('discovers OpenAPI agent operations dynamically from x-agent-usage', () => {
    const spec = {
      paths: {
        '/search': { get: { operationId: 'search', 'x-agent-usage': { tool_name: 'arkova_search' } } },
        '/future-agent': { get: { operationId: 'future_agent', 'x-agent-usage': { tool_name: 'arkova_future_agent' } } },
        '/openapi.json': { get: { operationId: 'get_openapi_v2_spec' } },
      },
    };

    expect(collectOpenApiAgentOperations(spec).map((operation) => operation.path)).toEqual([
      '/future-agent',
      '/search',
    ]);

    expect(collectOpenApiAgentDrift(spec, {
      arkova_search: z.object({ q: z.string() }),
    })).toEqual([
      {
        source: 'openapi:/future-agent',
        message: 'missing MCP schema arkova_future_agent for operationId future_agent',
      },
    ]);
  });

  it('reports explicit OpenAPI agent drift violation reasons', () => {
    const spec = {
      paths: {
        '/missing-operation-id': { get: { 'x-agent-usage': { tool_name: 'arkova_search' } } },
        '/mismatched-tool': { get: { operationId: 'search', 'x-agent-usage': { tool_name: 'find' } } },
        '/missing-schema': { get: { operationId: 'future_agent', 'x-agent-usage': { tool_name: 'arkova_future_agent' } } },
      },
    };

    const violations = collectOpenApiAgentDrift(spec, {
      arkova_search: z.object({ q: z.string() }),
    });

    expect(violations).toContainEqual({
      source: 'openapi:/missing-operation-id',
      message: 'missing operationId',
    });
    expect(violations).toContainEqual({
      source: 'openapi:/mismatched-tool',
      message: 'x-agent-usage.tool_name find does not match expected MCP tool arkova_search for operationId search',
    });
    expect(violations).toContainEqual({
      source: 'openapi:/missing-schema',
      message: 'missing MCP schema arkova_future_agent for operationId future_agent',
    });
  });
  it('rejects the obsolete unprefixed contract even when the old validator exists', () => {
    expect(collectOpenApiAgentDrift({ paths: {
      '/search': { get: { operationId: 'search', 'x-agent-usage': { tool_name: 'search' } } },
    } }, { search: z.object({ q: z.string() }) })).toEqual([
      { source: 'openapi:/search', message: 'x-agent-usage.tool_name search does not match expected MCP tool arkova_search for operationId search' },
      { source: 'openapi:/search', message: 'missing MCP schema arkova_search for operationId search' },
    ]);
  });

});
