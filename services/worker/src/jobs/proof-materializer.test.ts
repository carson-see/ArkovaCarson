/**
 * Tests for the INSERT-capable direct-anchor proof MATERIALIZER
 * (SCRUM-2917, CTO ruling Confluence 110198785).
 *
 * Mocks only — NO real DB, NO real chain, NO network. Pins the story's
 * non-negotiables:
 *   1. DUAL EXECUTE GUARD: dry-run by default; write mode needs BOTH
 *      options.execute===true AND confirm token === 'EXECUTE'
 *      (env PROOF_MATERIALIZER_CONFIRM via deps.confirmToken).
 *   2. The skeleton INSERT payload is EXACTLY
 *      { anchor_id, receipt_id, proof_completeness_class, materialize_run_id }
 *      — receipt_id := anchors.chain_tx_id. merkle_root / proof_path /
 *      op_return_payload / block_* are NEVER present (no degenerate Merkle
 *      branch, no fabricated payload — asserted structurally on every write).
 *   3. Idempotent: `.upsert(..., { onConflict: 'anchor_id',
 *      ignoreDuplicates: true })` + `.select('anchor_id')` counts actual
 *      inserts vs conflict-skips honestly.
 *   4. ELIGIBILITY: only classifier-`direct_anchored` anchors with NO existing
 *      anchor_proofs row. batch_provable / already_complete / existing-row
 *      anchors are skipped + counted, never inserted.
 *   5. Any ambiguous row on a page HALTS the run BEFORE any insert on that
 *      page (mirror of the classifier's runLabelApply halt semantics).
 *   6. GUC guard: refuses when arkova.proof_enforce_secured_complete is 'on';
 *      write mode fail-closes on 'unknown'.
 *   7. Advisory-lock concurrency guard on the materializer's OWN key (cannot
 *      collide with a concurrent classifier run); refuses when not acquired.
 *   8. Resumable job_queue checkpoint: SAME runId across resumes of one
 *      checkpoint (the per-run rollback key); restart mints a NEW runId.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runProofMaterializer,
  resolveMaterializerExecuteGuard,
  buildSkeletonRow,
  computeMaterializerLockId,
  SKELETON_INSERT_COLUMNS,
  SKELETON_FORBIDDEN_COLUMNS,
  MATERIALIZER_CHECKPOINT_JOB_TYPE,
  MATERIALIZER_EXECUTE_CONFIRM_TOKEN,
  __testing,
  type MaterializerSummary,
} from './proof-materializer.js';
import {
  computeClassifierLockId,
  type ClassifierLogger,
  type ClassifierLocker,
  type GucReader,
  type GucState,
} from './proof-backcatalog-classifier.js';

// Both jobs read their confirm-token default from typed config (SCRUM-1258
// pattern). Mock it so the unit test loads without prod env; every test
// injects `deps.confirmToken` explicitly when it matters.
vi.mock('../config.js', () => ({
  config: {
    proofClassifierConfirm: undefined,
    proofMaterializerConfirm: undefined,
  },
}));

// ── Test doubles (mirrors proof-backcatalog-classifier.test.ts) ──────────────

function makeLogger(): ClassifierLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function gucFixed(state: GucState): { guc: GucReader; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    guc: {
      async getProofEnforcementGuc() {
        calls.push(Date.now());
        return state;
      },
    },
  };
}

function makeLocker(acquired = true): ClassifierLocker & {
  acquires: number[];
  releases: number[];
} {
  const acquires: number[] = [];
  const releases: number[] = [];
  return {
    acquires,
    releases,
    async acquire(lockId: number) {
      acquires.push(lockId);
      return acquired;
    },
    async release(lockId: number) {
      releases.push(lockId);
    },
  };
}

interface FixtureAnchor {
  id: string;
  org_id: string | null;
  fingerprint: string;
  chain_tx_id: string | null;
  status?: string;
  deleted_at?: string | null;
}

interface FixtureProof {
  anchor_id: string;
  merkle_root: string | null;
  proof_path: unknown;
  batch_id: string | null;
  proof_completeness_class?: string | null;
  materialize_run_id?: string | null;
  receipt_id?: string | null;
}

interface RecordedWrite {
  table: string;
  op: 'insert' | 'update' | 'upsert';
  values: Record<string, unknown> | Array<Record<string, unknown>>;
  opts?: Record<string, unknown>;
}

interface RecordedRead {
  table: string;
  kind: 'scan' | 'cardinality' | 'other';
  filters: Array<{ method: string; col: string; val: unknown }>;
  limitN: number | null;
}

/**
 * Fixture-driven fake supabase client. Supports the exact chains the
 * materializer uses:
 *   - anchors page scan:   from().select().eq()...gt().order().limit() → await
 *   - tx cardinality:      from().select('id').eq(chain_tx_id).is().limit(2)
 *   - proof rows:          from().select().in() → await
 *   - skeleton insert:     from('anchor_proofs').upsert(rows, { onConflict:
 *                          'anchor_id', ignoreDuplicates: true }).select() → await
 *   - checkpoint load:     from('job_queue').select().eq()x3.order().limit()
 *   - checkpoint insert:   from('job_queue').insert().select('id').single()
 *   - checkpoint update:   from('job_queue').update().eq('id', …)
 * Every write is recorded; the ONLY legitimate anchor_proofs write is the
 * 4-column skeleton upsert, and upsert semantics honour ignoreDuplicates
 * against the live fixture (conflict rows are skipped and NOT returned).
 */
