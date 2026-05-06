# @arkova/sdk

> The official TypeScript / JavaScript SDK for the Arkova verification API.
> Anchor documents to a public network, call the API v2 agent tools, verify records, and manage webhooks — all without ever opening the Arkova web app.

[![npm version](https://img.shields.io/npm/v/@arkova/sdk.svg)](https://www.npmjs.com/package/@arkova/sdk) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Table of Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Anchoring](#anchoring)
- [Verification](#verification)
- [Batch verification](#batch-verification)
- [API v2 agent tools](#api-v2-agent-tools)
- [Webhook management](#webhook-management)
- [Nessie semantic search](#nessie-semantic-search)
- [Error handling](#error-handling)
- [x402 micropayments](#x402-micropayments)
- [TypeScript types](#typescript-types)
- [Browser usage](#browser-usage)
- [Reference](#reference)

---

## Install

```bash
npm install @arkova/sdk
# or
pnpm add @arkova/sdk
# or
yarn add @arkova/sdk
```

**Requirements:** Node.js ≥18 (uses native `fetch` and `crypto.subtle`). Works in browsers, Cloudflare Workers, Deno, and Bun without polyfills.

**Bundle size:** Under 10KB minified, zero runtime dependencies.

---

## Quickstart

```typescript
import { Arkova } from '@arkova/sdk';

const arkova = new Arkova({ apiKey: process.env.ARKOVA_API_KEY });

// 1. Anchor a document — fingerprint runs client-side, the document never leaves your machine
const receipt = await arkova.anchor('document content goes here');
console.log(receipt.publicId); // "ARK-2026-001"

// 2. Verify it later by public ID
const result = await arkova.verify(receipt.publicId);
console.log(result.verified); // true

// 3. Verify synchronous batches
const batch = await arkova.verifyBatch(['ARK-2026-001', 'ARK-2026-002', 'ARK-2026-003']);

// 4. Register a webhook so your system gets notified instead of polling
const webhook = await arkova.webhooks.create({
  url: 'https://api.example.com/hooks/arkova',
  events: ['anchor.secured', 'anchor.revoked'],
});
console.log('Save this secret:', webhook.secret); // shown ONCE — store immediately
```

That's it. No UI, no SDK calls to learn beyond `anchor`, `verify`, `verifyBatch`, v2 `search`, and `webhooks.*`.

### 20-line document anchor example

See [`examples/anchor-document.ts`](./examples/anchor-document.ts) for a complete Node 18+ script that anchors a local document and prints the public ID.

---

## Configuration

```typescript
import { Arkova } from '@arkova/sdk';

const arkova = new Arkova({
  /** API key — get one from app.arkova.ai/settings/api-keys */
  apiKey: 'ak_live_...',

  /** Override the API base URL (default: production worker) */
  baseUrl: 'https://arkova-worker-270018525501.us-central1.run.app',

  /** Optional retry tuning. 429 responses honor Retry-After automatically. */
  retry: { retries: 2, baseDelayMs: 250, maxDelayMs: 5000 },

  /** Optional x402 micropayment config (machine-to-machine billing) */
  x402: {
    payerAddress: '0xae12...',
    signPayment: async (amount, payTo) => {
      // your wallet signing logic
      return signedPaymentToken;
    },
  },
});
```

The `apiKey` is the only thing you usually need. The SDK ships pointed at the production worker; only override `baseUrl` for local development or staging.

---

## Anchoring

### `arkova.anchor(data)`

Compute a SHA-256 fingerprint of `data` (in your browser/process — the raw document never leaves your device) and submit just the fingerprint to Arkova for network anchoring.

```typescript
// String input
const r1 = await arkova.anchor('any document content');

// Binary input (ArrayBuffer or Uint8Array)
const fileBytes = await fetch('/path/to/file.pdf').then(r => r.arrayBuffer());
const r2 = await arkova.anchor(fileBytes);

console.log(r1);
// {
//   publicId: "ARK-2026-001",
//   fingerprint: "abc123...",  // SHA-256 hex
//   status: "PENDING",          // PENDING → SUBMITTED → SECURED
//   createdAt: "2026-04-11T10:30:00.000Z",
//   networkReceiptId: undefined  // populated once SECURED
// }
```

**Idempotency:** the same fingerprint returns the same `publicId`. Anchoring identical content twice is a no-op.

### `arkova.fingerprint(data)`

Standalone client-side SHA-256 helper. Useful when you want to compute the fingerprint yourself before deciding whether to anchor.

```typescript
const fp = await arkova.fingerprint('hello world');
// "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
```

---

## Verification

### `arkova.verify(publicId)` or `arkova.verify(data, receipt)`

Two call signatures:

```typescript
// 1. By public ID — quick lookup
const result = await arkova.verify('ARK-2026-001');

// 2. By data + receipt — also re-checks the fingerprint matches the receipt
const result = await arkova.verify(originalData, receipt);
```

The result shape:

```typescript
{
  verified: true,                       // false if data doesn't match the receipt
  status: 'ACTIVE',                     // ACTIVE | REVOKED | EXPIRED | SUPERSEDED | UNKNOWN
  issuerName: 'University of Michigan',
  credentialType: 'DEGREE',
  issuedDate: '2025-05-15',
  expiryDate: null,
  anchorTimestamp: '2026-04-11T10:30:00.000Z',
  networkReceiptId: 'tx-abcdef123456...',
  recordUri: 'https://app.arkova.ai/verify/ARK-2026-001',
  description: 'Bachelor of Science transcript',
  confidenceScores: { overall: 0.93, fields: { issuerName: 0.97 } },
  subType: 'official_undergraduate',
}
```

Verification results also expose rich nullable metadata when the API returns it, including `complianceControls`, `chainConfirmations`, `parentPublicId`, `versionNumber`, `revocationTxId`, `revocationBlockHeight`, `fileMime`, and `fileSize`.

When called with `(data, receipt)` and the SHA-256 hash of `data` doesn't match `receipt.fingerprint`, the SDK returns `{ verified: false, status: 'UNKNOWN', ... }` **without making a network call**. This is the offline tamper detection path.

---

## Batch verification

### `arkova.verifyBatch(publicIds)`

Verify up to 20 credentials in a single synchronous round-trip. Results are returned in the same order as the input array.

```typescript
const results = await arkova.verifyBatch([
  'ARK-2026-001',
  'ARK-2026-002',
  'ARK-2026-003',
]);

results.forEach((r, i) => {
  console.log(`${i}: ${r.verified ? '✅' : '❌'} ${r.issuerName}`);
});
```

**Limits:**

- Empty array → returns `[]` immediately, no network call.
- More than 20 IDs → throws `ArkovaError` with `code: 'batch_too_large'` (no network call).
- Rate limit: **10 batch req/min per API key**.

---

## API v2 agent tools

The SDK includes typed wrappers for the API v2 read-only agent operations described by the OpenAPI 3.1 spec at `https://api.arkova.ai/v2/openapi.json`.

```typescript
const { results } = await arkova.search('Acme compliance certificate', {
  type: 'document',
  limit: 5,
});

const fingerprint = await arkova.fingerprint('contract body');
const verification = await arkova.verifyFingerprint(fingerprint);

const anchor = await arkova.getAnchor(results[0].publicId);
const orgs = await arkova.listOrgs();
```

Retries are built in for `429`, `500`, `502`, `503`, and `504`. For rate limits, the SDK reads `Retry-After` and waits before retrying. API v2 errors are exposed as `ArkovaError.problem` with the full RFC 7807 `{ type, title, status, detail, instance }` payload.

---

## Webhook management

> **🔥 New in INT-09 (April 2026)** — full programmable CRUD over webhook endpoints. You no longer need to use the Arkova web UI to manage webhooks.

The `arkova.webhooks` namespace has six methods:

> Webhook CRUD is a legacy v1 management surface. Its `id` values are webhook endpoint identifiers scoped to the authenticated org, not API v2 public resource identifiers. API v2 agent/search/detail surfaces use `public_id`/`publicId` and do not expose internal database UUIDs.

```typescript
arkova.webhooks.create(input)    // Register a new endpoint, returns the secret ONCE
arkova.webhooks.list(options?)   // Paginated list of org endpoints
arkova.webhooks.get(id)          // Get one by ID
arkova.webhooks.update(id, input)// Partial update (url / events / description / isActive)
arkova.webhooks.delete(id)       // Permanently delete (cascades to delivery logs)
arkova.webhooks.test(id)         // Send a synthetic test event to verify connectivity
```

### Register a webhook

```typescript
const { id, secret, warning } = await arkova.webhooks.create({
  url: 'https://api.example.com/hooks/arkova',
  events: ['anchor.secured', 'anchor.revoked'],  // optional, this is the default
  description: 'Production HR sync',              // optional
  verify: true,                                   // optional — sends a verification ping first
});

// ⚠️ secret is shown ONCE. Store it immediately in your secret manager.
console.log(warning); // "Save this secret now. It is shown once and used to verify HMAC signatures..."
```

If `verify: true`, Arkova POSTs a challenge token to the URL with a 5-second timeout. Your endpoint must respond `2xx` and echo the challenge token in the body — otherwise registration fails with `verification_failed`.

### List, get, update, delete

```typescript
// List with pagination
const { webhooks, total, limit, offset } = await arkova.webhooks.list({ limit: 50, offset: 0 });

// Get one
const endpoint = await arkova.webhooks.get('550e8400-e29b-41d4-a716-446655440000');

// Disable temporarily
await arkova.webhooks.update(endpoint.id, { isActive: false });

// Re-enable + change URL
await arkova.webhooks.update(endpoint.id, {
  isActive: true,
  url: 'https://api.example.com/v2/hooks/arkova',
});

// Subscribe to additional events
await arkova.webhooks.update(endpoint.id, {
  events: ['anchor.secured', 'anchor.revoked', 'anchor.expired'],
});

// Permanently delete
await arkova.webhooks.delete(endpoint.id);
```

### Test connectivity

```typescript
const result = await arkova.webhooks.test(endpoint.id);
// { success: true, statusCode: 200, eventId: "test_a1b2c3..." }
```

### Verifying webhook signatures

Every event Arkova sends to your URL includes three headers:

| Header | Description |
|---|---|
| `X-Arkova-Signature` | HMAC-SHA256 hex digest |
| `X-Arkova-Timestamp` | Unix epoch seconds |
| `X-Arkova-Event` | Event type |

The signature is computed as `HMAC-SHA256(secret, ${timestamp}.${rawBody})`. Verify it like this:

```typescript
import crypto from 'node:crypto';

function verifyArkovaWebhook(rawBody: string, headers: Headers, secret: string): boolean {
  const signature = headers.get('X-Arkova-Signature') ?? '';
  const timestamp = headers.get('X-Arkova-Timestamp') ?? '';

  // Replay protection — reject events older than 5 minutes
  const ageSec = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Number.isNaN(ageSec) || ageSec > 300 || ageSec < -60) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}
```

For a complete reference (with Express, Flask, and Go examples), see [docs/api/webhooks.md](../../docs/api/webhooks.md) in the Arkova repo.

---

## Nessie semantic search

Arkova maintains an embedding corpus of 1.4M+ verified public records (SEC filings, court documents, regulatory data). Nessie lets you search and ask questions over them — every result is provably anchored.

### `arkova.query(q, options?)` — retrieval mode

```typescript
const { results, count } = await arkova.query('Apple revenue 2025', { limit: 5 });

results.forEach(r => {
  console.log(r.title, r.relevanceScore);
  console.log('Anchor proof:', r.anchorProof?.chainTxId);
});
```

### `arkova.ask(q, options?)` — RAG mode with synthesized answer

```typescript
const { answer, citations, confidence, model } = await arkova.ask(
  'What was Apple total revenue in 2025?'
);

console.log(answer);     // "Apple reported $394 billion in revenue in 2025..."
console.log(confidence); // 0.88
citations.forEach(c => {
  console.log(`— ${c.title} (${c.source})`);
  console.log(`  Anchor: ${c.anchorProof?.chainTxId}`);
});
```

Every citation links back to a network-anchored source document, so you can verify the model didn't hallucinate.

---

## Error handling

All SDK methods that fail throw an `ArkovaError`:

```typescript
import { Arkova, ArkovaError } from '@arkova/sdk';

try {
  await arkova.webhooks.create({ url: 'http://insecure.example.com' });
} catch (err) {
  if (err instanceof ArkovaError) {
    console.log(err.statusCode); // 400
    console.log(err.code);       // "invalid_url"
    console.log(err.message);    // "Webhook URL targets a private or internal network address"
  }
}
```

### Common error codes

| `code` | HTTP | When |
|---|---|---|
| `validation_error` | 400 | Request body or query failed validation |
| `invalid_url` | 400 | Webhook URL targets private/internal IP (SSRF blocked) |
| `verification_failed` | 400 | Webhook verification ping (`verify: true`) failed |
| `batch_too_large` | 400 | More than 20 IDs passed to `verifyBatch` |
| `authentication_required` | 401 | Missing or invalid API key |
| `not_found` | 404 | Resource doesn't exist or belongs to another org |
| `rate_limit_exceeded` | 429 | Exceeded the rate limit for this endpoint group |
| `internal_error` | 500 | Server-side failure — retry with exponential backoff |

---

## x402 micropayments

Arkova supports the [x402 protocol](https://x402.org) for machine-to-machine billing. x402 is enforced for paid API v1 launch scopes such as `/api/v1/verify`, `/api/v1/verify/entity`, `/api/v1/compliance/check`, `/api/v1/regulatory/lookup`, `/api/v1/cle`, and `/api/v1/nessie/query`. API v2 agent/read surfaces use scoped API keys, not x402.

```typescript
const arkova = new Arkova({
  x402: {
    facilitatorUrl: 'https://x402.arkova.ai',
    payerAddress: '0xae12...',
    signPayment: async (amount, payTo) => {
      // Sign the payment using your wallet (Base USDC)
      return await myWallet.signX402(amount, payTo);
    },
  },
});

// Calls without an API key will auto-attach an x402 payment when required
const result = await arkova.verify('ARK-2026-001');
```

---

## TypeScript types

All types are exported from the package root:

```typescript
import type {
  ArkovaConfig,
  AnchorReceipt,
  RichVerificationFields,
  VerificationResult,
  NessieQueryResult,
  NessieContextResult,
  WebhookEventType,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedWebhooks,
  ProblemDetail,
  SearchOptions,
  SearchResponse,
  FingerprintVerification,
  AnchorDetails,
  OrganizationSummary,
} from '@arkova/sdk';
```

---

## Browser usage

The SDK works directly in modern browsers via the standard `<script type="module">` pattern or any bundler (Vite, Webpack, esbuild, Rollup, Parcel).

```html
<script type="module">
  import { Arkova } from 'https://esm.sh/@arkova/sdk';
  const arkova = new Arkova({ apiKey: 'ak_live_...' });
  const receipt = await arkova.anchor('hello from the browser');
  console.log(receipt.publicId);
</script>
```

> ⚠️ **Never embed live API keys in client-side JavaScript.** Use a server-side proxy for browser apps. The SDK works in the browser primarily for local fingerprint computation and anonymous public verification (`verify` works without an API key).

---

## Reference

### Base URL

Production: `https://arkova-worker-270018525501.us-central1.run.app`
Override with `baseUrl` config option for staging or local development.

### Method index

| Method | Description |
|---|---|
| `arkova.fingerprint(data)` | Compute SHA-256 hash client-side |
| `arkova.anchor(data)` | Anchor a document fingerprint |
| `arkova.verify(publicId)` | Verify by public ID |
| `arkova.verify(data, receipt)` | Verify by data + receipt (offline tamper check) |
| `arkova.verifyBatch(publicIds)` | Verify up to 20 credentials at once |
| `arkova.search(q, options?)` | API v2 search across orgs, records, fingerprints, and documents |
| `arkova.verifyFingerprint(fingerprint)` | API v2 fingerprint verification |
| `arkova.getAnchor(publicId)` | API v2 public anchor lookup |
| `arkova.listOrgs()` | API v2 organization context for the API key |
| `arkova.query(q, options?)` | Nessie retrieval search over public records |
| `arkova.ask(q, options?)` | Nessie RAG with cited answer |
| `arkova.webhooks.create(input)` | Register a webhook endpoint |
| `arkova.webhooks.list(options?)` | Paginated list of org endpoints |
| `arkova.webhooks.get(id)` | Get a single endpoint |
| `arkova.webhooks.update(id, input)` | Partially update an endpoint |
| `arkova.webhooks.delete(id)` | Permanently delete an endpoint |
| `arkova.webhooks.test(id)` | Send a synthetic test event |

### Related documentation

- [Webhooks developer guide](../../docs/api/webhooks.md) — comprehensive HMAC verification, retry policy, SSRF rules
- [API docs index](../../docs/api/README.md) — full API surface map
- [OpenAPI spec](../../docs/api/openapi.yaml) — machine-readable schema
- [Arkova platform docs](https://app.arkova.ai/docs) — hosted Swagger UI

### License

MIT © Arkova
