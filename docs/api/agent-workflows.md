# Arkova Agent API Workflows

> **Status:** Canonical | **Story:** SCRUM-1571 | **Audience:** API-key clients, MCP agents, and SDK consumers

This guide is the canonical playbook for agentic Arkova verification. It is intentionally narrower than the full API reference: agents should discover public resources, inspect the right detail endpoint, verify by fingerprint when available, and report public proof/lifecycle fields without exposing internal identifiers or document bytes.

The API v2 OpenAPI document remains the machine-readable contract. This page shows the safest call order across REST v2, MCP, TypeScript, and Python.

## Canonical Sequence

1. Establish context with `list_orgs` when the user asks for org-scoped or tenant-specific work.
2. Discover candidate resources with `search`.
3. Inspect the top candidate with the type-specific detail operation.
4. Verify by SHA-256 fingerprint with `verify` when a fingerprint is present.
5. Fetch public proof/lifecycle fields with `get_anchor` when the user needs receipt status, record URI, network receipt, revocation, expiry, or lifecycle context.

Agents should not request or invent internal `id`, `org_id`, `user_id`, or raw document content. Detail responses expose public IDs, metadata, hashes, and receipt fields only. All API v2 failures use RFC 7807 `application/problem+json`; retry `429` only after `Retry-After`.

## Canonical Surface Matrix

| Intent | REST v2 | OpenAPI operationId | MCP tool | TypeScript SDK | Python SDK |
|---|---|---|---|---|---|
| Search resources | `GET /api/v2/search` | `search` | `search` | `arkova.search()` | `arkova.search()` |
| List caller orgs | `GET /api/v2/orgs` | `list_orgs` | `list_orgs` | `arkova.listOrgs()` | `arkova.list_orgs()` |
| Inspect organization | `GET /api/v2/organizations/{public_id}` | `get_organization` | `get_organization` | `arkova.getOrganization()` | `arkova.get_organization()` |
| Inspect record | `GET /api/v2/records/{public_id}` | `get_record` | `get_record` | `arkova.getRecord()` | `arkova.get_record()` |
| Inspect fingerprint | `GET /api/v2/fingerprints/{fingerprint}` | `get_fingerprint` | `get_fingerprint` | `arkova.getFingerprint()` | `arkova.get_fingerprint()` |
| Inspect document | `GET /api/v2/documents/{public_id}` | `get_document` | `get_document` | `arkova.getDocument()` | `arkova.get_document()` |
| Verify fingerprint | `GET /api/v2/verify/{fingerprint}` | `verify` | `verify` | `arkova.verifyFingerprint()` | `arkova.verify_fingerprint()` |
| Fetch public proof | `GET /api/v2/anchors/{public_id}` | `get_anchor` | `get_anchor` | `arkova.getAnchor()` | `arkova.get_anchor()` |

## Workflow 1: Find A Document, Inspect It, Verify It

Use this when the user describes a document or credential but does not provide a fingerprint.

REST v2:

```http
GET /api/v2/search?q=Acme%20compliance%20certificate&type=document&limit=5
GET /api/v2/documents/{public_id}
GET /api/v2/verify/{fingerprint}
GET /api/v2/anchors/{public_id}
```

MCP:

```text
search({ "q": "Acme compliance certificate", "type": "document", "max_results": 5 })
get_document({ "public_id": "<result.public_id>" })
verify({ "fingerprint": "<detail.fingerprint>" })
get_anchor({ "public_id": "<detail.public_id>" })
```

TypeScript:

```typescript
const searchResult = await arkova.search('Acme compliance certificate', {
  type: 'document',
  limit: 5,
});

const candidate = searchResult.results[0];
if (!candidate) throw new Error('No Arkova document matched the query');

const detail = await arkova.getDocument(candidate.publicId);
if (!detail.publicId || !detail.fingerprint) {
  throw new Error('Document detail did not include proof fields');
}

const verification = await arkova.verifyFingerprint(detail.fingerprint);
const proof = await arkova.getAnchor(detail.publicId);
```

Python:

