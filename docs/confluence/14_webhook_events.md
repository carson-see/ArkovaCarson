# Webhook Events Catalog

> Last updated: 2026-03-23

## Overview

Arkova dispatches webhook events to registered endpoints when key actions occur.
All events are signed with HMAC-SHA256 using the endpoint's signing secret.

## Event Types

| Event Type | Trigger | Payload Fields |
|---|---|---|
| `anchor.secured` | Anchor confirmed on Bitcoin | `public_id`, `fingerprint`, `chain_tx_id`, `block_height`, `timestamp` |
| `attestation.created` | New attestation submitted | `public_id`, `attestation_type`, `attester_name`, `subject_identifier` |
| `attestation.revoked` | Attestation revoked | `public_id`, `reason`, `revoked_at` |
| `job.completed` | Batch verification job finished | `job_id`, `status`, `total`, `result_count` |
| `test.ping` | Sent via POST /webhooks/test | `message`, `endpoint_id` |

## Payload Schema

Every webhook payload follows this structure:

```json
{
  "event_type": "anchor.secured",
  "event_id": "evt_a1b2c3d4e5f6...",
  "timestamp": "2026-03-23T12:00:00.000Z",
  "data": {
    "public_id": "ARK-2026-DOC-001",
    "fingerprint": "a1b2c3...",
    "chain_tx_id": "b8e381df...",
    "block_height": 204567,
    "timestamp": "2026-03-23T12:00:00.000Z"
  }
}
```

## Request Headers

| Header | Description |
|---|---|
| `Content-Type` | `application/json` |
| `X-Arkova-Signature` | HMAC-SHA256 signature |
| `X-Arkova-Timestamp` | Unix timestamp (seconds) |
| `X-Arkova-Event` | Event type string |

## Signature Verification

The signature is computed as:

```
HMAC-SHA256(secret, "{timestamp}.{payload_json}")
```

Where `{timestamp}` is the value of `X-Arkova-Timestamp` and `{payload_json}` is the raw request body.

### Node.js

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(req, secret) {
  const signature = req.headers['x-arkova-signature'];
  const timestamp = req.headers['x-arkova-timestamp'];
  const body = req.body; // raw string body

  // Prevent replay attacks: reject if timestamp is > 5 minutes old
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error('Timestamp too old — possible replay attack');
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error('Invalid signature');
  }

  return JSON.parse(body);
}
```

### Python

```python
import hmac
import hashlib
import time
import json

def verify_webhook_signature(headers, body, secret):
    signature = headers.get('x-arkova-signature')
    timestamp = headers.get('x-arkova-timestamp')

    # Prevent replay attacks
    if abs(time.time() - int(timestamp)) > 300:
        raise ValueError('Timestamp too old — possible replay attack')

    expected = hmac.new(
        secret.encode('utf-8'),
        f'{timestamp}.{body}'.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(signature, expected):
        raise ValueError('Invalid signature')

    return json.loads(body)
```

### Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "math"
    "strconv"
    "time"
)

func VerifyWebhookSignature(signature, timestamp, body, secret string) error {
    // Prevent replay attacks
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return fmt.Errorf("invalid timestamp")
    }
    if math.Abs(float64(time.Now().Unix()-ts)) > 300 {
        return fmt.Errorf("timestamp too old")
    }

    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(timestamp + "." + body))
    expected := hex.EncodeToString(mac.Sum(nil))

    if !hmac.Equal([]byte(signature), []byte(expected)) {
        return fmt.Errorf("invalid signature")
    }

    return nil
}
```

## Retry Policy

- **Max retries:** 5
- **Backoff:** Exponential (1s, 2s, 4s, 8s, 16s)
- **Circuit breaker:** Opens after 5 consecutive failures, half-open after 60s
- **Dead letter queue:** Failed events after all retries are moved to DLQ for manual inspection
- **Idempotency:** Events are delivered at-most-once per endpoint (keyed by endpoint_id + event_id)

## Testing

Use `POST /api/v1/webhooks/test` to send a synthetic `test.ping` event to your endpoint.
The payload includes `"test": true` so you can distinguish test from real events.

## Delivery Logs

Use `GET /api/v1/webhooks/deliveries?endpoint_id={id}` to view recent delivery attempts,
including status codes, error messages, and retry history. Self-service debugging without
contacting support.
