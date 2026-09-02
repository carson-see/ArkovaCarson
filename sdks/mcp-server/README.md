# arkova-mcp-server

MCP (Model Context Protocol) server tools for Arkova record verification. Works with Claude, OpenAI, Cursor, and any MCP-compatible client.

There are **two** Arkova MCP surfaces. Prefer the hosted one.

| | Hosted | This package (local / stdio) |
|---|---|---|
| Endpoint | `https://edge.arkova.ai/mcp` | subprocess on your machine |
| Transport | streamable HTTP | stdio |
| Install | none | `npx` or `npm install -g` |
| Implementation | `services/edge/` (Cloudflare Worker) | `sdks/mcp-server/` |

They are **separate implementations with independently maintained tool sets** — a fix to one does not reach the other. Use this package only for clients that speak stdio and nothing else, or for environments that cannot reach the hosted endpoint.

## Hosted (recommended)

```bash
claude mcp add --transport http arkova https://edge.arkova.ai/mcp --header "X-API-Key: ak_live_your_key"
```

Get a key at <https://app.arkova.ai/settings/api-keys>.

The endpoint also advertises OAuth via `WWW-Authenticate` and serves valid protected-resource metadata at `/mcp/.well-known/oauth-protected-resource`. **That path is not usable yet** — the authorization server it names (`https://edge.arkova.ai/auth`) is not deployed, so its discovery document returns 404 and the OAuth handshake cannot complete. Use `X-API-Key` until that ships.

## Local / stdio

The published npm name is **`arkova-mcp-server`** — unscoped. There is no `@arkova/mcp-server` package; that name returns a 404.

```bash
npx -y arkova-mcp-server
```

Or install it globally:

```bash
npm install -g arkova-mcp-server
```

### Configuration

| Variable | Required | Default |
|---|---|---|
| `ARKOVA_API_KEY` | Yes, for authenticated tools | none |
| `ARKOVA_API_URL` | No | `https://api.arkova.ai` |

**Set the key in your MCP client's config, not in your shell.** Claude Desktop, Claude Code, and Cursor launch this server as a subprocess that does **not** inherit an interactive shell's environment, so an `export ARKOVA_API_KEY=…` at your terminal prompt will not reach it. Use the `env` block below. `ARKOVA_API_URL` only needs setting to point at a non-production Arkova API.

The server starts and warns to stderr (it does **not** exit) when `ARKOVA_API_KEY` is unset — authenticated tool calls then fail with a 401 from the Arkova API rather than failing at startup.

### Claude Code

```bash
claude mcp add arkova -e ARKOVA_API_KEY=ak_live_your_key -- npx -y arkova-mcp-server
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arkova": {
      "command": "npx",
      "args": ["-y", "arkova-mcp-server"],
      "env": {
        "ARKOVA_API_KEY": "ak_live_your_key"
      }
    }
  }
}
```

### Verifying the install

The server speaks JSON-RPC over stdio. A handshake plus a `tools/list` confirms it is connectable without needing an API key:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npx -y arkova-mcp-server
```

A healthy server replies with its `serverInfo` and all 6 tool definitions. The `ARKOVA_API_KEY is not set` line on stderr is expected here and is not a failure.

## Tools

6 tools total, all reading the same `ARKOVA_API_KEY`. **Every tool is a remote HTTPS call to the Arkova API.** None of them read local files, environment variables, or stored secrets.

| Tool | Description |
|------|-------------|
| `arkova_verify_anchor` | Verify an anchored record's authenticity and network anchor status by public ID |
| `arkova_anchor_status` | Get anchor status and proof details for an anchored record |
| `arkova_search_anchors` | Search the Arkova public registry by subject name, issuing institution, or record type |
| `arkova_create_attestation` | Create a third-party attestation (requires `attester_name` and a non-empty `claims` array; any authenticated API key, not just org admins) |
| `arkova_batch_verify` | Verify up to 20 public IDs at once; results returned inline |
| `arkova_verify_signature` | Verify an AdES electronic signature (Phase III) |

### Renamed / removed in this version (v3.0.0, breaking)

Three tools were renamed. The old names contained "credential", which in an agent tool namespace reads as *authentication secrets* rather than *verified records* — an agent asked to "search arkova credentials" skipped this server entirely and swept the local filesystem for `.env` files instead.

The 4 `nessie_`-prefixed compliance-intelligence tools (NCE-19) were removed outright. This server only ever authenticates with `X-API-Key`, but the worker's `/compliance/score`, `/compliance/gap-analysis`, and `/compliance/cross-reference` routes require a Supabase JWT and explicitly reject `Bearer ak_…` — so three of them 401'd for every real caller regardless of key validity. The fourth, `nessie_ask`, was already a standing 503 by founder directive (Nessie is off in production). With none of the four reachable, there was nothing left to disclose a workaround for.

| Old | New / reason |
|---|---|
| `arkova_verify_credential` | `arkova_verify_anchor` |
| `arkova_credential_status` | `arkova_anchor_status` |
| `arkova_search_credentials` | `arkova_search_anchors` |
| `nessie_compliance_score` | removed — 401s for every caller (`/compliance/*` requires a Supabase JWT; this server sends `X-API-Key` only) |
| `nessie_gap_analysis` | removed — same reason |
| `nessie_cross_reference` | removed — same reason |
| `nessie_ask` | removed — standing 503 by founder directive; the endpoint isn't served in production |

There are no aliases: keeping the old names available would preserve the ambiguity that caused the original failure, and there is no working destination to alias the 4 removed tools to.

## Rate Limits

- Anonymous: 100 req/min
- API key: 1,000 req/min
- Batch: 10 req/min

## License

MIT
