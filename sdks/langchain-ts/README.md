# @arkova/langchain

Zero-dependency, LangChain-style callable tools for the Arkova record verification API.

Each exported tool has `name`, `description`, and `call(input: string): Promise<string>`.
The package does not depend on `@langchain/core`, and its classes do not extend
LangChain `Tool`, `StructuredTool`, or `Runnable`. Use them directly in code that
accepts this small callable shape, or wrap them in the adapter required by your
installed LangChain version before passing them to an agent executor.

**ESM only.** This package ships as `"type": "module"` with an `exports` map
declaring only `import`/`types` conditions — there is no CJS build and no
`require` entry point. `import { getArkovaTools } from '@arkova/langchain'`
(or dynamic `await import('@arkova/langchain')` from CommonJS) works
everywhere Node `>=18` runs it. **A plain `require('@arkova/langchain')`
does not work, on any Node version** — it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` (verified against the real published
tarball on Node 25.6.1, and true by the exports-conditions algorithm on
every Node version: an `exports` map with no `require` condition refuses
a `require()` caller before Node's separate `require(esm)` interop is ever
considered — that interop only applies to a bare ESM file with no
restricting `exports` map, which is not this package's shape). If your
project is CommonJS and you cannot move to `import`/dynamic `import()`,
use `sdks/mcp-server` instead (published as `arkova-mcp-server`) or wait
for a dual-build release — see `agents.md` for why this package did not
add one in this pass.

## Installation

**Not yet published.** `@arkova/langchain` returns a 404 on the npm registry — no package name has
been reserved and there is no published version to install. Do not `npm install @arkova/langchain`;
it will fail. Until this ships, use the source directly from this directory (`sdks/langchain-ts/`)
or via `sdks/mcp-server/` (published as `arkova-mcp-server`), which exposes a 9-tool set over MCP —
this package covers a 6-tool subset (it has no equivalent of `arkova_submit_anchor`,
`arkova_get_submission_status`, or `arkova_manage_folders`); see "Tools" below.

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

6 tools total. This is a subset of `sdks/mcp-server`'s 9-tool set — this package has no equivalent
of `arkova_submit_anchor`, `arkova_get_submission_status`, or `arkova_manage_folders`. Every tool
here is a remote HTTPS call to the Arkova API — none of them read local files, environment
variables, or stored secrets.

| Tool | Description |
|------|-------------|
| `arkova_verify_anchor` | Verify an anchored record by public ID |
| `arkova_anchor_status` | Check network anchor status and proof details |
| `arkova_search_anchors` | Search verified anchored records |
| `arkova_create_attestation` | Create a third-party attestation (attester_name + claims required) |
| `arkova_batch_verify` | Verify up to 20 public IDs at once, results returned inline |
| `arkova_verify_signature` | Verify an AdES electronic signature (Phase III) |

`arkova_verify_anchor` returns an **explicit allowlist** of the verification
API response — `verified`, `valid` (a convenience field derived only from the
API's authoritative `verified` boolean), `public_id`, `status`,
`credential_type`, `anchored_at`, `network_receipt_id`, `proof_availability`,
and `issuer`. It does **not** pass through the full API response: the real
endpoint's frozen schema includes issuer- or extraction-authored free-text
fields (e.g. `description`, `sub_type`) this package has never reviewed, and
a tool's return value becomes an LLM's context — an unreviewed free-text
field is exactly where a prompt-injection payload would live. `issuer`
(institution name) is the one allowlisted field that is still issuer-authored
text; it is bounded to 200 characters and has control characters (newlines
included) stripped before it is returned. Pending states such as `PENDING`
and `SUBMITTED`, plus revoked or unknown states, return `valid: false`;
callers can still inspect `status` and the returned proof fields as evidence.

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
