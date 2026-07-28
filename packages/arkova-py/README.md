# Arkova Python SDK

Typed Python client for the Arkova Verification APIs.

## Install

```bash
pip install arkova
```

Python 3.10 or newer is supported.

## Supported methods

- `anchor(data=None, *, fingerprint=None)`
- `anchor_bulk(inputs, *, dry_run=None, duplicate_strategy=None, batch_id=None)`
- `fingerprint(data)`
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

## Anchor a document (HAKI-REQ-02)

`anchor()` fingerprints `data` client-side (SHA-256, in-process — the raw
content is never sent, only the 64-char hex fingerprint) and submits it for
network anchoring. Pass a pre-computed `fingerprint` instead if you already
hashed the document elsewhere.

```python
from arkova import Arkova

with Arkova(api_key="ak_live_...") as arkova:
    # Raw content — fingerprinted in-process before anything is sent.
    receipt = arkova.anchor("document content goes here")
    print(receipt.public_id, receipt.status)  # "PENDING" -> "SUBMITTED" -> "SECURED"

    # Or: you already have the fingerprint.
    receipt = arkova.anchor(fingerprint="a" * 64)
```

The same fingerprint always returns the same `public_id` — anchoring
identical content twice is a no-op.

## Bulk-anchor documents (HAKI-REQ-02)

`anchor_bulk()` anchors up to `BULK_ANCHOR_MAX_ROWS` (1000) documents in one
call. Each `BulkAnchorInput` row provides exactly one of `fingerprint` (a
pre-computed 64-char hex SHA-256) or `data` (raw content, fingerprinted
client-side the same way `anchor()` does it) — you can mix both forms across
rows in one call.

```python
from arkova import Arkova, BulkAnchorInput

with Arkova(api_key="ak_live_...") as arkova:
    with open("contract.pdf", "rb") as f:
        contract_bytes = f.read()

    result = arkova.anchor_bulk(
        [
            # Already hashed elsewhere — send the fingerprint directly.
            BulkAnchorInput(fingerprint="a" * 64, external_id="invoice-001"),
            # Raw content — the SDK hashes it for you before it's ever sent.
            BulkAnchorInput(
                data=contract_bytes,
                credential_type="CONTRACT_PRESIGNING",
                document_type="contract",
                matter_or_case_ref="CASE-42",
            ),
        ],
        duplicate_strategy="skip",
        batch_id="nightly-2026-07-28",
    )

    print(result.queued, result.duplicates, result.errors)
    for anchor in result.anchors or []:
        print(anchor.public_id, anchor.status)
```

**Options:** `dry_run=True` validates every row (including dedup checks)
without queuing or deducting credits — `result.anchors` is `None` on a dry
run. `duplicate_strategy` controls what happens when a fingerprint already
exists in-batch or in your org; the server default is `"fail"` (raises
`ArkovaError(code="duplicate_fingerprints")` on any duplicate — pass
`"skip"`, `"supersede"`, or `"link"` to proceed instead). `batch_id` is your
own correlation ID, echoed back and surfaced in audit events.

**Limits:** empty input returns a zero-row response immediately, no network
call. More than 1000 rows raises `ArkovaError(code="batch_too_large")` — the
SDK does **not** auto-chunk (splitting a logical batch across requests would
let a duplicate fingerprint slip past the cheaper intra-batch check and
would deduct credits per chunk instead of atomically for the whole batch;
split manually and correlate with a shared `batch_id` if you need more than
1000 rows). A row with neither `fingerprint` nor `data` (or with both)
raises `ArkovaError(code="invalid_request")`, checked before any network
call.

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
header when present. `code` carries the machine-readable error code — from the
plain-JSON `error` field on v1 write-path errors (`anchor()` / `anchor_bulk()`
codes include `"insufficient_credits"`, `"duplicate_fingerprints"`,
`"batch_too_large"`, `"invalid_request"`), or the RFC 7807 `type` slug on v2
problem documents.

```python
from arkova import Arkova, ArkovaError

try:
    with Arkova(api_key="ak_live_...") as arkova:
        arkova.get_anchor("ARK-DOC-MISSING")
except ArkovaError as exc:
    print(exc.status_code, exc.code, exc.problem.type if exc.problem else None)
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
