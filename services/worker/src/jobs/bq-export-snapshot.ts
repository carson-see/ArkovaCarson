/**
 * Snapshot sync job — daily full-replace per partition_date.
 *
 * SCRUM-1724 (parent SCRUM-1062 GCP-MAX-02). Runs on a 02:00 UTC daily
 * cron via Cloud Scheduler hitting POST /jobs/bq-export-snapshot.
 *
 * For each of (organizations, api_keys):
 *   1. Mark run started
 *   2. Compute snapshot_date = today (UTC)
 *   3. DELETE FROM <table> WHERE snapshot_date = @date  (idempotency
 *      for re-runs same day)
 *   4. SELECT source columns (allowlist-restricted for api_keys —
 *      raw `key`/`name` NEVER touched)
 *   5. insertAll with snapshot_date stamped on each row
 *   6. Mark run succeeded (last_synced_at = snapshot_date midnight)
 *
 * api_keys is the load-bearing PII guard: SELECT uses
 * API_KEYS_COLUMN_ALLOWLIST, never `*` and never the raw `key` column.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';

import {
  ensureTable,
  insertRows,
  runQuery,
  serializeJsonForBigQuery,
  type BqInsertRow,
} from './bq-export-client.js';
import {
  API_KEYS_COLUMN_ALLOWLIST,
  API_KEYS_FORBIDDEN_COLUMNS,
  BQ_TABLES,
} from './bq-export-schemas.js';
import {
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
  type BqExportTableName,
} from './bq-export-watermark.js';

const SNAPSHOT_TABLES: BqExportTableName[] = ['organizations', 'api_keys'];

const ORGANIZATIONS_SELECT = [
  'id',
  'legal_name',
  'display_name',
  'org_prefix',
  'tier',
  'parent_org_id',
  'payment_state',
  'verified_badge_granted_at',
  'created_at',
  'updated_at',
] as const;

export interface SnapshotRunResult {
  table: BqExportTableName;
  snapshotDate: string;
  rowsInserted: number;
  errors: number;
}

function utcDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Hard guard: assert no forbidden api_keys column slipped into the
 * select list at build/runtime. The TS schema test enforces this at
 * build time; this runtime check is defense-in-depth in case the
 * allowlist export was tampered with after build.
 */
function assertNoApiKeysPiiLeak(columns: readonly string[]): void {
  const forbidden = columns.filter((c) => API_KEYS_FORBIDDEN_COLUMNS.includes(c));
  if (forbidden.length > 0) {
    throw new Error(
      `api_keys snapshot: forbidden PII column(s) in select list: ${forbidden.join(', ')}. ` +
        'This must NEVER happen — see CLAUDE.md §1.4 + SOC 2 DC 200.',
    );
  }
}

