# @arkova/mcp-server

MCP (Model Context Protocol) server tools for Arkova credential verification. Works with Claude, OpenAI, Cursor, and any MCP-compatible client.

## Installation

```bash
npm install @arkova/mcp-server
```

## Configuration

Set environment variables:

```bash
export ARKOVA_API_KEY=ak_live_your_key
export ARKOVA_API_URL=https://api.arkova.ai  # optional, this is the default
```

## Tools

| Tool | Description |
|------|-------------|
| `verify_credential` | Verify a credential by public ID or fingerprint |
| `get_credential_status` | Get anchor status and proof details |
| `search_credentials` | Search by name, institution, or type |
| `create_attestation` | Create a third-party attestation |
| `verify_signature` | Verify an AdES electronic signature |

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arkova": {
      "command": "npx",
      "args": ["@arkova/mcp-server"],
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
