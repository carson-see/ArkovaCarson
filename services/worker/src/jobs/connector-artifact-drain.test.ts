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
  readAnchorStatus: ReturnType<typeof vi.fn>;
  listMaterializedArtifacts: ReturnType<typeof vi.fn>;
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

  // Default: the specific anchor has IRREVERSIBLY advanced (SUBMITTED + tx), so
  // the first-pass happy path marks the artifact `anchored`. Tests for the
  // "debited but not yet advanced (BROADCASTING/null-tx)" path inject their own
  // readAnchorStatus.
  const readAnchorStatus =
    (overrides.readAnchorStatus as ReturnType<typeof vi.fn>) ??
    vi.fn(async ({ anchorId }: { anchorId: string }) => ({ id: anchorId, status: 'SUBMITTED', chain_tx_id: 'tx-confirmed' }));

  // Default: no pre-existing materialized rows awaiting confirmation. Tests for
  // the confirmation step inject their own list.
  const listMaterializedArtifacts =
    (overrides.listMaterializedArtifacts as ReturnType<typeof vi.fn>) ?? vi.fn(async () => []);

  const alert = (overrides.emitAlert as ReturnType<typeof vi.fn>) ?? vi.fn();

  const deps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    materializeAnchor: materialize,
    debitAndEnqueueAnchor: debit,
    batchAnchor,
    readAnchorStatus,
    listMaterializedArtifacts,
    emitAlert: alert,
    ...overrides,
  } as unknown as ConnectorArtifactDrainDeps;

  return { rows, deps, materialize, debit, batchAnchor, readAnchorStatus, listMaterializedArtifacts, alert, claimAttempts };
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

  it('exactly-once: a row that passes the SELECT but loses the claim CAS is not anchored', async () => {
    // Model a real race: the row is DRAINABLE ('queued') so it is returned by the
    // candidate SELECT and claimRow() IS invoked — but a concurrent winner already
    // flipped it to 'processing', so the compare-and-set UPDATE matches zero rows.
    // This exercises the claim CAS loser path (seeding 'processing' would instead
    // drop the row at the SELECT and never hit claimRow, hiding a CAS regression).
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'queued' })]);

    // Flip the row to 'processing' the instant the claim UPDATE evaluates, so the
    // CAS `.in('status', ['pending','queued'])` filter no longer matches.
    let claimAttempted = false;
    const realFrom = h.deps.db.from.bind(h.deps.db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.deps.db as any).from = (table: string) => {
      const builder = realFrom(table);
      const origUpdate = builder.update.bind(builder);
      builder.update = (patch: Record<string, unknown>) => {
        if (patch.status === 'processing' && !claimAttempted) {
          claimAttempted = true;
          h.rows[0].status = 'processing'; // concurrent winner got there first
        }
        return origUpdate(patch);
      };
      return builder;
    };

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(claimAttempted).toBe(true); // claimRow() WAS exercised
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

  it('insufficient credits: debit fails → row REQUEUED (retryable), NOT failed; no batch-anchor; bounded requeue alert', async () => {
    // insufficient_credits is transient: the next daily drain must retry once
    // credits land. `failed` is NOT a drainable status, so marking failed would
    // strand the row permanently. It must land back in 'queued'.
    const debit = vi.fn(async () => ({ success: false, error: 'insufficient_credits' }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(1);
    expect(result.anchored).toBe(0);
    expect(h.batchAnchor).not.toHaveBeenCalled();
    // RETRYABLE: row is back in 'queued' (a drainable status), never terminal 'failed'.
    expect(h.rows[0].status).toBe('queued');
    expect(h.rows[0].status).not.toBe('failed');
    expect(h.alert).toHaveBeenCalledTimes(1);
    // bounded + PII-scrubbed: requeue reason, ids only, never raw bytes/fingerprint
    const alertArg = h.alert.mock.calls[0][0];
    expect(alertArg).toMatchObject({ orgId: ORG_A, artifactId: ART_1, reason: 'insufficient_credits_requeued' });
    expect(JSON.stringify(alertArg)).not.toContain(FP_1);
  });

  it('hard debit failure (non-insufficient_credits): row marked failed (terminal), bounded alert', async () => {
    // A hard/unexpected debit error is NOT retryable — it stays terminal 'failed'
    // for review, distinct from the insufficient_credits requeue path.
    const debit = vi.fn(async () => ({ success: false, error: 'debit_constraint_violation' }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(1);
    expect(result.anchored).toBe(0);
    expect(h.batchAnchor).not.toHaveBeenCalled();
    expect(h.rows[0].status).toBe('failed');
    expect(h.alert).toHaveBeenCalledTimes(1);
    const alertArg = h.alert.mock.calls[0][0];
    expect(alertArg).toMatchObject({ orgId: ORG_A, artifactId: ART_1, reason: 'debit_constraint_violation' });
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

  // ── FIX 1: lost-lease guarded transitions STOP the row ──────────────────────

  it('lost lease at materialized transition: STOPS the row — no debit/batch, no terminal count', async () => {
    // The row is claimed (queued→processing), but before the processing→
    // materialized transition persists, the reaper re-queues it (or another
    // worker reclaims it). The status-guarded markStatus then matches zero rows
    // → the loop must STOP this row: no debit, no batch, no count, no alert.
    const materialize = vi.fn(async () => {
      // simulate the reaper yanking the lease right after the claim: flip the
      // row off 'processing' so the guarded `.eq('status','processing')` misses.
      h.rows[0].status = 'queued';
      return { anchorId: ANCHOR_1, anchorPublicId: 'p' };
    });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'queued' })], { materializeAnchor: materialize });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.claimed).toBe(1); // the claim itself succeeded
    expect(result.anchored).toBe(0);
    expect(result.failed).toBe(0); // NOT counted as failed — the lease was lost
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.batchAnchor).not.toHaveBeenCalled();
    // no terminal alert for a transition that didn't persist
    expect(h.alert).not.toHaveBeenCalled();
    // the reaper's re-queue is left intact
    expect(h.rows[0].status).toBe('queued');
  });

  it('lost lease at mark-anchored transition: STOPS the row — anchored NOT counted', async () => {
    // Debit + batch + anchor-advance all succeed, but the materialized→anchored
    // transition matches zero rows (reaper/other worker took the row). The loop
    // must NOT count `anchored`.
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'queued' })]);
    // After the row reaches 'materialized', yank it to 'queued' so the guarded
    // materialized→anchored transition misses. Hook the anchor re-read (which
    // runs immediately before mark-anchored) to flip the row. The anchor IS
    // irreversibly advanced (SUBMITTED+tx) so the flow reaches mark-anchored.
    const readAnchorStatus = vi.fn(async ({ anchorId }: { anchorId: string }) => {
      h.rows[0].status = 'queued'; // reaper reclaimed the materialized row
      return { id: anchorId, status: 'SUBMITTED', chain_tx_id: 'tx-confirmed' };
    });
    h.deps.readAnchorStatus = readAnchorStatus as unknown as ConnectorArtifactDrainDeps['readAnchorStatus'];

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.anchored).toBe(0);
    expect(result.failed).toBe(0);
    expect(h.rows[0].status).toBe('queued'); // not clobbered to 'anchored'
  });

  // ── FIX 2/3: mark anchored ONLY on an IRREVERSIBLE advance ──────────────────

  it('irreversibly-advanced anchor (SUBMITTED + tx) → marked anchored', async () => {
    const readAnchorStatus = vi.fn(async ({ anchorId }: { anchorId: string }) => ({
      id: anchorId, status: 'SUBMITTED', chain_tx_id: 'tx-abc',
    }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { readAnchorStatus });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(readAnchorStatus).toHaveBeenCalledWith({ orgId: ORG_A, anchorId: ANCHOR_1 });
    expect(result.anchored).toBe(1);
    expect(h.rows[0].status).toBe('anchored');
  });

  it('FIX-3: debit ok but anchor only BROADCASTING (null tx) → stays materialized, NOT anchored', async () => {
    // The debit RPC itself moves the anchor PENDING→BROADCASTING. Bare
    // BROADCASTING (null tx) is REVERSIBLE (recover_stuck_broadcasts can reset it
    // to PENDING), so it must NOT be treated as advanced — the artifact stays
    // 'materialized' (awaiting the confirmation re-read), never terminal anchored.
    const batchAnchor = vi.fn(async () => ({ processed: 0, batchId: null, merkleRoot: null, txId: null }));
    const readAnchorStatus = vi.fn(async ({ anchorId }: { anchorId: string }) => ({
      id: anchorId, status: 'BROADCASTING', chain_tx_id: null,
    }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { batchAnchor, readAnchorStatus });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.anchored).toBe(0);
    expect(result.failed).toBe(0);
    // RETRYABLE via confirmation: left materialized, never anchored/failed/queued.
    expect(h.rows[0].status).toBe('materialized');
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, artifactId: ART_1, reason: 'anchor_pending_confirmation' }),
    );
    // debit happened exactly once (no re-debit on this pass)
    expect(h.debit).toHaveBeenCalledTimes(1);
  });

  it('post-debit throw (batch blows up after a successful charge) → left materialized for confirmation, NOT failed, NOT re-queued', async () => {
    // The debit succeeded (anchor BROADCASTING). A post-debit throw must NOT mark
    // the artifact terminal `failed` (a CHARGED anchor as failed) and must NOT
    // re-queue it (re-queue → re-debit hits the PENDING-expected RPC rejection on
    // a BROADCASTING anchor). It stays 'materialized'; the confirmation step owns
    // it from here.
    const batchAnchor = vi.fn(async () => { throw new Error('chain submit blew up'); });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { batchAnchor });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(0); // NOT counted failed — the charge stands
    expect(result.anchored).toBe(0);
    expect(h.debit).toHaveBeenCalledTimes(1);
    // left materialized (NOT re-queued, NOT failed) for the confirmation step.
    expect(h.rows[0].status).toBe('materialized');
    expect(h.rows[0].status).not.toBe('failed');
    expect(h.rows[0].status).not.toBe('queued');
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, artifactId: ART_1, reason: 'post_debit_error_left_materialized' }),
    );
  });

  it('first-pass anchor re-read returns null (anchor gone) → stays materialized', async () => {
    const readAnchorStatus = vi.fn(async () => null);
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { readAnchorStatus });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.anchored).toBe(0);
    expect(h.rows[0].status).toBe('materialized');
  });

  // ── FIX-3: CONFIRMATION step over prior-pass materialized rows ──────────────

  it('confirmation: a materialized row whose anchor now has a tx → promoted to anchored (no re-debit)', async () => {
    // A prior pass debited the anchor (BROADCASTING) and left the row
    // 'materialized'. This pass's confirmation re-reads the anchor — now
    // SUBMITTED+tx — and promotes the artifact to 'anchored' WITHOUT re-debiting.
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'materialized', anchor_id: ANCHOR_1 })], {
      listMaterializedArtifacts: vi.fn(async () => [{ id: ART_1, anchor_id: ANCHOR_1 }]),
      readAnchorStatus: vi.fn(async ({ anchorId }: { anchorId: string }) => ({ id: anchorId, status: 'SUBMITTED', chain_tx_id: 'tx-xyz' })),
    });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.confirmed).toBe(1);
    expect(result.anchored).toBe(1);
    expect(h.rows[0].status).toBe('anchored');
    // confirmation NEVER re-debits an in-flight anchor.
    expect(h.debit).not.toHaveBeenCalled();
  });

  it('confirmation: a materialized row whose anchor is still BROADCASTING (in flight) → left materialized, NOT re-queued, NOT re-debited', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'materialized', anchor_id: ANCHOR_1 })], {
      listMaterializedArtifacts: vi.fn(async () => [{ id: ART_1, anchor_id: ANCHOR_1 }]),
      readAnchorStatus: vi.fn(async ({ anchorId }: { anchorId: string }) => ({ id: anchorId, status: 'BROADCASTING', chain_tx_id: null })),
    });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.confirmed).toBe(0);
    expect(result.reconfirmRequeued).toBe(0);
    expect(h.rows[0].status).toBe('materialized'); // untouched
    expect(h.debit).not.toHaveBeenCalled(); // no re-debit of an in-flight BROADCASTING anchor
  });

  it('confirmation: a materialized row whose anchor was reset to PENDING → re-queued, then re-drives the debit in the same pass', async () => {
    // The confirmation step re-queues the row (anchor lost forward progress);
    // because 'queued' is drainable, the SAME pass's new-row drain re-claims and
    // re-debits it (the anchor is PENDING again, so the PENDING-expected debit is
    // accepted). End state is materialized again (re-debited, back in flight) —
    // confirmation produced the re-queue (reconfirmRequeued=1) + the alert, and
    // the debit was re-driven exactly once.
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'materialized', anchor_id: ANCHOR_1 })], {
      listMaterializedArtifacts: vi.fn(async () => [{ id: ART_1, anchor_id: ANCHOR_1 }]),
      // PENDING on the confirmation read (lost progress → requeue); after the
      // same-pass re-drive the row is left materialized (readAnchorStatus is also
      // consulted post-debit and still returns PENDING → not advanced).
      readAnchorStatus: vi.fn(async ({ anchorId }: { anchorId: string }) => ({ id: anchorId, status: 'PENDING', chain_tx_id: null })),
    });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.confirmed).toBe(0);
    expect(result.reconfirmRequeued).toBe(1);
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, artifactId: ART_1, reason: 'anchor_not_advanced_requeued' }),
    );
    // the re-queue made the row drainable again → re-claimed + re-debited once
    expect(result.claimed).toBe(1);
    expect(h.debit).toHaveBeenCalledTimes(1);
    expect(h.rows[0].status).toBe('materialized'); // re-debited, back in flight
  });
});

