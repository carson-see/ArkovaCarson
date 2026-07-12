/**
 * Tests for the back-catalogue proof-completeness CLASSIFIER
 * (S3-A / PROOF-BACKCATALOG, builds on SCRUM-2335 PROOF-02 + SCRUM-2491).
 *
 * Mocks only — NO real DB, NO real chain, NO network. Pins the story's
 * non-negotiables:
 *   1. DRY-RUN by default emits the per-class plan and writes NOTHING.
 *   2. The classifier NEVER fabricates a Merkle path: direct-anchored rows are
 *      classified honestly with Merkle-path fields left empty; existing proof
 *      columns are READ-ONLY (asserted structurally on every write payload).
 *   3. Write mode HALTS when ambiguous > 0.
 *   4. Write mode refuses with the exact 0354 schema gap (no
 *      `proof_completeness_class` column exists in 0340) — zero writes today.
 *   5. GUC guard: refuses to run when arkova.proof_enforce_secured_complete
 *      is ON; checked at run start AND on every resume (= every invocation).
 *   6. Resumable: durable job_queue checkpoint; re-invoke resumes, never
 *      restarts from zero.
 *   7. Idempotent: same fixture classified twice ⇒ identical plan, zero writes.
 *   8. Org-scoped runs scan only that org's rows (tx-cardinality reads stay
 *      global — a batch tx shared across orgs is still a batch tx).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runBackCatalogClassifier,
  classifyAnchor,
  buildClassWriteSet,
  resolveExecuteGuard,
  createDbGucReader,
  createDbLocker,
  computeClassifierLockId,
  CLASSIFIER_READ_ONLY_COLUMNS,
  SCHEMA_GAP_0354,
  CHECKPOINT_JOB_TYPE,
  EXECUTE_CONFIRM_TOKEN,
  DEFAULT_MAX_BATCHES_PER_INVOCATION,
  __testing,
  type BackCatalogClass,
  type ClassifierLogger,
  type ClassifierLocker,
  type GucReader,
  type GucState,
  type ScanAnchorRow,
  type ClassifierProofRow,
} from './proof-backcatalog-classifier.js';

// The job reads the confirm token default from typed config (SCRUM-1258
// pattern). Mock it so the unit test loads without prod env; every test
// injects `deps.confirmToken` explicitly when it matters.
vi.mock('../config.js', () => ({
  config: {
    proofClassifierConfirm: undefined,
  },
}));

// ── Test doubles ─────────────────────────────────────────────────────────────

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

/**
 * Fake advisory locker that records every acquire/release. `acquired` controls
 * whether the first acquire succeeds (simulating a concurrent invocation
 * already holding the lock when false).
 */
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
}

interface RecordedWrite {
  table: string;
  op: 'insert' | 'update';
  values: Record<string, unknown>;
  filters: Array<{ method: string; col: string; val: unknown }>;
}

interface RecordedRead {
  table: string;
  /** What the read shape says the query IS (derived from its filter shape). */
  kind: 'scan' | 'cardinality' | 'soft_deleted' | 'other';
  filters: Array<{ method: string; col: string; val: unknown }>;
  limitN: number | null;
}

/**
 * Fixture-driven fake supabase client. Supports the exact chains the
 * classifier uses (R0-8: no count:'exact' head-counts anywhere — every probe
 * is a bounded id-row fetch):
 *   - anchors page scan:   from().select().eq()...gt().order().limit() → await
 *   - tx cardinality:      from().select('id').eq(chain_tx_id).is().limit(2)
 *   - soft-deleted caveat: from().select('id').eq(status).not().limit(cap)
 *   - proof rows:          from().select().in() → await
 *   - checkpoint load:     from('job_queue').select().eq()x3.order().limit()
 *   - checkpoint insert:   from('job_queue').insert().select('id').single()
 *   - checkpoint update:   from('job_queue').update().eq('id', …)
 * Every write is recorded; anchors/anchor_proofs writes are the "never" set.
 */
