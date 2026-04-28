# Arkova Python SDK

Three-function-call wrapper around the Arkova verification API. Mirrors the
`@arkova/sdk` TypeScript surface so cross-language pipelines see the same
shape for `anchor` / `verify` / `verifyBatch`.

## Install

```sh
pip install arkova
```

Python 3.9+. Single dependency: `httpx` (sync + async).

## Quickstart

```python
from arkova import Arkova

client = Arkova(api_key="ak_...")  # base_url defaults to prod worker

# Anchor — SDK computes the SHA-256 fingerprint locally; PII never leaves
# your process.
receipt = client.anchor("the document body or fingerprint source")
print(receipt.public_id, receipt.status)

# Verify
result = client.verify(receipt.public_id)
assert result.verified

# Batch (up to 100 ids per call)
results = client.verify_batch(["ARK-001", "ARK-002"])
```

## Async

```python
import asyncio
from arkova import AsyncArkova

async def main() -> None:
    async with AsyncArkova(api_key="ak_...") as client:
        result = await client.verify("ARK-001")

asyncio.run(main())
```

## Errors

Non-2xx responses raise `ArkovaError` with the HTTP status, server-supplied
error code, and details payload. Branch on `error.code` rather than parsing
message strings:

```python
from arkova import Arkova, ArkovaError

try:
    client.verify("ARK-bad")
except ArkovaError as err:
    if err.code == "rate_limited":
        ...
    elif err.status == 404:
        ...
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `api_key` | `None` | Sent as `X-API-Key`; required for non-public verify calls |
| `base_url` | `https://arkova-worker-270018525501.us-central1.run.app` | Override for staging or self-hosted |
| `timeout` | `30.0` seconds | Single-request httpx timeout |
| `client` | new `httpx.Client` | Inject your own to share connection pools / mocks |

## Reference

- TypeScript SDK (parity surface): [`@arkova/sdk`](../sdk/README.md)
- Verification API docs: <https://arkova.io/docs/api/verify>
- Source: `packages/python-sdk/src/arkova/`
