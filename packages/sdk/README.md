# @arkova/sdk

TypeScript SDK for the Arkova verification API. Anchor documents with cryptographic proof and verify them later.

## Install

```bash
npm install @arkova/sdk
```

## Quick Start

```typescript
import { Arkova } from '@arkova/sdk';

const arkova = new Arkova({ apiKey: 'ak_...' });

// Anchor a document
const receipt = await arkova.anchor('document content');
console.log(receipt.publicId); // ARK-2026-001

// Verify later
const result = await arkova.verify(receipt.publicId);
console.log(result.verified); // true

// Search verified public records
const results = await arkova.query('SEC filing Apple 2025');

// Ask Nessie (RAG with verified citations)
const answer = await arkova.ask('What was Apple revenue in 2025?');
console.log(answer.answer);
console.log(answer.citations); // Each citation links to an anchored document
```

## API

### `new Arkova(config)`

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | API key (get one at app.arkova.io/settings/api-keys) |
| `baseUrl` | `string` | API base URL (default: production) |

### `arkova.anchor(data)`

Compute SHA-256 fingerprint and submit for network anchoring.

### `arkova.verify(publicId)` / `arkova.verify(data, receipt)`

Verify a document's anchor status. Returns verification result with proof.

### `arkova.query(question, options?)`

Semantic search over anchored public records (SEC filings, patents, regulatory docs).

### `arkova.ask(question, options?)`

RAG query with verified citations. Returns a synthesized answer citing anchored documents.

### `arkova.fingerprint(data)`

Generate SHA-256 fingerprint client-side. The document never leaves your device.
