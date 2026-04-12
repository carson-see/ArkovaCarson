# arkova — Python SDK

> Anchor, verify, and manage credentials on Bitcoin. Full parity with `@arkova/sdk` (TypeScript).

## Install

```bash
pip install arkova
```

## Quick Start

```python
from arkova import ArkovaClient

client = ArkovaClient(api_key="ak_live_...")

# Anchor a document (SHA-256 hashed client-side — data never leaves your machine)
receipt = client.anchor(open("diploma.pdf", "rb").read(), credential_type="DEGREE")
print(receipt.public_id)  # ARK-2026-XXXX

# Verify by public ID
result = client.verify(receipt.public_id)
print(result.verified)    # True once secured on-chain
print(result.status)      # ACTIVE | REVOKED | EXPIRED
```

## Batch Verification

```python
results = client.verify_batch([
    "ARK-2026-001",
    "ARK-2026-002",
    "ARK-2026-003",
])
for r in results:
    print(f"{r.issuer_name}: {'Verified' if r.verified else r.status}")
```

Max 20 IDs per synchronous batch request.

## Webhook Management

```python
# Register an endpoint (save the secret — shown only once)
wh = client.webhooks.create(
    url="https://api.example.com/hooks/arkova",
    events=["anchor.secured", "anchor.revoked"],
    description="Production webhook",
)
print(wh.secret)  # Save this immediately

# List endpoints
page = client.webhooks.list(limit=10)
for endpoint in page.webhooks:
    print(f"{endpoint.id}: {endpoint.url} (active={endpoint.is_active})")

# Update
client.webhooks.update(wh.id, is_active=False)

# Test connectivity
test = client.webhooks.test(wh.id)
print(f"Delivered: {test.success}, HTTP {test.status_code}")

# Delete
client.webhooks.delete(wh.id)
```

## Nessie Intelligence (RAG over 1.4M+ verified records)

```python
# Semantic search
results = client.query("SEC 10-K filings for tech companies")
for r in results.results:
    print(f"{r.title} ({r.source}) — score: {r.relevance_score:.2f}")
    if r.anchor_proof:
        print(f"  Chain TX: {r.anchor_proof.chain_tx_id}")

# Ask a question (synthesized answer with citations)
answer = client.ask("What are the disclosure requirements for California CPAs?")
print(answer.answer)
print(f"Confidence: {answer.confidence:.0%}")
for c in answer.citations:
    print(f"  [{c.source}] {c.title}: {c.excerpt[:80]}...")
```

## Error Handling

```python
from arkova import ArkovaError

try:
    client.webhooks.create(url="https://10.0.0.1/hooks")
except ArkovaError as e:
    print(e.status_code)  # 400
    print(e.code)         # "invalid_url"
    print(str(e))         # "URL resolves to private network"
```

## Context Manager

```python
with ArkovaClient(api_key="ak_live_...") as client:
    receipt = client.anchor(b"important data")
    # HTTP client auto-closed on exit
```

## Pre-computed Fingerprint

```python
import hashlib

fp = hashlib.sha256(open("contract.pdf", "rb").read()).hexdigest()
receipt = client.anchor_fingerprint(fp, credential_type="LEGAL")
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `api_key` | **required** | Your API key (starts with `ak_`) |
| `base_url` | `https://arkova-worker-...` | API base URL |
| `timeout` | `30.0` | Request timeout in seconds |

## Requirements

- Python 3.9+
- `httpx` ≥ 0.24

## License

MIT
