# Arkova Python SDK

Typed Python client for the Arkova Verification APIs.

## Install

```bash
pip install arkova
```

Python 3.10 or newer is supported.

## Supported methods

- `search(q, type="all", cursor=None, limit=50)`
- `verify(public_id)`
- `verify_fingerprint(fingerprint)`
- `get_anchor(public_id)`
- `list_orgs()`

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
The same optional rich fields are typed on v2 `verify_fingerprint()` and
`get_anchor()` responses, so newer API payloads are not silently hidden by the
SDK model layer.

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

## Offline proof verification (no network, no API key)

`verify_bundle` verifies an exported Arkova proof package entirely offline —
an independent re-derivation of the documented bundle format (Merkle
recompute with the CVE-2012-2459 structural guard, fixed-offset on-chain
payload decode, 80-byte header rules, timestamp honesty, Ed25519 signed
bundles). It makes zero network calls and never contacts Arkova; on-chain
confirmation runs only against canned or caller-supplied independent-node
responses.

```python
import json
from arkova import verify_bundle

packet = json.load(open("proof.json"))
outcome = verify_bundle(packet)          # recompute-only
print(outcome.verdict, outcome.reason_code)  # "VERIFIED" / None, or a frozen code
```

Every NOT-VERIFIED outcome carries one frozen machine reason code
(`arkova.REASON_CODES`), kept in lockstep with the TypeScript reference
verifier via a cross-runtime parity gate in the Arkova repo. A passing
signature never substitutes for the cryptographic recompute; a failing
explicitly-requested signature check fails the verdict closed.
