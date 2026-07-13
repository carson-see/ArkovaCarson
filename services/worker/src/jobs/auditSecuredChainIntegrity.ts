/**
 * SECURED-chain-integrity back-catalogue AUDIT (SCRUM-2486 AC-2, Lane 1).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A STRICTLY READ-ONLY audit of the existing anchor back-catalogue (~2.97M
 * SECURED rows as of 2026-07) for the SECURED-chain-integrity invariant:
 *
 *   Every `anchors.status = 'SECURED'` row MUST have:
 *     - a non-null, non-blank `chain_tx_id`  (a network receipt exists), AND
 *     - a 64-hex `fingerprint`               (matches the char(64) column +
 *                                              `anchors_fingerprint_format` CHECK
 *                                              `^[A-Fa-f0-9]{64}$`), AND
 *     - WHERE `chain_block_height` is populated, a POSITIVE height
 *       (nullable by design — a legacy / very-recently-confirmed row may not yet
 *        carry a height; that is NOT a violation, a present-but-<=0 height IS).
 *
 * This mirrors the worker-enforced reality: the ONLY producer of SECURED status
 * is the confirmation poller (`check-confirmations.ts`, service_role), which
 * always co-writes `chain_tx_id` + `chain_block_height` + `chain_block_hash`, and
 * the DB `anchors_chain_data_consistency` CHECK already forbids
 * `status='SECURED' AND chain_tx_id IS NULL`. This audit is the belt-and-braces
 * READ-side proof that the invariant holds across the whole historical corpus,
 * catching any row that pre-dates a constraint or slipped in via a
 * constraint-bypassing path.
 *
 * ── HARD SAFETY GUARANTEES (SCRUM-2486 AC-2) ─────────────────────────────────
 *   - NEVER writes, mutates, inserts, upserts, deletes, backfills, or repairs.
 *     There is NO execute path, NO `--execute` flag, NO env-gated write. It only
 *     SELECTs and REPORTS. (The fake client in the test throws if any mutating
 *     method is called — a self-enforcing contract.)
 *   - NEVER fabricates chain data. Offending rows are TALLIED + SAMPLED (bounded
 *     id list) and surfaced in the summary for a human/RTE to investigate. The
 *     audit forms NO opinion on how to fix them.
 *   - Cursor-paginated (created_at, ascending) + resumable, so it scales to the
 *     full back-catalogue without an unbounded result set. A read error THROWS
 *     (fail-loud) rather than silently reporting a clean corpus.
 *
 * ── HOW IT'S RUN ─────────────────────────────────────────────────────────────
 * `runSecuredChainIntegrityAudit(deps)` is a pure library taking an injected
 * Supabase client + logger (so unit tests never touch prod config / real DB).
 * The operator CLI wrapper is `services/worker/scripts/audit-secured-chain-integrity.ts`,
 * which resolves the service-role client from Secret Manager and prints the JSON
 * summary. Read-only ⇒ safe to run against prod at any time.
 *
 * Constitution refs: §1.4 (service_role read; the SECURED write itself stays
 * worker-only), §1.5 (evidence: reports what IS measured, asserts nothing about
 * remediation), §1.6/§1.6A (no document bytes — only ids + chain metadata flow).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Minimal logger surface (matches the worker `logger`). */
export interface AuditLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * The subset of an `anchors` row the audit reads. Column names verified against
 * the baseline migration `anchors` DDL: `fingerprint` char(64) NOT NULL,
 * `chain_tx_id` text NULL, `chain_block_height` bigint NULL, `status`
 * anchor_status, `public_id` text NULL, `created_at` timestamptz NOT NULL.
 */
export interface SecuredAnchorAuditRow {
  id: string;
  public_id: string | null;
  status: string;
  fingerprint: string | null;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  created_at: string;
}

/** The distinct invariant-violation kinds this audit reports. */
export type ViolationType = 'missing_chain_tx_id' | 'bad_fingerprint' | 'bad_block_height';

const ALL_VIOLATION_TYPES: readonly ViolationType[] = [
  'missing_chain_tx_id',
  'bad_fingerprint',
  'bad_block_height',
] as const;

export interface RowClassification {
  ok: boolean;
  violations: ViolationType[];
}

/** Matches the DB `anchors_fingerprint_format` CHECK: exactly 64 hex chars, any case. */
const FINGERPRINT_RE = /^[A-Fa-f0-9]{64}$/;

/** Default rows fetched per page. Bounded so one pass never loads the corpus. */
export const DEFAULT_BATCH_SIZE = 1_000;
// Floor of 1 (not 50): a read-only audit has no write cost, so a small page is
// harmless, and staged rehearsals/tests exercise multi-page pagination with a
// tiny batchSize. The MAX cap is what actually protects against unbounded reads.
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 10_000;

/** Default cap on sampled offending ids retained in the summary. */
export const DEFAULT_SAMPLE_LIMIT = 100;

/** The pre-Unix-epoch sentinel cursor: strictly less than any real created_at. */
const EPOCH_CURSOR = '0001-01-01T00:00:00.000Z';

/**
 * Pure invariant check for a single SECURED anchor row. No I/O. Returns every
 * violation found (a row can violate more than one clause).
 */
