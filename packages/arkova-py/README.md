# Arkova Python SDK

Typed Python client for the Arkova Verification APIs.

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

## Verify a public ID

```python
from arkova import Arkova

with Arkova(api_key="ak_live_...") as arkova:
    result = arkova.verify("ARK-2026-ABC")
    print(result.verified, result.description, result.confidence_scores)
```

`verify()` returns the rich v1 verification shape, including API-RICH-01 fields
such as `compliance_controls`, `chain_confirmations`, `parent_public_id`,
`version_number`, `file_mime`, and `file_size`, plus API-RICH-02 fields
`confidence_scores` and `sub_type` when the API response includes them.

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
