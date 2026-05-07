/**
 * BigQuery target schemas for the arkova_analytics dataset.
 *
 * SCRUM-1722 (parent SCRUM-1062 GCP-MAX-02). Source of truth for the BQ-side
 * shape of each mirrored Postgres table.
 *
 * Five mirrored tables, two write modes:
 *   - Append-only (incremental sync every 5 min, watermark-driven via
 *     bq_export_watermarks; SCRUM-1723):
 *         anchors, verifications, audit_events
 *   - Snapshot (full replace per partition_date, daily 02:00 UTC; SCRUM-1724):
 *         organizations, api_keys
 *
 * audit_events carries partition_expiration_ms = 2555 days for SOC 2 audit-
 * evidence retention (CLAUDE.md §1.5; AICPA DC 200 §5 Control Environment).
 *
 * api_keys schema HARD-EXCLUDES the raw `key` column. The build-time test in
 * bq-export-schemas.test.ts asserts no field named `key`/`secret`/etc. ever
 * leaks in. The snapshot job (SCRUM-1724) MUST source columns through the
 * exported `API_KEYS_COLUMN_ALLOWLIST` — never `SELECT *`.
 *
 * Typed against the BigQuery REST API "tables.insert" payload shape, not
 * against `@google-cloud/bigquery` — deliberate per services/worker/src/utils/
 * gcp-auth.ts (avoids npm SDK dep + bundle bloat).
 */

/** A BigQuery table schema field (subset of the REST API field type we use). */
export interface BqField {
  readonly name: string;
  readonly type:
    | 'STRING'
    | 'BYTES'
    | 'INTEGER'
    | 'INT64'
    | 'FLOAT'
    | 'FLOAT64'
    | 'BOOLEAN'
    | 'BOOL'
    | 'TIMESTAMP'
    | 'DATE'
    | 'DATETIME'
    | 'NUMERIC'
    | 'JSON'
    | 'RECORD';
  readonly mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
  readonly description?: string;
  readonly fields?: readonly BqField[];
}

export interface BqTimePartitioning {
  readonly type: 'DAY';
  readonly field: string;
  /** Partition expiration in milliseconds, as a string per BQ API quirk. */
  readonly expirationMs?: string;
}

export interface BqClustering {
  readonly fields: readonly string[];
}

export type BqWriteMode = 'append' | 'snapshot';

export interface BqTableTarget {
  readonly tableId: string;
  readonly mode: BqWriteMode;
  readonly description: string;
  readonly schema: { readonly fields: readonly BqField[] };
  readonly timePartitioning: BqTimePartitioning;
  readonly clustering?: BqClustering;
}

/** Project + dataset constants. Asserted in tests; consumed by sync jobs. */
export const PROJECT_ID = 'arkova1';
export const DATASET_ID = 'arkova_analytics';
export const DATASET_LOCATION = 'US';

/**
 * 7 years (2,555 days) in milliseconds — partition expiration for
 * audit_events. Computed at module-load so the test can re-derive and
 * compare without hardcoding the literal in two places.
 */
