/**
 * QUEUE-06 (SCRUM-2352) — connector_artifact drain consumer tests.
 *
 * The loop-closer: drains `connector_artifact` rows (status pending|queued),
 * claims them concurrency-safely (compare-and-set so two cycles never
 * double-anchor a row), materializes a PENDING anchor, charges ONLY at
 * SECURING via `debit_and_enqueue_anchor`, then batch-anchors and marks the
 * row `anchored`. Per-row failure → status='failed' + bounded alert; no silent
 * drops.
 *
 * These are unit tests over an injected DB/deps surface — no real Supabase,
 * Stripe, or Bitcoin (CLAUDE.md §1.7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The drain module imports db/logger/batch-anchor/sentry at module load; those
// transitively load worker config (which needs prod env). Every dep is injected
// in these tests, so stub the heavy module-load imports.
vi.mock('../utils/db.js', () => ({ db: { from: () => { throw new Error('default db must not be used'); } } }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../utils/sentry.js', () => ({ Sentry: { captureMessage: vi.fn() } }));
vi.mock('../utils/rpc.js', () => ({ callRpc: vi.fn() }));

vi.mock('../config.js', () => ({ config: { enableConnectorArtifactDrain: true } }));

const {
  drainConnectorArtifactsForOrg,
  runConnectorArtifactDrain,
  reapStaleInFlightArtifacts,
} = await import('./connector-artifact-drain.js');
type ConnectorArtifactDrainDeps =
  import('./connector-artifact-drain.js').ConnectorArtifactDrainDeps;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ART_1 = '11111111-1111-4111-8111-111111111111';
const ART_2 = '22222222-2222-4222-8222-222222222222';
const ANCHOR_1 = 'a1111111-1111-4111-8111-111111111111';
const ANCHOR_2 = 'a2222222-2222-4222-8222-222222222222';
const FP_1 = 'a'.repeat(64);
const FP_2 = 'b'.repeat(64);

/**
 * Minimal in-memory `connector_artifact` table backing a supabase-js-shaped
 * query builder. Models the compare-and-set claim: an UPDATE that matches the
 * row only while it is still pending|queued (so a concurrent second claim
 * returns zero rows = the loser).
 */
interface Row {
  id: string;
  org_id: string;
  status: string;
  fingerprint_sha256: string;
  byte_length: number | null;
  source: string;
  external_ref: string;
  metadata: Record<string, unknown>;
  anchor_id: string | null;
  credit_deduction_id: string | null;
}

function makeRow(over: Partial<Row> & Pick<Row, 'id' | 'org_id'>): Row {
  return {
    status: 'pending',
    fingerprint_sha256: FP_1,
    byte_length: 1234,
    source: 'google_drive',
    external_ref: 'file-1',
    metadata: {},
    anchor_id: null,
    credit_deduction_id: null,
    ...over,
  };
}

interface Harness {
  rows: Row[];
  deps: ConnectorArtifactDrainDeps;
  materialize: ReturnType<typeof vi.fn>;
  debit: ReturnType<typeof vi.fn>;
  batchAnchor: ReturnType<typeof vi.fn>;
  alert: ReturnType<typeof vi.fn>;
  claimAttempts: Array<{ id: string }>;
}