function makeFakeDb(fixture: { anchors: FixtureAnchor[]; proofs: FixtureProof[] }) {
  const writes: RecordedWrite[] = [];
  const reads: RecordedRead[] = [];
  const insertedProofRows: Array<Record<string, unknown>> = [];
  const checkpointRows: Array<{
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    created_at: string;
  }> = [];
  let cpSeq = 0;
  let failScan = false;
  let beforeUpsert: (() => void) | null = null;

  const anchorsSorted = () => [...fixture.anchors].sort((a, b) => a.id.localeCompare(b.id));

  interface BuilderState {
    table: string;
    filters: Array<{ method: string; col: string; val: unknown }>;
    limitN: number | null;
  }

  function readKind(state: BuilderState): RecordedRead['kind'] {
    if (state.table !== 'anchors') return 'other';
    if (state.filters.some((f) => f.method === 'eq' && f.col === 'chain_tx_id')) return 'cardinality';
    return 'scan';
  }

  function dispatchRead(state: BuilderState): { data?: unknown; error: { message: string } | null } {
    const kind = readKind(state);
    reads.push({ table: state.table, kind, filters: state.filters, limitN: state.limitN });

    if (kind === 'cardinality') {
      const txFilter = state.filters.find((f) => f.method === 'eq' && f.col === 'chain_tx_id')!;
      const rows = fixture.anchors.filter(
        (a) => a.chain_tx_id === txFilter.val && (a.deleted_at ?? null) === null,
      );
      const limited = state.limitN !== null ? rows.slice(0, state.limitN) : rows;
      return { data: limited.map((a) => ({ id: a.id })), error: null };
    }

    if (state.table === 'anchors') {
      if (failScan) return { data: null, error: { message: 'simulated scan failure' } };
      let rows = anchorsSorted().filter(
        (a) => (a.status ?? 'SECURED') === 'SECURED' && (a.deleted_at ?? null) === null,
      );
      for (const f of state.filters) {
        if (f.method === 'eq' && f.col === 'org_id') rows = rows.filter((a) => a.org_id === f.val);
        if (f.method === 'gt' && f.col === 'id') rows = rows.filter((a) => a.id > String(f.val));
      }
      const limited = state.limitN !== null ? rows.slice(0, state.limitN) : rows;
      return {
        data: limited.map((a) => ({
          id: a.id,
          org_id: a.org_id,
          fingerprint: a.fingerprint,
          chain_tx_id: a.chain_tx_id,
        })),
        error: null,
      };
    }

    if (state.table === 'anchor_proofs') {
      const inFilter = state.filters.find((f) => f.method === 'in' && f.col === 'anchor_id');
      const ids = new Set((inFilter?.val as string[]) ?? []);
      return {
        data: fixture.proofs
          .filter((p) => ids.has(p.anchor_id))
          .map((p) => ({
            anchor_id: p.anchor_id,
            merkle_root: p.merkle_root,
            proof_path: p.proof_path,
            batch_id: p.batch_id,
            proof_completeness_class: p.proof_completeness_class ?? null,
          })),
        error: null,
      };
    }

    if (state.table === 'job_queue') {
      let rows = [...checkpointRows];
      for (const f of state.filters) {
        if (f.method === 'eq' && f.col === 'type') rows = rows.filter((r) => r.type === f.val);
        if (f.method === 'eq' && f.col === 'payload->>scope') {
          rows = rows.filter((r) => String(r.payload.scope) === f.val);
        }
        if (f.method === 'eq' && f.col === 'payload->>mode') {
          rows = rows.filter((r) => String(r.payload.mode) === f.val);
        }
      }
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const limited = state.limitN !== null ? rows.slice(0, state.limitN) : rows;
      return { data: limited.map((r) => ({ id: r.id, payload: r.payload })), error: null };
    }

    return { data: [], error: null };
  }

  function makeBuilder(table: string) {
    const state: BuilderState = { table, filters: [], limitN: null };
    const builder = {
      eq(col: string, val: unknown) {
        state.filters.push({ method: 'eq', col, val });
        return builder;
      },
      is(col: string, val: unknown) {
        state.filters.push({ method: 'is', col, val });
        return builder;
      },
      gt(col: string, val: unknown) {
        state.filters.push({ method: 'gt', col, val });
        return builder;
      },
      in(col: string, val: unknown[]) {
        state.filters.push({ method: 'in', col, val });
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        state.limitN = n;
        return builder;
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        try {
          resolve(dispatchRead(state));
        } catch (err) {
          if (reject) reject(err);
        }
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return makeBuilder(table);
        },
        insert(values: Record<string, unknown>) {
          return {
            select(_cols: string) {
              return {
                async single() {
                  writes.push({ table, op: 'insert', values });
                  if (table === 'job_queue') {
                    const id = `cp-${++cpSeq}`;
                    checkpointRows.push({
                      id,
                      type: String(values.type),
                      status: String(values.status),
                      payload: (values.payload ?? {}) as Record<string, unknown>,
                      created_at: new Date(Date.now() + cpSeq).toISOString(),
                    });
                    return { data: { id }, error: null };
                  }
                  return { data: null, error: { message: `unexpected insert on ${table}` } };
                },
              };
            },
          };
        },
        upsert(rows: Array<Record<string, unknown>>, opts: Record<string, unknown>) {
          return {
            select(_cols: string) {
              return {
                then(resolve: (v: unknown) => void) {
                  if (beforeUpsert) beforeUpsert();
                  writes.push({ table, op: 'upsert', values: rows, opts });
                  if (table !== 'anchor_proofs') {
                    resolve({ data: null, error: { message: `unexpected upsert on ${table}` } });
                    return;
                  }
                  // ON CONFLICT (anchor_id) DO NOTHING semantics: conflicting
                  // rows are skipped and NOT returned by .select().
                  const affected: Array<{ anchor_id: string }> = [];
                  for (const row of rows) {
                    const anchorId = String(row.anchor_id);
                    if (fixture.proofs.some((p) => p.anchor_id === anchorId)) continue;
                    fixture.proofs.push({
                      anchor_id: anchorId,
                      merkle_root: (row.merkle_root as string | null) ?? null,
                      proof_path: row.proof_path ?? null,
                      batch_id: (row.batch_id as string | null) ?? null,
                      proof_completeness_class:
                        (row.proof_completeness_class as string | null) ?? null,
                      materialize_run_id: (row.materialize_run_id as string | null) ?? null,
                      receipt_id: (row.receipt_id as string | null) ?? null,
                    });
                    insertedProofRows.push({ ...row });
                    affected.push({ anchor_id: anchorId });
                  }
                  resolve({ data: affected, error: null });
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          const filters: Array<{ method: string; col: string; val: unknown }> = [];
          const chain = {
            eq(col: string, val: unknown) {
              filters.push({ method: 'eq', col, val });
              return chain;
            },
            then(resolve: (v: unknown) => void) {
              writes.push({ table, op: 'update', values });
              if (table === 'job_queue') {
                const idFilter = filters.find((f) => f.col === 'id');
                const row = checkpointRows.find((r) => r.id === idFilter?.val);
                if (row && values.payload) {
                  row.payload = values.payload as Record<string, unknown>;
                }
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  return {
    client: client as unknown as Parameters<typeof runProofMaterializer>[0]['client'],
    writes,
    reads,
    checkpointRows,
    insertedProofRows,
    setFailScan(v: boolean) {
      failScan = v;
    },
    /** Hook fired just before each upsert lands (simulates a concurrent writer). */
    setBeforeUpsert(fn: (() => void) | null) {
      beforeUpsert = fn;
    },
    /** Writes to anything OTHER than the job_queue checkpoint store. */
    nonCheckpointWrites() {
      return writes.filter((w) => w.table !== 'job_queue');
    },
    proofRow(anchorId: string) {
      return fixture.proofs.find((p) => p.anchor_id === anchorId);
    },
    pushAnchor(a: FixtureAnchor) {
      fixture.anchors.push(a);
    },
    pushProof(p: FixtureProof) {
      fixture.proofs.push(p);
    },
  };
}

// ── Fixture shorthand ────────────────────────────────────────────────────────

const FP = (n: number) => n.toString(16).padStart(64, '0');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function anchor(over: Partial<FixtureAnchor> & { id: string }): FixtureAnchor {
  return {
    org_id: ORG_A,
    fingerprint: FP(1),
    chain_tx_id: `tx-${over.id}`,
    status: 'SECURED',
    deleted_at: null,
    ...over,
  };
}

/**
 * Clean mixed fixture (zero ambiguity; ids are the scan/cursor order):
 *   a01 direct, NO proof row, solo tx           → INSERT candidate
 *   a02 direct, NO proof row, solo tx           → INSERT candidate
 *   a03 direct, EXISTING receipt-only proof row → skippedExisting
 *   a04 batch_provable (root + batch_id)        → skippedBatchProvable
 *   a05 already_complete (root + path)          → skippedAlreadyComplete
 */
function cleanFixture() {
  const anchors: FixtureAnchor[] = [
    anchor({ id: 'a01', fingerprint: FP(1) }),
    anchor({ id: 'a02', fingerprint: FP(2) }),
    anchor({ id: 'a03', fingerprint: FP(3) }),
    anchor({ id: 'a04', fingerprint: FP(4), chain_tx_id: 'tx-batch-1' }),
    anchor({ id: 'a05', fingerprint: FP(5) }),
  ];
  const proofs: FixtureProof[] = [
    { anchor_id: 'a03', merkle_root: null, proof_path: null, batch_id: null },
    { anchor_id: 'a04', merkle_root: FP(40), proof_path: null, batch_id: 'batch-1' },
    { anchor_id: 'a05', merkle_root: FP(5), proof_path: [], batch_id: null },
  ];
  return { anchors, proofs };
}

/** 120 direct anchors, none with a proof row (all INSERT candidates, 3 pages @50). */
function candidateFixture(count = 120) {
  return {
    anchors: Array.from({ length: count }, (_, i) =>
      anchor({ id: `a${String(i).padStart(3, '0')}`, fingerprint: FP(i + 1) }),
    ),
    proofs: [] as FixtureProof[],
  };
}

const baseDeps = (db: ReturnType<typeof makeFakeDb>, guc?: GucReader) => ({
  client: db.client,
  guc: guc ?? gucFixed('off').guc,
  logger: makeLogger(),
});

const writeDeps = (db: ReturnType<typeof makeFakeDb>, guc?: GucReader) => ({
  ...baseDeps(db, guc),
  confirmToken: MATERIALIZER_EXECUTE_CONFIRM_TOKEN,
});

function upserts(db: ReturnType<typeof makeFakeDb>) {
  return db.writes.filter((w) => w.table === 'anchor_proofs' && w.op === 'upsert');
}

// ── 1. Dual execute guard ────────────────────────────────────────────────────

describe('resolveMaterializerExecuteGuard', () => {
  it('refuses without both the flag and the token', () => {
    expect(resolveMaterializerExecuteGuard(undefined, undefined).permitted).toBe(false);
    expect(resolveMaterializerExecuteGuard(true, undefined).permitted).toBe(false);
    expect(
      resolveMaterializerExecuteGuard(false, MATERIALIZER_EXECUTE_CONFIRM_TOKEN).permitted,
    ).toBe(false);
    expect(resolveMaterializerExecuteGuard(true, 'nope').permitted).toBe(false);
  });
  it('permits only with flag AND exact token', () => {
    expect(resolveMaterializerExecuteGuard(true, MATERIALIZER_EXECUTE_CONFIRM_TOKEN)).toEqual({
      permitted: true,
      reason: null,
    });
  });
});

describe('runProofMaterializer: dual guard at the run level', () => {
  it('execute flag without token downgrades to dry-run with a refusal reason — zero inserts', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(
      { ...baseDeps(db), confirmToken: undefined },
      { execute: true },
    );
    expect(summary.mode).toBe('dry-run');
    expect(summary.executeRefusalReason).toMatch(/confirmation missing/i);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('token without execute flag stays dry-run — zero inserts', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db), {});
    expect(summary.mode).toBe('dry-run');
    expect(summary.executeRefusalReason).toBeNull(); // execute was never requested
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('both flag AND token enter write mode', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db), { execute: true });
    expect(summary.mode).toBe('write');
    expect(summary.refused).toBe(false);
  });
});

// ── 2. Skeleton row shape: the forge/fabrication guard ───────────────────────

describe('buildSkeletonRow: structural forge guard (§1.4 / §1.5)', () => {
  it('emits EXACTLY the 4 ruling columns, receipt_id := chain_tx_id', () => {
    const row = buildSkeletonRow({ id: 'anchor-1', chain_tx_id: 'tx-abc' }, 'run-uuid-1');
    expect(row).toEqual({
      anchor_id: 'anchor-1',
      receipt_id: 'tx-abc',
      proof_completeness_class: 'direct_anchored',
      materialize_run_id: 'run-uuid-1',
    });
    expect(Object.keys(row).sort()).toEqual([...SKELETON_INSERT_COLUMNS].sort());
  });

  it('never contains any forbidden proof/chain column', () => {
    const row = buildSkeletonRow({ id: 'anchor-1', chain_tx_id: 'tx-abc' }, 'run-uuid-1');
    for (const col of SKELETON_FORBIDDEN_COLUMNS) {
      expect(Object.keys(row)).not.toContain(col);
    }
  });

  it('the forbidden set covers every Merkle/chain column a forge would need', () => {
    for (const col of [
      'merkle_root',
      'proof_path',
      'merkle_index',
      'op_return_payload',
      'block_hash',
      'block_header',
      'block_height',
      'block_timestamp',
      'batch_id',
      'raw_response',
    ]) {
      expect(SKELETON_FORBIDDEN_COLUMNS).toContain(col);
    }
  });

  it('insert and forbidden sets are disjoint', () => {
    for (const col of SKELETON_INSERT_COLUMNS) {
      expect(SKELETON_FORBIDDEN_COLUMNS).not.toContain(col);
    }
  });
});

// ── 3. DRY-RUN default: full plan, zero anchor_proofs writes ─────────────────

describe('runProofMaterializer: dry-run default', () => {
  it('plans inserts + per-class skips and performs ZERO anchor_proofs writes', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(baseDeps(db), {});

    expect(summary.mode).toBe('dry-run');
    expect(summary.refused).toBe(false);
    expect(summary.runComplete).toBe(true);
    expect(summary.rowsScanned).toBe(5);
    expect(summary.planned).toEqual({
      toInsert: 2, // a01 + a02
      skippedExisting: 1, // a03
      skippedBatchProvable: 1, // a04
      skippedAlreadyComplete: 1, // a05
    });
    expect(summary.inserted).toBe(0);
    expect(summary.conflictSkipped).toBe(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0); // ← the core guarantee
    expect(upserts(db)).toHaveLength(0);
  });

  it('still persists a durable checkpoint (like the classifier census)', async () => {
    const db = makeFakeDb(cleanFixture());
    await runProofMaterializer(baseDeps(db), {});

    expect(db.checkpointRows).toHaveLength(1);
    expect(db.checkpointRows[0].type).toBe(MATERIALIZER_CHECKPOINT_JOB_TYPE);
    expect(db.checkpointRows[0].status).toBe('completed'); // terminal, never claimable
    expect(db.checkpointRows[0].payload.mode).toBe('dry-run');
    expect(typeof db.checkpointRows[0].payload.runId).toBe('string');
  });

  it('throws on a scan read failure (fail-closed, Scheduler retries)', async () => {
    const db = makeFakeDb(cleanFixture());
    db.setFailScan(true);
    await expect(runProofMaterializer(baseDeps(db), {})).rejects.toThrow(/scan query failed/i);
  });
});

// ── 4. GUC guard ─────────────────────────────────────────────────────────────

describe('runProofMaterializer: GUC guard (arkova.proof_enforce_secured_complete)', () => {
  it('refuses entirely when the GUC is ON — dry-run mode', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(baseDeps(db, gucFixed('on').guc), {});
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('guc_enforcement_on');
    expect(db.reads.filter((r) => r.table === 'anchors')).toHaveLength(0); // no scan started
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('refuses entirely when the GUC is ON — write mode', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db, gucFixed('on').guc), {
      execute: true,
    });
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('guc_enforcement_on');
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it("write mode fail-closes on 'unknown' — zero inserts", async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db, gucFixed('unknown').guc), {
      execute: true,
    });
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('guc_state_unknown');
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it("dry-run proceeds under 'unknown' (zero-write rehearsal is safe) with the state recorded", async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(baseDeps(db, gucFixed('unknown').guc), {});
    expect(summary.refused).toBe(false);
    expect(summary.gucState).toBe('unknown');
    expect(summary.planned.toInsert).toBe(2);
  });
});

// ── 5. Concurrency guard: the materializer's OWN advisory-lock key ──────────

describe('runProofMaterializer: concurrency guard', () => {
  it('refuses when the lock is not acquired — no scan, no checkpoint, no release of a lock never held', async () => {
    const db = makeFakeDb(cleanFixture());
    const locker = makeLocker(false);
    const logger = makeLogger();

    const summary = await runProofMaterializer({ ...baseDeps(db), logger, locker }, {});

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('lock_not_acquired');
    expect(summary.rowsScanned).toBe(0);
    expect(db.reads.filter((r) => r.table === 'anchors')).toHaveLength(0);
    expect(db.checkpointRows).toHaveLength(0);
    expect(locker.acquires).toHaveLength(1);
    expect(locker.releases).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('acquires then RELEASES the lock on normal completion (same key)', async () => {
    const db = makeFakeDb(cleanFixture());
    const locker = makeLocker(true);
    const summary = await runProofMaterializer({ ...baseDeps(db), locker }, {});
    expect(summary.refused).toBe(false);
    expect(locker.acquires).toHaveLength(1);
    expect(locker.releases).toEqual(locker.acquires);
  });

  it('RELEASES the lock even when the scan throws (finally — no leaked lock)', async () => {
    const db = makeFakeDb(cleanFixture());
    db.setFailScan(true);
    const locker = makeLocker(true);
    await expect(
      runProofMaterializer({ ...baseDeps(db), locker }, {}),
    ).rejects.toThrow(/scan query failed/i);
    expect(locker.releases).toEqual(locker.acquires);
  });

  it("the materializer's lock key can NEVER collide with the classifier's for the same (scope,mode)", () => {
    for (const scope of ['global', ORG_A]) {
      for (const mode of ['dry-run', 'write'] as const) {
        expect(computeMaterializerLockId(scope, mode)).not.toBe(
          computeClassifierLockId(scope, mode),
        );
      }
    }
  });

  it('materializer lock keys are distinct per (scope,mode), deterministic, and safe integers', () => {
    const a = computeMaterializerLockId('global', 'dry-run');
    const b = computeMaterializerLockId(ORG_A, 'dry-run');
    const c = computeMaterializerLockId('global', 'write');
    expect(new Set([a, b, c]).size).toBe(3);
    expect(computeMaterializerLockId('global', 'dry-run')).toBe(a);
    for (const id of [a, b, c]) expect(Number.isSafeInteger(id)).toBe(true);
  });
});

// ── 6. WRITE MODE: honest skeleton inserts ───────────────────────────────────

describe('runProofMaterializer: write mode', () => {
  it('inserts EXACTLY the 4-column skeleton for direct anchors with no proof row', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db), { execute: true });

    expect(summary.mode).toBe('write');
    expect(summary.refused).toBe(false);
    expect(summary.inserted).toBe(2); // a01 + a02
    expect(summary.conflictSkipped).toBe(0);
    expect(summary.planned).toEqual({
      toInsert: 2,
      skippedExisting: 1,
      skippedBatchProvable: 1,
      skippedAlreadyComplete: 1,
    });

    // Exactly-4-column structural check on every row that hit the wire.
    expect(db.insertedProofRows).toHaveLength(2);
    for (const row of db.insertedProofRows) {
      expect(Object.keys(row).sort()).toEqual([...SKELETON_INSERT_COLUMNS].sort());
      for (const col of SKELETON_FORBIDDEN_COLUMNS) {
        expect(Object.keys(row)).not.toContain(col);
      }
      expect(row.proof_completeness_class).toBe('direct_anchored');
      expect(row.materialize_run_id).toBe(summary.runId);
    }
    // receipt_id := anchors.chain_tx_id (semantically the chain tx id).
    expect(db.proofRow('a01')?.receipt_id).toBe('tx-a01');
    expect(db.proofRow('a02')?.receipt_id).toBe('tx-a02');

    // Skipped classes were NEVER inserted (their rows keep their prior state).
    expect(db.proofRow('a04')?.materialize_run_id ?? null).toBeNull();
    expect(db.proofRow('a05')?.materialize_run_id ?? null).toBeNull();
    // Merkle/chain emptiness is preserved on the new skeletons (honest direct).
    expect(db.proofRow('a01')?.merkle_root).toBeNull();
    expect(db.proofRow('a01')?.proof_path).toBeNull();

    // The upsert used the idempotent ON CONFLICT DO NOTHING shape.
    for (const w of upserts(db)) {
      expect(w.opts).toEqual({ onConflict: 'anchor_id', ignoreDuplicates: true });
    }
    // anchors table itself is NEVER written.
    expect(db.writes.filter((w) => w.table === 'anchors')).toHaveLength(0);
  });

  it('a concurrent writer racing the upsert is counted as conflictSkipped (ignoreDuplicates), never a double insert', async () => {
    const db = makeFakeDb(cleanFixture());
    // Just before the upsert lands, a02 gains a proof row from "someone else".
    db.setBeforeUpsert(() => {
      if (!db.proofRow('a02')) {
        db.pushProof({ anchor_id: 'a02', merkle_root: null, proof_path: null, batch_id: null });
      }
    });

    const summary = await runProofMaterializer(writeDeps(db), { execute: true });

    expect(summary.inserted).toBe(1); // a01 only
    expect(summary.conflictSkipped).toBe(1); // a02 lost the race — honestly counted
    expect(db.insertedProofRows).toHaveLength(1);
    expect(db.insertedProofRows[0].anchor_id).toBe('a01');
    // The pre-existing a02 row was NOT clobbered.
    expect(db.proofRow('a02')?.materialize_run_id ?? null).toBeNull();
  });

  it('a second write run over the same catalogue inserts nothing (idempotent end state)', async () => {
    const db = makeFakeDb(cleanFixture());
    const first = await runProofMaterializer(writeDeps(db), { execute: true });
    expect(first.inserted).toBe(2);

    const second = await runProofMaterializer(writeDeps(db), { execute: true, restart: true });
    // a01/a02 now HAVE proof rows → skippedExisting, not candidates.
    expect(second.inserted).toBe(0);
    expect(second.planned.toInsert).toBe(0);
    expect(second.planned.skippedExisting).toBe(3); // a01 + a02 + a03
    expect(db.insertedProofRows).toHaveLength(2); // nothing new hit the wire
  });

  it('re-invoking a COMPLETED run returns the stored summary without rescanning', async () => {
    const db = makeFakeDb(cleanFixture());
    const deps = writeDeps(db);
    const first = await runProofMaterializer(deps, { execute: true });
    expect(first.runComplete).toBe(true);
    const scansAfterFirst = db.reads.filter((r) => r.kind === 'scan').length;

    const second = await runProofMaterializer(deps, { execute: true });
    expect(second.runComplete).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.inserted).toBe(first.inserted);
    expect(second.runId).toBe(first.runId);
    expect(db.reads.filter((r) => r.kind === 'scan')).toHaveLength(scansAfterFirst);
  });
});

// ── 7. HALT-ON-AMBIGUOUS: before any write on the page ───────────────────────

describe('runProofMaterializer: ambiguous rows HALT the page before any insert', () => {
  it('an ambiguous row on the (single) page blocks every insert on it', async () => {
    const fixture = cleanFixture();
    // Two anchors sharing a tx with no persisted root → ambiguous ×2.
    fixture.anchors.push(
      anchor({ id: 'a06', fingerprint: FP(6), chain_tx_id: 'tx-shared' }),
      anchor({ id: 'a07', fingerprint: FP(7), chain_tx_id: 'tx-shared' }),
    );
    const db = makeFakeDb(fixture);

    const summary = await runProofMaterializer(writeDeps(db), { execute: true });

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('ambiguous_rows_present');
    expect(summary.haltedAmbiguous).toBe(2);
    expect(summary.ambiguousReasons.batch_member_without_root).toBe(2);
    expect(summary.inserted).toBe(0);
    expect(upserts(db)).toHaveLength(0); // a01/a02 were on the same page — NOT inserted
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('a SECURED-without-tx anchor is ambiguous (belt over the skippedNoTx braces) and halts', async () => {
    const fixture = cleanFixture();
    fixture.anchors.push(anchor({ id: 'a06', fingerprint: FP(6), chain_tx_id: null }));
    const db = makeFakeDb(fixture);

    const summary = await runProofMaterializer(writeDeps(db), { execute: true });

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('ambiguous_rows_present');
    expect(summary.ambiguousReasons.secured_without_tx).toBe(1);
    expect(upserts(db)).toHaveLength(0);
  });

  it('earlier CLEAN pages are inserted; the ambiguous page halts without writes and without advancing the cursor', async () => {
    const fixture = candidateFixture(60); // page 1 = a000..a049 clean
    // Page 2 contains an ambiguous pair (shared tx, no roots).
    fixture.anchors.push(
      anchor({ id: 'b01', fingerprint: FP(200), chain_tx_id: 'tx-shared' }),
      anchor({ id: 'b02', fingerprint: FP(201), chain_tx_id: 'tx-shared' }),
    );
    const db = makeFakeDb(fixture);

    const summary = await runProofMaterializer(writeDeps(db), {
      execute: true,
      batchSize: 50,
      maxBatches: 10,
    });

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('ambiguous_rows_present');
    expect(summary.inserted).toBe(50); // page 1 landed
    expect(summary.runComplete).toBe(false);
    expect(summary.cursor).toBe('a049'); // NOT advanced past the halting page
    expect(db.insertedProofRows).toHaveLength(50);
    expect(db.proofRow('a050')).toBeUndefined(); // page-2 candidate NOT inserted
    expect(db.proofRow('b01')).toBeUndefined();
  });

  it('dry-run halts at the same point (faithful rehearsal of the write path)', async () => {
    const fixture = cleanFixture();
    fixture.anchors.push(
      anchor({ id: 'a06', fingerprint: FP(6), chain_tx_id: 'tx-shared' }),
      anchor({ id: 'a07', fingerprint: FP(7), chain_tx_id: 'tx-shared' }),
    );
    const db = makeFakeDb(fixture);

    const summary = await runProofMaterializer(baseDeps(db), {});
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('ambiguous_rows_present');
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });
});

// ── 8. Resumable checkpoint: SAME runId across resumes, new on restart ───────

describe('runProofMaterializer: resumable checkpoint + runId (the rollback key)', () => {
  it('resumes from the durable cursor with the SAME runId stamped on every row', async () => {
    const db = makeFakeDb(candidateFixture(120));
    const deps = writeDeps(db);
    const opts = { execute: true, batchSize: 50, maxBatches: 1 };

    const inv1 = await runProofMaterializer(deps, opts);
    expect(inv1.runComplete).toBe(false);
    expect(inv1.inserted).toBe(50);
    expect(inv1.cursor).toBe('a049');
    const runId = inv1.runId;
    expect(typeof runId).toBe('string');
    expect(runId).toMatch(/^[0-9a-f-]{36}$/i); // uuid, minted once at creation

    const inv2 = await runProofMaterializer(deps, opts);
    expect(inv2.resumed).toBe(true);
    expect(inv2.runComplete).toBe(false);
    expect(inv2.inserted).toBe(100); // cumulative
    expect(inv2.runId).toBe(runId); // ← SAME runId across resumes

    const inv3 = await runProofMaterializer(deps, opts);
    expect(inv3.runComplete).toBe(true);
    expect(inv3.inserted).toBe(120);
    expect(inv3.runId).toBe(runId);

    // Every inserted row across ALL invocations carries the one runId.
    expect(db.insertedProofRows).toHaveLength(120);
    for (const row of db.insertedProofRows) {
      expect(row.materialize_run_id).toBe(runId);
    }

    // The resumed scan queried strictly AFTER the durable cursor.
    const resumedScans = db.reads.filter(
      (r) =>
        r.kind === 'scan' &&
        r.filters.some((f) => f.method === 'gt' && f.col === 'id' && f.val === 'a049'),
    );
    expect(resumedScans.length).toBeGreaterThan(0);
  });

  it('restart=true mints a NEW runId (fresh checkpoint; the old row remains as audit trail)', async () => {
    const db = makeFakeDb(candidateFixture(60));
    const deps = writeDeps(db);

    const first = await runProofMaterializer(deps, { execute: true });
    expect(first.runComplete).toBe(true);

    const second = await runProofMaterializer(deps, { execute: true, restart: true });
    expect(second.runId).not.toBe(first.runId);
    expect(db.checkpointRows).toHaveLength(2); // old checkpoint preserved
  });

  it('dry-run and write checkpoints do not collide (separate scope+mode rows)', async () => {
    const db = makeFakeDb(cleanFixture());
    await runProofMaterializer(baseDeps(db), {});
    await runProofMaterializer(writeDeps(db), { execute: true });

    const modes = db.checkpointRows.map((r) => r.payload.mode);
    expect(modes).toContain('dry-run');
    expect(modes).toContain('write');
  });

  it('org-scoped runs scan only that org and record the scope on the checkpoint', async () => {
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', org_id: ORG_A, fingerprint: FP(1) }),
        anchor({ id: 'b01', org_id: ORG_B, fingerprint: FP(2) }),
      ],
      proofs: [],
    });

    const summary = await runProofMaterializer(writeDeps(db), { execute: true, orgId: ORG_A });

    expect(summary.scope).toBe(ORG_A);
    expect(summary.rowsScanned).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(db.insertedProofRows.map((r) => r.anchor_id)).toEqual(['a01']);
    for (const s of db.reads.filter((r) => r.kind === 'scan')) {
      expect(s.filters).toContainEqual({ method: 'eq', col: 'org_id', val: ORG_A });
    }
    // Cardinality probes stay GLOBAL (no org filter) — cross-org batch txs count.
    for (const c of db.reads.filter((r) => r.kind === 'cardinality')) {
      expect(c.filters.find((f) => f.col === 'org_id')).toBeUndefined();
    }
  });
});

// ── 9. Clamps ────────────────────────────────────────────────────────────────

describe('materializer batch clamps (HTTP input cannot force an unbounded run)', () => {
  it('clamps batchSize to [50, 2000] and maxBatches to [1, 200] with safe defaults', () => {
    expect(__testing.clampBatchSize(undefined)).toBe(500);
    expect(__testing.clampBatchSize(1)).toBe(50);
    expect(__testing.clampBatchSize(10_000_000)).toBe(2_000);
    expect(__testing.clampBatchSize(NaN)).toBe(500);
    expect(__testing.clampMaxBatches(undefined)).toBe(20);
    expect(__testing.clampMaxBatches(0)).toBe(1);
    expect(__testing.clampMaxBatches(10_000_000)).toBe(200);
    expect(__testing.clampMaxBatches(NaN)).toBe(20);
  });
});

// ── 10. Summary honesty (§1.5): every path is counted, nothing guessed ───────

describe('runProofMaterializer: summary honesty', () => {
  it('a refused run reports zeroed counts and a null runId (nothing was started)', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary: MaterializerSummary = await runProofMaterializer(
      { ...baseDeps(db), locker: makeLocker(false) },
      {},
    );
    expect(summary.refused).toBe(true);
    expect(summary.runId).toBeNull();
    expect(summary.rowsScanned).toBe(0);
    expect(summary.inserted).toBe(0);
    expect(summary.planned).toEqual({
      toInsert: 0,
      skippedExisting: 0,
      skippedBatchProvable: 0,
      skippedAlreadyComplete: 0,
    });
  });

  it('skippedNoTx stays zero on the honest path (secured-without-tx rows halt as ambiguous first)', async () => {
    const db = makeFakeDb(cleanFixture());
    const summary = await runProofMaterializer(writeDeps(db), { execute: true });
    expect(summary.skippedNoTx).toBe(0);
  });
});
