# Data Model

## Overview

Ralph uses PostgreSQL via Supabase with a schema-first approach. All tables have Row Level Security (RLS) enabled and enforce data integrity through constraints and triggers.

## Enums

### user_role

Defines user permission levels.

| Value | Description |
|-------|-------------|
| `INDIVIDUAL` | Regular user, manages their own anchors only |
| `ORG_ADMIN` | Organization administrator, can view org anchors |

**Usage:** Assigned to profiles.role (immutable once set)

### anchor_status

Defines anchor lifecycle states.

| Value | Description |
|-------|-------------|
| `PENDING` | Anchor created, awaiting on-chain confirmation |
| `SECURED` | Anchor confirmed on-chain with transaction reference |
| `REVOKED` | Anchor has been revoked (soft delete equivalent) |

**Transitions:**
- `PENDING` → `SECURED` (system only, when on-chain)
- `PENDING` → `REVOKED` (user can revoke pending)
- `SECURED` → `REVOKED` (user can revoke secured)

## Tables

### organizations

Multi-tenant organization container.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `legal_name` | text | NO | - | Official legal name |
| `display_name` | text | NO | - | UI display name |
| `domain` | text | YES | NULL | Organization domain |
| `verification_status` | text | NO | 'UNVERIFIED' | UNVERIFIED, PENDING, VERIFIED |
| `created_at` | timestamptz | NO | now() | Creation timestamp (UTC) |
| `updated_at` | timestamptz | NO | now() | Last update timestamp (UTC) |

**Indexes:**
- `idx_organizations_domain` - domain (where not null)
- `idx_organizations_created_at` - created_at

**Constraints:**
- Domain must match lowercase domain pattern if provided
- Name lengths: 1-255 characters

### profiles

User profiles linked to Supabase Auth.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | - | PK, references auth.users(id) |
| `email` | text | NO | - | User email (lowercase enforced) |
| `full_name` | text | YES | NULL | Display name |
| `avatar_url` | text | YES | NULL | Profile picture URL |
| `role` | user_role | YES | NULL | User role (immutable once set) |
| `role_set_at` | timestamptz | YES | NULL | When role was assigned |
| `org_id` | uuid | YES | NULL | Organization membership |
| `requires_manual_review` | boolean | NO | false | Admin review flag |
| `manual_review_reason` | text | YES | NULL | Review reason |
| `manual_review_completed_at` | timestamptz | YES | NULL | Review completion |
| `manual_review_completed_by` | uuid | YES | NULL | Reviewing admin |
| `is_verified` | boolean | NO | false | Identity verified by admin (privileged) |
| `subscription_tier` | text | NO | 'free' | Billing tier: free/starter/professional/enterprise (privileged) |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Last update timestamp |

**Indexes:**
- `idx_profiles_email` - email (unique)
- `idx_profiles_org_id` - org_id (where not null)
- `idx_profiles_role` - role (where not null)
- `idx_profiles_requires_review` - requires_manual_review (where true)

**Constraints:**
- `id` references auth.users with CASCADE delete
- ORG_ADMIN must have org_id set
- Email must be valid format and lowercase
- `subscription_tier` must be one of: free, starter, professional, enterprise

**Triggers:**
- `enforce_profiles_lowercase_email` - Lowercase email on insert/update
- `set_profiles_updated_at` - Update timestamp
- `enforce_role_immutability` - Prevent role changes
- `protect_privileged_fields` - Block direct update of admin fields (org_id, requires_manual_review, manual_review_reason, manual_review_completed_at, manual_review_completed_by, is_verified, subscription_tier)

### anchors