// Build a full ConnectorArtifactDrainResult (defaults the confirmation fields).
function drainResult(over: Partial<{ claimed: number; anchored: number; failed: number; confirmed: number; reconfirmRequeued: number }>) {
  return { claimed: 0, anchored: 0, failed: 0, confirmed: 0, reconfirmRequeued: 0, ...over };
}

describe('runConnectorArtifactDrain (cron entrypoint)', () => {
  it('enumerates orgs with drainable rows and drains each, aggregating results', async () => {
    const drainForOrg = vi.fn(async (orgId: string) =>
      orgId === ORG_A
        ? drainResult({ claimed: 2, anchored: 2 })
        : drainResult({ claimed: 1, failed: 1 }),
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
      .mockResolvedValueOnce(drainResult({ claimed: 1, anchored: 1 }));
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
    const calls: { patch?: Record<string, unknown>; eqStatus?: string; ltArg?: string } = {};
    const builder: Record<string, unknown> = {
      update(patch: Record<string, unknown>) { calls.patch = patch; return builder; },
      eq(col: string, val: string) { if (col === 'status') calls.eqStatus = val; return builder; },
      lt(_c: string, val: string) { calls.ltArg = val; return builder; },
      select() { return builder; },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (opts.error) return resolve({ data: null, error: { message: opts.error } });
        // The reaper re-queues ONLY 'processing' rows (materialized is owned by
        // the confirmation step). Model the `.eq('status', ...)` guard.
        const matched = rows.filter((r) => r.status === calls.eqStatus && r.updated_at < (calls.ltArg ?? ''));
        return resolve({ data: matched.map((r) => ({ id: r.id, org_id: r.org_id })), error: null });
      },
    };
    return { db: { from: () => builder } as unknown as ConnectorArtifactDrainDeps['db'], calls };
  }

  it('re-queues ONLY stranded processing rows past the lease — NEVER materialized (confirmation owns those)', async () => {
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rows = [
      { id: 'a1', org_id: ORG_A, status: 'processing', updated_at: OLD },
      // a materialized row (possibly an in-flight BROADCASTING anchor) is NOT
      // reaped — re-queuing it would force a re-debit the RPC rejects.
      { id: 'a2', org_id: ORG_A, status: 'materialized', updated_at: OLD },
      { id: 'a3', org_id: ORG_A, status: 'processing', updated_at: new Date().toISOString() },
    ];
    const { db, calls } = makeReaperDb(rows);
    const result = await reapStaleInFlightArtifacts({ db, logger, emitAlert, thresholdMs: 60_000 });
    expect(result.reaped).toBe(1); // only a1 (stale processing); a2 materialized is left alone
    expect(calls.patch).toMatchObject({ status: 'queued' });
    expect(calls.eqStatus).toBe('processing');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a1', reason: 'stale_inflight_requeued' }));
    // the stale materialized row was NOT reaped
    expect(emitAlert).not.toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a2' }));
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