```python
with Arkova(api_key=api_key) as arkova:
    search_result = arkova.search(
        "Acme compliance certificate",
        type="document",
        limit=5,
    )
    if not search_result.results:
        raise RuntimeError("No Arkova document matched the query")

    detail = arkova.get_document(search_result.results[0].public_id)
    if detail.public_id is None or detail.fingerprint is None:
        raise RuntimeError("Document detail did not include proof fields")

    verification = arkova.verify_fingerprint(detail.fingerprint)
    proof = arkova.get_anchor(detail.public_id)
```

Agent response should summarize `verified`, `status`, `public_id`, `record_uri`, `anchor_timestamp`, `network_receipt_id`, and any lifecycle fields. It should not imply the raw document was retrieved.

## Workflow 2: Verify A Known Fingerprint

Use this when the caller already has a SHA-256 fingerprint and wants to know whether Arkova anchored it.

REST v2:

```http
GET /api/v2/verify/{fingerprint}
GET /api/v2/fingerprints/{fingerprint}
```

MCP:

```text
verify({ "fingerprint": "<64-character-sha256>" })
get_fingerprint({ "fingerprint": "<64-character-sha256>" })
```

TypeScript:

```typescript
const verification = await arkova.verifyFingerprint(fingerprint);
const detail = await arkova.getFingerprint(fingerprint);
```

Python:

```python
verification = arkova.verify_fingerprint(fingerprint)
detail = arkova.get_fingerprint(fingerprint)
```

If `verified` is false, report that Arkova did not find an anchored record for that fingerprint. Do not fabricate issuer, dates, or chain details.

## Workflow 3: Start With Organization Context

Use this when the user asks for work scoped to their organization, an issuer, or a verified organization profile.

REST v2:

```http
GET /api/v2/orgs
GET /api/v2/organizations/{public_id}
GET /api/v2/search?q=licensed%20nurse&type=record&limit=10
GET /api/v2/records/{public_id}
GET /api/v2/anchors/{public_id}
```

MCP:

```text
list_orgs({})
get_organization({ "public_id": "<organization.public_id>" })
search({ "q": "licensed nurse", "type": "record", "max_results": 10 })
get_record({ "public_id": "<result.public_id>" })
get_anchor({ "public_id": "<detail.public_id>" })
```

TypeScript:

```typescript
const orgs = await arkova.listOrgs();
const org = orgs[0] ? await arkova.getOrganization(orgs[0].publicId) : null;

const records = await arkova.search('licensed nurse', { type: 'record', limit: 10 });
const record = records.results[0]
  ? await arkova.getRecord(records.results[0].publicId)
  : null;
const proof = record?.publicId ? await arkova.getAnchor(record.publicId) : null;
```

Python:

```python
orgs = arkova.list_orgs()
org = arkova.get_organization(orgs.organizations[0].public_id) if orgs.organizations else None

records = arkova.search("licensed nurse", type="record", limit=10)
record = arkova.get_record(records.results[0].public_id) if records.results else None
proof = arkova.get_anchor(record.public_id) if record and record.public_id else None
```

Organization detail is context, not proof that a particular document is valid. For document or credential validity, inspect the record/document and verify the fingerprint or public anchor.

## Failure Handling

| Condition | Agent behavior |
|---|---|
| `400 validation_error` | Ask for a valid public ID, fingerprint, or query. |
| `401 authentication_required` | Ask the operator to provide a valid Arkova API key. |
| `403 invalid_scope` | Report the missing scope named by the problem detail. |
| `404 not_found` | State that Arkova has no matching public resource for the supplied identifier. |
| `429 rate_limit_exceeded` | Wait for `Retry-After` before retrying; do not loop immediately. |
| `5xx` | Retry according to SDK/client policy, then report temporary service failure. |

## Agent Output Contract

When returning results to a user, include only public and proof fields:

- `verified`, `status`, `public_id`, `fingerprint`
- `issuer_name`, `credential_type`, `sub_type`, `title`, `description`
- `issued_date`, `expiry_date`, `anchor_timestamp`
- `network_receipt_id`, `record_uri`, `chain_confirmations`
- `parent_public_id`, `version_number`, revocation fields when present

Avoid internal IDs, database table names, Supabase storage paths, raw document bytes, and unverified claims not present in the returned data.
