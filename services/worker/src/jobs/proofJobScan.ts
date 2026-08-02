/**
 * Shared read-only scan/probe primitives for the proof back-catalog jobs
 * (proof-backcatalog-classifier, proof-materializer).
 *
 * Both jobs walk `anchors` the same way — keyset-paged SECURED rows, chunked
 * `anchor_proofs` lookups, and LIMIT-2 tx cardinality probes. The code was
 * copy-pasted when the materializer landed and SonarCloud flagged it as
 * duplicated new code; it lives here once, parameterised only by the label
 * that appears in error/warning text.
 *
 * READ-ONLY BY CONSTRUCTION: nothing here writes. Both jobs keep their own
 * write paths so one job can never accidentally execute the other's mutations.
 *
 * The `db` shape is deliberately narrow and structural (not the generated
 * SupabaseClient) so the jobs' hand-rolled test doubles satisfy it unchanged.
 */

import { runWithConcurrency } from '../utils/concurrency.js';
import { chunkForInFilter } from './anchor-batching.js';

/**
 * Cardinality probes fetch at most 2 ids. Classification only ever needs
 * 0 / 1 / ≥2, and 2 stands for "≥2" — so an exact count would be a pointless
 * full scan of the hot anchors table (R0-8 / SCRUM-1254).
 */
export const CARDINALITY_PROBE_LIMIT = 2;

/** Parallel cardinality probes per page. */
export const CARDINALITY_CONCURRENCY = 8;

/** The anchors columns both jobs' classification reads (nothing more). */
export interface ScanAnchorRow {
  id: string;
  org_id: string | null;
  fingerprint: string;
  chain_tx_id: string | null;
}

/** The anchor_proofs columns both jobs' classification reads (nothing more). */
export interface ScanProofRow {
  anchor_id: string;
  merkle_root: string | null;
  proof_path: unknown;
  batch_id: string | null;
  proof_completeness_class: string | null;
}

export interface ScanLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/** The minimum read surface the scan helpers touch. */
export interface ScanDb {
  from(table: string): {
    select(cols: string): unknown;
  };
}

/**
 * Clamp a caller-supplied bound into [min, max], falling back to `fallback`
 * for undefined / non-finite input. Both jobs bound page size and batches per
 * invocation this way; only the constants differ.
 */
export function clampBound(
  requested: number | undefined,
  bounds: { fallback: number; min: number; max: number },
): number {
  const n = requested ?? bounds.fallback;
  if (!Number.isFinite(n)) return bounds.fallback;
  return Math.min(Math.max(Math.floor(n), bounds.min), bounds.max);
}

/**
 * Generic list splitter for REQUEST-BODY batches (RPC payloads, insert rows).
 *
 * NOT for PostgREST `.in()` filters — those go through `chunkForInFilter`
 * (`anchor-batching.ts`), which bounds by encoded URL bytes rather than by a
 * caller-chosen count. Reaching for a count constant here is the mistake that
 * cost 70 hours of public-record anchoring.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Keyset page of SECURED, non-soft-deleted anchors, ordered by id. */
export async function fetchScanPage(
  db: ScanDb,
  opts: { orgId?: string; cursor: string | null; batchSize: number },
  label: string,
): Promise<ScanAnchorRow[]> {
  // Chained shape kept explicit so the narrow test doubles can mirror it.
  let q = (
    db.from('anchors').select('id, org_id, fingerprint, chain_tx_id') as {
      eq(col: string, val: unknown): unknown;
    }
  ).eq('status', 'SECURED') as {
    is(col: string, val: unknown): typeof q;
    eq(col: string, val: unknown): typeof q;
    gt(col: string, val: unknown): typeof q;
    order(col: string, o: { ascending: boolean }): typeof q;
    limit(
      n: number,
    ): PromiseLike<{ data: ScanAnchorRow[] | null; error: { message?: string } | null }>;
  };
  q = q.is('deleted_at', null);
  if (opts.orgId) q = q.eq('org_id', opts.orgId);
  if (opts.cursor) q = q.gt('id', opts.cursor);
  const { data, error } = await q.order('id', { ascending: true }).limit(opts.batchSize);
  if (error) {
    throw new Error(
      `${label} scan query failed at cursor=${opts.cursor ?? '<start>'}: ${error.message ?? 'unknown'}`,
    );
  }
  return data ?? [];
}

/** anchor_proofs rows for the given anchor ids, chunked to bound the query string. */
export async function fetchProofRows(
  db: ScanDb,
  anchorIds: string[],
  label: string,
): Promise<Map<string, ScanProofRow>> {
  const map = new Map<string, ScanProofRow>();
  for (const { values: ids } of chunkForInFilter(anchorIds)) {
    const { data, error } = await (db
      .from('anchor_proofs')
      .select('anchor_id, merkle_root, proof_path, batch_id, proof_completeness_class') as unknown as {
      in(col: string, vals: string[]): PromiseLike<{
        data: ScanProofRow[] | null;
        error: { message?: string } | null;
      }>;
    }).in('anchor_id', ids);
    if (error) {
      throw new Error(`${label} proof-row query failed: ${error.message ?? 'unknown'}`);
    }
    for (const row of data ?? []) map.set(row.anchor_id, row);
  }
  return map;
}

/**
 * Resolve tx cardinality (live anchors sharing the tx, CAPPED at
 * CARDINALITY_PROBE_LIMIT) for each distinct tx, memoized across the whole
 * invocation. DELIBERATELY GLOBAL — no org filter: a tx shared with another
 * org's anchor is still a batch tx. Uses the partial index
 * idx_anchors_chain_tx_id via LIMIT-2 id probes, NOT exact-count head-counts
 * (R0-8 / SCRUM-1254). A probe failure marks that tx 'unknown' → the affected
 * rows classify AMBIGUOUS (fail-closed).
 */
export async function resolveCardinalities(
  db: ScanDb,
  txIds: string[],
  memo: Map<string, number | null>,
  logger: ScanLogger,
  jobName: string,
): Promise<void> {
  const unresolved = [...new Set(txIds)].filter((tx) => !memo.has(tx));
  if (unresolved.length === 0) return;

  const tasks = unresolved.map((tx) => async () => {
    const { data, error } = await (
      db.from('anchors').select('id') as unknown as {
        eq(col: string, val: unknown): {
          is(col: string, val: unknown): {
            limit(n: number): PromiseLike<{
              data: Array<{ id: string }> | null;
              error: { message?: string } | null;
            }>;
          };
        };
      }
    )
      .eq('chain_tx_id', tx)
      .is('deleted_at', null)
      .limit(CARDINALITY_PROBE_LIMIT);
    if (error || !data) {
      logger.warn(
        { tx, error: error?.message ?? 'null rows' },
        `${jobName}: cardinality probe failed — rows on this tx will classify AMBIGUOUS`,
      );
      memo.set(tx, null);
      return;
    }
    // data.length is 0, 1, or 2 — 2 stands for "≥2", which is everything
    // classifyAnchor ever distinguishes (<1 ⇒ ambiguous, 1 ⇒ direct, >1 ⇒ shared).
    memo.set(tx, data.length);
  });

  await runWithConcurrency(tasks, CARDINALITY_CONCURRENCY);
}
