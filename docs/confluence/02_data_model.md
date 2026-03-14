# Data Model
_Last updated: 2026-03-12 | Migrations: 0001–0051 (0033 skipped)_

## Overview

Arkova uses PostgreSQL via Supabase with a schema-first approach. All tables have Row Level Security (RLS) enabled via `FORCE ROW LEVEL SECURITY`. Data integrity is enforced through constraints, triggers, and Zod validators on all write paths.

**Total tables:** 21 across 50 migrations.

## Enums

### user_role

| Value | Description |
|-------|-------------|
| `INDIVIDUAL` | Regular user, manages their own anchors only |
| `ORG_ADMIN` | Organization administrator, can view org anchors |

Assigned to `profiles.role`. Immutable once set (enforced by trigger).

### anchor_status

| Value | Description |
|-------|-------------|
| `PENDING` | Anchor created, awaiting on-chain confirmation |
| `SECURED` | Anchor confirmed on-chain with transaction reference |
| `REVOKED` | Anchor has been revoked (soft delete equivalent) |

Transitions: `PENDING` → `SECURED` (worker only via service_role), `PENDING` → `REVOKED`, `SECURED` → `REVOKED`.

### credential_type (migration 0029)

| Value | Description |
|-------|-------------|
| `DEGREE` | Academic degree |
| `LICENSE` | Professional license |
| `CERTIFICATE` | Certificate of completion/achievement |
| `TRANSCRIPT` | Academic transcript |
| `PROFESSIONAL` | Professional credential |
| `OTHER` | Uncategorized |

### job_status (migration 0017)

| Value | Description |
|-------|-------------|
| `pending` | Job awaiting processing |
| `processing` | Job claimed by worker |
| `completed` | Job finished successfully |
| `failed` | Job failed after max attempts |

### report_type (migration 0019)

`anchor_summary` | `compliance_audit` | `activity_log` | `billing_history`

### report_status (migration 0019)

`pending` | `generating` | `completed` | `failed`

---

## Core Tables

### organizations (migration 0002)

Multi-tenant organization container.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `legal_name` | text | NO | — | Official legal name |
| `display_name` | text | NO | — | UI display name |
| `domain` | text | YES | NULL | Organization domain |
| `verification_status` | text | NO | 'UNVERIFIED' | UNVERIFIED / PENDING / VERIFIED |
| `created_at` | timestamptz | NO | now() | Creation timestamp (UTC) |
| `updated_at` | timestamptz | NO | now() | Last update timestamp (UTC) |

### profiles (migrations 0003, 0023, 0028)

User profiles linked to Supabase Auth.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | — | PK, references auth.users(id) |
| `email` | text | NO | — | User email (lowercase enforced) |
| `full_name` | text | YES | NULL | Display name |
| `avatar_url` | text | YES | NULL | Profile picture URL |
| `role` | user_role | YES | NULL | User role (immutable once set) |
| `role_set_at` | timestamptz | YES | NULL | When role was assigned |
| `org_id` | uuid | YES | NULL | Organization membership |
| `requires_manual_review` | boolean | NO | false | Admin review flag |
| `manual_review_reason` | text | YES | NULL | Review reason |
| `manual_review_completed_at` | timestamptz | YES | NULL | Review completion |
| `manual_review_completed_by` | uuid | YES | NULL | Reviewing admin |
| `is_verified` | boolean | NO | false | Identity verified (privileged, migration 0028) |
| `subscription_tier` | text | NO | 'free' | Billing tier (privileged, migration 0028) |
| `is_public_profile` | boolean | NO | false | Public discoverability toggle (migration 0023) |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Last update timestamp |

**Triggers:** `enforce_profiles_lowercase_email`, `set_profiles_updated_at`, `enforce_role_immutability`, `protect_privileged_fields` (guards org_id, manual_review_*, is_verified, subscription_tier — service_role bypasses).

**Note:** `stripe_customer_id` and `stripe_subscription_id` are NOT on profiles. They live on the `subscriptions` table (migration 0016).

### anchors (migrations 0004, 0020, 0029, 0030, 0031, 0036)

