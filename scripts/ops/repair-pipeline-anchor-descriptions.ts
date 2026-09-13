#!/usr/bin/env -S npx tsx
/**
 * scripts/ops/repair-pipeline-anchor-descriptions.ts
 *
 * Backfills `anchors.description` for pipeline anchors created before
 * migration `0458` (SCRUM-5120) fixed `public.batch_insert_anchors` silently
 * dropping the caller's `description` field. The text is not lost — it is
 * still sitting in the linked `public_records.metadata` row
 * (`public_records.anchor_id = anchors.id`, `idx_public_records_anchor_id`) —
 * this tool recovers it into `anchors.description` for existing rows. New
 * pipeline anchors created AFTER `0458` land with a description already;
 * this script is a one-time (or occasionally re-run) catch-up, not a
 * standing job.
 *
 * SCOPE (defaults, overridable via flags): `--sources openalex,federal_register`
 * `--since 2026-08-17` — the two pipeline sources and the date the SCRUM-5120
 * defect was first observed live (~40,059 affected rows at authoring time).
 * Text priority matches `services/worker/src/jobs/publicRecordAnchor.ts`'s
 * `publicRecordDescription`: `metadata.abstract`, else `metadata.description`,
 * else `metadata.summary`, first non-empty string wins.
 *
 * CANDIDATE SELECTION uses the existing partial indexes built for exactly
 * this backfill — `idx_anchors_backfill_desc` / `idx_anchors_desc_backfill`
 * (`WHERE description IS NULL AND metadata->>'pipeline_source' IS NOT NULL`)
 * — via a keyset (`id > lastId ORDER BY id LIMIT batchSize`) walk, NEVER
 * `LIMIT`/`OFFSET` pagination (OFFSET re-scans and skips/duplicates rows as
 * the table is concurrently written).
 *
 * REFERENCE SQL — `buildBatchUpdateSql()` below produces the single
 * parameterized statement this operation is semantically equivalent to, run
 * bounded by a 5s lock_timeout inside its own transaction:
 *
 *   SET LOCAL lock_timeout = '5s';
 *   UPDATE anchors a
 *   SET description = left(coalesce(
 *     nullif(pr.metadata->>'abstract', ''),
 *     nullif(pr.metadata->>'description', ''),
 *     nullif(pr.metadata->>'summary', '')
 *   ), 500)
 *   FROM public_records pr
 *   WHERE pr.anchor_id = a.id
 *     AND a.id = ANY($1)
 *     AND a.description IS NULL
 *     AND pr.source = ANY($2)
 *     AND coalesce(
 *       nullif(pr.metadata->>'abstract', ''),
 *       nullif(pr.metadata->>'description', ''),
 *       nullif(pr.metadata->>'summary', '')
 *     ) IS NOT NULL;
 *
 * This codebase has no raw-Postgres-wire-protocol access path anywhere (no
 * `pg`/`postgres` driver dependency exists in this repo, and
 * `services/worker/src/utils/db.ts` — WH-2 — explicitly REJECTS a
 * `postgres://` value handed to `SUPABASE_POOLER_URL`, treating it as a
 * misconfiguration rather than a connection string; `SUPABASE_POOLER_URL` is
 * PgBouncer fronted BY PostgREST, not a wire-protocol endpoint). The two
 * write-capable precedents in `scripts/ops/`/`scripts/staging/` that DO run
 * raw SQL (`ensure-pipeline-dashboard-cache-cron.ts`'s cron/DDL management)
 * go through the Supabase MANAGEMENT API (`api.supabase.com`, a
 * `SUPABASE_ACCESS_TOKEN` personal/org token + project ref) — a different
 * credential than this tool's spec calls for. Per this tool's contract
 * (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` only, matching
 * `scripts/ops/mfa-break-glass.ts` and every other `@supabase/supabase-js`
 * script in this directory), `--apply` executes the REFERENCE SQL's exact
 * semantics through PostgREST instead of through that literal statement:
 * a keyset SELECT of candidate ids, a SELECT of their linked
 * `public_records` rows (bounded, `.in('anchor_id', batchIds)`), then one
 * `.update({ description }).eq('id', id).is('description', null)` per row
 * that needs one — the `.is('description', null)` guard makes each write
 * idempotent and safe against a concurrent writer touching the same row
 * between the SELECT and the UPDATE. Each PostgREST write is already exactly
 * one Postgres statement in its own implicit transaction; what is NOT
 * literally reproduced is the single cross-table `UPDATE ... FROM` shape
 * (PostgREST has no passthrough for that) or the explicit `SET LOCAL
 * lock_timeout` (there is no session to attach it to over REST — each
 * request is its own short-lived statement against an indexed, targeted
 * single-row predicate, which is the actual risk `lock_timeout` guards
 * against, so the exposure this tool carries is materially smaller than an
 * unbounded batch DDL statement). An operator with direct Postgres access
 * (the Supabase MCP `execute_sql` tool against an approved target, or `psql`)
 * MAY run the REFERENCE SQL text verbatim instead, one id-batch at a time —
 * this script does not do that itself, and doing so is NOT covered by this
 * script's own guards.
 *
 * Truncation is surrogate-safe on PURPOSE: `truncateCodePoints()` below
 * truncates by Unicode CODE POINT via `Array.from(text)` (which iterates a
 * string by code point, keeping a UTF-16 surrogate pair together), matching
 * Postgres `left(text, n)` — Postgres `text` is stored/measured in code
 * points, not UTF-16 code units. This is NOT
 * `services/worker/src/utils/utf16-truncate.ts`'s `truncateUtf16Safe`
 * (deliberately not imported here): that helper's contract is UTF-16-CODE-
 * UNIT safety (matching `String.prototype.length`/`.slice()` semantics for
 * the browser/worker's own DB writes), which is a DIFFERENT, narrower
 * guarantee than code-point safety and would not agree with what `left()`
 * does in Postgres for any character outside the Basic Multilingual Plane.
 * Reusing it here would silently reintroduce a units-vs-codepoints mismatch
 * one layer down from the exact bug (`.slice(0,500)` splitting a surrogate
 * pair) this whole area of the codebase already got bitten by once
 * (2026-08-17 poison record, see `publicRecordAnchor.ts`).
 *
 * SAFETY:
 *   - Dry run is the default: counts candidates per batch and prints the
 *     id-range plan (first id, last id, batch count, would-update count).
 *     Calls no UPDATE.
 *   - `--apply` is required to write anything.
 *   - Hard-refuses (exit 1, before any client is constructed) when
 *     `SUPABASE_URL` contains the prod project ref
 *     (`vzwyaatejekddvltxyye`), in BOTH dry-run and apply mode, unless
 *     `--i-know-this-is-prod` is also passed — mirrors
 *     `scripts/staging/provision-isolated-rig.sh`'s prod posture (there it is
 *     an unconditional hard-deny with no override; here an explicit flag
 *     exists because this is a read-mostly, per-row-idempotent repair, not a
 *     provisioning operation, and the PR/task that authorizes a real prod run
 *     is expected to pass it deliberately).
 *   - Never truncates via `.slice()` — see above.
 *   - Never uses `LIMIT`/`OFFSET` for candidate selection — see above.
 *   - Statement-equivalent scope is bounded by `--sources`/`--since` on
 *     BOTH the candidate SELECT and (in the reference SQL) the UPDATE's own
 *     `pr.source = ANY($2)` clause — belt and suspenders, not just an index
 *     hint.
 *
 * THIS SCRIPT MUST NOT BE RUN AGAINST ANY DATABASE OTHER THAN A LOCAL STACK
 * IN DRY-RUN MODE by an agent session. A real `--apply` run against staging
 * or prod is an operator action, authorized and performed separately.
 *
 * Usage (dry run — always first):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/ops/repair-pipeline-anchor-descriptions.ts
 *
 * Usage (apply):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/ops/repair-pipeline-anchor-descriptions.ts --apply
 *
 * Exit codes: 0 done; 1 validation/refusal (nothing written); 2 an API call
 * failed mid-run (see the printed summary for how far it got).
 */
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 1;
export const EXIT_API_FAILURE = 2;

