# Arkova Python SDK

Typed Python client for the Arkova Verification API v2.

## Install

```bash
pip install arkova
```

Python 3.10 or newer is supported.

## Quick start

```python
import os
from arkova import Arkova

with Arkova(api_key=os.environ["ARKOVA_API_KEY"]) as arkova:
    results = arkova.search("registered nurse", type="record", limit=5)
    for item in results.results:
        print(item.public_id, item.snippet)
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