function makeFakeDb(fixture: { anchors: FixtureAnchor[]; proofs: FixtureProof[] }) {
  const writes: RecordedWrite[] = [];
  const reads: RecordedRead[] = [];
  const checkpointRows: Array<{
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    created_at: string;
  }> = [];
  let cpSeq = 0;
  let failCardinalityForTx: string | null = null;
  let failScan = false;

  const anchorsSorted = () => [...fixture.anchors].sort((a, b) => a.id.localeCompare(b.id));

  function readKind(state: BuilderState): RecordedRead['kind'] {
    if (state.table !== 'anchors') return 'other';
    if (state.filters.some((f) => f.method === 'eq' && f.col === 'chain_tx_id')) return 'cardinality';
    if (state.filters.some((f) => f.method === 'not' && f.col === 'deleted_at')) return 'soft_deleted';
    return 'scan';
  }

  function dispatchRead(state: BuilderState): { data?: unknown; error: { message: string } | null } {
    const kind = readKind(state);
    reads.push({ table: state.table, kind, filters: state.filters, limitN: state.limitN });

    if (kind === 'cardinality') {
      // LIMIT-2 id probe: live rows sharing the tx (no status/org filter — global).
      const txFilter = state.filters.find((f) => f.method === 'eq' && f.col === 'chain_tx_id')!;
      if (failCardinalityForTx !== null && txFilter.val === failCardinalityForTx) {
        return { data: null, error: { message: 'simulated cardinality failure' } };
      }
      const rows = fixture.anchors.filter(
        (a) => a.chain_tx_id === txFilter.val && (a.deleted_at ?? null) === null,
      );
      const limited = state.limitN !== null ? rows.slice(0, state.limitN) : rows;
      return { data: limited.map((a) => ({ id: a.id })), error: null };
    }

    if (kind === 'soft_deleted') {
      // Capped id probe: status SECURED + deleted_at NOT null (+ optional org).
      const orgFilter = state.filters.find((f) => f.method === 'eq' && f.col === 'org_id');
      const rows = fixture.anchors.filter(
        (a) =>
          (a.status ?? 'SECURED') === 'SECURED' &&
          (a.deleted_at ?? null) !== null &&
          (!orgFilter || a.org_id === orgFilter.val),
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
        data: fixture.proofs.filter((p) => ids.has(p.anchor_id)),
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

  interface BuilderState {
    table: string;
    filters: Array<{ method: string; col: string; val: unknown }>;
    limitN: number | null;
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
      not(col: string, op: string, val: unknown) {
        state.filters.push({ method: 'not', col, val: `${op}.${String(val)}` });
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
                  writes.push({ table, op: 'insert', values, filters: [] });
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
        update(values: Record<string, unknown>) {
          const filters: Array<{ method: string; col: string; val: unknown }> = [];
          const chain = {
            eq(col: string, val: unknown) {
              filters.push({ method: 'eq', col, val });
              return chain;
            },
            then(resolve: (v: unknown) => void) {
              writes.push({ table, op: 'update', values, filters });
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
    client: client as unknown as Parameters<typeof runBackCatalogClassifier>[0]['client'],
    writes,
    reads,
    checkpointRows,
    setFailCardinalityFor(tx: string | null) {
      failCardinalityForTx = tx;
    },
    setFailScan(v: boolean) {
      failScan = v;
    },
    /** Writes to anything OTHER than the job_queue checkpoint store. */
    nonCheckpointWrites() {
      return writes.filter((w) => w.table !== 'job_queue');
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
 * Mixed-population fixture (ids are the scan/cursor order):
 *   a01 direct: no proof row, solo tx                      → direct_anchored
 *   a02 direct: proof row root==fingerprint, path null     → direct_anchored
 *   a03 complete: root + path ([] counts — FIX-1 shape)    → already_complete
 *   a04 batch: root + batch_id, path null (pre-FIX-1)      → batch_provable
 *   a05+a06 batch members sharing tx, NO proof rows        → ambiguous ×2
 *   a07 no tx at all                                       → ambiguous
 */
function mixedFixture() {
  const anchors: FixtureAnchor[] = [
    anchor({ id: 'a01', fingerprint: FP(1) }),
    anchor({ id: 'a02', fingerprint: FP(2) }),
    anchor({ id: 'a03', fingerprint: FP(3) }),
    anchor({ id: 'a04', fingerprint: FP(4), chain_tx_id: 'tx-batch-1' }),
    anchor({ id: 'a05', fingerprint: FP(5), chain_tx_id: 'tx-shared' }),
    anchor({ id: 'a06', fingerprint: FP(6), chain_tx_id: 'tx-shared' }),
    anchor({ id: 'a07', fingerprint: FP(7), chain_tx_id: null }),
  ];
  const proofs: FixtureProof[] = [
    { anchor_id: 'a02', merkle_root: FP(2), proof_path: null, batch_id: null },
    { anchor_id: 'a03', merkle_root: FP(3), proof_path: [], batch_id: null },
    { anchor_id: 'a04', merkle_root: FP(40), proof_path: null, batch_id: 'batch-1' },
  ];
  return { anchors, proofs };
}

const MIXED_PLAN = {
  direct_anchored: 2,
  batch_provable: 1,
  already_complete: 1,
  ambiguous: 3,
};

// ── 1. classifyAnchor: the honest state model ────────────────────────────────

describe('classifyAnchor: honest per-row taxonomy (never fabricates)', () => {
  const a = (over: Partial<ScanAnchorRow> = {}): ScanAnchorRow => ({
    id: 'a1',
    org_id: ORG_A,
    fingerprint: FP(9),
    chain_tx_id: 'tx-1',
    ...over,
  });
  const p = (over: Partial<ClassifierProofRow> = {}): ClassifierProofRow => ({
    anchor_id: 'a1',
    merkle_root: null,
    proof_path: null,
    batch_id: null,
    ...over,
  });

  it('already_complete: merkle_root + proof_path present (the 0340 trigger predicate)', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(9), proof_path: [] }), 1);
    expect(r).toEqual({ cls: 'already_complete', reason: null });
  });

  it('already_complete even for a populated batch branch', () => {
    const r = classifyAnchor(
      a(),
      p({ merkle_root: FP(40), proof_path: [{ hash: FP(8), position: 'left' }], batch_id: 'b1' }),
      7,
    );
    expect(r.cls).toBe('already_complete');
  });

  it('ambiguous: SECURED without a chain tx', () => {
    const r = classifyAnchor(a({ chain_tx_id: null }), null, null);
    expect(r).toEqual({ cls: 'ambiguous', reason: 'secured_without_tx' });
  });

  it('batch_provable: stored root + batch membership, branch reconstructable (no cardinality needed)', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(40), batch_id: 'b1' }), null);
    expect(r).toEqual({ cls: 'batch_provable', reason: null });
  });

  it('direct_anchored: solo tx, no proof row at all (the pre-FIX-1 back catalogue)', () => {
    const r = classifyAnchor(a(), null, 1);
    expect(r).toEqual({ cls: 'direct_anchored', reason: null });
  });

  it('direct_anchored: solo tx, receipt-only proof row (no root)', () => {
    const r = classifyAnchor(a(), p(), 1);
    expect(r.cls).toBe('direct_anchored');
  });

  it('direct_anchored: solo tx, single-leaf root == fingerprint, path honestly absent', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(9) }), 1);
    expect(r.cls).toBe('direct_anchored');
  });

  it('ambiguous: solo tx but stored root differs from the fingerprint (contradictory row)', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(40) }), 1);
    expect(r).toEqual({ cls: 'ambiguous', reason: 'solo_tx_foreign_root' });
  });

  it('ambiguous: shares a tx with others but no root persisted (cannot prove membership)', () => {
    expect(classifyAnchor(a(), null, 3)).toEqual({
      cls: 'ambiguous',
      reason: 'batch_member_without_root',
    });
    expect(classifyAnchor(a(), p(), 3).reason).toBe('batch_member_without_root');
  });

  it('ambiguous: root == fingerprint on a SHARED tx (single-leaf claim contradicts batch tx)', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(9) }), 2);
    expect(r).toEqual({ cls: 'ambiguous', reason: 'fingerprint_root_shared_tx' });
  });

  it('ambiguous: foreign root on a shared tx without batch_id', () => {
    const r = classifyAnchor(a(), p({ merkle_root: FP(40) }), 2);
    expect(r).toEqual({ cls: 'ambiguous', reason: 'unbatched_root_shared_tx' });
  });

  it('ambiguous (fail-closed): cardinality unknown when it was needed', () => {
    expect(classifyAnchor(a(), null, null)).toEqual({
      cls: 'ambiguous',
      reason: 'tx_cardinality_unknown',
    });
    expect(classifyAnchor(a(), null, 0).reason).toBe('tx_cardinality_unknown');
  });
});