Document fingerprint records (NO document content stored).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | — | Owner, references profiles |
| `org_id` | uuid | YES | NULL | Organization, references organizations |
| `fingerprint` | char(64) | NO | — | SHA-256 hash (64 hex chars) |
| `filename` | text | NO | — | Original filename (metadata) |
| `file_size` | bigint | YES | NULL | File size in bytes |
| `file_mime` | text | YES | NULL | MIME type |
| `status` | anchor_status | NO | 'PENDING' | Anchor lifecycle state |
| `chain_tx_id` | text | YES | NULL | On-chain transaction ID |
| `chain_block_height` | bigint | YES | NULL | Block height |
| `chain_timestamp` | timestamptz | YES | NULL | On-chain timestamp |
| `legal_hold` | boolean | NO | false | Prevents deletion |
| `retention_until` | timestamptz | YES | NULL | Retention policy date |
| `deleted_at` | timestamptz | YES | NULL | Soft delete timestamp |
| `public_id` | text | YES | NULL | Non-guessable public verification ID (migration 0020) |
| `credential_type` | credential_type | YES | NULL | Credential classification (migration 0029) |
| `metadata` | jsonb | YES | NULL | Structured credential metadata (migration 0030) |
| `parent_anchor_id` | uuid | YES | NULL | Previous version self-ref FK (migration 0031) |
| `version_number` | integer | NO | 1 | Version in lineage chain (migration 0031) |
| `revocation_reason` | text | YES | NULL | Reason for revocation (migration 0036) |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Last update timestamp |

**Key constraints:**
- `fingerprint` must match `^[A-Fa-f0-9]{64}$`
- `status = 'SECURED'` implies `chain_tx_id IS NOT NULL`
- `legal_hold = true` implies `deleted_at IS NULL`
- `metadata` must be JSON object if provided
- `version_number >= 1`; root anchors (no parent) must be v1
- Cannot self-reference (`parent_anchor_id != id`)

**Triggers:**
- `auto_generate_public_id` — sets `public_id` when status transitions to SECURED (migration 0020)
- `prevent_metadata_edit_trigger` — blocks metadata changes after leaving PENDING (migration 0030)
- `set_anchor_version_trigger` — auto-computes version_number from parent on INSERT (migration 0031)
- `create_anchoring_job_on_insert` — auto-creates anchoring job for PENDING anchors (migration 0017)

### audit_events (migration 0006)

Append-only audit log. UPDATE and DELETE blocked by triggers.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `event_type` | text | NO | — | Specific event (e.g., anchor.created) |
| `event_category` | text | NO | — | AUTH / ANCHOR / PROFILE / ORG / ADMIN / SYSTEM |
| `actor_id` | uuid | YES | NULL | User who performed action |
| `actor_email` | text | YES | NULL | Actor's email |
| `actor_ip` | inet | YES | NULL | Client IP address |
| `actor_user_agent` | text | YES | NULL | Client user agent |
| `target_type` | text | YES | NULL | Affected entity type |
| `target_id` | uuid | YES | NULL | Affected entity ID |
| `org_id` | uuid | YES | NULL | Organization context |
| `details` | text | YES | NULL | Event details (max 10,000 chars) |
| `created_at` | timestamptz | NO | now() | Event timestamp (UTC) |

---

## Billing Tables (migration 0016)

### plans

Available subscription plans. Seeded with: free, individual, professional, organization.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | text | NO | — | Primary key (e.g., 'free', 'professional') |
| `name` | text | NO | — | Display name |
| `description` | text | YES | NULL | Plan description |
| `stripe_price_id` | text | YES | NULL | Stripe price reference (UNIQUE) |
| `price_cents` | integer | NO | 0 | Price in cents |
| `billing_period` | text | NO | 'month' | month / year / custom |
| `records_per_month` | integer | NO | 10 | Monthly anchor quota |
| `features` | jsonb | NO | '[]' | Feature list for display |
| `is_active` | boolean | NO | true | Whether plan is available |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated via moddatetime |

### subscriptions