function makeHarness(rows: Row[], overrides: Partial<ConnectorArtifactDrainDeps> = {}): Harness {
  const claimAttempts: Array<{ id: string }> = [];

  // supabase-js-shaped builder. Only the operations the drain uses are modeled.
  function from(table: string) {
    if (table !== 'connector_artifact') throw new Error(`unexpected table ${table}`);

    const state: {
      op: 'select' | 'update';
      patch?: Record<string, unknown>;
      filters: Array<(r: Row) => boolean>;
      inStatuses?: string[];
    } = { op: 'select', filters: [] };

    const builder: Record<string, unknown> = {
      select() { return builder; },
      update(patch: Record<string, unknown>) { state.op = 'update'; state.patch = patch; return builder; },
      eq(col: string, val: unknown) {
        state.filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return builder;
      },
      in(col: string, vals: string[]) {
        if (col === 'status') state.inStatuses = vals;
        state.filters.push((r) => vals.includes((r as unknown as Record<string, unknown>)[col] as string));
        return builder;
      },
      is(col: string, val: null) {
        state.filters.push(
          (r) =>
            (r as unknown as Record<string, unknown>)[col] === val ||
            (r as unknown as Record<string, unknown>)[col] == null,
        );
        return builder;
      },
      order() { return builder; },
      limit(n: number) {
        // terminal for SELECT
        const matched = rows.filter((r) => state.filters.every((f) => f(r))).slice(0, n);
        return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
      },
      // terminal for UPDATE ... RETURNING (.select().maybeSingle())
      maybeSingle() {
        if (state.op === 'update') {
          const target = rows.find((r) => state.filters.every((f) => f(r)));
          if (!target) return Promise.resolve({ data: null, error: null });
          // record claim attempt for compare-and-set assertions
          if (state.inStatuses && state.patch?.status === 'processing') {
            claimAttempts.push({ id: target.id });
          }
          Object.assign(target, state.patch);
          return Promise.resolve({ data: { ...target }, error: null });
        }
        const found = rows.find((r) => state.filters.every((f) => f(r)));
        return Promise.resolve({ data: found ? { ...found } : null, error: null });
      },
      // terminal for bare `await update().eq().eq()` (markAnchored / markFailed)
      then(onFulfilled: (v: { data: unknown; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
        let value: { data: unknown; error: null };
        if (state.op === 'update') {
          for (const r of rows.filter((row) => state.filters.every((f) => f(row)))) {
            Object.assign(r, state.patch);
          }
          value = { data: null, error: null };
        } else {
          value = { data: rows.filter((r) => state.filters.every((f) => f(r))), error: null };
        }
        return Promise.resolve(value).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const materialize =
    (overrides.materializeAnchor as ReturnType<typeof vi.fn>) ??
    vi.fn(async (row: Row) => ({ anchorId: row.id === ART_2 ? ANCHOR_2 : ANCHOR_1, anchorPublicId: 'pub-1' }));

  const debit =
    (overrides.debitAndEnqueueAnchor as ReturnType<typeof vi.fn>) ??
    vi.fn(async () => ({ success: true }));

  const batchAnchor =
    (overrides.batchAnchor as ReturnType<typeof vi.fn>) ??
    vi.fn(async () => ({ processed: 1, batchId: 'batch-1', merkleRoot: 'c'.repeat(64), txId: 'tx-1' }));

  const alert = (overrides.emitAlert as ReturnType<typeof vi.fn>) ?? vi.fn();

  const deps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    materializeAnchor: materialize,
    debitAndEnqueueAnchor: debit,
    batchAnchor,
    emitAlert: alert,
    ...overrides,
  } as unknown as ConnectorArtifactDrainDeps;

  return { rows, deps, materialize, debit, batchAnchor, alert, claimAttempts };
}

beforeEach(() => vi.clearAllMocks());

describe('drainConnectorArtifactsForOrg', () => {
  it('drains a pending row: claim → materialize → charge at securing → anchored', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'pending' })]);

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result).toMatchObject({ claimed: 1, anchored: 1, failed: 0 });
    // materialized a PENDING anchor for THIS row
    expect(h.materialize).toHaveBeenCalledTimes(1);
    // charge happens exactly once, at securing, via debit_and_enqueue_anchor
    expect(h.debit).toHaveBeenCalledTimes(1);
    expect(h.debit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A, anchorId: ANCHOR_1 }));
    // batch-anchored
    expect(h.batchAnchor).toHaveBeenCalledWith({ force: true, orgId: ORG_A });
    // terminal state
    expect(h.rows[0].status).toBe('anchored');
    expect(h.rows[0].anchor_id).toBe(ANCHOR_1);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('also drains queued rows (status IN pending,queued)', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'queued' })]);
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(result.claimed).toBe(1);
    expect(h.rows[0].status).toBe('anchored');
  });

  it('forced cycle still drains (forced + normal both supported)', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'pending' })]);
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(result.anchored).toBe(1);
    expect(h.batchAnchor).toHaveBeenCalledWith({ force: true, orgId: ORG_A });
  });

  it('exactly-once: a duplicate-delivery row already claimed by another cycle is not re-anchored', async () => {
    // Row is already in 'processing' (claimed by a concurrent cycle). The
    // compare-and-set claim must match zero rows → skip, never double-anchor.
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'processing' })]);

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.claimed).toBe(0);
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.rows[0].status).toBe('processing');
  });

  it('charge-happens-once-at-securing: never debits at enqueue/claim, only after materialize', async () => {
    const order: string[] = [];
    const materialize = vi.fn(async () => { order.push('materialize'); return { anchorId: ANCHOR_1, anchorPublicId: 'p' }; });
    const debit = vi.fn(async () => { order.push('debit'); return { success: true }; });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { materializeAnchor: materialize, debitAndEnqueueAnchor: debit });

    await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(order).toEqual(['materialize', 'debit']);
    expect(debit).toHaveBeenCalledTimes(1);
  });

  it('insufficient credits: debit fails → row NOT anchored, no batch-anchor, alert raised, no silent drop', async () => {
    const debit = vi.fn(async () => ({ success: false, error: 'insufficient_credits' }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(1);
    expect(result.anchored).toBe(0);
    expect(h.batchAnchor).not.toHaveBeenCalled();
    expect(h.rows[0].status).toBe('failed');
    expect(h.alert).toHaveBeenCalledTimes(1);
    // alert is bounded + PII-scrubbed: carries ids/reason, never raw bytes/fingerprint
    const alertArg = h.alert.mock.calls[0][0];
    expect(alertArg).toMatchObject({ orgId: ORG_A, artifactId: ART_1, reason: expect.any(String) });
    expect(JSON.stringify(alertArg)).not.toContain(FP_1);
  });

  it('partial-failure isolation: one row fails, the next still drains', async () => {
    const materialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('materialize boom'))
      .mockResolvedValueOnce({ anchorId: ANCHOR_2, anchorPublicId: 'p2' });
    const h = makeHarness(
      [
        makeRow({ id: ART_1, org_id: ORG_A, fingerprint_sha256: FP_1 }),
        makeRow({ id: ART_2, org_id: ORG_A, external_ref: 'file-2', fingerprint_sha256: FP_2 }),
      ],
      { materializeAnchor: materialize },
    );

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.anchored).toBe(1);
    expect(h.rows.find((r) => r.id === ART_1)?.status).toBe('failed');
    expect(h.rows.find((r) => r.id === ART_2)?.status).toBe('anchored');
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it('cross-org isolation: draining ORG_A never claims ORG_B rows', async () => {
    const h = makeHarness([
      makeRow({ id: ART_1, org_id: ORG_A }),
      makeRow({ id: ART_2, org_id: ORG_B, external_ref: 'file-2' }),
    ]);

    await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(h.rows.find((r) => r.id === ART_1)?.status).toBe('anchored');
    // ORG_B row untouched
    expect(h.rows.find((r) => r.id === ART_2)?.status).toBe('pending');
    // debit was only ever called for ORG_A
    for (const call of h.debit.mock.calls) {
      expect(call[0].orgId).toBe(ORG_A);
    }
  });

  it('cycle-level select failure: alerts (scope=cycle) and throws so Cloud Scheduler retries', async () => {
    // A select error must NOT be a silent drop. The drain surfaces it so the
    // cron route returns non-200 and Scheduler retries.
    function from() {
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        order() { return builder; },
        limit() { return Promise.resolve({ data: null, error: { message: 'boom' } }); },
      };
      return builder;
    }
    const alert = vi.fn();
    const deps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { from } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      materializeAnchor: vi.fn(),
      debitAndEnqueueAnchor: vi.fn(),
      batchAnchor: vi.fn(),
      emitAlert: alert,
    } as unknown as ConnectorArtifactDrainDeps;

    await expect(drainConnectorArtifactsForOrg(ORG_A, deps)).rejects.toThrow();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cycle', orgId: ORG_A }));
  });
});