// ── 2. Read-only enforcement: the write set can never touch proof columns ────

describe('buildClassWriteSet: read-only proof columns are structurally unreachable', () => {
  const ALL_CLASSES: BackCatalogClass[] = [
    'direct_anchored',
    'batch_provable',
    'already_complete',
    'ambiguous',
  ];

  it('never emits any read-only column for any class', () => {
    for (const cls of ALL_CLASSES) {
      const ws = buildClassWriteSet(cls);
      const cols = Object.keys(ws.values ?? {});
      for (const readonlyCol of CLASSIFIER_READ_ONLY_COLUMNS) {
        expect(cols).not.toContain(readonlyCol);
      }
    }
  });

  it('read-only set covers every existing proof column (incl. the 0340 chain-data columns)', () => {
    for (const col of [
      'merkle_root',
      'proof_path',
      'merkle_index',
      'block_hash',
      'block_header',
      'op_return_payload',
      'batch_id',
      'receipt_id',
    ]) {
      expect(CLASSIFIER_READ_ONLY_COLUMNS).toContain(col);
    }
  });

  it('already_complete and ambiguous need no write at all', () => {
    expect(buildClassWriteSet('already_complete')).toEqual({ values: null, schemaGap: null });
    expect(buildClassWriteSet('ambiguous')).toEqual({ values: null, schemaGap: null });
  });

  it('direct_anchored / batch_provable need the class column 0340 does not have → 0354 gap', () => {
    for (const cls of ['direct_anchored', 'batch_provable'] as const) {
      const ws = buildClassWriteSet(cls);
      expect(ws.values).toBeNull();
      expect(ws.schemaGap).toEqual(SCHEMA_GAP_0354);
    }
    expect(SCHEMA_GAP_0354.table).toBe('anchor_proofs');
    expect(SCHEMA_GAP_0354.neededColumn).toBe('proof_completeness_class');
  });
});

// ── 3. Execute guard (mirrors the SCRUM-2491 foundation double-guard) ────────

describe('resolveExecuteGuard', () => {
  it('refuses without both the flag and the env token', () => {
    expect(resolveExecuteGuard(undefined, undefined).permitted).toBe(false);
    expect(resolveExecuteGuard(true, undefined).permitted).toBe(false);
    expect(resolveExecuteGuard(false, EXECUTE_CONFIRM_TOKEN).permitted).toBe(false);
    expect(resolveExecuteGuard(true, 'nope').permitted).toBe(false);
  });
  it('permits only with flag AND exact token', () => {
    expect(resolveExecuteGuard(true, EXECUTE_CONFIRM_TOKEN)).toEqual({
      permitted: true,
      reason: null,
    });
  });
});

// ── 4. DRY-RUN default: full per-class plan, zero writes ────────────────────

describe('runBackCatalogClassifier: dry-run default', () => {
  it('emits the per-class row-count plan and performs ZERO non-checkpoint writes', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.mode).toBe('dry-run');
    expect(summary.refused).toBe(false);
    expect(summary.runComplete).toBe(true);
    expect(summary.plan).toEqual(MIXED_PLAN);
    expect(summary.ambiguousReasons).toEqual({
      batch_member_without_root: 2,
      secured_without_tx: 1,
    });
    expect(summary.writesApplied).toBe(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0); // ← the core guarantee
  });

  it('execute flag without env token downgrades to dry-run with a refusal reason', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger(), confirmToken: undefined },
      { execute: true },
    );

    expect(summary.mode).toBe('dry-run');
    expect(summary.executeRefusalReason).toMatch(/env confirmation/i);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('is idempotent: a re-census over the same data yields an identical plan and still zero writes', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    const first = await runBackCatalogClassifier(deps, {});
    const second = await runBackCatalogClassifier(deps, { restart: true });

    expect(second.plan).toEqual(first.plan);
    expect(second.ambiguousReasons).toEqual(first.ambiguousReasons);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('throws on a scan read failure (fail-closed, Scheduler retries)', async () => {
    const db = makeFakeDb(mixedFixture());
    db.setFailScan(true);
    const { guc } = gucFixed('off');

    await expect(
      runBackCatalogClassifier({ client: db.client, guc, logger: makeLogger() }, {}),
    ).rejects.toThrow(/scan query failed/i);
  });

  it('a cardinality probe failure classifies that row ambiguous (fail-closed), never guesses', async () => {
    const fixture = mixedFixture();
    const db = makeFakeDb(fixture);
    db.setFailCardinalityFor('tx-a01'); // a01 would otherwise be direct_anchored
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.plan.direct_anchored).toBe(MIXED_PLAN.direct_anchored - 1);
    expect(summary.plan.ambiguous).toBe(MIXED_PLAN.ambiguous + 1);
    expect(summary.ambiguousReasons.tx_cardinality_unknown).toBe(1);
  });
});

