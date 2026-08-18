#!/usr/bin/env node
/**
 * arkova-mcp-server — stdio entrypoint (npm `bin`)
 *
 * `npx arkova-mcp-server` (or the installed bin, e.g. from Claude Desktop's
 * `claude_desktop_config.json`) runs this file. It wires the existing
 * TOOL_DEFINITIONS / handleToolCall pair (index.ts) onto a real
 * `@modelcontextprotocol/sdk` Server over stdio, so this package is a
 * connectable MCP server, not just a library of tool definitions.
 *
 * This is the LOCAL / stdio alternative. The HOSTED MCP endpoint is
 * edge.arkova.ai (services/edge/, a Cloudflare Worker) — a separate
 * implementation with its own tool set and its own transport
 * (streamable HTTP, not stdio). A fix here does not reach that surface and
 * vice versa; see sdks/agents.md.
 *
 * Auth: ARKOVA_API_KEY environment variable (same as the library — see
 * index.ts). `ARKOVA_API_URL` optionally overrides the API base.
 *
 * Story: PH2-AGENT-06 (SCRUM-403); npm publication prep (2026-08-18).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, handleToolCall } from './index.js';

// Keep in sync with package.json "version" — no runtime JSON import here to
// avoid ESM import-assertion version skew across Node LTS releases.
const SERVER_VERSION = '2.2.0';

/**
 * Builds a Server wired to TOOL_DEFINITIONS / handleToolCall. Exported
 * (rather than only constructed inside main()) so tests can drive it over
 * an InMemoryTransport instead of the real stdio streams.
 */
export function createServer(): Server {
  const server = new Server(
    { name: 'arkova-mcp-server', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const result = await handleToolCall(name, (args ?? {}) as Record<string, string>);
    return { content: result.content, isError: result.isError };
  });

  return server;
}

async function main(): Promise<void> {
  if (!process.env.ARKOVA_API_KEY) {
    // Non-fatal: some tools (e.g. public search) may still function without
    // a key server-side, and refusing to start would be a worse failure
    // mode than letting the first authenticated call surface a 401.
    process.stderr.write(
      'arkova-mcp-server: ARKOVA_API_KEY is not set — authenticated tool calls will fail.\n',
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the live stdio server when this file is the process entry point
// (i.e. actually invoked as the `bin`). Importing it — as the test suite
// does, to reach `createServer()` — must not also start reading stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(
      `arkova-mcp-server: fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
