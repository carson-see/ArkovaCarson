# @arkova/langchain

LangChain tool wrappers for the Arkova credential verification API.

## Installation

```bash
npm install @arkova/langchain
```

## Usage

```typescript
import { getArkovaTools } from '@arkova/langchain';

const tools = getArkovaTools({
  apiKey: 'ak_live_your_api_key_here',
});

// Use with any LangChain agent
// tools includes: ArkovaVerifyTool, ArkovaAnchorStatusTool,
//                 ArkovaSearchTool, ArkovaAttestTool
```

## Tools

| Tool | Description |
|------|-------------|
| `arkova_verify_credential` | Verify a credential by public ID |
| `arkova_anchor_status` | Check anchor status and proof details |
| `arkova_search_credentials` | Search verified credentials |
| `arkova_create_attestation` | Create a third-party attestation |

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
