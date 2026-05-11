/**
 * Thin BigQuery REST API wrapper for the arkova_analytics export jobs.
 *
 * SCRUM-1723 / SCRUM-1724 / SCRUM-1727 (parent SCRUM-1062 GCP-MAX-02).
 *
 * Three operations the export jobs need:
 *   - ensureTable(target):  create the BQ table from the schema if missing
 *   - insertRows(target, rows): tabledata.insertAll streaming insert with
 *     per-row insertId for at-least-once + best-effort dedup
 *   - runQuery(sql, params): DML query (used by snapshot job for partition
 *     replace via DELETE-then-INSERT)
 *
 * No `@google-cloud/bigquery` dependency — uses raw fetch + access token
 * from utils/gcp-auth.ts (avoids SDK churn, follows the established
 * worker convention).
 */

import { logger } from '../utils/logger.js';
import { getGcpAccessToken } from '../utils/gcp-auth.js';

import {
  DATASET_ID,
  DATASET_LOCATION,
  PROJECT_ID,
  type BqTableTarget,
} from './bq-export-schemas.js';

const BQ_API_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

interface BqHttpError extends Error {
  status: number;
  body?: unknown;
}

function bqError(status: number, body: unknown): BqHttpError {
  const err = new Error(`BigQuery API error: ${status}`) as BqHttpError;
  err.status = status;
  err.body = body;
  return err;
}

