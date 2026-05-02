# Arkova API v1 to v2 Migration Guide

Last updated: 2026-04-24

## Deprecation Calendar

| Milestone | Date | Customer impact |
|---|---:|---|
| API v2 GA | 2026-04-24 | New integrations should use `/api/v2` and scoped API keys. |
| v1 deprecation headers begin | 2026-04-24 | Every `/api/v1` response includes the `Deprecation` header. |
| v1 feature freeze | 2026-04-24 | v1 receives security and reliability fixes only. |
| v1 sunset | 2027-04-23 | v1 traffic must be migrated before this date. |
| v1 hard cutoff | 2027-04-23 00:00:00 GMT | `/api/v1` routes may be disabled after the cutoff window. |

Every v1 response includes:

```http
Deprecation: Sun, 23 Apr 2027 00:00:00 GMT; link="<https://arkova.ai/docs/v2-migration>; rel=successor-version"
```

## Authentication

v2 accepts the same Arkova API key formats:

```http
Authorization: Bearer ak_live_...
X-API-Key: ak_live_...
```

v2 keys are scope-aware. Ask your Arkova admin for only the scopes your integration needs:

| Scope | Use |
|---|---|
| `read:search` | Search records, organizations, fingerprints, and documents. |
| `read:records` | Verify fingerprints and fetch public anchors. |
| `read:orgs` | List organization context for agent workflows. |
| `write:anchors` | Submit anchors when write endpoints become generally available. |
| `admin:rules` | Manage rule workflows when admin endpoints become generally available. |

## Endpoint Mapping

| v1 pattern | v2 replacement | Notes |
|---|---|---|
| `GET /api/v1/verify/{publicId}` | `GET /api/v2/anchors/{public_id}` | Returns redacted public anchor metadata. |
| Fingerprint lookup through v1 search flows | `GET /api/v2/verify/{fingerprint}` | Accepts a 64-character SHA-256 hex fingerprint. |
| Search-oriented v1 endpoints | `GET /api/v2/search?q=...` | Cursor pagination and typed result rows. |
| Agent org bootstrap | `GET /api/v2/orgs` | Returns organization context for the API key. |

## Rate Limits

v1 remains frozen at the published limits. v2 uses per-scope quotas:

| Scope | Default quota |
|---|---:|
| `read:search` | 1,000 requests/minute/API key |
| `read:records` | 500 requests/minute/API key |
| `read:orgs` | 500 requests/minute/API key |
| `write:anchors` | 100 requests/minute/API key |
| `admin:rules` | 50 requests/minute/API key |

`429` responses include `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

## Error Handling

v2 returns RFC 7807 problem details for every error:

```json
{
  "type": "https://arkova.ai/problems/invalid-scope",
  "title": "Insufficient Scope",
  "status": 403,
  "detail": "This API key does not have the required scope: read:records.",
  "instance": "/api/v2/anchors/ARK-DOC-ABC"
}
```

Clients should branch on `status` and `type`, not string-match `detail`.

## SDKs

- TypeScript: `@arkova/sdk`
- Python: `pip install arkova`

Both SDKs expose v2 search, fingerprint verification, anchor lookup, organization
listing, retry handling, and problem detail errors. The Python package also
exposes `verify(public_id)` for the rich v1 verification response while teams
migrate public-ID verification to the v2 anchor-detail flow.

## Cutover Checklist

1. Create a v2-scoped API key.
2. Replace v1 verification calls with the v2 endpoint mapping above.
3. Update error handling for `application/problem+json`.
4. Honor `Retry-After` on 429 and 5xx retries.
5. Run a one-day shadow comparison against production data.
6. Remove v1 traffic before 2027-04-23.