// ── 5. GUC guard ─────────────────────────────────────────────────────────────

describe('runBackCatalogClassifier: GUC guard (arkova.proof_enforce_secured_complete)', () => {
  it('refuses to run entirely when the GUC is ON (dry-run included)', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('on');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('guc_enforcement_on');
    expect(summary.rowsScanned).toBe(0);
    expect(db.reads.filter((r) => r.table === 'anchors')).toHaveLength(0); // no scan started
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('write mode refuses when the GUC state cannot be confirmed (fail-closed on unknown)', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('unknown');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger(), confirmToken: EXECUTE_CONFIRM_TOKEN },
      { execute: true },
    );

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('guc_state_unknown');
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('dry-run proceeds under unknown GUC state (zero-write census is safe) with the state recorded', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('unknown');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.refused).toBe(false);
    expect(summary.gucState).toBe('unknown');
    expect(summary.plan).toEqual(MIXED_PLAN);
  });

  it('re-checks the GUC on every invocation (start AND resume)', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc, calls } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 1 });
    await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 1 });

    expect(calls).toHaveLength(2);
  });
});

// ── 6. Write mode: halt on ambiguous, then the honest 0354 schema-gap stop ──

describe('runBackCatalogClassifier: write mode', () => {
  const writeDeps = (db: ReturnType<typeof makeFakeDb>) => ({
    client: db.client,
    guc: gucFixed('off').guc,
    logger: makeLogger(),
    confirmToken: EXECUTE_CONFIRM_TOKEN,
  });

  it('HALTS (refuses write mode) when ambiguous > 0 — zero writes', async () => {
    const db = makeFakeDb(mixedFixture()); // fixture has 3 ambiguous rows
    const summary = await runBackCatalogClassifier(writeDeps(db), { execute: true });

    expect(summary.mode).toBe('write');
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('ambiguous_rows_present');
    expect(summary.plan.ambiguous).toBe(3);
    expect(summary.writesApplied).toBe(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('with a clean plan, refuses on the exact 0354 schema gap — the class label has no 0340 column', async () => {
    // Clean fixture: only classifiable rows, zero ambiguity.
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', fingerprint: FP(1) }), // direct (no proof row, solo tx)
        anchor({ id: 'a03', fingerprint: FP(3) }), // complete
        anchor({ id: 'a04', fingerprint: FP(4), chain_tx_id: 'tx-batch-1' }), // batch_provable
      ],
      proofs: [
        { anchor_id: 'a03', merkle_root: FP(3), proof_path: [], batch_id: null },
        { anchor_id: 'a04', merkle_root: FP(40), proof_path: null, batch_id: 'batch-1' },
      ],
    });

    const summary = await runBackCatalogClassifier(writeDeps(db), { execute: true });

    expect(summary.mode).toBe('write');
    expect(summary.plan).toEqual({
      direct_anchored: 1,
      batch_provable: 1,
      already_complete: 1,
      ambiguous: 0,
    });
    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('schema_gap_0354');
    expect(summary.schemaGap).toEqual(SCHEMA_GAP_0354);
    expect(summary.writesApplied).toBe(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0); // ← never fabricates, never writes
  });

  it('write mode over already_complete-only rows is a vacuous success (nothing to persist)', async () => {
    const db = makeFakeDb({
      anchors: [anchor({ id: 'a03', fingerprint: FP(3) })],
      proofs: [{ anchor_id: 'a03', merkle_root: FP(3), proof_path: [], batch_id: null }],
    });

    const summary = await runBackCatalogClassifier(writeDeps(db), { execute: true });

    expect(summary.refused).toBe(false);
    expect(summary.writesApplied).toBe(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('running write mode twice yields an identical end state (idempotent, zero double-writes)', async () => {
    const db = makeFakeDb(mixedFixture());
    const first = await runBackCatalogClassifier(writeDeps(db), { execute: true });
    const second = await runBackCatalogClassifier(writeDeps(db), { execute: true, restart: true });

    expect(second.plan).toEqual(first.plan);
    expect(second.refusalReason).toBe(first.refusalReason);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });
});

// ── 7. Resumable durable checkpoint ──────────────────────────────────────────

describe('runBackCatalogClassifier: resumable job_queue checkpoint', () => {
  it('persists a durable cursor per batch and resumes — never restarts from zero', async () => {
    // 7 rows, batchSize 50 is the clamp floor → force small pages via clamp?
    // Use maxBatches=1 with batchSize clamped to the floor (50): the fixture is
    // smaller than a page, so build a 120-row fixture to span 3 pages.
    const anchors: FixtureAnchor[] = Array.from({ length: 120 }, (_, i) =>
      anchor({ id: `a${String(i).padStart(3, '0')}`, fingerprint: FP(i + 1) }),
    );
    const db = makeFakeDb({ anchors, proofs: [] });
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    // Invocation 1: one 50-row batch, then stop.
    const inv1 = await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 1 });
    expect(inv1.runComplete).toBe(false);
    expect(inv1.rowsScanned).toBe(50);
    expect(inv1.cursor).toBe('a049');

    // The checkpoint row is durable in job_queue (terminal status, never claimable).
    expect(db.checkpointRows).toHaveLength(1);
    expect(db.checkpointRows[0].type).toBe(CHECKPOINT_JOB_TYPE);
    expect(db.checkpointRows[0].status).toBe('completed');
    expect(db.checkpointRows[0].payload.cursor).toBe('a049');

    // Invocation 2 (fresh call = worker restart): resumes AFTER the cursor.
    const inv2 = await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 5 });
    expect(inv2.resumed).toBe(true);
    expect(inv2.runComplete).toBe(true);
    expect(inv2.rowsScanned).toBe(120); // cumulative — no rescan of the first 50
    expect(inv2.plan.direct_anchored).toBe(120);

    // The resumed scan queried strictly AFTER the checkpoint cursor.
    const resumedScans = db.reads.filter(
      (r) =>
        r.table === 'anchors' &&
        r.kind === 'scan' &&
        r.filters.some((f) => f.method === 'gt' && f.col === 'id' && f.val === 'a049'),
    );
    expect(resumedScans.length).toBeGreaterThan(0);
  });

  it('re-invoking a COMPLETED census returns the stored summary without rescanning', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    const first = await runBackCatalogClassifier(deps, {});
    expect(first.runComplete).toBe(true);
    const scansAfterFirst = db.reads.filter((r) => r.table === 'anchors' && r.kind === 'scan').length;

    const second = await runBackCatalogClassifier(deps, {});
    expect(second.runComplete).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.plan).toEqual(first.plan);
    // No new anchors-scan reads.
    const scansAfterResume = db.reads.filter((r) => r.table === 'anchors' && r.kind === 'scan');
    expect(scansAfterResume).toHaveLength(scansAfterFirst);
  });

  it('restart=true starts a fresh census instead of returning the stored one', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    await runBackCatalogClassifier(deps, {});
    const scansAfterFirst = db.reads.filter((r) => r.table === 'anchors' && r.kind === 'scan').length;

    const second = await runBackCatalogClassifier(deps, { restart: true });
    expect(second.plan).toEqual(MIXED_PLAN);
    expect(db.reads.filter((r) => r.table === 'anchors' && r.kind === 'scan').length).toBeGreaterThan(
      scansAfterFirst,
    );
  });
});

