# Retention & Legal Hold

## Overview

Arkova supports data retention policies and legal hold capabilities to meet compliance and legal requirements. This document describes the mechanisms and constraints.

## Legal Hold

### Purpose

Legal hold prevents deletion of anchors that may be required for legal proceedings, regulatory investigations, or compliance audits.

### Implementation

The `anchors` table includes:

```sql
legal_hold boolean NOT NULL DEFAULT false
```

A database constraint prevents deletion when legal hold is active:

```sql
CONSTRAINT anchors_legal_hold_no_delete CHECK (
  legal_hold = false OR deleted_at IS NULL
)
```

### Behavior

| legal_hold | Allowed Actions |
|------------|-----------------|
| `false` | Can be soft-deleted (set deleted_at) |
| `true` | Cannot be deleted; must remove hold first |

### Setting Legal Hold

Only administrators (via service_role) can set legal hold:

```sql
-- Apply legal hold
UPDATE anchors
SET legal_hold = true
WHERE id = 'anchor-uuid';

-- Remove legal hold (after legal clearance)
UPDATE anchors
SET legal_hold = false
WHERE id = 'anchor-uuid';
```

Users cannot modify `legal_hold` via RLS (protected by trigger).

### Audit Trail

All legal hold changes should be logged:

```sql
INSERT INTO audit_events (
  event_type, event_category, actor_id, target_type, target_id, details
) VALUES (
  'admin.legal_hold_set', 'ADMIN', admin_user_id, 'anchor', anchor_id,
  'Legal hold applied for case #12345'
);
```

## Retention Policy

### Purpose

Retention policies define how long anchors must be kept before they can be deleted. This supports compliance with data retention regulations.

### Implementation

The `anchors` table includes:

```sql
retention_until timestamptz NULL
```

### Behavior

| retention_until | Meaning |
|-----------------|---------|
| `NULL` | No retention policy; normal deletion rules apply |
| Future date | Cannot delete until date passes |
| Past date | Retention period complete; can delete |

### Setting Retention

```sql
-- Set 7-year retention (common for financial records)
UPDATE anchors
SET retention_until = now() + interval '7 years'
WHERE id = 'anchor-uuid';
```

### Application-Level Enforcement

While legal_hold has DB-level enforcement, retention_until should be checked in application code:

```typescript
function canDeleteAnchor(anchor: Anchor): boolean {
  if (anchor.legal_hold) return false;
  if (anchor.retention_until && new Date(anchor.retention_until) > new Date()) {
    return false;
  }
  return true;
}
```

## Soft Delete

### Implementation

Anchors use soft delete via `deleted_at`:

```sql
deleted_at timestamptz NULL
```

### Deletion Process

1. Check `legal_hold = false`
2. Check `retention_until` has passed (if set)
3. Set `deleted_at = now()`

```sql
UPDATE anchors
SET deleted_at = now()
WHERE id = 'anchor-uuid'
  AND legal_hold = false
  AND (retention_until IS NULL OR retention_until < now());
```

### Querying Non-Deleted Records

Most queries should exclude deleted records:

```sql
SELECT * FROM anchors WHERE deleted_at IS NULL;
```

The unique index respects soft delete:

```sql
CREATE UNIQUE INDEX idx_anchors_user_fingerprint_unique
  ON anchors(user_id, fingerprint)
  WHERE deleted_at IS NULL;
```

## On-Chain Permanence

### Important Note

While Arkova allows soft deletion of anchor records, **on-chain data is permanent**:

- The fingerprint anchored to blockchain cannot be removed
- `deleted_at` only affects Arkova's local record
- Chain evidence remains for verification

This is by design: the blockchain provides immutable proof that existed independently of Arkova's database.

## Compliance Considerations

### GDPR Right to Erasure

- Anchors contain fingerprints (hashes), not personal data
- User's right to erasure applies to profiles, not anchor evidence
- Legal hold may override erasure requests during legal proceedings

### Financial Records Retention

Many jurisdictions require 5-7 year retention for financial documents:

```sql
-- Example: Apply 7-year retention to financial anchors
UPDATE anchors
SET retention_until = created_at + interval '7 years'
WHERE file_mime = 'application/pdf'
  AND filename LIKE '%invoice%';
```

### Audit Requirements

All retention and legal hold changes are logged in `audit_events` for compliance auditing.

## Timestamps

All timestamps are stored as `timestamptz` and treated as UTC:

- `created_at` - When anchor was created
- `deleted_at` - When soft-deleted
- `retention_until` - Retention policy expiration
- `chain_timestamp` - On-chain confirmation time

UTC ensures consistent, auditable timestamps across timezones.