/** The prod Supabase project ref — never a target for `--apply` without the explicit override flag. */
export const PROD_SUPABASE_REF = 'vzwyaatejekddvltxyye';

export const DEFAULT_SOURCES = ['openalex', 'federal_register'] as const;
export const DEFAULT_SINCE = '2026-08-17';
export const DEFAULT_BATCH_SIZE = 1000;
export const DESCRIPTION_MAX_CODEPOINTS = 500;

export interface CliOptions {
  sources: string[];
  since: string;
  apply: boolean;
  maxBatches: number | null;
  batchSize: number;
  allowProd: boolean;
}

/** True when `url` (a SUPABASE_URL value) names the prod project ref. */
export function isProdUrl(url: string): boolean {
  return url.includes(PROD_SUPABASE_REF);
}

/**
 * Truncates `text` to at most `max` UNICODE CODE POINTS — matching Postgres
 * `left(text, max)` — never UTF-16 code units. `Array.from(text)` iterates a
 * string by code point (via its default string iterator), so a surrogate
 * pair is kept or dropped as a whole, unlike `text.slice(0, max)` which
 * indexes by UTF-16 code unit and can split a pair (the exact 2026-08-17
 * poison-record bug in `publicRecordAnchor.ts`, a different call site, that
 * this deliberately does not reintroduce here).
 */