User subscription state.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | — | FK → profiles(id), UNIQUE |
| `org_id` | uuid | YES | NULL | FK → organizations(id) |
| `plan_id` | text | NO | — | FK → plans(id) |
| `stripe_subscription_id` | text | YES | NULL | Stripe subscription reference (UNIQUE) |
| `stripe_customer_id` | text | YES | NULL | Stripe customer reference |
| `status` | text | NO | 'active' | active / past_due / canceled / trialing / paused |
| `current_period_start` | timestamptz | YES | NULL | Billing period start |
| `current_period_end` | timestamptz | YES | NULL | Billing period end |
| `cancel_at_period_end` | boolean | NO | false | Pending cancellation |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated via moddatetime |

### entitlements

Current entitlements for users/orgs.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | YES | NULL | FK → profiles(id) |
| `org_id` | uuid | YES | NULL | FK → organizations(id) |
| `entitlement_type` | text | NO | — | Entitlement name |
| `value` | jsonb | NO | '{}' | Entitlement value |
| `source` | text | NO | 'subscription' | subscription / manual / trial / promo |
| `valid_from` | timestamptz | NO | now() | Start of validity |
| `valid_until` | timestamptz | YES | NULL | End of validity |
| `created_at` | timestamptz | NO | now() | Creation timestamp |

**Constraint:** Must have either `user_id` or `org_id` (or both).

### billing_events

Append-only audit trail for billing events. UPDATE and DELETE blocked by triggers (reuses `reject_audit_modification()`).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `stripe_event_id` | text | YES | NULL | Stripe event ID (UNIQUE, for idempotency) |
| `event_type` | text | NO | — | Event type |
| `user_id` | uuid | YES | NULL | FK → profiles(id) |
| `org_id` | uuid | YES | NULL | FK → organizations(id) |
| `subscription_id` | uuid | YES | NULL | FK → subscriptions(id) |
| `payload` | jsonb | NO | '{}' | Event payload |
| `processed_at` | timestamptz | NO | now() | Processing timestamp |
| `idempotency_key` | text | YES | NULL | Unique idempotency key |

---

## Worker Tables

### anchoring_jobs (migration 0017)

Queue of pending anchoring work with safe claim mechanism.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `anchor_id` | uuid | NO | — | FK → anchors(id), UNIQUE |
| `status` | job_status | NO | 'pending' | Job state |
| `claimed_at` | timestamptz | YES | NULL | When claimed by worker |
| `claimed_by` | text | YES | NULL | Worker ID |
| `claim_expires_at` | timestamptz | YES | NULL | Claim lock timeout |
| `attempts` | integer | NO | 0 | Attempt count |
| `max_attempts` | integer | NO | 3 | Max retry attempts |
| `last_error` | text | YES | NULL | Last error message |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `started_at` | timestamptz | YES | NULL | First processing start |
| `completed_at` | timestamptz | YES | NULL | Completion timestamp |

**RLS:** No authenticated policies — service_role only (worker access).

**Functions:** `claim_anchoring_job(worker_id, lock_seconds)` — atomic claim with `FOR UPDATE SKIP LOCKED`. `complete_anchoring_job(job_id, success, error)` — mark done/failed.

### anchor_proofs (migration 0017)

Proof data for secured anchors.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `anchor_id` | uuid | NO | — | FK → anchors(id), UNIQUE |
| `receipt_id` | text | NO | — | Chain receipt ID |
| `block_height` | integer | NO | — | Block number |
| `block_timestamp` | timestamptz | NO | — | Block timestamp |
| `merkle_root` | text | YES | NULL | Merkle root hash |
| `proof_path` | jsonb | YES | NULL | Merkle proof path |
| `raw_response` | jsonb | YES | NULL | Raw chain response |
| `created_at` | timestamptz | NO | now() | Creation timestamp |

---

## Webhook Tables (migration 0018)

### webhook_endpoints

Organization-level webhook configuration. See [09_webhooks.md](./09_webhooks.md) for full details.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `org_id` | uuid | NO | — | FK → organizations(id) |
| `url` | text | NO | — | HTTPS endpoint (CHECK enforced) |
| `secret_hash` | text | NO | — | HMAC secret hash (write-only) |
| `events` | text[] | NO | `{anchor.secured, anchor.revoked}` | Events to subscribe |
| `is_active` | boolean | NO | true | Enabled state |
| `description` | text | YES | NULL | Human label |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated |
| `created_by` | uuid | YES | NULL | FK → profiles(id) |

