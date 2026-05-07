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

const AUDIT_EVENTS: BqTableTarget = {
  tableId: 'audit_events',
  mode: 'append',
  description:
    'Append-only mirror of public.audit_events. 7-year partition expiration for SOC 2 evidence retention (DC 200 Criterion #5 Control Environment).',
  schema: {
    fields: [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'actor_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'actor_type', type: 'STRING', mode: 'NULLABLE', description: 'system/user/service_role/api_key/cron' },
      { name: 'category', type: 'STRING', mode: 'NULLABLE', description: 'UPPERCASE per check constraint' },
      { name: 'action', type: 'STRING', mode: 'NULLABLE' },
      { name: 'target_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'target_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'details', type: 'JSON', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'bq_synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  timePartitioning: {
    type: 'DAY',
    field: 'created_at',
    expirationMs: SOC2_AUDIT_RETENTION_MS,
  },
  clustering: { fields: ['org_id', 'actor_type', 'category'] },
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
 * CRITICAL — this schema MUST NOT include any field that could carry the raw
 * key value. Allowed columns are enumerated in API_KEYS_COLUMN_ALLOWLIST below.
 * The snapshot job (SCRUM-1724) MUST source rows via that allowlist; the test
 * `api_keys schema only contains allowlisted columns` enforces this at build
 * time.
 */
const API_KEYS: BqTableTarget = {
  tableId: 'api_keys',
  mode: 'snapshot',
  description:
    'Daily snapshot of public.api_keys with raw key values stripped. Hashed key + key_prefix + scopes only — see API_KEYS_COLUMN_ALLOWLIST.',
  schema: {
    fields: [
      { name: 'snapshot_date', type: 'DATE', mode: 'REQUIRED' },
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'org_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'key_prefix', type: 'STRING', mode: 'NULLABLE', description: 'Public key prefix (ARK-...) — safe to mirror' },
      { name: 'hashed_key', type: 'STRING', mode: 'NULLABLE', description: 'SHA-256 hash of the raw key — never the raw key itself' },
      { name: 'scopes', type: 'STRING', mode: 'REPEATED' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'revoked_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'last_used_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
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
  'hashed_key',
  'scopes',
  'created_at',
  'revoked_at',
  'last_used_at',
]);

/**
 * Hard deny list: columns that must NEVER appear in BQ for api_keys, no matter
 * what schema drift happens. The test asserts this list intersected with the
 * api_keys BQ schema field names is empty.
 */
export const API_KEYS_FORBIDDEN_COLUMNS: readonly string[] = Object.freeze([
  'key', // the raw key — explicit deny
  'secret',
  'private_key',
  'token',
  'password',
  'plain_text_key',
]);