export const SOC2_AUDIT_RETENTION_DAYS = 2555;
export const SOC2_AUDIT_RETENTION_MS = String(
  SOC2_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Append-only mirrors (5-min incremental sync)
// ---------------------------------------------------------------------------

const ANCHORS: BqTableTarget = {
  tableId: 'anchors',
  mode: 'append',
  description:
    'Append-only mirror of public.anchors. Source of truth lives in Postgres; this dataset is for analytics + audit queries only.',
  schema: {
    fields: [
      { name: 'id', type: 'STRING', mode: 'REQUIRED', description: 'Source uuid (used as MERGE key)' },
      { name: 'public_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'credential_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'fingerprint', type: 'STRING', mode: 'NULLABLE' },
      { name: 'status', type: 'STRING', mode: 'NULLABLE' },
      { name: 'chain_block_height', type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'chain_tx_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'chain_confirmations', type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'parent_anchor_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'version_number', type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'metadata', type: 'JSON', mode: 'NULLABLE' },
      { name: 'revoked_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'revoked_by', type: 'STRING', mode: 'NULLABLE' },
      { name: 'issued_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Time the row landed in BQ (for freshness SLO)' },
    ],
  },
  timePartitioning: { type: 'DAY', field: 'created_at' },
  clustering: { fields: ['org_id', 'status'] },
};

const VERIFICATIONS: BqTableTarget = {
  tableId: 'verifications',
  mode: 'append',
  description:
    'Append-only mirror of public.verifications. One row per anchor verification request.',
  schema: {
    fields: [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'anchor_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'public_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'result', type: 'STRING', mode: 'NULLABLE', description: 'matched/no_match/error' },
      { name: 'verified_via', type: 'STRING', mode: 'NULLABLE', description: 'api/web/mcp/sdk' },
      { name: 'verifier_ip_hash', type: 'STRING', mode: 'NULLABLE', description: 'Hashed only — no raw IP per CLAUDE.md §1.4' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  timePartitioning: { type: 'DAY', field: 'created_at' },
  clustering: { fields: ['org_id', 'anchor_id'] },
};

/**
 * audit_events mirror.
 *
 * Source columns per supabase/migrations/0006_audit_events.sql:
 *   id, event_type, event_category, actor_id, actor_email (PII), actor_ip
 *   (PII), actor_user_agent (semi-PII), target_type, target_id, org_id,
 *   details (text), created_at.
 *
 * BQ mirror EXCLUDES actor_email, actor_ip, and actor_user_agent — these
 * are PII and the SOC 2 evidence trail does not require them at the
 * warehouse layer (the operational Postgres still has them under RLS).
 * `details` is a text column in source; mirror as STRING (not JSON) to
 * match source typing exactly.
 */
const AUDIT_EVENTS: BqTableTarget = {
  tableId: 'audit_events',
  mode: 'append',
  description:
    'Append-only mirror of public.audit_events. PII columns (actor_email, actor_ip, actor_user_agent) deliberately excluded — see source-of-truth allowlist AUDIT_EVENTS_COLUMN_ALLOWLIST. 7-year partition expiration for SOC 2 evidence retention (DC 200 Criterion #5 Control Environment).',
  schema: {
    fields: [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'event_type', type: 'STRING', mode: 'REQUIRED', description: 'Source NOT NULL; e.g. "anchor.created"' },
      { name: 'event_category', type: 'STRING', mode: 'REQUIRED', description: 'CHECK constraint: AUTH/ANCHOR/PROFILE/ORG/ADMIN/SYSTEM' },
      { name: 'actor_id', type: 'STRING', mode: 'NULLABLE', description: 'uuid only; actor_email/actor_ip excluded as PII' },
      { name: 'target_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'target_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'details', type: 'STRING', mode: 'NULLABLE', description: 'Source is text, not JSON' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  timePartitioning: {
    type: 'DAY',
    field: 'created_at',
    expirationMs: SOC2_AUDIT_RETENTION_MS,
  },
  clustering: { fields: ['org_id', 'event_category', 'event_type'] },
};

// ---------------------------------------------------------------------------
// Snapshot mirrors (daily 02:00 UTC, full replace per partition_date)
// ---------------------------------------------------------------------------

const ORGANIZATIONS: BqTableTarget = {
  tableId: 'organizations',
  mode: 'snapshot',
  description:
    'Daily snapshot of public.organizations. Partitioned by snapshot_date for point-in-time queries (e.g. "what was this org\'s tier on 2025-08-01?").',
  schema: {
    fields: [
      { name: 'snapshot_date', type: 'DATE', mode: 'REQUIRED', description: 'UTC date the snapshot was taken' },
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'legal_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'display_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'org_prefix', type: 'STRING', mode: 'NULLABLE' },
      { name: 'tier', type: 'STRING', mode: 'NULLABLE' },
      { name: 'parent_org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'payment_state', type: 'STRING', mode: 'NULLABLE' },
      { name: 'verified_badge_granted_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  timePartitioning: { type: 'DAY', field: 'snapshot_date' },
  clustering: { fields: ['id'] },
};

/**
 * api_keys snapshot.
 *
 * Source column per supabase/migrations/0057_verification_api_foundation.sql:
 *   key_hash (NOT hashed_key) — HMAC-SHA256 with API_KEY_HMAC_SECRET, raw
 *   key never persisted (CLAUDE.md §1.4).
 *
 * CRITICAL — this schema MUST NOT include any field that could carry the
 * raw key value. Allowed columns are enumerated in API_KEYS_COLUMN_ALLOWLIST
 * below. `name` is also excluded because operators sometimes embed PII-ish
 * labels there ("Carson's prod key"). The snapshot job (SCRUM-1724) MUST
 * source rows via this allowlist; the build-time test enforces it.
 */
const API_KEYS: BqTableTarget = {
  tableId: 'api_keys',
  mode: 'snapshot',
  description:
    'Daily snapshot of public.api_keys with raw key values stripped. key_hash (HMAC-SHA256) + key_prefix + scopes only — see API_KEYS_COLUMN_ALLOWLIST. `name` excluded (potential PII).',
  schema: {
    fields: [
      { name: 'snapshot_date', type: 'DATE', mode: 'REQUIRED' },
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'key_prefix', type: 'STRING', mode: 'NULLABLE', description: 'Public key prefix (e.g. "ak_live_") — safe to mirror' },
      { name: 'key_hash', type: 'STRING', mode: 'NULLABLE', description: 'HMAC-SHA256 hash with API_KEY_HMAC_SECRET — never the raw key' },
      { name: 'scopes', type: 'STRING', mode: 'REPEATED' },
      { name: 'rate_limit_tier', type: 'STRING', mode: 'NULLABLE' },
      { name: 'is_active', type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'expires_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'last_used_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'revoked_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'revocation_reason', type: 'STRING', mode: 'NULLABLE' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  timePartitioning: { type: 'DAY', field: 'snapshot_date' },
  clustering: { fields: ['org_id'] },
};

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export const BQ_TABLES: Readonly<Record<string, BqTableTarget>> = Object.freeze({
  anchors: ANCHORS,
  verifications: VERIFICATIONS,
  audit_events: AUDIT_EVENTS,
  organizations: ORGANIZATIONS,
  api_keys: API_KEYS,
});

/**
 * Allowlist of public.api_keys columns the snapshot job is permitted to source.
 *
 * Adding a column here means it will appear in BQ. Adding a SECRET column here
 * is a SOC 2 / CLAUDE.md §1.4 violation — the build-time test enforces that
 * none of API_KEYS_FORBIDDEN_COLUMNS appear here.
 *
 * If you need a new column, also update the api_keys schema in BQ and run the
 * apply-schemas script. Keep this list and the BQ schema in sync; the test
 * enforces that too.
 */
export const API_KEYS_COLUMN_ALLOWLIST: readonly string[] = Object.freeze([
  'id',
  'org_id',
  'key_prefix',
  'key_hash',
  'scopes',
  'rate_limit_tier',
  'is_active',
  'created_at',
  'expires_at',
  'last_used_at',
  'revoked_at',
  'revocation_reason',
]);

/**
 * Allowlist of public.audit_events columns the incremental sync may source.
 *
 * EXCLUDES actor_email, actor_ip, actor_user_agent (PII per CLAUDE.md §1.4).
 * The incremental sync job (SCRUM-1723) MUST source through this allowlist;
 * the build-time test enforces it.
 */
export const AUDIT_EVENTS_COLUMN_ALLOWLIST: readonly string[] = Object.freeze([
  'id',
  'event_type',
  'event_category',
  'actor_id',
  'target_type',
  'target_id',
  'org_id',
  'details',
  'created_at',
]);

/**
 * audit_events PII columns that must NEVER appear in BQ. Asserted in tests.
 */
export const AUDIT_EVENTS_FORBIDDEN_COLUMNS: readonly string[] = Object.freeze([
  'actor_email',
  'actor_ip',
  'actor_user_agent',
]);

/**
 * Hard deny list: columns that must NEVER appear in BQ for api_keys, no matter
 * what schema drift happens. The test asserts this list intersected with the
 * api_keys BQ schema field names is empty.
 */
export const API_KEYS_FORBIDDEN_COLUMNS: readonly string[] = Object.freeze([
  'key', // the raw key — explicit deny (no such column in source, but defense-in-depth)
  'secret',
  'private_key',
  'token',
  'password',
  'plain_text_key',
  'name', // operators sometimes embed PII-ish labels; safer to exclude
]);