### webhook_delivery_logs

Delivery attempts for audit and retry logic. See [09_webhooks.md](./09_webhooks.md).

Key columns: `endpoint_id`, `event_type`, `event_id`, `payload`, `attempt_number`, `status` (pending/success/failed/retrying), `next_retry_at`.

---

## Reports Tables (migration 0019)

### reports

Report requests and metadata.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | — | FK → profiles(id) |
| `org_id` | uuid | YES | NULL | FK → organizations(id) |
| `report_type` | report_type | NO | — | anchor_summary / compliance_audit / activity_log / billing_history |
| `parameters` | jsonb | NO | '{}' | Report configuration |
| `status` | report_status | NO | 'pending' | pending / generating / completed / failed |
| `error_message` | text | YES | NULL | Error details |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `started_at` | timestamptz | YES | NULL | Generation start |
| `completed_at` | timestamptz | YES | NULL | Generation end |
| `expires_at` | timestamptz | YES | NULL | Download expiry |
| `idempotency_key` | text | YES | NULL | UNIQUE |

### report_artifacts

Generated report files.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `report_id` | uuid | NO | — | FK → reports(id) |
| `filename` | text | NO | — | Output filename |
| `mime_type` | text | NO | 'application/json' | File MIME type |
| `file_size` | integer | YES | NULL | File size in bytes |
| `storage_path` | text | NO | — | Storage location |
| `created_at` | timestamptz | NO | now() | Creation timestamp |

---

## Feature Flags (migration 0021)

### switchboard_flags

Server-side feature flags with defaults.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | text | NO | — | Primary key (flag name) |
| `value` | boolean | NO | — | Current value |
| `description` | text | YES | NULL | Human description |
| `default_value` | boolean | NO | — | Fallback value |
| `is_dangerous` | boolean | NO | false | Requires extra caution |
| `updated_at` | timestamptz | NO | now() | Last update |
| `updated_by` | uuid | YES | NULL | FK → profiles(id) |

**Seeded flags:** `ENABLE_PROD_NETWORK_ANCHORING` (false), `ENABLE_OUTBOUND_WEBHOOKS` (false), `ENABLE_NEW_CHECKOUTS` (true), `ENABLE_REPORTS` (true), `MAINTENANCE_MODE` (false).

**Function:** `get_flag(flag_id)` — safe lookup with default.

### switchboard_flag_history

Audit trail for flag changes. Auto-populated by trigger on switchboard_flags UPDATE.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `flag_id` | text | NO | — | FK → switchboard_flags(id) |
| `old_value` | boolean | YES | NULL | Previous value |
| `new_value` | boolean | NO | — | New value |
| `changed_by` | uuid | YES | NULL | FK → profiles(id) |
| `changed_at` | timestamptz | NO | now() | Change timestamp |
| `reason` | text | YES | NULL | Change reason |

---

## Credential Templates (migration 0040)

### credential_templates

Reusable credential configurations for organizations.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `org_id` | uuid | NO | — | FK → organizations(id) |
| `name` | text | NO | — | Template name (1–255 chars, UNIQUE per org) |
| `description` | text | YES | NULL | Template description (max 2000 chars) |
| `credential_type` | credential_type | NO | — | Credential classification |
| `default_metadata` | jsonb | YES | '{}' | Default metadata schema (must be object) |
| `is_active` | boolean | NO | true | Whether template is available |
| `created_by` | uuid | YES | NULL | FK → profiles(id) |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated |

**RLS:** ORG_ADMIN can full CRUD for their org's templates.

---

## Verification Events (migration 0042)

### verification_events