Document fingerprint records (NO document content stored).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | - | Owner, references profiles |
| `org_id` | uuid | YES | NULL | Organization, references organizations |
| `fingerprint` | char(64) | NO | - | SHA-256 hash (64 hex chars) |
| `filename` | text | NO | - | Original filename (metadata) |
| `file_size` | bigint | YES | NULL | File size in bytes |
| `file_mime` | text | YES | NULL | MIME type |
| `status` | anchor_status | NO | 'PENDING' | Anchor lifecycle state |
| `chain_tx_id` | text | YES | NULL | On-chain transaction ID |
| `chain_block_height` | bigint | YES | NULL | Block height |
| `chain_timestamp` | timestamptz | YES | NULL | On-chain timestamp |
| `legal_hold` | boolean | NO | false | Prevents deletion |
| `retention_until` | timestamptz | YES | NULL | Retention policy date |
| `deleted_at` | timestamptz | YES | NULL | Soft delete timestamp |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Last update timestamp |

**Indexes:**
- `idx_anchors_user_id` - user_id
- `idx_anchors_org_id` - org_id (where not null)
- `idx_anchors_fingerprint` - fingerprint
- `idx_anchors_status` - status
- `idx_anchors_created_at` - created_at
- `idx_anchors_legal_hold` - legal_hold (where true)
- `idx_anchors_user_fingerprint_unique` - (user_id, fingerprint) unique where not deleted

**Constraints:**
- `fingerprint` must match `^[A-Fa-f0-9]{64}$`
- `filename` length 1-255, no control characters
- `legal_hold = true` implies `deleted_at IS NULL`
- `status = 'SECURED'` implies `chain_tx_id IS NOT NULL`

### audit_events

Append-only audit log.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `event_type` | text | NO | - | Specific event (e.g., anchor.created) |
| `event_category` | text | NO | - | Category: AUTH, ANCHOR, etc. |
| `actor_id` | uuid | YES | NULL | User who performed action |
| `actor_email` | text | YES | NULL | Actor's email |
| `actor_ip` | inet | YES | NULL | Client IP address |
| `actor_user_agent` | text | YES | NULL | Client user agent |
| `target_type` | text | YES | NULL | Affected entity type |
| `target_id` | uuid | YES | NULL | Affected entity ID |
| `org_id` | uuid | YES | NULL | Organization context |
| `details` | text | YES | NULL | Event details |
| `created_at` | timestamptz | NO | now() | Event timestamp (UTC) |

**Event Categories:** AUTH, ANCHOR, PROFILE, ORG, ADMIN, SYSTEM

**Indexes:**
- `idx_audit_events_actor_id` - actor_id
- `idx_audit_events_org_id` - org_id
- `idx_audit_events_event_type` - event_type
- `idx_audit_events_event_category` - event_category
- `idx_audit_events_created_at` - created_at
- `idx_audit_events_target` - (target_type, target_id)

**Triggers:**
- `reject_audit_update` - Blocks all UPDATE operations
- `reject_audit_delete` - Blocks all DELETE operations

## Zod Validators

Client-side validators in `src/lib/validators.ts`:

### AnchorCreateSchema

Validates new anchor creation:
- `fingerprint`: 64 hex chars, normalized to lowercase
- `filename`: 1-255 chars, no control characters
- `file_size`: optional positive integer
- `file_mime`: optional string
- `org_id`: optional UUID

**Note:** `user_id` and `status` are NOT in schema (set server-side)

### ProfileUpdateSchema

Validates profile updates:
- `full_name`: optional, max 255 chars
- `avatar_url`: optional valid URL

**Note:** Privileged fields blocked by DB trigger

## Entity Relationships

```
auth.users
    │
    └──< profiles (id = auth.users.id)
            │
            ├──< anchors (user_id = profiles.id)
            │       │
            │       └──> organizations (org_id)
            │
            ├──> organizations (org_id)
            │
            └──< audit_events (actor_id = profiles.id)
                    │
                    └──> organizations (org_id)
```

## Type Generation

Generate TypeScript types from schema:

```bash
npm run gen:types
```

This creates `src/types/database.types.ts` which serves as the authoritative UI contract.
