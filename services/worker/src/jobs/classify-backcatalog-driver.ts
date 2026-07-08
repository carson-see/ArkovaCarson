/**
 * Targeted soak driver — proof-backcatalog classifier (#1410 / #1427).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The classify-proof-backcatalog job (`/jobs|/cron/classify-proof-backcatalog`)
 * walks the ~2.97M SECURED back-catalogue and CENSUSES each anchor_proofs row
 * into a proof-completeness class (fully-proven / header-missing /
 * index-unreconstructable) so the fleet knows what fraction of the 2.97M can be
 * made proof-complete vs is blocked on SCRUM-2471. It is a long, resumable,
 * per-org-scoped pass gated behind a Postgres GUC and serialized by an advisory
 * mutex. The failed soak fleet ran generic mixed HTTP load that NEVER drove any
 * of the four behaviors that can actually corrupt a census:
 *
 *   1. CENSUS correctness      — every scanned row lands in exactly one class;
 *                                the tallies sum to rows scanned.
 *   2. RESUME / CHECKPOINT     — a mid-pass crash resumes from the last saved
 *                                checkpoint with NO double-count and NO skipped
 *                                rows (idempotent over the cursor).
 *   3. CONCURRENCY MUTEX       — two overlapping passes must NOT both run; the
 *                                second no-ops (mutex held) rather than
 *                                double-censusing the same rows.
 *   4. GUC GUARD               — the pass is inert unless the enabling GUC is
 *                                set; a fresh env with the GUC unset censuses
 *                                ZERO rows (never a silent partial run).
 *   5. PER-ORG SCOPING         — an org-scoped run touches ONLY that org's rows;
 *                                cross-org rows are never counted into its census.
 *
 * This module is the REUSABLE behavioral FOUNDATION for those five invariants.
 * It defines the classifier's pure `classifyRow` census function plus a
 * deterministic in-memory `BackcatalogStore` that reimplements the EXACT
 * contract semantics (GUC gate, advisory mutex, checkpoint persistence, org
 * scoping) the SQL/worker classifier must honour — mirroring how #1463's
 * batch-drain harness reimplements claim/submit/recover SQL in memory. Any real
 * classifier wired to `/jobs/classify-proof-backcatalog` must satisfy the same
 * invariants; the rig harness (classify-backcatalog-harness.ts) drives them
 * over HTTP against an isolated rig.
 *
 * NO rig, NO network, NO spend, NO real DB — pure + unit-testable (§1.7).
 * §1.12 T3 (data-integrity census over the 2.97M back-catalogue).
 */

// ─── Census classification ──────────────────────────────────────────────────

/**
 * Mutually-exclusive proof-completeness classes for a back-catalogue
 * anchor_proofs row. Mirrors backfillProofCompleteness.ts reconstructability:
 *   - `fully_proven`          : all completeness columns present (or fully
 *     reconstructable) — 0340 trigger would accept it.
 *   - `header_missing`        : app-tree branch present but bitcoin-tree
 *     confirmation evidence (block_header/block_hash) not yet populated —
 *     reconstructable via chain fetch (the confirmation-proof populate path).
 *   - `index_unreconstructable`: merkle_index/branch is gone (SCRUM-2471:
 *     tree.proofs discarded) — can NEVER be made proof-complete by backfill.
 *   - `no_app_tree`           : merkle_root itself is missing — not even the
 *     app-tree branch was written (a pre-FIX-1 anchor); nothing to census yet.
 */
export type ProofClass =
  | 'fully_proven'
  | 'header_missing'
  | 'index_unreconstructable'
  | 'no_app_tree';

/** One back-catalogue row the census reads. */
export interface BackcatalogRow {
  anchorId: string;
  orgId: string;
  merkleRoot: string | null;
  blockHeader: string | Buffer | null;
  blockHash: string | null;
  merkleIndex: number | null;
  /** Stable ordering key for the resumable cursor (e.g. anchor_proofs.created_at). */
  createdAt: string;
}

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/**
 * Census one row into exactly one {@link ProofClass}. Pure. The precedence
 * matters: an anchor with NO merkle_root is `no_app_tree` regardless of other
 * columns; a merkle_index-gone row is `index_unreconstructable` even if the
 * header is present (it can never be fully proof-complete); a header-missing row
 * is recoverable; everything else is fully proven.
 */