interface FetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function bqFetch(
  path: string,
  init: FetchInit = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = await getGcpAccessToken();
  const url = `${BQ_API_BASE}${path}`;
  // Bare `fetch` — Node 18+ global. TS error here matches the existing
  // baseline (see services/worker/src/utils/gcp-auth.ts which uses the
  // same pattern); this lib=ES2022 tsconfig doesn't include DOM lib but
  // @types/node provides the runtime symbol.
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Idempotent: GET the table; if 404, create it from the schema. Returns
 * `created` so the caller can log first-time setup.
 */
export async function ensureTable(target: BqTableTarget): Promise<{ created: boolean }> {
  const path = `/projects/${PROJECT_ID}/datasets/${DATASET_ID}/tables/${target.tableId}`;

  const get = await bqFetch(path);
  if (get.ok) return { created: false };
  if (get.status !== 404) {
    throw bqError(get.status, get.body);
  }

  // Create the table from the target spec. Schema fields + time partitioning +
  // clustering all map directly to the BQ REST API table resource shape.
  const createPayload = {
    tableReference: {
      projectId: PROJECT_ID,
      datasetId: DATASET_ID,
      tableId: target.tableId,
    },
    description: target.description,
    schema: { fields: target.schema.fields },
    timePartitioning: {
      type: target.timePartitioning.type,
      field: target.timePartitioning.field,
      ...(target.timePartitioning.expirationMs
        ? { expirationMs: target.timePartitioning.expirationMs }
        : {}),
    },
    ...(target.clustering
      ? { clustering: { fields: [...target.clustering.fields] } }
      : {}),
  };

  const create = await bqFetch(`/projects/${PROJECT_ID}/datasets/${DATASET_ID}/tables`, {
    method: 'POST',
    body: JSON.stringify(createPayload),
  });
  if (!create.ok) {
    throw bqError(create.status, create.body);
  }
  logger.info(
    { tableId: target.tableId, dataset: DATASET_ID, location: DATASET_LOCATION },
    'BQ export: created BigQuery table',
  );
  return { created: true };
}

export interface BqInsertRow {
  /** Source primary key, used as `insertId` for BQ best-effort dedup. */
  insertId: string;
  json: Record<string, unknown>;
}

/**
 * Serialize a value for a BQ JSON-type column.
 *
 * BigQuery's streaming `insertAll` API requires JSON-typed columns to be
 * sent as JSON-encoded *strings*, not raw values. Postgres returns jsonb
 * as deserialized JS values — objects, arrays, but also scalar strings,
 * numbers, and booleans (all valid jsonb). Every non-null value must be
 * stringified, not just objects/arrays.
 *
 * Shared helper so both the incremental sync and backfill jobs stay in
 * sync (SCRUM-1723 live-prod fix, CodeRabbit review 2026-05-09).
 */
export function serializeJsonForBigQuery(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

/**
 * Convert a Postgres row into the BQ `tabledata.insertAll` wire shape.
 *
 * Two invariants this enforces:
 *   1. `insertId = "<table>-<id>"` for at-least-once + best-effort dedup
 *      across the BQ ~1-minute window.
 *   2. Any field whose BQ schema declares `type === 'JSON'` is serialized
 *      via {@link serializeJsonForBigQuery} before insertAll. BigQuery's
 *      streaming API requires JSON-type columns to be sent as JSON-encoded
 *      strings, not nested objects or bare scalars; Postgres returns jsonb
 *      as deserialized JS values, so without this re-stringify the API
 *      rejects rows with `This field: <name> is not a record.`
 *      (SCRUM-1723 live-prod defect 2026-05-09).
 *
 * Lives here in bq-export-client.ts so both the incremental sync job
 * and the one-shot backfill job share the same wire-shaping; SonarCloud
 * was flagging the otherwise-duplicated copies as 45.7% dup density.
 */
export function toBqRow(
  target: BqTableTarget,
  table: string,
  row: Record<string, unknown>,
): BqInsertRow {
  const rawId = row.id;
  if (rawId === null || rawId === undefined || rawId === '') {
    throw new Error(`bq-export: missing id while shaping row for table=${table}`);
  }
  const id = String(rawId);
  const json: Record<string, unknown> = { ...row, bq_synced_at: new Date().toISOString() };
  for (const field of target.schema.fields) {
    if (field.type !== 'JSON') continue;
    json[field.name] = serializeJsonForBigQuery(json[field.name]);
  }
  return { insertId: `${table}-${id}`, json };
}

export interface BqInsertResult {
  insertedCount: number;
  errors: Array<{ index: number; reason: string }>;
}

/**
 * Stream rows into a BQ table. Rows MUST already match the target schema;
 * the caller is responsible for shaping (see incremental/snapshot jobs).
 *
 * Uses `tabledata.insertAll` with `skipInvalidRows: false` so a single bad
 * row aborts the batch — better to surface the issue than silently lose
 * a row. `ignoreUnknownValues: false` for the same reason.
 */
/**
 * Retry on transient BQ failures (5xx, 429). Per BigQuery docs the streaming
 * insert path can return 503 during backend rebalancing; client-side retries
 * with backoff are recommended. Permanent failures (4xx other than 429) are
 * not retried — they're real schema/auth/quota errors that need surfacing.
 *
 * SCRUM-1062 operational hardening: without this, every transient 5xx blip
 * would advance no watermark + emit a Sentry event, noising the consecutive-
 * failure alert on infrastructure flakes that resolve on their own.
 */
const INSERT_ALL_MAX_ATTEMPTS = 3;
const INSERT_ALL_BASE_BACKOFF_MS = 500;

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function bqFetchWithRetry(
  path: string,
  init: FetchInit,
  attempts: number = INSERT_ALL_MAX_ATTEMPTS,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let lastRes: { ok: boolean; status: number; body: unknown } | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await bqFetch(path, init);
    lastRes = res;
    if (res.ok || !isTransientStatus(res.status)) return res;
    if (attempt < attempts - 1) {
      // Exponential backoff with jitter: 500ms, 1s, 2s (+ up to 250ms jitter).
      const backoff = INSERT_ALL_BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(
        { path, status: res.status, attempt: attempt + 1, backoffMs: backoff },
        'BQ transient failure — retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  return lastRes ?? { ok: false, status: 0, body: 'no response' };
}

export async function insertRows(
  target: BqTableTarget,
  rows: readonly BqInsertRow[],
): Promise<BqInsertResult> {
  if (rows.length === 0) return { insertedCount: 0, errors: [] };

  const path = `/projects/${PROJECT_ID}/datasets/${DATASET_ID}/tables/${target.tableId}/insertAll`;
  const payload = {
    kind: 'bigquery#tableDataInsertAllRequest',
    skipInvalidRows: false,
    ignoreUnknownValues: false,
    rows: rows.map((r) => ({ insertId: r.insertId, json: r.json })),
  };

  const res = await bqFetchWithRetry(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw bqError(res.status, res.body);
  }

  // Body shape: { kind, insertErrors?: [{ index, errors: [{ reason, message }] }] }
  const body = (res.body ?? {}) as {
    insertErrors?: Array<{ index: number; errors: Array<{ reason: string; message?: string }> }>;
  };

  const errors = (body.insertErrors ?? []).map((e) => ({
    index: e.index,
    reason: e.errors.map((err) => `${err.reason}${err.message ? `: ${err.message}` : ''}`).join('; '),
  }));

  return {
    insertedCount: rows.length - errors.length,
    errors,
  };
}

/**
 * Run a DML / standard-SQL query (e.g. DELETE WHERE snapshot_date = X for
 * the snapshot job's partition replace). Synchronous response — not for
 * long-running queries.
 *
 * `query` MUST use parameter binding (no string concatenation) to avoid
 * injection (CLAUDE.md §0.2 security review).
 */
export async function runQuery(
  query: string,
  parameters: Array<{ name: string; type: 'STRING' | 'TIMESTAMP' | 'DATE'; value: string }> = [],
): Promise<{ totalRows: number }> {
  const path = `/projects/${PROJECT_ID}/queries`;
  const payload = {
    query,
    useLegacySql: false,
    location: DATASET_LOCATION,
    parameterMode: parameters.length > 0 ? 'NAMED' : 'POSITIONAL',
    queryParameters: parameters.map((p) => ({
      name: p.name,
      parameterType: { type: p.type },
      parameterValue: { value: p.value },
    })),
  };

  const res = await bqFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw bqError(res.status, res.body);
  }

  const body = (res.body ?? {}) as { totalRows?: string; numDmlAffectedRows?: string };
  const totalRows = Number(body.numDmlAffectedRows ?? body.totalRows ?? '0');
  return { totalRows };
}