export function truncateCodePoints(text: string, max: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return codePoints.slice(0, max).join('');
}

/**
 * Same source-text priority as `services/worker/src/jobs/publicRecordAnchor.ts`'s
 * `publicRecordDescription`: `abstract`, else `description`, else `summary`,
 * first non-empty string wins. Not imported from there — that function reads
 * a `PipelinePublicRecord`, not a raw `public_records.metadata` object, and
 * duplicating the four-line priority is cheaper and clearer than reshaping
 * this tool's rows to fit an interface built for the worker's own pipeline.
 */
export function computeDescription(metadata: Record<string, unknown> | null | undefined): string | null {
  const meta = metadata ?? {};
  const raw = (typeof meta.abstract === 'string' && meta.abstract !== '' ? meta.abstract : null)
    ?? (typeof meta.description === 'string' && meta.description !== '' ? meta.description : null)
    ?? (typeof meta.summary === 'string' && meta.summary !== '' ? meta.summary : null);
  return raw !== null ? truncateCodePoints(raw, DESCRIPTION_MAX_CODEPOINTS) : null;
}

/**
 * The REFERENCE single-statement SQL this operation is semantically
 * equivalent to — see the file header for why `--apply` does not execute
 * this text directly (no raw-Postgres access path exists for a standalone
 * script in this codebase) and instead performs the PostgREST-equivalent
 * read+per-row-write. Provided so an operator with direct Postgres access
 * can run it by hand, one id-batch at a time, as an alternative execution
 * path this script does not itself take.
 */
export function buildBatchUpdateSql(ids: string[], sources: string[]): { text: string; values: [string[], string[]] } {
  const text = [
    "SET LOCAL lock_timeout = '5s';",
    'UPDATE anchors a',
    "SET description = left(coalesce(",
    "  nullif(pr.metadata->>'abstract', ''),",
    "  nullif(pr.metadata->>'description', ''),",
    "  nullif(pr.metadata->>'summary', '')",
    '), 500)',
    'FROM public_records pr',
    'WHERE pr.anchor_id = a.id',
    '  AND a.id = ANY($1)',
    '  AND a.description IS NULL',
    '  AND pr.source = ANY($2)',
    "  AND coalesce(",
    "    nullif(pr.metadata->>'abstract', ''),",
    "    nullif(pr.metadata->>'description', ''),",
    "    nullif(pr.metadata->>'summary', '')",
    '  ) IS NOT NULL;',
  ].join('\n');
  return { text, values: [ids, sources] };
}

