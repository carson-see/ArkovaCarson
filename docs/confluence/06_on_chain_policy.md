# On-Chain Content Policy

## Overview

Arkova anchors document fingerprints to a blockchain for tamper-evident timestamping. This document describes the content policy guardrails that prevent abuse and ensure compliance.

## Core Principle: Fingerprint-Only

Arkova does NOT store document content on-chain or in the database. Only the SHA-256 fingerprint (hash) is stored. This means:

1. **No content inspection possible** - We cannot determine document contents from the hash
2. **Privacy preserved** - Sensitive documents never leave user devices
3. **Minimal on-chain footprint** - Only 64-byte hashes are anchored

## Database-Level Guardrails

### Filename Constraints

The `anchors` table enforces these constraints on filenames:

```sql
-- Filename length limit (255 characters max)
CONSTRAINT anchors_filename_length CHECK (
  char_length(filename) >= 1 AND char_length(filename) <= 255
)

-- No control characters (prevents injection attacks)
CONSTRAINT anchors_filename_no_control_chars CHECK (
  filename !~ '[\x00-\x1F\x7F]'
)
```

**Rationale:**
- Length limit prevents storage abuse
- Control character rejection prevents:
  - Null byte injection
  - Terminal escape sequence attacks
  - Log injection
  - Path traversal attempts

### Fingerprint Validation

```sql
-- Must be valid SHA-256 hex (64 chars, uppercase or lowercase hex)
CONSTRAINT anchors_fingerprint_format CHECK (
  fingerprint ~ '^[A-Fa-f0-9]{64}$'
)
```

**Rationale:**
- Ensures data integrity
- Prevents arbitrary string injection
- Normalizes fingerprint format

### MIME Type Considerations

The `file_mime` column is optional and informational only. Future enhancements may include:

```sql
-- Optional: Allowlist for file types (not currently enforced)
-- CONSTRAINT anchors_mime_allowlist CHECK (
--   file_mime IS NULL OR file_mime IN (
--     'application/pdf',
--     'image/png',
--     'image/jpeg',
--     'text/plain',
--     'application/json',
--     -- Add approved types as needed
--   )
-- )
```

**Current status:** MIME type is metadata only; not used for access decisions.

## Allowed Fields for On-Chain Anchoring

Only these fields may be included in on-chain anchor data:

| Field | Included | Notes |
|-------|----------|-------|
| `fingerprint` | Yes | SHA-256 hash (64 hex chars) |
| `created_at` | Yes | UTC timestamp |
| `id` | Optional | Anchor UUID for reference |

## Forbidden from On-Chain

These fields must NEVER be included in on-chain transactions:

| Field | Reason |
|-------|--------|
| `filename` | May contain PII or sensitive info |
| `file_size` | Could reveal document type |
| `file_mime` | Could reveal document type |
| `user_id` | Privacy concern |
| `org_id` | Privacy concern |
| `email` | PII |

## Rate Limiting (Defined — Constitution Section 1.10)

Rate limits are defined in the Constitution and enforced by the worker (`services/worker/src/utils/rateLimit.ts`):

| Scope | Limit | Notes |
|-------|-------|-------|
| Anonymous | 100 req/min per IP | Public verification endpoints |
| API key holders | 1,000 req/min per key | Authenticated API access (Phase 1.5) |
| Batch endpoints | 10 req/min per API key | Bulk operations (Phase 1.5) |

Rate limit headers are included on every response. HTTP 429 with `Retry-After` on excess.

Additionally, subscription-tier anchor quotas are enforced via the `plans.records_per_month` column (migration 0016).

## Compliance Considerations

### GDPR / Data Protection

- Fingerprints are one-way hashes; original documents cannot be recovered
- No PII stored in anchor records (except user_id reference)
- Deletion possible via soft delete (but on-chain records are permanent)

### Legal Hold

When `legal_hold = true`:
- Anchor cannot be deleted
- Must be preserved for legal/compliance purposes
- See [05_retention_legal_hold.md](./05_retention_legal_hold.md)

## Implementation Notes

1. Fingerprint computation happens client-side
2. Server never receives document content
3. All timestamps are UTC (`timestamptz`)
4. Bitcoin timestamps are observational metadata only