export function classifyAnchorRow(row: SecuredAnchorAuditRow): RowClassification {
  const violations: ViolationType[] = [];

  // 1. chain_tx_id must be a present, non-blank string.
  if (row.chain_tx_id === null || row.chain_tx_id === undefined || row.chain_tx_id.trim() === '') {
    violations.push('missing_chain_tx_id');
  }

  // 2. fingerprint must be 64-hex (matches char(64) + format CHECK).
  if (typeof row.fingerprint !== 'string' || !FINGERPRINT_RE.test(row.fingerprint)) {
    violations.push('bad_fingerprint');
  }

  // 3. chain_block_height is OPTIONAL (nullable), but if present must be > 0.
  if (row.chain_block_height !== null && row.chain_block_height !== undefined) {
    if (!Number.isFinite(row.chain_block_height) || row.chain_block_height <= 0) {
      violations.push('bad_block_height');
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface RunAuditOptions {
  client: SupabaseClient;
  logger: AuditLogger;
  /** Rows per page (clamped to [50, 10000]). */
  batchSize?: number;
  /** Max offending ids retained in the summary (default 100). */
  sampleLimit?: number;
  /** Resume cursor (exclusive lower bound on created_at). */
  startAfterCreatedAt?: string;
  /** Optional hard cap on pages (testing / staged rehearsal). */
  maxBatches?: number;
}

export interface AuditSummary {
  /** True iff every scanned SECURED row satisfied the invariant. */
  clean: boolean;
  /** Total SECURED rows scanned. */
  securedScanned: number;
  /** Total rows with >=1 violation. */
  violations: number;
  /** Per-type tally (a row can contribute to more than one). */
  violationsByType: Record<ViolationType, number>;
  /** Bounded sample of offending anchor ids (for human follow-up). */
  sampleOffendingIds: string[];
  /** Number of pages read (includes the final short/empty terminating page). */
  batchesScanned: number;
  /** created_at of the last scanned row, for a resumable follow-up run. */
  finalCursor: string | null;
}

function clampBatchSize(requested: number | undefined): number {
  const n = requested ?? DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.floor(n), MIN_BATCH_SIZE), MAX_BATCH_SIZE);
}

/**
 * Scan the SECURED back-catalogue read-only and return a structured summary of
 * invariant violations. Throws on a DB read error (fail-loud — never reports a
 * false-clean corpus).
 */
export async function runSecuredChainIntegrityAudit(
  opts: RunAuditOptions,
): Promise<AuditSummary> {
  const { client, logger } = opts;
  const batchSize = clampBatchSize(opts.batchSize);
  const sampleLimit = Math.max(0, Math.floor(opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT));

  const violationsByType: Record<ViolationType, number> = {
    missing_chain_tx_id: 0,
    bad_fingerprint: 0,
    bad_block_height: 0,
  };
  const sampleOffendingIds: string[] = [];

  let cursor = opts.startAfterCreatedAt ?? EPOCH_CURSOR;
  let securedScanned = 0;
  let violations = 0;
  let batchesScanned = 0;
  let finalCursor: string | null = null;

  logger.info(
    { batchSize, sampleLimit, startAfterCreatedAt: cursor },
    'SECURED-chain-integrity audit: starting read-only scan',
  );

  for (;;) {
    if (opts.maxBatches !== undefined && batchesScanned >= opts.maxBatches) {
      logger.warn({ batchesScanned }, 'SECURED-chain-integrity audit: maxBatches cap reached');
      break;
    }

    const { data, error } = await client
      .from('anchors')
      .select('id, public_id, status, fingerprint, chain_tx_id, chain_block_height, created_at')
      .eq('status', 'SECURED')
      .gt('created_at', cursor)
      .order('created_at', { ascending: true })
      .limit(batchSize);

    batchesScanned += 1;

    if (error) {
      const message = (error as { message?: string }).message ?? 'unknown DB error';
      logger.error({ error, cursor }, 'SECURED-chain-integrity audit: read failed');
      throw new Error(`SECURED-chain-integrity audit read failed: ${message}`);
    }

    const rows = (data ?? []) as SecuredAnchorAuditRow[];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      securedScanned += 1;
      finalCursor = row.created_at;

      const { ok, violations: rowViolations } = classifyAnchorRow(row);
      if (!ok) {
        violations += 1;
        for (const v of rowViolations) {
          violationsByType[v] += 1;
        }
        if (sampleOffendingIds.length < sampleLimit) {
          sampleOffendingIds.push(row.id);
        }
      }
    }

    // Advance the cursor to the last row's created_at. A short page (< batchSize)
    // means we've reached the tail; loop once more to hit the empty terminating
    // page (keeps the terminate-condition in exactly one place).
    cursor = rows[rows.length - 1].created_at;
  }

  const clean = violations === 0;

  const summary: AuditSummary = {
    clean,
    securedScanned,
    violations,
    violationsByType,
    sampleOffendingIds,
    batchesScanned,
    finalCursor,
  };

  const logPayload = { ...summary };
  if (clean) {
    logger.info(logPayload, 'SECURED-chain-integrity audit: CLEAN — invariant holds');
  } else {
    logger.error(
      logPayload,
      `SECURED-chain-integrity audit: ${violations} violation(s) across ${ALL_VIOLATION_TYPES.length} check(s) — REPORT ONLY, no rows mutated`,
    );
  }

  return summary;
}