Analytics: tracks public verification lookups (no PII).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `anchor_id` | uuid | YES | NULL | FK → anchors(id) |
| `public_id` | text | NO | — | Verified anchor's public ID |
| `method` | text | NO | 'web' | web / api / embed / qr |
| `result` | text | NO | — | verified / revoked / not_found / error |
| `fingerprint_provided` | boolean | NO | false | Whether fingerprint was included |
| `ip_hash` | text | YES | NULL | SHA-256 of IP (never raw) |
| `user_agent` | text | YES | NULL | Request user agent |
| `referrer` | text | YES | NULL | Request referrer |
| `country_code` | char(2) | YES | NULL | Country code |
| `org_id` | uuid | YES | NULL | FK → organizations(id) |
| `created_at` | timestamptz | NO | now() | Event timestamp |

**RLS:** ORG_ADMIN can read events for their org. Insert via service_role only (worker/API).

---

## AI / Vector Tables

### institution_ground_truth (migration 0051)

Institution verification ground truth data with vector embeddings for semantic similarity search. Used by P8 anomaly detection (INFRA-08).

**Extensions required:** `vector` (pgvector), `pg_trgm` (trigram fuzzy search) — both enabled in migration 0051.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `institution_name` | text | NO | — | Institution display name |
| `domain` | text | YES | NULL | Institution domain (e.g., mit.edu) |
| `metadata` | jsonb | NO | '{}' | Structured metadata (accreditation, location, etc.) |
| `embedding` | vector(768) | YES | NULL | 768-dimensional vector embedding for similarity search |
| `source` | text | NO | 'manual' | Data source: cloudflare_crawl, manual, api |
| `confidence_score` | numeric(3,2) | YES | NULL | Reliability score 0.00–1.00 |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated via trigger |

**Indexes:**
- `idx_institution_ground_truth_embedding` — IVFFlat (vector_cosine_ops, lists=100). Switch to HNSW when dataset exceeds ~100K rows.
- `idx_institution_ground_truth_name_trgm` — GIN trigram index for fuzzy name search
- `idx_institution_ground_truth_domain` — B-tree partial index (WHERE domain IS NOT NULL)
- `idx_institution_ground_truth_source` — B-tree index on source column

**RLS:** service_role has full access. Authenticated users have read-only access.

**Trigger:** `trg_institution_ground_truth_updated_at` — auto-sets `updated_at` on UPDATE.

---

## Entity Relationships

```
auth.users
    │
    └──< profiles (id = auth.users.id)
            │
            ├──< anchors (user_id)
            │       │
            │       ├──> organizations (org_id)
            │       ├──< anchoring_jobs (anchor_id)
            │       ├──< anchor_proofs (anchor_id)
            │       ├──< verification_events (anchor_id)
            │       └──> anchors (parent_anchor_id, self-ref lineage)
            │
            ├──> organizations (org_id)
            │       │
            │       ├──< webhook_endpoints (org_id)
            │       │       └──< webhook_delivery_logs (endpoint_id)
            │       ├──< credential_templates (org_id)
            │       └──< reports (org_id)
            │
            ├──< subscriptions (user_id)
            │       └──> plans (plan_id)
            │
            ├──< entitlements (user_id / org_id)
            ├──< billing_events (user_id)
            ├──< reports (user_id)
            └──< audit_events (actor_id)

switchboard_flags ──< switchboard_flag_history (flag_id)

institution_ground_truth (standalone — no FK relationships)
```

## Zod Validators

Client-side validators in `src/lib/validators.ts`:

### AnchorCreateSchema
- `fingerprint`: 64 hex chars, normalized to lowercase
- `filename`: 1–255 chars, no control characters
- `file_size`: optional positive integer
- `file_mime`: optional string
- `org_id`: optional UUID

**Note:** `user_id` and `status` are NOT in schema (set server-side).

### ProfileUpdateSchema
- `full_name`: optional, max 255 chars
- `avatar_url`: optional valid URL

**Note:** Privileged fields blocked by DB trigger.

## Type Generation

```bash
npm run gen:types
```

Creates `src/types/database.types.ts` — the authoritative UI contract. Regenerate after every schema change.

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Complete rewrite: added 16 missing tables, added missing anchor columns (public_id, credential_type, metadata, parent_anchor_id, version_number, revocation_reason), added is_public_profile to profiles, documented all enums, updated ER diagram |
| 2026-03-12 | INFRA-08 | Added institution_ground_truth table (migration 0051). Enabled pgvector + pg_trgm extensions. 21 tables total. |