describe('runConnectorArtifactDrain (cron entrypoint)', () => {
  it('enumerates orgs with drainable rows and drains each, aggregating results', async () => {
    const drainForOrg = vi.fn(async (orgId: string) =>
      orgId === ORG_A
        ? { claimed: 2, anchored: 2, failed: 0 }
        : { claimed: 1, anchored: 0, failed: 1 },
    );
    const listDrainableOrgIds = vi.fn(async () => [ORG_A, ORG_B]);

    const reapStale = vi.fn(async () => ({ reaped: 0 }));
    const result = await runConnectorArtifactDrain({ listDrainableOrgIds, drainForOrg, reapStale });

    expect(reapStale).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      skipped: false,
      orgsProcessed: 2,
      claimed: 3,
      anchored: 2,
      failed: 1,
    });
    expect(drainForOrg).toHaveBeenCalledWith(ORG_A);
    expect(drainForOrg).toHaveBeenCalledWith(ORG_B);
  });

  it('no-ops (skipped) when the flag is disabled', async () => {
    const drainForOrg = vi.fn();
    const listDrainableOrgIds = vi.fn();
    const result = await runConnectorArtifactDrain({
      enabled: false,
      listDrainableOrgIds,
      drainForOrg,
    });
    expect(result).toMatchObject({ skipped: true });
    expect(listDrainableOrgIds).not.toHaveBeenCalled();
    expect(drainForOrg).not.toHaveBeenCalled();
  });

  it('per-org drain failure is isolated: one org throws, the others still drain, no silent drop', async () => {
    const drainForOrg = vi
      .fn()
      .mockRejectedValueOnce(new Error('org A drain boom'))
      .mockResolvedValueOnce({ claimed: 1, anchored: 1, failed: 0 });
    const listDrainableOrgIds = vi.fn(async () => [ORG_A, ORG_B]);
    const emitAlert = vi.fn();

    const reapStale = vi.fn(async () => ({ reaped: 0 }));
    const result = await runConnectorArtifactDrain({ listDrainableOrgIds, drainForOrg, emitAlert, reapStale });

    expect(result.orgsProcessed).toBe(2);
    expect(result.orgsFailed).toBe(1);
    expect(result.anchored).toBe(1);
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cycle', orgId: ORG_A }));
  });
});

