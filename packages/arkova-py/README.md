# Arkova Python SDK

Typed Python client for the Arkova Verification API v2 read-only surface.

## Install

```bash
pip install arkova
```

Python 3.10 or newer is supported.

## Current surface

| Method | Sync client | Async client | Endpoint |
| --- | --- | --- | --- |
| Search records, organizations, fingerprints, and documents | `search()` | `search()` | `GET /search` |
| Verify a SHA-256 fingerprint | `verify_fingerprint()` | `verify_fingerprint()` | `GET /verify/{fingerprint}` |
| Fetch public anchor metadata | `get_anchor()` | `get_anchor()` | `GET /anchors/{public_id}` |
| List organization context | `list_orgs()` | `list_orgs()` | `GET /orgs` |
| Fetch organization detail | `get_organization()` | `get_organization()` | `GET /organizations/{public_id}` |
| Fetch record detail | `get_record()` | `get_record()` | `GET /records/{public_id}` |
| Fetch fingerprint detail | `get_fingerprint()` | `get_fingerprint()` | `GET /fingerprints/{fingerprint}` |
| Fetch document detail | `get_document()` | `get_document()` | `GET /documents/{public_id}` |

This package does not currently expose v1 anchoring, webhook management, or
x402 write/payment helpers. Use the REST API directly or `@arkova/sdk` for
those surfaces until equivalent v2 Python methods are published.

## Quick start

```python
import os
from arkova import Arkova

with Arkova(api_key=os.environ["ARKOVA_API_KEY"]) as arkova:
    results = arkova.search("registered nurse", type="record", limit=5)
    for item in results.results:
        detail = arkova.get_record(item.public_id)
        print(detail.public_id, detail.status, detail.record_uri)
```

## Verify a fingerprint

```python
from arkova import Arkova

fingerprint = "a" * 64

with Arkova(api_key="ak_live_...") as arkova:
    result = arkova.verify_fingerprint(fingerprint)
    print(result.verified, result.public_id)
```

Verification and anchor models include nullable rich fields when the API returns
them, including `sub_type`, `description`, `confidence_scores`,
`compliance_controls`, `chain_confirmations`, version lineage, revocation
provenance, and file metadata.

## Async client

```python
import asyncio
from arkova import AsyncArkova


async def main() -> None:
    async with AsyncArkova(api_key="ak_live_...") as arkova:
        orgs = await arkova.list_orgs()
        print([org.display_name for org in orgs.organizations])


asyncio.run(main())
```

## Errors and retries

`ArkovaError` preserves the API v2 RFC 7807 problem document and the `Retry-After`
header when present.

```python
from arkova import Arkova, ArkovaError

try:
    with Arkova(api_key="ak_live_...") as arkova:
        arkova.get_anchor("ARK-DOC-MISSING")
except ArkovaError as exc:
    print(exc.status_code, exc.problem.type if exc.problem else None)
```

The client retries `429` and `5xx` responses by default and respects `Retry-After`.
Pass `retries=0` to disable retries.
