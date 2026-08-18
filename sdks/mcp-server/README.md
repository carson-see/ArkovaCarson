# arkova-mcp-server

MCP (Model Context Protocol) server tools for Arkova credential verification. Works with Claude, OpenAI, Cursor, and any MCP-compatible client.

> **Hosted vs. local.** Arkova also runs a **hosted** MCP endpoint at
> [`edge.arkova.ai`](https://edge.arkova.ai) (a Cloudflare Worker) that most
> integrations should use directly — no install required. **This package is
> the local/stdio alternative**: it runs the same class of Arkova
> verification tools as a subprocess on your machine, for clients that only
> speak the stdio MCP transport (e.g. Claude Desktop) or for environments
> that can't reach a hosted endpoint. The two are separate implementations
> with independently maintained tool sets — a fix to one does not reach the
> other.

## Installation

Run directly with `npx` (no install step needed):

```bash
npx -y arkova-mcp-server
```

Or install it:

```bash
npm install -g arkova-mcp-server
```

## Configuration

Set environment variables:

```bash
export ARKOVA_API_KEY=ak_live_your_key
export ARKOVA_API_URL=https://api.arkova.ai  # optional, this is the default
```

The server starts and warns to stderr (does not exit) if `ARKOVA_API_KEY` is unset — unauthenticated tool calls will fail with a 401 from the Arkova API.

## Tools

10 tools total, all read the same `ARKOVA_API_KEY`:

| Tool | Description |
|------|-------------|
| `arkova_verify_credential` | Verify a credential's authenticity and Bitcoin anchor status by public ID or fingerprint |
| `arkova_credential_status` | Get anchor status and proof details for a credential |
| `arkova_search_credentials` | Search verified credentials by name, institution, credential type, or other metadata |
| `arkova_create_attestation` | Create a third-party attestation (requires org admin privileges) |
| `arkova_batch_verify` | Verify multiple credentials at once (max 100 public IDs) |
| `arkova_verify_signature` | Verify an AdES electronic signature (Phase III) |
| `nessie_compliance_score` | Get an organization's compliance score for a jurisdiction/industry pair |
| `nessie_gap_analysis` | Identify missing required/recommended compliance documents |
| `nessie_ask` | Ask Nessie a compliance question, answered with citations to anchored source documents |
| `nessie_cross_reference` | Cross-reference multiple anchored documents for inconsistencies |

## Usage with Claude Desktop

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

## Rate Limits

- Anonymous: 100 req/min
- API key: 1,000 req/min
- Batch: 10 req/min

## License

MIT