// ── 8. Per-org scoping ───────────────────────────────────────────────────────

describe('runBackCatalogClassifier: per-org scoping', () => {
  it('an org-scoped run scans only that org and touches zero other-org rows', async () => {
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', org_id: ORG_A, fingerprint: FP(1) }),
        anchor({ id: 'b01', org_id: ORG_B, fingerprint: FP(2) }),
        anchor({ id: 'b02', org_id: ORG_B, fingerprint: FP(3) }),
      ],
      proofs: [],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      { orgId: ORG_A },
    );

    expect(summary.scope).toBe(ORG_A);
    expect(summary.rowsScanned).toBe(1);
    expect(summary.plan.direct_anchored).toBe(1);

    // Every anchors page-scan carried the org filter…
    const scans = db.reads.filter((r) => r.table === 'anchors' && r.kind === 'scan');
    for (const s of scans) {
      expect(s.filters).toContainEqual({ method: 'eq', col: 'org_id', val: ORG_A });
    }
    // …and zero writes anywhere near another org's rows (zero writes at all).
    expect(db.nonCheckpointWrites()).toHaveLength(0);
  });

  it('tx-cardinality probes stay GLOBAL (a cross-org batch tx is still a batch tx)', async () => {
    // Same tx shared across orgs: an org-scoped run must still see cardinality 2.
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', org_id: ORG_A, fingerprint: FP(1), chain_tx_id: 'tx-x' }),
        anchor({ id: 'b01', org_id: ORG_B, fingerprint: FP(2), chain_tx_id: 'tx-x' }),
      ],
      proofs: [],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      { orgId: ORG_A },
    );

    // Shared tx + no proof row = ambiguous, NOT direct.
    expect(summary.plan.ambiguous).toBe(1);
    expect(summary.plan.direct_anchored).toBe(0);

    // Cardinality count queries must NOT be org-filtered.
    const cardReads = db.reads.filter(
      (r) => r.table === 'anchors' && r.kind === 'cardinality',
    );
    expect(cardReads.length).toBeGreaterThan(0);
    for (const c of cardReads) {
      expect(c.filters.find((f) => f.col === 'org_id')).toBeUndefined();
    }
  });

  it('org-scoped and global checkpoints do not collide', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    await runBackCatalogClassifier(deps, {});
    await runBackCatalogClassifier(deps, { orgId: ORG_A });

    const scopes = db.checkpointRows.map((r) => r.payload.scope);
    expect(scopes).toContain('global');
    expect(scopes).toContain(ORG_A);
  });
});

// ── 9. Cardinality memoization ───────────────────────────────────────────────