/** The next keyset cursor: the last row's id, or null when the page was empty (walk is done). */
export function nextCursor(rows: Array<{ id: string }>): string | null {
  if (rows.length === 0) return null;
  return rows[rows.length - 1].id;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      sources: { type: 'string' },
      since: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'max-batches': { type: 'string' },
      'batch-size': { type: 'string' },
      'i-know-this-is-prod': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const sources = values.sources
    ? String(values.sources).split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_SOURCES];
  if (sources.length === 0) {
    throw new Error('--sources must not be empty');
  }

  const since = values.since ? String(values.since) : DEFAULT_SINCE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got "${since}"`);
  }

  let maxBatches: number | null = null;
  if (values['max-batches'] !== undefined) {
    const n = Number(values['max-batches']);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--max-batches must be a positive integer, got "${values['max-batches']}"`);
    }
    maxBatches = n;
  }

  let batchSize = DEFAULT_BATCH_SIZE;
  if (values['batch-size'] !== undefined) {
    const n = Number(values['batch-size']);
    if (!Number.isInteger(n) || n <= 0 || n > 5000) {
      throw new Error(`--batch-size must be a positive integer <= 5000, got "${values['batch-size']}"`);
    }
    batchSize = n;
  }

  return {
    sources,
    since,
    apply: values.apply === true,
    maxBatches,
    batchSize,
    allowProd: values['i-know-this-is-prod'] === true,
  };
}

/** Narrow surface this tool needs from Postgres — real wiring is `createSupabaseRepairClient`, tests inject a fake. */
export interface RepairClient {
  /** Keyset page of candidate anchor ids: `description IS NULL`, has a `pipeline_source`, `id > lastId ORDER BY id LIMIT limit`. */
  fetchCandidateIds(lastId: string | null, limit: number): Promise<Array<{ id: string }>>;
  /** The linked `public_records` rows for this id batch, scoped to `sources`/`since`. */
  fetchSourceRows(
    ids: string[],
    sources: string[],
    since: string,
  ): Promise<Array<{ anchor_id: string; metadata: Record<string, unknown> | null }>>;
  /** One targeted, idempotent write: only takes effect if the row's description is still NULL. Returns whether it updated a row. */
  updateDescription(id: string, description: string): Promise<{ updated: boolean }>;
}

export function createSupabaseRepairClient(client: SupabaseClient): RepairClient {
  return {
    async fetchCandidateIds(lastId, limit) {
      let query = client
        .from('anchors')
        .select('id')
        .is('description', null)
        .not('metadata->>pipeline_source', 'is', null)
        .order('id', { ascending: true })
        .limit(limit);
      if (lastId !== null) {
        query = query.gt('id', lastId);
      }
      const { data, error } = await query;
      if (error) throw new Error(`fetchCandidateIds failed: ${error.message}`);
      return (data ?? []) as Array<{ id: string }>;
    },
    async fetchSourceRows(ids, sources, since) {
      const { data, error } = await client
        .from('public_records')
        .select('anchor_id, metadata')
        .in('anchor_id', ids)
        .in('source', sources)
        .gte('created_at', since);
      if (error) throw new Error(`fetchSourceRows failed: ${error.message}`);
      return (data ?? []) as Array<{ anchor_id: string; metadata: Record<string, unknown> | null }>;
    },
    async updateDescription(id, description) {
      const { data, error } = await client
        .from('anchors')
        .update({ description })
        .eq('id', id)
        .is('description', null)
        .select('id');
      if (error) throw new Error(`updateDescription(${id}) failed: ${error.message}`);
      return { updated: (data ?? []).length > 0 };
    },
  };
}

