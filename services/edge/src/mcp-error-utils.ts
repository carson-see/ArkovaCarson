/**
 * Shared MCP tool-error scrubbing (F4).
 *
 * `mcp-server.ts` originally defined `safeErrorText` for its own top-level
 * tool-registration catch blocks. `mcp-tools.ts` had ~10 hand-built
 * `errorResult(`...failed: ${error.message}`)` catch blocks that never went
 * through it, so a raw `Error.message` — which can carry an internal host,
 * a URL with query params, or other server-side detail — could reach
 * `content[0].text` verbatim on an MCP client. Pulled into its own module
 * (rather than importing `mcp-server.ts` from `mcp-tools.ts`) because
 * `mcp-server.ts` imports `TOOL_DEFINITIONS` from `mcp-tools.ts` already —
 * the reverse import would be a cycle.
 */

/**
 * Scrub a tool handler error before it reaches the MCP client. Full detail
 * goes to `console.error` (Cloudflare Logpush); the client gets a fixed,
 * non-leaking envelope — never `String(err)` or `err.message`, both of
 * which can carry internal hosts/URLs/stack frames.
 */
export function safeErrorText(err: unknown, context: string): string {
  console.error(`[mcp-server] ${context}:`, err);
  return JSON.stringify({ error: `${context} failed`, code: 'TOOL_ERROR' });
}