describe('runBackCatalogClassifier: tx-cardinality probes are memoized', () => {
  it('one count probe per distinct tx, not per row', async () => {
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', fingerprint: FP(1), chain_tx_id: 'tx-shared' }),
        anchor({ id: 'a02', fingerprint: FP(2), chain_tx_id: 'tx-shared' }),
        anchor({ id: 'a03', fingerprint: FP(3), chain_tx_id: 'tx-shared' }),
        anchor({ id: 'a04', fingerprint: FP(4), chain_tx_id: 'tx-solo' }),
      ],
      proofs: [],
    });
    const { guc } = gucFixed('off');

    await runBackCatalogClassifier({ client: db.client, guc, logger: makeLogger() }, {});

    const probes = db.reads
      .filter((r) => r.table === 'anchors' && r.kind === 'cardinality')
      .map((r) => r.filters.find((f) => f.col === 'chain_tx_id')?.val);
    expect(probes.sort()).toEqual(['tx-shared', 'tx-solo']);
  });
});

// ── 9b. R0-8 probe shapes: no count:'exact' — bounded id probes only ─────────

describe('runBackCatalogClassifier: R0-8-safe probe shapes (no count:\'exact\')', () => {
  it('cardinality probes are LIMIT-2 id fetches (0 / 1 / ≥2 is all classification needs)', async () => {
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', fingerprint: FP(1), chain_tx_id: 'tx-shared' }),
        anchor({ id: 'a02', fingerprint: FP(2), chain_tx_id: 'tx-shared' }),
        anchor({ id: 'a03', fingerprint: FP(3), chain_tx_id: 'tx-shared' }),
      ],
      proofs: [],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    // 3 anchors share one tx: the capped probe (returns 2 ⇒ "≥2") still
    // classifies every one of them as a shared-tx row — never direct.
    expect(summary.plan.ambiguous).toBe(3);
    expect(summary.plan.direct_anchored).toBe(0);
    expect(summary.ambiguousReasons.batch_member_without_root).toBe(3);

    const probes = db.reads.filter((r) => r.kind === 'cardinality');
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.limitN).toBe(__testing.CARDINALITY_PROBE_LIMIT);
    }
  });

  it('soft-deleted SECURED anchors are excluded from the census and counted exactly (small set)', async () => {
    const db = makeFakeDb({
      anchors: [
        anchor({ id: 'a01', fingerprint: FP(1) }),
        anchor({ id: 'a02', fingerprint: FP(2), deleted_at: '2026-01-01T00:00:00Z' }),
        anchor({ id: 'a03', fingerprint: FP(3), deleted_at: '2026-01-02T00:00:00Z' }),
      ],
      proofs: [],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.rowsScanned).toBe(1); // soft-deleted rows never enter the scan
    expect(summary.softDeletedExcluded).toBe(2);
    const probe = db.reads.find((r) => r.kind === 'soft_deleted');
    expect(probe?.limitN).toBe(__testing.SOFT_DELETED_PROBE_LIMIT);
  });

  it("reports 'unknown' (never a truncated number) when the soft-deleted caveat cap is hit", async () => {
    const cap = __testing.SOFT_DELETED_PROBE_LIMIT;
    const anchors: FixtureAnchor[] = [
      anchor({ id: 'a-live', fingerprint: FP(1) }),
      ...Array.from({ length: cap }, (_, i) =>
        anchor({
          id: `del-${String(i).padStart(5, '0')}`,
          fingerprint: FP(i + 2),
          deleted_at: '2026-01-01T00:00:00Z',
        }),
      ),
    ];
    const db = makeFakeDb({ anchors, proofs: [] });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.softDeletedExcluded).toBe('unknown');
    expect(summary.rowsScanned).toBe(1); // census itself is unaffected by the cap
  });
});

// ── 10. GUC reader mapping ───────────────────────────────────────────────────

describe('createDbGucReader', () => {
  const rpcClient = (result: { data?: unknown; error?: { message: string } | null }) =>
    ({
      rpc: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
    }) as never;

  it("maps 'on' → on and 'off'/empty/null → off", async () => {
    expect(await createDbGucReader(rpcClient({ data: 'on' })).getProofEnforcementGuc()).toBe('on');
    expect(await createDbGucReader(rpcClient({ data: 'off' })).getProofEnforcementGuc()).toBe('off');
    expect(await createDbGucReader(rpcClient({ data: '' })).getProofEnforcementGuc()).toBe('off');
    expect(await createDbGucReader(rpcClient({ data: null })).getProofEnforcementGuc()).toBe('off');
  });

  it('maps RPC errors (incl. missing function — no reader RPC exists yet) → unknown', async () => {
    const state = await createDbGucReader(
      rpcClient({ error: { message: 'function get_proof_enforcement_guc() does not exist' } }),
    ).getProofEnforcementGuc();
    expect(state).toBe('unknown');
  });

  it('maps unexpected values → unknown (fail-closed)', async () => {
    expect(await createDbGucReader(rpcClient({ data: 'maybe' })).getProofEnforcementGuc()).toBe(
      'unknown',
    );
  });
});

// ── 11. Batch-size + max-batches clamps ──────────────────────────────────────

describe('clampBatchSize', () => {
  it('clamps to [MIN, MAX] and defaults safely', () => {
    expect(__testing.clampBatchSize(undefined)).toBe(__testing.DEFAULT_BATCH_SIZE);
    expect(__testing.clampBatchSize(1)).toBe(__testing.MIN_BATCH_SIZE);
    expect(__testing.clampBatchSize(10_000_000)).toBe(__testing.MAX_BATCH_SIZE);
    expect(__testing.clampBatchSize(NaN)).toBe(__testing.DEFAULT_BATCH_SIZE);
  });
});

