# @arkova/langchain

Zero-dependency, LangChain-style callable tools for the Arkova record verification API.

Each exported tool has `name`, `description`, and `call(input: string): Promise<string>`.
The package does not depend on `@langchain/core`, and its classes do not extend
LangChain `Tool`, `StructuredTool`, or `Runnable`. Use them directly in code that
accepts this small callable shape, or wrap them in the adapter required by your
installed LangChain version before passing them to an agent executor.

## Installation

**Not yet published.** `@arkova/langchain` returns a 404 on the npm registry — no package name has
been reserved and there is no published version to install. Do not `npm install @arkova/langchain`;
it will fail. Until this ships, use the source directly from this directory (`sdks/langchain-ts/`)
or via `sdks/mcp-server/` (published as `arkova-mcp-server`), which has the same 6-tool set over MCP.

## Usage

```typescript
import { getArkovaTools } from '@arkova/langchain';

const tools = getArkovaTools({
  apiKey: 'ak_live_your_api_key_here',
});

// tools includes: ArkovaVerifyTool, ArkovaAnchorStatusTool, ArkovaSearchTool,
//                 ArkovaAttestTool, ArkovaBatchVerifyTool, ArkovaVerifySignatureTool

// The stable package contract is the tool's own call(string) method.
const result = await tools[0].call('ARK-EXAMPLE-RECORD-001');

// To use a current LangChain agent, wrap `name`, `description`, and `call`
// with the Tool/DynamicTool adapter supplied by your installed LangChain version.
```

Arkova does not claim direct compatibility with every LangChain release. The
framework changes its tool base classes and invocation interfaces independently;
pin and test your application-side adapter when upgrading LangChain.

## Tools

6 tools total, in parity with `sdks/mcp-server`'s tool set. Every tool is a remote HTTPS call to the
Arkova API — none of them read local files, environment variables, or stored secrets.

| Tool | Description |
|------|-------------|
| `arkova_verify_anchor` | Verify an anchored record by public ID |
| `arkova_anchor_status` | Check network anchor status and proof details |
| `arkova_search_anchors` | Search verified anchored records |
| `arkova_create_attestation` | Create a third-party attestation (attester_name + claims required) |
| `arkova_batch_verify` | Verify up to 20 public IDs at once, results returned inline |
| `arkova_verify_signature` | Verify an AdES electronic signature (Phase III) |

`arkova_verify_anchor` preserves the verification API response and adds a
`valid` convenience field derived only from the API's authoritative `verified`
boolean. Pending states such as `PENDING` and `SUBMITTED`, plus revoked or
unknown states, return `valid: false`; callers can still inspect `status` and
the returned proof fields as evidence.

## Configuration

```typescript
const config = {
  apiKey: 'ak_live_...',        // Required
  baseUrl: 'https://api.arkova.ai', // Optional (default)
  timeoutMs: 10000,             // Optional (default: 10s)
};
```

## Rate Limits

- Anonymous: 100 req/min
- API key: 1,000 req/min
- Batch: 10 req/min

## License

MIT