export function classifyRow(row: BackcatalogRow): ProofClass {
  if (!isFilled(row.merkleRoot)) return 'no_app_tree';
  if (!isFilled(row.merkleIndex)) return 'index_unreconstructable';
  if (!isFilled(row.blockHeader) || !isFilled(row.blockHash)) return 'header_missing';
  return 'fully_proven';
}

/** A per-class tally. Every field is a non-negative row count. */
export interface Census {
  fully_proven: number;
  header_missing: number;
  index_unreconstructable: number;
  no_app_tree: number;
}

export function emptyCensus(): Census {
  return { fully_proven: 0, header_missing: 0, index_unreconstructable: 0, no_app_tree: 0 };
}

export function censusTotal(c: Census): number {
  return c.fully_proven + c.header_missing + c.index_unreconstructable + c.no_app_tree;
}

export function addToCensus(c: Census, klass: ProofClass): void {
  c[klass] += 1;
}

// ─── In-memory contract store (reimplements the SQL/worker semantics) ────────

/** Persisted checkpoint: the cursor + accumulated census for a (job, org) scope. */
export interface Checkpoint {
  scopeKey: string;
  cursor: string;
  census: Census;
  rowsScanned: number;
  done: boolean;
}

/** The GUC that gates the classifier. Unset/false ⇒ the pass censuses ZERO rows. */
export const CLASSIFY_GUC = 'arkova.classify_proof_backcatalog_enabled';
/** Advisory-lock key the classifier serializes on (one pass at a time). */
export const CLASSIFY_MUTEX_KEY = 'classify_proof_backcatalog';

export interface BackcatalogStoreConfig {
  rows: BackcatalogRow[];
  /** Value of {@link CLASSIFY_GUC}; when not 'on'/'true' the classifier is inert. */
  guc?: string;
}

/**
 * Deterministic store standing in for Postgres. Reimplements EXACTLY the
 * contract the real classifier depends on: GUC read, advisory-lock acquire/
 * release, ordered cursor scan (optionally org-scoped), and checkpoint
 * persistence. No timers, no async I/O races — purely synchronous state a test
 * can drive step by step.
 */
export class BackcatalogStore {
  private readonly rows: BackcatalogRow[];
  private guc: string;
  private mutexHeldBy: string | null = null;
  private readonly checkpoints = new Map<string, Checkpoint>();