describe('clampMaxBatches (HTTP input cannot force an unbounded single-request run)', () => {
  it('clamps to [MIN, MAX] and defaults safely', () => {
    expect(__testing.clampMaxBatches(undefined)).toBe(DEFAULT_MAX_BATCHES_PER_INVOCATION);
    expect(__testing.clampMaxBatches(0)).toBe(__testing.MIN_BATCHES_PER_INVOCATION);
    expect(__testing.clampMaxBatches(-5)).toBe(__testing.MIN_BATCHES_PER_INVOCATION);
    expect(__testing.clampMaxBatches(10_000_000)).toBe(__testing.MAX_BATCHES_PER_INVOCATION);
    expect(__testing.clampMaxBatches(NaN)).toBe(DEFAULT_MAX_BATCHES_PER_INVOCATION);
  });

  it('a below-minimum maxBatches still processes exactly one batch (clamped, not zero-looped)', async () => {
    const anchors: FixtureAnchor[] = Array.from({ length: 120 }, (_, i) =>
      anchor({ id: `a${String(i).padStart(3, '0')}`, fingerprint: FP(i + 1) }),
    );
    const db = makeFakeDb({ anchors, proofs: [] });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      { batchSize: 50, maxBatches: 0 },
    );

    expect(summary.batchesProcessed).toBe(1);
    expect(summary.rowsScanned).toBe(50);
    expect(summary.runComplete).toBe(false);
  });
});

// ── 12. F1: concurrency guard (advisory lock keyed on job+scope+mode) ────────
//
// Two concurrent /classify-proof-backcatalog invocations for the same
// (scope,mode) both read-modify-write the ONE durable job_queue checkpoint row.
// Without a mutex that is last-writer-wins: the second invocation's stale
// cursor overwrites the first's → the census cursor REWINDS and the per-class
// plan Carson gates the 2.97M labeling on is silently wrong. The advisory lock
// (pg_try_advisory_lock via the try_advisory_lock RPC, keyed on
// job+scope+mode) refuses the second invocation loudly. Mirrors
// chain-maintenance.test.ts:146 "skips when advisory lock not acquired".

describe('runBackCatalogClassifier: concurrency guard (F1)', () => {
  it('refuses (skips loudly) a second concurrent invocation for the same (scope,mode) — no scan, no checkpoint mutation', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const locker = makeLocker(false); // lock already held by a concurrent run
    const logger = makeLogger();

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger, locker },
      {},
    );

    expect(summary.refused).toBe(true);
    expect(summary.refusalReason).toBe('lock_not_acquired');
    expect(summary.rowsScanned).toBe(0);
    // The guard runs BEFORE any scan or checkpoint work.
    expect(db.reads.filter((r) => r.table === 'anchors')).toHaveLength(0);
    expect(db.checkpointRows).toHaveLength(0);
    expect(db.nonCheckpointWrites()).toHaveLength(0);
    // It tried exactly once and, having failed, did NOT release a lock it never held.
    expect(locker.acquires).toHaveLength(1);
    expect(locker.releases).toHaveLength(0);
    // Loud refusal.
    expect(logger.warn).toHaveBeenCalled();
  });

  it('acquires then RELEASES the lock on normal completion', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    const locker = makeLocker(true);

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger(), locker },
      {},
    );

    expect(summary.refused).toBe(false);
    expect(summary.runComplete).toBe(true);
    expect(locker.acquires).toHaveLength(1);
    expect(locker.releases).toHaveLength(1);
    // Same key for acquire and release.
    expect(locker.releases[0]).toBe(locker.acquires[0]);
  });

  it('RELEASES the lock even when the scan throws (finally — no leaked lock)', async () => {
    const db = makeFakeDb(mixedFixture());
    db.setFailScan(true); // scan read throws mid-run
    const { guc } = gucFixed('off');
    const locker = makeLocker(true);

    await expect(
      runBackCatalogClassifier({ client: db.client, guc, logger: makeLogger(), locker }, {}),
    ).rejects.toThrow(/scan query failed/i);

    // The error propagated, but the lock was still released.
    expect(locker.acquires).toHaveLength(1);
    expect(locker.releases).toHaveLength(1);
    expect(locker.releases[0]).toBe(locker.acquires[0]);
  });

  it('the lock is keyed on (scope,mode): global-dry-run, org-dry-run and global-write all get distinct keys', async () => {
    const globalDry = computeClassifierLockId('global', 'dry-run');
    const orgDry = computeClassifierLockId(ORG_A, 'dry-run');
    const globalWrite = computeClassifierLockId('global', 'write');

    const keys = new Set([globalDry, orgDry, globalWrite]);
    expect(keys.size).toBe(3); // all distinct
    // Deterministic + stable (safe signed-bigint range for pg_try_advisory_lock).
    expect(computeClassifierLockId('global', 'dry-run')).toBe(globalDry);
    expect(Number.isSafeInteger(globalDry)).toBe(true);
    expect(Number.isSafeInteger(orgDry)).toBe(true);
    expect(Number.isSafeInteger(globalWrite)).toBe(true);
  });

  it('an org-scoped run and a global run do NOT block each other (different lock keys)', async () => {
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');
    // A single shared locker that only lets ONE key be held at a time would
    // still permit both here because the keys differ. Model that: track held keys.
    const held = new Set<number>();
    const locker: ClassifierLocker = {
      async acquire(lockId: number) {
        if (held.has(lockId)) return false;
        held.add(lockId);
        return true;
      },
      async release(lockId: number) {
        held.delete(lockId);
      },
    };
    const deps = { client: db.client, guc, logger: makeLogger(), locker };

    const g = await runBackCatalogClassifier(deps, {});
    const o = await runBackCatalogClassifier(deps, { orgId: ORG_A });

    expect(g.refused).toBe(false);
    expect(o.refused).toBe(false);
    expect(o.scope).toBe(ORG_A);
  });

  it('defaults to a permissive no-op locker when none is injected (back-compat with the no-op single-worker assumption)', async () => {
    // No `locker` in deps → the run still proceeds (mirrors chain-maintenance's
    // no-op acquireLock). The production cron path injects the real DB locker.
    const db = makeFakeDb(mixedFixture());
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.refused).toBe(false);
    expect(summary.runComplete).toBe(true);
  });
});

