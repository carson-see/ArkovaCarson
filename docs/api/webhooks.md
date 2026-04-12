# Webhooks — Developer Guide

> **Status:** Stable | **Version:** v1 | **Story:** [INT-09 / SCRUM-645](https://arkova.atlassian.net/browse/SCRUM-645)
> **Base URL:** `https://arkova-worker-270018525501.us-central1.run.app/api/v1`

Arkova webhooks let your system react to anchor lifecycle events the moment they happen — no polling required. This guide covers everything an API-only customer needs to register, verify, and consume webhooks programmatically. **You never need to log into the Arkova web app.**

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Event Types](#event-types)
4. [Endpoints](#endpoints)
   - [Register a webhook](#post-webhooks)
   - [List webhook endpoints](#get-webhooks)
   - [Get a single endpoint](#get-webhooksid)
   - [Update an endpoint](#patch-webhooksid)
   - [Delete an endpoint](#delete-webhooksid)
   - [Send a test event](#post-webhookstest)
   - [Inspect delivery logs](#get-webhooksdeliveries)
5. [Webhook Payload Format](#webhook-payload-format)
6. [Verifying HMAC Signatures](#verifying-hmac-signatures)
7. [Retry Policy](#retry-policy)
8. [SSRF Protection](#ssrf-protection)
9. [Rate Limits](#rate-limits)
10. [Error Codes](#error-codes)
11. [Quickstart Examples](#quickstart-examples)
12. [Migration: From UI-only to API-managed](#migration-from-ui-only-to-api-managed)

---

## Overview

A webhook in Arkova is an HTTPS endpoint you control that receives signed JSON payloads when an anchor changes state. Typical use cases:

- Reacting to `anchor.secured` to push verification status into your ATS, HR system, or candidate portal.
- Reacting to `anchor.revoked` to invalidate downstream artifacts (cached badges, generated PDFs, internal flags).
- Reacting to `anchor.expired` to trigger renewal workflows.

The CRUD endpoints documented here are the **complete** webhook surface — registration, listing, updating, and deletion are all programmable. The Arkova web UI (`app.arkova.ai`) is no longer required for webhook management.

---

## Authentication

All webhook management endpoints require an Arkova API key. Pass it as either:

- **Header:** `X-API-Key: ak_live_...`
- **Bearer:** `Authorization: Bearer ak_live_...`

API keys are scoped to a single organization. All webhook operations are automatically scoped to your org — you cannot register, read, or modify another org's webhooks.

---

## Event Types

| Event | Fired When |
|---|---|
| `anchor.secured` | Anchor transitions from `PENDING`/`SUBMITTED` → `SECURED` after network confirmation |
| `anchor.revoked` | Anchor is revoked by an org admin (revocation receipt published on-chain) |
| `anchor.expired` | Anchor's `expires_at` timestamp passes |

You can subscribe to any subset of these events per endpoint. The default at registration time is `['anchor.secured', 'anchor.revoked']`.

---

## Endpoints

### `POST /webhooks`

Register a new webhook endpoint.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `url` | string | ✅ | — | HTTPS URL that will receive POST events. Must be publicly resolvable. |
| `events` | string[] | ❌ | `["anchor.secured", "anchor.revoked"]` | Subset of supported events. |
| `description` | string | ❌ | — | Free-text label, max 500 chars. Useful for distinguishing prod/staging. |
| `verify` | boolean | ❌ | `false` | If `true`, Arkova sends a synchronous verification ping to your URL with a challenge token. Your endpoint must respond `2xx` and echo the challenge in the body for the registration to succeed. |

**Example request:**

```bash
curl -X POST https://arkova-worker-270018525501.us-central1.run.app/api/v1/webhooks \
  -H "X-API-Key: ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/hooks/arkova",
    "events": ["anchor.secured", "anchor.revoked"],
    "description": "Production HR sync"
  }'
```

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://api.example.com/hooks/arkova",
  "events": ["anchor.secured", "anchor.revoked"],
  "is_active": true,
  "description": "Production HR sync",
  "created_at": "2026-04-11T10:30:00.000Z",
  "updated_at": "2026-04-11T10:30:00.000Z",
  "secret": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "warning": "Save this secret now. It is shown once and used to verify HMAC signatures on incoming webhooks."
}
```

> ⚠️ **The `secret` is returned exactly once.** Store it in your secret manager immediately. There is no API to retrieve it later — to rotate, you must delete and re-register the endpoint.

**Error responses:**

| Status | Error code | Cause |
|---|---|---|
| 400 | `validation_error` | Missing/invalid fields |
| 400 | `invalid_url` | URL targets a private/internal/cloud-metadata IP (SSRF blocked) |
| 400 | `verification_failed` | `verify: true` was passed but the verification ping failed |
| 401 | `authentication_required` | Missing or invalid API key |
| 429 | (rate limit) | Exceeded 10 req/min on webhook management |

---

### `GET /webhooks`

List all webhook endpoints registered to your organization. Paginated.

**Query params:**

| Param | Type | Default | Range |
|---|---|---|---|
| `limit` | integer | 50 | 1–100 |
| `offset` | integer | 0 | ≥0 |

**Example:**

```bash
curl -H "X-API-Key: ak_live_..." \
  "https://arkova-worker-270018525501.us-central1.run.app/api/v1/webhooks?limit=20&offset=0"
```

**Response 200:**

```json
{
  "webhooks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "url": "https://api.example.com/hooks/arkova",
      "events": ["anchor.secured", "anchor.revoked"],
      "is_active": true,
      "description": "Production HR sync",
      "created_at": "2026-04-11T10:30:00.000Z",
      "updated_at": "2026-04-11T10:30:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

> 🔒 Secrets are never returned on list or get. They are returned exclusively by `POST /webhooks` at creation time.

---

### `GET /webhooks/{id}`

Retrieve a single webhook endpoint by ID.

**Example:**

```bash
curl -H "X-API-Key: ak_live_..." \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/webhooks/550e8400-e29b-41d4-a716-446655440000
```

**Response 200:** Same as a single entry from `GET /webhooks`. Returns 404 if not found or owned by a different org.

---

### `PATCH /webhooks/{id}`

Partially update an endpoint. Provide any subset of `{url, events, description, is_active}`. Empty body is rejected.

**Common operations:**

```bash
# Disable an endpoint without deleting it
curl -X PATCH https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"is_active": false}'

# Re-enable
curl -X PATCH https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"is_active": true}'

# Move to a new URL (re-validates SSRF)
curl -X PATCH https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"url": "https://api.example.com/v2/hooks/arkova"}'

# Subscribe to additional events
curl -X PATCH https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"events": ["anchor.secured", "anchor.revoked", "anchor.expired"]}'

# Clear description
curl -X PATCH https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"description": null}'
```

**Response 200:** Updated `WebhookEndpoint` (no secret).

> The signing secret cannot be rotated via PATCH. To rotate, delete and re-register.

---

### `DELETE /webhooks/{id}`

Permanently delete a webhook endpoint. Cascades to its delivery logs.

```bash
curl -X DELETE https://.../api/v1/webhooks/550e8400-... \
  -H "X-API-Key: ak_live_..."
```

**Response 204:** No content.

---

### `POST /webhooks/test`

Send a synthetic test event to a registered endpoint to verify it's reachable. The payload includes `test: true` so consumers can distinguish test from real events.

```bash
curl -X POST https://.../api/v1/webhooks/test \
  -H "X-API-Key: ak_live_..." -H "Content-Type: application/json" \
  -d '{"endpoint_id": "550e8400-..."}'
```

**Response 200:**

```json
{
  "success": true,
  "status_code": 200,
  "response_body": "ok",
  "event_id": "test_a1b2c3d4e5f6"
}
```

---

### `GET /webhooks/deliveries`

Inspect recent delivery attempts (success + failure) for self-service debugging.

```bash
curl -H "X-API-Key: ak_live_..." \
  "https://.../api/v1/webhooks/deliveries?endpoint_id=550e8400-...&limit=50"
```

Returns delivery logs with status, response status code, error message (if any), retry attempt number, and timing.

---

## Webhook Payload Format

When an event fires, Arkova POSTs JSON to your registered URL with three custom headers:

```http
POST /your/path HTTP/1.1
Host: api.example.com
Content-Type: application/json
X-Arkova-Signature: 9f8e7d6c5b4a39281706f5e4d3c2b1a0...
X-Arkova-Timestamp: 1744378200
X-Arkova-Event: anchor.secured

{
  "event_type": "anchor.secured",
  "event_id": "550e8400-e29b-41d4-a716-446655440042",
  "timestamp": "2026-04-11T10:30:00.000Z",
  "data": {
    "public_id": "ARK-2026-001",
    "fingerprint": "abc123...",
    "status": "SECURED",
    "credential_type": "DEGREE",
    "issuer_name": "University of Michigan",
    "anchor_timestamp": "2026-04-11T10:29:55.000Z",
    "network_receipt_id": "tx-abcdef123456...",
    "record_uri": "https://app.arkova.ai/verify/ARK-2026-001"
  }
}
```

### Headers

| Header | Description |
|---|---|
| `X-Arkova-Signature` | HMAC-SHA256 hex digest. See [Verifying HMAC Signatures](#verifying-hmac-signatures). |
| `X-Arkova-Timestamp` | Unix epoch seconds when the signature was generated. Use to prevent replay attacks. |
| `X-Arkova-Event` | Event type (also present in the body). Lets you route without parsing JSON. |

---

## Verifying HMAC Signatures

**Always verify the signature.** Without verification, anyone who learns your URL can spoof events.

The signature is computed as:

```
HMAC-SHA256(secret, `${X-Arkova-Timestamp}.${rawRequestBody}`)
```

### Node.js / TypeScript

```typescript
import crypto from 'node:crypto';
import express from 'express';

const app = express();

// IMPORTANT: capture the raw body for signature verification
app.use('/hooks/arkova', express.raw({ type: 'application/json' }));

app.post('/hooks/arkova', (req, res) => {
  const signature = req.header('X-Arkova-Signature');
  const timestamp = req.header('X-Arkova-Timestamp');
  const rawBody = req.body.toString('utf-8');

  if (!signature || !timestamp) {
    return res.status(400).send('missing signature headers');
  }

  // Reject events older than 5 minutes (replay protection)
  const ageSec = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Number.isNaN(ageSec) || ageSec > 300 || ageSec < -60) {
    return res.status(400).send('stale timestamp');
  }

  const expected = crypto
    .createHmac('sha256', process.env.ARKOVA_WEBHOOK_SECRET!)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'),
  );

  if (!valid) {
    return res.status(401).send('invalid signature');
  }

  const event = JSON.parse(rawBody);
  console.log('Verified Arkova event:', event.event_type, event.data.public_id);

  // Always return 2xx fast — process async to avoid timeouts
  res.status(200).send('ok');
});
```

### Python

```python
import hmac, hashlib, time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["ARKOVA_WEBHOOK_SECRET"].encode()

@app.post("/hooks/arkova")
def arkova_webhook():
    sig = request.headers.get("X-Arkova-Signature", "")
    ts = request.headers.get("X-Arkova-Timestamp", "")
    raw = request.get_data()  # bytes, before any JSON parsing

    # Replay protection
    age = int(time.time()) - int(ts or "0")
    if age > 300 or age < -60:
        abort(400, "stale timestamp")

    expected = hmac.new(SECRET, f"{ts}.{raw.decode()}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        abort(401, "invalid signature")

    event = request.get_json()
    print(f"Verified Arkova event: {event['event_type']} {event['data']['public_id']}")
    return "ok", 200
```

### Go

```go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
    "strconv"
    "time"
)

func arkovaWebhook(w http.ResponseWriter, r *http.Request) {
    sig := r.Header.Get("X-Arkova-Signature")
    ts := r.Header.Get("X-Arkova-Timestamp")
    body, _ := io.ReadAll(r.Body)

    tsInt, _ := strconv.ParseInt(ts, 10, 64)
    age := time.Now().Unix() - tsInt
    if age > 300 || age < -60 {
        http.Error(w, "stale timestamp", 400)
        return
    }

    mac := hmac.New(sha256.New, []byte(os.Getenv("ARKOVA_WEBHOOK_SECRET")))
    mac.Write([]byte(ts + "." + string(body)))
    expected := hex.EncodeToString(mac.Sum(nil))

    if !hmac.Equal([]byte(sig), []byte(expected)) {
        http.Error(w, "invalid signature", 401)
        return
    }

    w.WriteHeader(200)
    w.Write([]byte("ok"))
}
```

---

## Retry Policy

Failed deliveries (any non-2xx response, network error, or timeout) are retried with **exponential backoff**:

| Attempt | Delay |
|---|---|
| 1 | immediate |
| 2 | 30 seconds |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 6 hours |

After the final retry, the delivery is marked `failed` and moved to the dead-letter queue. Inspect with `GET /webhooks/deliveries`. **Idempotency:** every delivery includes a stable `event_id` — handle duplicates gracefully.

A circuit breaker opens after 5 consecutive failures and stays open for 60 seconds, then enters a half-open state. This protects your endpoint from being hammered when it's down.

---

## SSRF Protection

Arkova validates registered URLs against private/internal/cloud-metadata IP ranges using **full DNS resolution**, not just literal IP matching. This prevents:

- `http://localhost`, `127.0.0.1`, `0.0.0.0`
- RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Cloud metadata IP `169.254.169.254` (AWS/GCP/Azure)
- Link-local `169.254.0.0/16`
- IPv6 link-local and loopback (`::1`, `fe80::/10`, `fc00::/7`)
- DNS rebinding (resolved IPs are checked at registration AND just before each delivery)

Both `POST /webhooks` and `PATCH /webhooks/{id}` (when changing URL) run this check. Failures return `400 invalid_url`.

---

## Rate Limits

| Endpoint group | Limit |
|---|---|
| Webhook management (`POST/GET/PATCH/DELETE /webhooks*`) | **10 req/min** per API key |

Rate limit headers are returned on every response:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1744378260
```

When exceeded, you'll receive `429 Too Many Requests` with a `Retry-After` header.

---

## Error Codes

All errors follow the same envelope:

```json
{
  "error": "machine_readable_code",
  "message": "Human-readable description",
  "details": { /* optional, validation errors */ }
}
```

| HTTP | `error` code | Meaning |
|---|---|---|
| 400 | `validation_error` | Request body or query failed Zod validation |
| 400 | `invalid_url` | URL targets a private/internal IP |
| 400 | `verification_failed` | Verification ping (`verify: true`) didn't succeed |
| 401 | `authentication_required` | Missing or invalid API key |
| 404 | `not_found` | Endpoint ID doesn't exist or belongs to another org |
| 429 | (rate limit) | Exceeded 10 req/min |
| 500 | `internal_error` | Server-side failure — retry with exponential backoff |

---

## Quickstart Examples

### TypeScript SDK (`@arkova/sdk`)

```typescript
import { Arkova } from '@arkova/sdk';

const arkova = new Arkova({ apiKey: process.env.ARKOVA_API_KEY });

// Register
const { id, secret } = await arkova.webhooks.create({
  url: 'https://api.example.com/hooks/arkova',
  events: ['anchor.secured', 'anchor.revoked'],
  description: 'Production HR sync',
});
console.log('Save this secret:', secret);

// List
const { webhooks, total } = await arkova.webhooks.list({ limit: 20 });

// Update
await arkova.webhooks.update(id, { is_active: false });

// Delete
await arkova.webhooks.delete(id);
```

### Python (raw HTTP)

```python
import os, requests

API = "https://arkova-worker-270018525501.us-central1.run.app/api/v1"
HEADERS = {"X-API-Key": os.environ["ARKOVA_API_KEY"], "Content-Type": "application/json"}

# Register
resp = requests.post(f"{API}/webhooks", headers=HEADERS, json={
    "url": "https://api.example.com/hooks/arkova",
    "events": ["anchor.secured", "anchor.revoked"],
    "description": "Production HR sync",
})
resp.raise_for_status()
endpoint = resp.json()
print("Save this secret:", endpoint["secret"])

# List
resp = requests.get(f"{API}/webhooks?limit=20", headers=HEADERS)
print(resp.json())

# Update
requests.patch(f"{API}/webhooks/{endpoint['id']}", headers=HEADERS, json={"is_active": False})

# Delete
requests.delete(f"{API}/webhooks/{endpoint['id']}", headers=HEADERS)
```

---

## Migration: From UI-only to API-managed

Before INT-09, the Arkova web app was the only way to register webhooks. If you have existing endpoints registered through the UI, they continue to work — they're stored in the same `webhook_endpoints` table and signed with the same HMAC scheme.

To migrate management to the API:

1. **List existing endpoints:** `GET /webhooks` returns everything for your org, regardless of how it was created.
2. **You cannot retrieve existing secrets via API.** They were generated server-side and shown once. If you've lost them, delete the endpoint and re-register via `POST /webhooks` to receive a new secret.
3. **The signing format is identical.** Existing consumers don't need to change anything.
4. **Audit events** for `webhook.created` / `webhook.updated` / `webhook.deleted` flow into the same `audit_events` table whether you use the UI or the API.

Once your management is fully API-driven, you can stop accessing `app.arkova.ai` entirely — that's the entire point of INT-09.

---

## Changelog

| Version | Date | Story | Change |
|---|---|---|---|
| v1.0 | 2026-04-11 | INT-09 (SCRUM-645) | Initial CRUD API for webhook endpoints. POST/GET/PATCH/DELETE plus existing test/deliveries. |