describe('reapStaleInFlightArtifacts (F-1 stuck-row reaper)', () => {
  const OLD = '2020-01-01T00:00:00.000Z';

  function makeReaperDb(rows: Array<{ id: string; org_id: string; status: string; updated_at: string }>, opts: { error?: string } = {}) {
    const calls: { patch?: Record<string, unknown>; inArg?: string[]; ltArg?: string } = {};
    const builder: Record<string, unknown> = {
      update(patch: Record<string, unknown>) { calls.patch = patch; return builder; },
      in(_c: string, vals: string[]) { calls.inArg = vals; return builder; },
      lt(_c: string, val: string) { calls.ltArg = val; return builder; },
      select() { return builder; },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (opts.error) return resolve({ data: null, error: { message: opts.error } });
        const matched = rows.filter((r) => (calls.inArg ?? []).includes(r.status) && r.updated_at < (calls.ltArg ?? ''));
        return resolve({ data: matched.map((r) => ({ id: r.id, org_id: r.org_id })), error: null });
      },
    };
    return { db: { from: () => builder } as unknown as ConnectorArtifactDrainDeps['db'], calls };
  }

  it('re-queues rows stranded in processing|materialized past the lease and alerts per row', async () => {
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rows = [
      { id: 'a1', org_id: ORG_A, status: 'processing', updated_at: OLD },
      { id: 'a2', org_id: ORG_A, status: 'materialized', updated_at: OLD },
      { id: 'a3', org_id: ORG_A, status: 'processing', updated_at: new Date().toISOString() },
    ];
    const { db, calls } = makeReaperDb(rows);
    const result = await reapStaleInFlightArtifacts({ db, logger, emitAlert, thresholdMs: 60_000 });
    expect(result.reaped).toBe(2);
    expect(calls.patch).toMatchObject({ status: 'queued' });
    expect(calls.inArg).toEqual(['processing', 'materialized']);
    expect(emitAlert).toHaveBeenCalledTimes(2);
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a1', reason: 'stale_inflight_requeued' }));
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a2', reason: 'stale_inflight_requeued' }));
  });

  it('returns reaped:0 and a cycle alert on db error, never throwing', async () => {
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { db } = makeReaperDb([], { error: 'boom' });
    const result = await reapStaleInFlightArtifacts({ db, logger, emitAlert });
    expect(result.reaped).toBe(0);
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cycle', reason: expect.stringContaining('reaper failed') }));
  });

  it('does not reap when nothing is past the lease', async () => {
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rows = [{ id: 'b1', org_id: ORG_A, status: 'processing', updated_at: new Date().toISOString() }];
    const { db } = makeReaperDb(rows);
    const result = await reapStaleInFlightArtifacts({ db, logger, emitAlert, thresholdMs: 60_000 });
    expect(result.reaped).toBe(0);
    expect(emitAlert).not.toHaveBeenCalled();
  });
});