// ── 13. createDbLocker: RPC mapping ──────────────────────────────────────────

describe('createDbLocker (try_advisory_lock / release_advisory_lock RPCs)', () => {
  it('acquire returns true only when the RPC returns boolean true', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      rpc: vi.fn(async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: name === 'try_advisory_lock' ? true : null, error: null };
      }),
    } as never;

    const locker = createDbLocker(client);
    expect(await locker.acquire(123)).toBe(true);
    expect(calls[0]).toEqual({ name: 'try_advisory_lock', args: { lock_id: 123 } });
  });

  it('acquire returns false when the RPC returns false OR errors (fail-closed — do not run without the lock)', async () => {
    const falseClient = {
      rpc: vi.fn(async () => ({ data: false, error: null })),
    } as never;
    expect(await createDbLocker(falseClient).acquire(1)).toBe(false);

    const errClient = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })),
    } as never;
    expect(await createDbLocker(errClient).acquire(1)).toBe(false);
  });

  it('release calls release_advisory_lock and never throws on RPC error (best-effort unlock)', async () => {
    const errClient = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'unlock on wrong backend' } })),
    } as never;
    await expect(createDbLocker(errClient).release(7)).resolves.toBeUndefined();
  });
});

// ── 14. F3: already_complete_without_tx caveat counter ───────────────────────
//
// classifyAnchor returns already_complete on (root + path) BEFORE it checks for
// a chain tx. A row that is root+path-complete yet has chain_tx_id IS NULL is a
// self-contradiction (complete proof, no anchoring tx). We do NOT change the
// class vocabulary — the row still counts as already_complete — but we surface
// the contradiction count so the census is honest about it (§1.5).

describe('runBackCatalogClassifier: already_complete_without_tx caveat (F3)', () => {
  it('counts already_complete rows that have NO chain tx as a caveat, without changing the class', async () => {
    const db = makeFakeDb({
      anchors: [
        // complete + has tx → already_complete, NOT counted in the caveat
        anchor({ id: 'a01', fingerprint: FP(1), chain_tx_id: 'tx-1' }),
        // complete but NO tx → already_complete AND caveat-counted
        anchor({ id: 'a02', fingerprint: FP(2), chain_tx_id: null }),
        anchor({ id: 'a03', fingerprint: FP(3), chain_tx_id: null }),
      ],
      proofs: [
        { anchor_id: 'a01', merkle_root: FP(1), proof_path: [], batch_id: null },
        { anchor_id: 'a02', merkle_root: FP(2), proof_path: [], batch_id: null },
        { anchor_id: 'a03', merkle_root: FP(3), proof_path: [], batch_id: null },
      ],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    // Class vocabulary unchanged: all three are already_complete, zero ambiguous.
    expect(summary.plan.already_complete).toBe(3);
    expect(summary.plan.ambiguous).toBe(0);
    // The caveat surfaces the two contradictory rows.
    expect(summary.alreadyCompleteWithoutTx).toBe(2);
  });

  it('is zero when every already_complete row has a chain tx (no contradiction)', async () => {
    const db = makeFakeDb({
      anchors: [anchor({ id: 'a01', fingerprint: FP(1), chain_tx_id: 'tx-1' })],
      proofs: [{ anchor_id: 'a01', merkle_root: FP(1), proof_path: [], batch_id: null }],
    });
    const { guc } = gucFixed('off');

    const summary = await runBackCatalogClassifier(
      { client: db.client, guc, logger: makeLogger() },
      {},
    );

    expect(summary.plan.already_complete).toBe(1);
    expect(summary.alreadyCompleteWithoutTx).toBe(0);
  });

  it('the caveat count is cumulative across resumes (carried on the checkpoint)', async () => {
    // 120 rows, all complete + NO tx → all caveat-counted, spanning 3 pages.
    const anchors: FixtureAnchor[] = Array.from({ length: 120 }, (_, i) =>
      anchor({ id: `a${String(i).padStart(3, '0')}`, fingerprint: FP(i + 1), chain_tx_id: null }),
    );
    const proofs: FixtureProof[] = anchors.map((a) => ({
      anchor_id: a.id,
      merkle_root: a.fingerprint,
      proof_path: [],
      batch_id: null,
    }));
    const db = makeFakeDb({ anchors, proofs });
    const { guc } = gucFixed('off');
    const deps = { client: db.client, guc, logger: makeLogger() };

    const inv1 = await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 1 });
    expect(inv1.runComplete).toBe(false);
    expect(inv1.alreadyCompleteWithoutTx).toBe(50);

    const inv2 = await runBackCatalogClassifier(deps, { batchSize: 50, maxBatches: 5 });
    expect(inv2.runComplete).toBe(true);
    expect(inv2.alreadyCompleteWithoutTx).toBe(120); // cumulative, not reset
  });
});
