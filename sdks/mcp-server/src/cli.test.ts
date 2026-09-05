/**
 * arkova-mcp-server stdio entrypoint tests
 *
 * `cli.ts` is the `bin` target (`npx arkova-mcp-server`) — it wires
 * TOOL_DEFINITIONS / handleToolCall (index.ts) onto a real MCP Server over
 * stdio. These tests drive the server through the actual MCP protocol using
 * the SDK's InMemoryTransport, rather than reaching into private handler
 * maps, so a protocol-shape regression (wrong schema, wrong response
 * envelope) fails here the same way it would fail a real client.
 *
 * Story: NPM-PUBLISH-PREP (npm publication of the local/stdio MCP server).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './cli.js';
import { TOOL_DEFINITIONS } from './index.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

async function connectedClient(): Promise<Client> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('createServer', () => {
  it('lists every TOOL_DEFINITIONS entry over the real MCP protocol', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(tools.map((t) => t.name).sort()).toEqual(
      TOOL_DEFINITIONS.map((t) => t.name).sort(),
    );
  });

  it('dispatches tools/call to handleToolCall and returns its result verbatim', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ public_id: 'ARK-X', status: 'SECURED' }),
    });

    const client = await connectedClient();
    const result = await client.callTool({
      name: 'arkova_verify_credential',
      arguments: { public_id: 'ARK-X' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ARK-X');
    expect(content[0].text).toContain('SECURED');
  });

  it('surfaces handleToolCall errors as MCP tool errors, not protocol errors', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'nonexistent_tool',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Unknown tool');
  });

  it('treats a missing arguments object as an empty argument set, not a crash', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'nonexistent_tool' });

    expect(result.isError).toBe(true);
  });
});

describe('module import safety', () => {
  it('does not connect a live stdio transport merely by being imported', async () => {
    // If importing this module for its exports also started reading
    // process.stdin, this test process (and every future one) would hang.
    // Reaching this assertion at all is the proof; the entry-check in
    // cli.ts (`import.meta.url === file://${argv[1]}`) is what makes that
    // true, and only the compiled bin script sets argv[1] to this file.
    expect(typeof createServer).toBe('function');
  });
});