  constructor(cfg: BackcatalogStoreConfig) {
    // Rows are kept sorted by the cursor key so the scan is deterministic and
    // the resumable cursor is a strict lower bound (mirrors ORDER BY created_at).
    this.rows = [...cfg.rows].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.anchorId < b.anchorId ? -1 : 1,
    );
    this.guc = cfg.guc ?? '';
  }

  /** True when {@link CLASSIFY_GUC} is set to an enabling value. */
  gucEnabled(): boolean {
    const v = this.guc.trim().toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }

  setGuc(value: string): void {
    this.guc = value;
  }

  /** Try to take the advisory mutex. Returns false when another holder has it. */
  tryAcquireMutex(holder: string): boolean {
    if (this.mutexHeldBy !== null) return false;
    this.mutexHeldBy = holder;
    return true;
  }

  releaseMutex(holder: string): void {
    if (this.mutexHeldBy === holder) this.mutexHeldBy = null;
  }

  mutexHolder(): string | null {
    return this.mutexHeldBy;
  }

  /**
   * Read the next page of rows AFTER `cursor`, optionally scoped to one org.
   * `cursor` is a strict lower bound on `createdAt` (ties broken by anchorId,
   * matching the sort). Org scoping filters to `orgId === scopeOrgId`.
   */
  page(cursor: string, limit: number, scopeOrgId?: string): BackcatalogRow[] {
    const out: BackcatalogRow[] = [];
    for (const r of this.rows) {
      if (r.createdAt < cursor) continue;
      if (r.createdAt === cursor) continue; // strict: cursor is the last-seen createdAt
      if (scopeOrgId !== undefined && r.orgId !== scopeOrgId) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  loadCheckpoint(scopeKey: string): Checkpoint | undefined {
    const cp = this.checkpoints.get(scopeKey);
    return cp ? { ...cp, census: { ...cp.census } } : undefined;
  }

  saveCheckpoint(cp: Checkpoint): void {
    this.checkpoints.set(cp.scopeKey, { ...cp, census: { ...cp.census } });
  }
}

// ─── The classifier pass (the unit under contract) ───────────────────────────

export interface ClassifyOptions {
  /** Org to scope the census to; omit for a global (all-orgs) pass. */
  orgId?: string;
  /** Rows per page. */
  batchSize?: number;
  /** Unique holder id for the mutex (e.g. a worker instance / run id). */
  holder: string;
  /**
   * Fire after each page is censused + checkpointed, BEFORE the next page.
   * Returning `false` simulates a crash: the pass stops immediately, leaving the
   * checkpoint durable so a re-run resumes from it. Used to prove
   * resume/idempotency without real process death.
   */
  onPageCommitted?: (cp: Checkpoint) => boolean | void;
}

export interface ClassifyResult {
  /** True when the GUC was off — the pass censused nothing. */
  skippedGuc: boolean;
  /** True when the mutex was already held — this pass no-op'd. */
  skippedMutex: boolean;
  /** True when the pass ran to completion (source exhausted). */
  completed: boolean;
  census: Census;
  rowsScanned: number;
  pagesProcessed: number;
  finalCursor: string;
}

function scopeKeyFor(orgId?: string): string {
  return `${CLASSIFY_MUTEX_KEY}:${orgId ?? 'ALL'}`;
}

/**
 * Run one classifier pass against the store, honouring the full contract:
 *   GUC gate → mutex acquire → resume-from-checkpoint → paged census →
 *   per-page checkpoint → release mutex.
 *
 * A crash (via `onPageCommitted` returning false) leaves a durable checkpoint;
 * calling this again with the same scope RESUMES from it — the accumulated
 * census carries forward and no row is counted twice.
 */
export function runClassifyPass(store: BackcatalogStore, opts: ClassifyOptions): ClassifyResult {
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const scopeKey = scopeKeyFor(opts.orgId);

  // ── GUC guard: inert unless enabled ──
  // A skipped pass reports ZERO work for THIS invocation — the census/rowsScanned
  // fields describe what this call did, not the persisted checkpoint total (which
  // stays available via store.loadCheckpoint). This keeps the mutex/GUC skip
  // invariants unambiguous: "skipped ⇒ censused nothing".
  if (!store.gucEnabled()) {
    const resumed = store.loadCheckpoint(scopeKey);
    return {
      skippedGuc: true,
      skippedMutex: false,
      completed: false,
      census: emptyCensus(),
      rowsScanned: 0,
      pagesProcessed: 0,
      finalCursor: resumed?.cursor ?? '',
    };
  }

  // ── Concurrency mutex: one pass per scope at a time ──
  if (!store.tryAcquireMutex(opts.holder)) {
    const resumed = store.loadCheckpoint(scopeKey);
    return {
      skippedGuc: false,
      skippedMutex: true,
      completed: false,
      census: emptyCensus(),
      rowsScanned: 0,
      pagesProcessed: 0,
      finalCursor: resumed?.cursor ?? '',
    };
  }

  try {
    // ── Resume from the durable checkpoint, if any ──
    const resumed = store.loadCheckpoint(scopeKey);
    if (resumed?.done) {
      return {
        skippedGuc: false,
        skippedMutex: false,
        completed: true,
        census: resumed.census,
        rowsScanned: resumed.rowsScanned,
        pagesProcessed: 0,
        finalCursor: resumed.cursor,
      };
    }
    const census: Census = resumed ? { ...resumed.census } : emptyCensus();
    let cursor = resumed?.cursor ?? '';
    let rowsScanned = resumed?.rowsScanned ?? 0;
    let pagesProcessed = 0;

    for (;;) {
      const page = store.page(cursor, batchSize, opts.orgId);
      if (page.length === 0) {
        const cp: Checkpoint = { scopeKey, cursor, census, rowsScanned, done: true };
        store.saveCheckpoint(cp);
        return {
          skippedGuc: false,
          skippedMutex: false,
          completed: true,
          census,
          rowsScanned,
          pagesProcessed,
          finalCursor: cursor,
        };
      }

      for (const row of page) {
        addToCensus(census, classifyRow(row));
        rowsScanned += 1;
      }
      cursor = page[page.length - 1].createdAt;
      pagesProcessed += 1;

      const cp: Checkpoint = { scopeKey, cursor, census, rowsScanned, done: false };
      store.saveCheckpoint(cp);

      // Simulated crash boundary: stop AFTER the checkpoint is durable so a
      // re-run resumes exactly here with no double-count.
      const cont = opts.onPageCommitted?.(cp);
      if (cont === false) {
        return {
          skippedGuc: false,
          skippedMutex: false,
          completed: false,
          census,
          rowsScanned,
          pagesProcessed,
          finalCursor: cursor,
        };
      }
    }
  } finally {
    store.releaseMutex(opts.holder);
  }
}