export interface RepairResult {
  batches: number;
  candidatesSeen: number;
  updated: number;
  firstId: string | null;
  lastId: string | null;
}

/**
 * Drives the keyset walk. Logs one line per batch (index, id range, rows
 * updated/would-update, elapsed ms) and stops when a page comes back short
 * (the walk is exhausted) or `--max-batches` is reached. Idempotent by
 * construction: re-running after a partial run only touches rows still
 * `description IS NULL`.
 */
export async function runRepair(
  client: RepairClient,
  options: CliOptions,
  log: (line: string) => void = console.log,
): Promise<RepairResult> {
  let lastId: string | null = null;
  let batchIndex = 0;
  let candidatesSeen = 0;
  let updated = 0;
  let firstId: string | null = null;
  let lastIdSeen: string | null = null;

  for (;;) {
    if (options.maxBatches !== null && batchIndex >= options.maxBatches) break;

    const started = Date.now();
    const candidates = await client.fetchCandidateIds(lastId, options.batchSize);
    if (candidates.length === 0) break;

    const ids = candidates.map((c) => c.id);
    if (firstId === null) firstId = ids[0];
    lastIdSeen = ids[ids.length - 1];
    candidatesSeen += ids.length;

    const sourceRows = await client.fetchSourceRows(ids, options.sources, options.since);
    const byAnchorId = new Map(sourceRows.map((r) => [r.anchor_id, r]));

    let batchUpdated = 0;
    for (const id of ids) {
      const row = byAnchorId.get(id);
      if (!row) continue;
      const description = computeDescription(row.metadata);
      if (description === null) continue;

      if (options.apply) {
        const result = await client.updateDescription(id, description);
        if (result.updated) batchUpdated += 1;
      } else {
        batchUpdated += 1; // dry-run: count what WOULD be updated
      }
    }
    updated += batchUpdated;

    const elapsedMs = Date.now() - started;
    log(
      `batch ${batchIndex}: ids ${ids[0]}..${ids[ids.length - 1]} ` +
      `candidates=${ids.length} ${options.apply ? 'updated' : 'would_update'}=${batchUpdated} ` +
      `elapsed_ms=${elapsedMs}${options.apply ? '' : ' (dry-run — no writes)'}`,
    );

    batchIndex += 1;
    lastId = ids[ids.length - 1];
    if (candidates.length < options.batchSize) break; // short page — walk is exhausted
  }

  log(
    `summary: batches=${batchIndex} candidates_seen=${candidatesSeen} ` +
    `${options.apply ? 'updated' : 'would_update'}=${updated} ` +
    `id_range=${firstId ?? '(none)'}..${lastIdSeen ?? '(none)'}`,
  );

  return { batches: batchIndex, candidatesSeen, updated, firstId, lastId: lastIdSeen };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(resolvePath(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_VALIDATION;
  }

  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = requireEnv('SUPABASE_URL');
    serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_VALIDATION;
  }

  if (isProdUrl(supabaseUrl) && !options.allowProd) {
    console.error(
      `error: SUPABASE_URL names the prod project ref (${PROD_SUPABASE_REF}). ` +
      'Pass --i-know-this-is-prod to proceed deliberately, dry-run or apply.',
    );
    return EXIT_VALIDATION;
  }

  console.log(
    `repair-pipeline-anchor-descriptions: sources=${options.sources.join(',')} since=${options.since} ` +
    `batch_size=${options.batchSize} mode=${options.apply ? 'APPLY' : 'DRY-RUN'}` +
    `${options.maxBatches !== null ? ` max_batches=${options.maxBatches}` : ''}`,
  );

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const client = createSupabaseRepairClient(supabase);

  try {
    await runRepair(client, options);
    return EXIT_SUCCESS;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_API_FAILURE;
  }
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(e);
    process.exitCode = EXIT_API_FAILURE;
  });
}