async function runOrganizations(snapshotDate: string): Promise<SnapshotRunResult> {
  const target = BQ_TABLES.organizations;
  await ensureTable(target);
  await markRunStarted('organizations');

  // Idempotent partition replace
  await runQuery(
    `DELETE FROM \`arkova1.arkova_analytics.organizations\` WHERE snapshot_date = @snap`,
    [{ name: 'snap', type: 'DATE', value: snapshotDate }],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organizations')
    .select(ORGANIZATIONS_SELECT.join(', '));

  if (error) {
    await markRunFailed('organizations', `source query failed: ${error.message}`);
    throw new Error(`snapshot: organizations source query failed: ${error.message}`);
  }

  const rows = (data as Record<string, unknown>[] | null) ?? [];
  const bqRows: BqInsertRow[] = rows.map((r) => buildSnapshotRow(target, 'org', snapshotDate, r));

  const insertResult = await insertRows(target, bqRows);

  if (insertResult.errors.length > 0) {
    const reasons = insertResult.errors.slice(0, 5).map((e) => `idx=${e.index}: ${e.reason}`).join(' | ');
    await markRunFailed('organizations', `BQ insertAll errors: ${insertResult.errors.length}; first: ${reasons}`);
    throw new Error(`snapshot organizations: ${insertResult.errors.length} insert errors`);
  }

  const newWatermark = `${snapshotDate}T00:00:00Z`;
  await markRunSucceeded({ tableName: 'organizations', newWatermark, newLastId: null });

  return { table: 'organizations', snapshotDate, rowsInserted: insertResult.insertedCount, errors: 0 };
}

/**
 * Snapshot-shaped wire row. Different from the shared `toBqRow` because:
 *   - Snapshot tables use `<prefix>-<snapshotDate>-<id>` for insertId so a
 *     re-run within the same day deduplicates per row (vs prefix-id only).
 *   - Snapshot tables inject `snapshot_date` into the json payload.
 *
 * Schema-aware: JSON-typed fields are stringified via the shared
 * `serializeJsonForBigQuery` helper (SCRUM-1723 live-prod fix). Currently no
 * snapshot table declares a JSON-type field, but this guard keeps the
 * snapshot path safe if one is ever added.
 */
function buildSnapshotRow(
  target: BqTableTarget,
  insertIdPrefix: 'org' | 'key',
  snapshotDate: string,
  row: Record<string, unknown>,
): BqInsertRow {
  const json: Record<string, unknown> = {
    ...row,
    snapshot_date: snapshotDate,
    bq_synced_at: new Date().toISOString(),
  };
  for (const field of target.schema.fields) {
    if (field.type !== 'JSON') continue;
    json[field.name] = serializeJsonForBigQuery(json[field.name]);
  }
  return { insertId: `${insertIdPrefix}-${snapshotDate}-${String(row.id)}`, json };
}

async function runApiKeys(snapshotDate: string): Promise<SnapshotRunResult> {
  const target = BQ_TABLES.api_keys;
  await ensureTable(target);
  await markRunStarted('api_keys');

  // Defense in depth — runtime check that the allowlist hasn't been tampered.
  assertNoApiKeysPiiLeak(API_KEYS_COLUMN_ALLOWLIST);

  await runQuery(
    `DELETE FROM \`arkova1.arkova_analytics.api_keys\` WHERE snapshot_date = @snap`,
    [{ name: 'snap', type: 'DATE', value: snapshotDate }],
  );

  // Cross-tenant by design — the snapshot job mirrors EVERY org's api_keys
  // (with raw key + name excluded) into the BQ warehouse. The arkova/
  // missing-org-filter eslint rule is intended for per-tenant operational
  // queries; SOC 2 evidence aggregation is the documented exception.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter
  const { data, error } = await (db as any)
    .from('api_keys')
    .select(API_KEYS_COLUMN_ALLOWLIST.join(', '));

  if (error) {
    await markRunFailed('api_keys', `source query failed: ${error.message}`);
    throw new Error(`snapshot: api_keys source query failed: ${error.message}`);
  }

  const rows = (data as Record<string, unknown>[] | null) ?? [];
  const bqRows: BqInsertRow[] = rows.map((r) => buildSnapshotRow(target, 'key', snapshotDate, r));

  const insertResult = await insertRows(target, bqRows);

  if (insertResult.errors.length > 0) {
    const reasons = insertResult.errors.slice(0, 5).map((e) => `idx=${e.index}: ${e.reason}`).join(' | ');
    await markRunFailed('api_keys', `BQ insertAll errors: ${insertResult.errors.length}; first: ${reasons}`);
    throw new Error(`snapshot api_keys: ${insertResult.errors.length} insert errors`);
  }

  const newWatermark = `${snapshotDate}T00:00:00Z`;
  await markRunSucceeded({ tableName: 'api_keys', newWatermark, newLastId: null });

  return { table: 'api_keys', snapshotDate, rowsInserted: insertResult.insertedCount, errors: 0 };
}

/**
 * Entry point — called by the /jobs/bq-export-snapshot HTTP route.
 */
export async function runSnapshot(snapshotDate: string = utcDateToday()): Promise<SnapshotRunResult[]> {
  const results: SnapshotRunResult[] = [];
  for (const table of SNAPSHOT_TABLES) {
    try {
      const r = table === 'organizations'
        ? await runOrganizations(snapshotDate)
        : await runApiKeys(snapshotDate);
      results.push(r);
      logger.info(
        { table, snapshotDate, rowsInserted: r.rowsInserted },
        'BQ export: snapshot sync succeeded',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ table, snapshotDate, err: msg }, 'BQ export: snapshot sync failed');
      // SCRUM-1062 AC: emit Sentry events on snapshot failures so the
      // alert rule can fire on consecutive-failures.
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: { job: 'bq-export-snapshot', table, subsystem: 'bq-export' },
        extra: { snapshotDate },
      });
      results.push({ table, snapshotDate, rowsInserted: 0, errors: 1 });
    }
  }
  return results;
}

export const __testing = {
  runOrganizations,
  runApiKeys,
  utcDateToday,
  assertNoApiKeysPiiLeak,
  ORGANIZATIONS_SELECT,
  SNAPSHOT_TABLES,
};
