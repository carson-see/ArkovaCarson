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
import { callRpc } from '../utils/rpc.js';

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
  defaultListDrainableOrgIds,
  scrubReason,
  defaultMaterializeAnchor,
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
  updated_at: string;
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
    updated_at: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

function publishLinked(rows: Row[], captured: Pick<Row, 'id' | 'anchor_id'>) {
  const target = rows.find((row) => row.id === captured.id)!;
  const anchorId = target.anchor_id ?? (target.id === ART_2 ? ANCHOR_2 : ANCHOR_1);
  const created = target.anchor_id === null;
  Object.assign(target, { status: 'materialized', anchor_id: anchorId });
  return { outcome: 'linked' as const, anchorId, anchorPublicId: 'pub-1', created };
}

interface Harness {
  rows: Row[];
  deps: ConnectorArtifactDrainDeps;
  materialize: ReturnType<typeof vi.fn>;
  debit: ReturnType<typeof vi.fn>;
  resetUnclaimedConnectorBroadcasts: ReturnType<typeof vi.fn>;
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
    vi.fn(async (row: Row) => publishLinked(rows, row));

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

  const resetUnclaimedConnectorBroadcasts =
    (overrides.resetUnclaimedConnectorBroadcasts as ReturnType<typeof vi.fn>) ?? vi.fn(async () => 0);

  const deps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    materializeAnchor: materialize,
    debitAndEnqueueAnchor: debit,
    resetUnclaimedConnectorBroadcasts,
    batchAnchor,
    readAnchorStatus,
    listMaterializedArtifacts,
    emitAlert: alert,
    ...overrides,
  } as unknown as ConnectorArtifactDrainDeps;

  return { rows, deps, materialize, debit, resetUnclaimedConnectorBroadcasts, batchAnchor, readAnchorStatus, listMaterializedArtifacts, alert, claimAttempts };
}

beforeEach(() => vi.clearAllMocks());

describe('drainConnectorArtifactsForOrg', () => {
  it('lost debit response after commit preserves the linked artifact for idempotent recovery', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    const injected: Partial<ConnectorArtifactDrainDeps> = { ...h.deps };
    delete injected.debitAndEnqueueAnchor; // exercise the real default RPC adapter
    let committedDebits = 0;
    vi.mocked(callRpc).mockImplementationOnce(async (_db, name) => {
      expect(name).toBe('debit_and_enqueue_anchor');
      committedDebits += 1; // server commit occurs before the connection drops
      return { data: null, error: { message: 'fetch failed after committed debit' } };
    });
    const result = await drainConnectorArtifactsForOrg(ORG_A, injected);
    expect(committedDebits).toBe(1);
    expect(h.rows[0].status).toBe('materialized');
    expect(h.rows[0].anchor_id).toBe(ANCHOR_1);
    expect(result.failed).toBe(0);
    expect(h.batchAnchor).not.toHaveBeenCalled();
  });
  it.each([null, {}, { success: 'true' }, { success: false, error: 'unknown_future_reply' }])(
    'an unrecognized debit reply %j preserves the linked artifact', async (data) => {
      const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
      const injected: Partial<ConnectorArtifactDrainDeps> = { ...h.deps };
      delete injected.debitAndEnqueueAnchor;
      vi.mocked(callRpc).mockResolvedValueOnce({ data, error: null });
      const result = await drainConnectorArtifactsForOrg(ORG_A, injected);
      expect(h.rows[0].status).toBe('materialized');
      expect(h.rows[0].anchor_id).toBe(ANCHOR_1);
      expect(result.failed).toBe(0);
      expect(h.batchAnchor).not.toHaveBeenCalled();
      expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'debit_outcome_uncertain' }));
    },
  );


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

  it('design-C (mig 0353): resets stuck connector broadcasts to PENDING BEFORE the batch, so it claims+submits them promptly', async () => {
    const order: string[] = [];
    const reset = vi.fn(async () => { order.push('reset'); return 3; });
    const batchAnchor = vi.fn(async () => { order.push('batch'); return { processed: 3, batchId: 'b', merkleRoot: 'c'.repeat(64), txId: 't' }; });
    const debit = vi.fn(async () => { order.push('debit'); return { success: true }; });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], {
      debitAndEnqueueAnchor: debit,
      resetUnclaimedConnectorBroadcasts: reset,
      batchAnchor,
    });

    await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    // The reset runs org-scoped, AFTER the charge (never touches it) and BEFORE
    // the batch (so the batch claims the just-reset PENDING anchors and submits).
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
    expect(order).toEqual(['debit', 'reset', 'batch']);
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

  // SECURITY (code-review finding, 2026-09-01): cross-file TOCTOU regression.
  // Simulates the real attack/failure sequence: a forged inbound row wins the
  // ON CONFLICT DO NOTHING race and is picked up by the candidate SELECT, but
  // `docusign-envelope-completed.ts`'s F1-heal (its OWN `WHERE anchor_id IS
  // NULL` UPDATE, which can land on an unclaimed row at any time) overwrites
  // the fingerprint + strips the declared-inbound markers BEFORE this row's
  // claim CAS runs. The materialized anchor must carry the HEALED (verified)
  // fingerprint and metadata — never the forged batch-read snapshot. This test
  // would have FAILED against the pre-fix code, which passed the id-only
  // candidate list's era of `row` — i.e. content read once, at batch-SELECT
  // time — straight into materialization, bypassing whatever `claimRow`'s own
  // CAS UPDATE actually saw.
  it('TOCTOU regression: materializes from the row content AS OF THE CLAIM, not the batch-read snapshot, when a provenance heal lands in between', async () => {
    const FORGED_FP = 'f'.repeat(64);
    const VERIFIED_FP = 'e'.repeat(64);
    const row = makeRow({
      id: ART_1,
      org_id: ORG_A,
      status: 'queued',
      fingerprint_sha256: FORGED_FP,
      metadata: { _direction: 'inbound', _sending_account_id: 'acct-FOREIGN' },
    });
    const h = makeHarness([row]);

    // Intercept the candidate SELECT's terminal `limit()`. The instant it
    // resolves — i.e. the instant the batch-read snapshot has been taken —
    // apply the SAME mutation `docusign-envelope-completed.ts`'s auto-heal
    // makes to the row: overwrite `fingerprint_sha256` with the verified
    // value and strip the declared-inbound markers. This models real async
    // time elapsing between the batch-read and THIS row's claim
    // (`resolveOrgActorUserId`, `findExistingEnvelopeAnchor`, and — in a
    // multi-row batch — every earlier row's own awaits), during which the
    // heal can land.
    let healApplied = false;
    const realFrom = h.deps.db.from.bind(h.deps.db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.deps.db as any).from = (table: string) => {
      const builder = realFrom(table);
      const origLimit = builder.limit.bind(builder);
      builder.limit = async (n: number) => {
        const result = await origLimit(n);
        if (!healApplied) {
          healApplied = true;
          h.rows[0].fingerprint_sha256 = VERIFIED_FP;
          delete (h.rows[0].metadata as Record<string, unknown>)._direction;
          delete (h.rows[0].metadata as Record<string, unknown>)._sending_account_id;
        }
        return result;
      };
      return builder;
    };

    const materialize = vi.fn(async (r: Row) => publishLinked(h.rows, r));
    h.deps.materializeAnchor = materialize as unknown as ConnectorArtifactDrainDeps['materializeAnchor'];

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(healApplied).toBe(true);
    expect(result.claimed).toBe(1);
    expect(materialize).toHaveBeenCalledTimes(1);

    // The materializer — and therefore the minted anchor's fingerprint — saw
    // the VERIFIED value, never the forged one the batch SELECT observed.
    const materializedRow = materialize.mock.calls[0][0] as Row;
    expect(materializedRow.fingerprint_sha256).toBe(VERIFIED_FP);
    expect(materializedRow.fingerprint_sha256).not.toBe(FORGED_FP);

    // The heal already stripped `_direction`, so `defaultMaterializeAnchor`'s
    // `isInboundDeclaredHash` check (which reads `_direction` fresh from
    // whatever row it is GIVEN) would see no declared-inbound marker here —
    // the anchor is never stamped 'issuer_record_attestation' for a row this
    // pass has ALREADY reconciled to a measured value. (`defaultMaterializeAnchor`
    // itself never asserts the literal 'document_bytes' — §1.5/R19: it did not
    // do the fetch, so it must not assert a class it did not measure — but the
    // property under test is the one that matters here: a healed row must
    // never be mis-classified as a declared/attested source.)
    expect(materializedRow.metadata._direction).toBeUndefined();

    // Full pipeline completed on the VERIFIED value — the row reached the
    // terminal `anchored` state via the real anchor, not a forged one.
    expect(h.rows[0].status).toBe('anchored');
    expect(h.rows[0].anchor_id).toBe(ANCHOR_1);
  });

  // SQL validation runs under a row lock before any anchor publication. These
  // caller tests assert that a rejection cannot trigger debit or a stale write;
  // the actual transaction interleavings have separate PostgreSQL coverage.
  it.each(['fingerprint', 'metadata', 'version'] as const)(
    'atomic rejection after a %s heal leaves the newer row untouched', async (changed) => {
      const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
      let healed: Row | undefined;
      h.deps.materializeAnchor = async () => {
        if (changed === 'fingerprint') h.rows[0].fingerprint_sha256 = FP_2;
        if (changed === 'metadata') h.rows[0].metadata = { verified: true };
        if (changed === 'version') h.rows[0].updated_at = '2026-09-05T10:00:00Z';
        healed = structuredClone(h.rows[0]);
        return { outcome: 'superseded' };
      };
      const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
      expect(h.rows[0]).toEqual(healed);
      expect(h.rows[0].anchor_id).toBeNull();
      expect(h.debit).not.toHaveBeenCalled();
      expect(h.batchAnchor).not.toHaveBeenCalled();
      expect(result).toMatchObject({ anchored: 0, failed: 0, supersededRequeued: 0 });
      expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'artifact_snapshot_rejected' }));
    },
  );

  it('stale processing lease cannot requeue or fail a newly acquired processing lease', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    let newer: Row | undefined;
    h.deps.materializeAnchor = async () => {
      // Reaper + another claim is an ABA status transition: the status is again
      // processing, but the old caller must not change this newer generation.
      h.rows[0].updated_at = '2026-09-05T11:00:00Z';
      h.rows[0].metadata = { owner: 'new-lease' };
      newer = structuredClone(h.rows[0]);
      return { outcome: 'superseded' };
    };
    await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(h.rows[0]).toEqual(newer);
    expect(h.debit).not.toHaveBeenCalled();
  });

  it('lost lease leaves a reaper-requeued row untouched and raises a bounded diagnostic', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    h.deps.materializeAnchor = async () => {
      h.rows[0].status = 'queued';
      return { outcome: 'lost_lease' };
    };
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(h.rows[0].status).toBe('queued');
    expect(result).toMatchObject({ anchored: 0, failed: 0 });
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.batchAnchor).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'artifact_materialization_uncertain' }));
  });

  it('an unchanged snapshot publishes, links, debits and anchors', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(result).toMatchObject({ claimed: 1, anchored: 1, supersededRequeued: 0 });
    expect(h.rows[0].anchor_id).toBe(ANCHOR_1);
    expect(h.debit).toHaveBeenCalledTimes(1);
  });

  it('charge-happens-once-at-securing: never debits at enqueue/claim, only after materialize', async () => {
    const order: string[] = [];
    const materialize = vi.fn(async (row: import('./connector-artifact-drain.js').ConnectorArtifactRow) => { order.push('materialize'); return publishLinked(h.rows, row); });
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

  it('a post-publication error cannot fail a newer processing lease', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    let newer: Row | undefined;
    h.deps.debitAndEnqueueAnchor = async () => {
      h.rows[0].status = 'processing';
      h.rows[0].updated_at = '2026-09-05T12:00:00Z';
      h.rows[0].metadata = { owner: 'new-lease' };
      newer = structuredClone(h.rows[0]);
      throw new Error('late old-client response');
    };
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(h.rows[0]).toEqual(newer);
    expect(result.failed).toBe(0);
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

  // Regression — PROD 2026-08-02T00:41:53Z, artifact 921347cc, org 40383eb2.
  // A row failed with `envelope anchor lookup failed: canceling statement due to
  // statement timeout` and the DATABASE RECORDED NOTHING: `markFailed` accepted
  // a `reason` and never persisted it. The only surviving copy of the cause was
  // a Sentry alert. A terminal `failed` artifact must carry its own reason —
  // that is the row an operator triages.
  it('a thrown debit request preserves recovery and logs the bounded cause with its stack', async () => {
    const debit = vi.fn(async () => {
      throw new Error('envelope anchor lookup failed: canceling statement due to statement timeout');
    });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(0);
    expect(h.rows[0].status).toBe('materialized');
    expect(h.rows[0].metadata.drain_error).toBeUndefined();

    // 2. The log line carries BOTH the bounded reason AND the error object, so
    //    the stack survives. utils/logger.ts registers redactErrorSerializer for
    //    the `err`/`error` keys, so logging the object is safe; dropping it would
    //    lose the only thing that localises a TypeError deeper in the drain.
    const loggerErr = h.deps.logger.error as unknown as { mock: { calls: unknown[][] } };
    const errorCall = loggerErr.mock.calls.find(
      (c: unknown[]) => String(c[1]).includes('debit outcome uncertain'),
    );
    expect(errorCall).toBeDefined();
    const logged = errorCall![0] as Record<string, unknown>;
    expect(String(logged.reason)).toContain('statement timeout');
    expect(logged.err).toBeInstanceOf(Error);
    expect((logged.err as Error).stack).toBeTruthy();
  });

  // F1 — the DEBIT-failure path reaches markFailed via handleDebitFailure with a
  // `{success:false}` result, NOT via a throw, so the tests above never covered
  // it. It passed the raw PostgREST/Postgres `error.message` straight through.
  // Postgres constraint-violation text routinely echoes the offending VALUE, and
  // migration 0343 grants `SELECT ON connector_artifact TO authenticated`
  // (`connector_artifact_org_select`) — so an unbounded raw DB string here is
  // readable by every member of the org.
  it('bounds a raw DB error from the debit path before it reaches the org-readable row', async () => {
    const rawDbError = 'duplicate key value violates unique constraint "x": Key (email)=('
      + 'victim@example.com) already exists. ' + 'B'.repeat(5000);
    const debit = vi.fn(async () => ({ success: false, error: rawDbError }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(1);
    expect(h.rows[0].status).toBe('failed');
    const persisted = (h.rows[0].metadata as Record<string, unknown>).drain_error as string;
    expect(typeof persisted).toBe('string');
    expect(persisted.length).toBeLessThanOrEqual(600);
    expect(persisted).not.toContain('victim@example.com');
  });

  it('never lets a failure reason carry raw bytes or unbounded vendor output', async () => {
    const debit = vi.fn(async () => {
      throw new Error('boom ' + 'A'.repeat(5000) + ' \u0000\u0001\u0002');
    });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(h.rows[0].status).toBe('materialized');
    expect(h.rows[0].metadata.drain_error).toBeUndefined();
    const logged = vi.mocked(h.deps.logger.error).mock.calls[0][0] as { reason: string };
    expect(logged.reason.length).toBeLessThanOrEqual(200);
  });

  it('anchor_not_in_expected_status + anchor ALREADY ADVANCED: promote to anchored, NEVER failed (idempotent, no re-charge)', async () => {
    // Regression (found in T3 soak @ ~10k/hr: ~12k artifacts wrongly marked
    // `failed` whose anchors were SECURED/SUBMITTED). A concurrent cycle advanced
    // THIS anchor past PENDING before the first-pass debit, so the RPC rejects
    // with `anchor_not_in_expected_status` — BEFORE charging (idempotent on
    // anchor id, no charge lost). The securing already happened: the row must be
    // promoted to `anchored`, not stranded `failed`.
    const debit = vi.fn(async () => ({ success: false, error: 'anchor_not_in_expected_status' }));
    // default readAnchorStatus → { status: 'SUBMITTED', chain_tx_id: 'tx-confirmed' } (advanced)
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(h.readAnchorStatus).toHaveBeenCalledWith({ orgId: ORG_A, anchorId: ANCHOR_1 });
    expect(result.anchored).toBe(1);
    expect(result.failed).toBe(0);
    expect(h.rows[0].status).toBe('anchored');
    expect(h.rows[0].status).not.toBe('failed');
  });

  it('anchor_not_in_expected_status + anchor still IN FLIGHT (BROADCASTING): left materialized for confirmation, NOT failed', async () => {
    const debit = vi.fn(async () => ({ success: false, error: 'anchor_not_in_expected_status' }));
    const readAnchorStatus = vi.fn(async ({ anchorId }: { anchorId: string }) => ({
      id: anchorId,
      status: 'BROADCASTING',
      chain_tx_id: null,
    }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], {
      debitAndEnqueueAnchor: debit,
      readAnchorStatus,
    });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(0);
    expect(result.anchored).toBe(0);
    // Left materialized (retryable via confirmation), never terminal failed.
    expect(h.rows[0].status).toBe('materialized');
    expect(h.rows[0].status).not.toBe('failed');
  });

  it('partial-failure isolation: uncertain publication stays recoverable and the next row drains', async () => {
    const h = makeHarness([
      makeRow({ id: ART_1, org_id: ORG_A }),
      makeRow({ id: ART_2, org_id: ORG_A, external_ref: 'file-2', fingerprint_sha256: FP_2 }),
    ]);
    h.deps.materializeAnchor = async (row) => {
      if (row.id === ART_1) throw new Error('publication response lost');
      return publishLinked(h.rows, row);
    };
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(result).toMatchObject({ claimed: 2, failed: 0, anchored: 1 });
    expect(h.rows[0].status).toBe('processing');
    expect(h.rows[0].anchor_id).toBeNull();
    expect(h.rows[1].status).toBe('anchored');
    expect(h.debit).toHaveBeenCalledTimes(1);
    expect(h.debit).toHaveBeenCalledWith({ orgId: ORG_A, anchorId: ANCHOR_2 });
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ artifactId: ART_1, reason: 'artifact_materialization_uncertain' }));
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

  it('SCRUM-2625 F-3: the FINAL post-debit confirmation re-read throwing (not just batchAnchor) also leaves the row materialized, NOT failed', async () => {
    // Same invariant as the batchAnchor-throws case above, but pinning a
    // DIFFERENT post-debit step: readAnchorStatus (the confirmation re-read
    // that decides whether to mark the artifact terminal `anchored`). The
    // debit already succeeded (charge landed, anchor BROADCASTING) BEFORE this
    // call runs, so a throw here must hit the same debitSucceeded guard as any
    // other post-debit failure — never mis-marking a charged artifact `failed`.
    const readAnchorStatus = vi.fn(async () => { throw new Error('db connection reset'); });
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { readAnchorStatus });

    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.failed).toBe(0);
    expect(result.anchored).toBe(0);
    expect(h.debit).toHaveBeenCalledTimes(1);
    expect(h.rows[0].status).toBe('materialized');
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
function drainResult(over: Partial<{ claimed: number; anchored: number; failed: number; confirmed: number; reconfirmRequeued: number; supersededRequeued: number }>) {
  return { claimed: 0, anchored: 0, failed: 0, confirmed: 0, reconfirmRequeued: 0, supersededRequeued: 0, ...over };
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

  it('org-enumeration failure propagates (rejects) so the route returns 500 and Scheduler retries — NOT a green zero-org pass', async () => {
    // The enumerator is the only org-discovery path; if it throws (broken RPC),
    // runConnectorArtifactDrain must reject (not swallow → green skipped:false /
    // orgsProcessed:0), so the /jobs route's catch returns non-2xx.
    const listDrainableOrgIds = vi.fn(async () => {
      throw new Error('connector-artifact org enumeration failed: rpc boom');
    });
    const drainForOrg = vi.fn();
    const reapStale = vi.fn(async () => ({ reaped: 0 }));
    await expect(
      runConnectorArtifactDrain({ listDrainableOrgIds, drainForOrg, reapStale }),
    ).rejects.toThrow(/org enumeration failed/);
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

  // ── SCRUM-2625 / QUEUE-10 F-1: worker-kill simulation + credit-safety ───────
  it('worker-kill simulation: a row stuck in processing is recovered by the reaper AND the next drain pass re-claims + completes it exactly once, with exactly ONE debit call', async () => {
    // Simulate a crash between claim (pending → processing) and the
    // processing → materialized transition: the row is left in 'processing'
    // with a stale updated_at, and — because materialize/debit run strictly
    // AFTER that transition in the real pipeline — NO debit has happened yet
    // for this row. This is the structural reason the reaper is safe to
    // re-drive: 'processing' rows are always pre-debit.
    const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const reaperRows = [{ id: ART_1, org_id: ORG_A, status: 'processing', updated_at: STALE }];
    const { db: reaperDb } = (() => {
      const calls: { patch?: Record<string, unknown>; eqStatus?: string; ltArg?: string } = {};
      const builder: Record<string, unknown> = {
        update(patch: Record<string, unknown>) { calls.patch = patch; return builder; },
        eq(col: string, val: string) { if (col === 'status') calls.eqStatus = val; return builder; },
        lt(_c: string, val: string) { calls.ltArg = val; return builder; },
        select() { return builder; },
        then(resolve: (v: { data: unknown; error: unknown }) => void) {
          const matched = reaperRows.filter((r) => r.status === calls.eqStatus && r.updated_at < (calls.ltArg ?? ''));
          for (const r of matched) r.status = 'queued'; // model the actual re-queue write
          return resolve({ data: matched.map((r) => ({ id: r.id, org_id: r.org_id })), error: null });
        },
      };
      return { db: { from: () => builder } as unknown as ConnectorArtifactDrainDeps['db'] };
    })();

    // 1) Reaper runs first (as it does at the head of every cron pass) and
    // recovers the stranded row: no lost row, re-queued to 'queued'.
    const reapResult = await reapStaleInFlightArtifacts({ db: reaperDb, logger, emitAlert, thresholdMs: 15 * 60 * 1000 });
    expect(reapResult.reaped).toBe(1);
    expect(reaperRows[0].status).toBe('queued'); // row is NOT lost — recovered to a drainable status

    // 2) The next drain pass re-claims the now-'queued' row and drives it
    // through to completion. Assert the debit (the ONLY credit-charging call
    // in this pipeline) fires EXACTLY ONCE — the worker-kill + reap cycle must
    // never cause a double-charge, because the crash happened pre-debit.
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A, status: 'queued' })]);
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(result.claimed).toBe(1);
    expect(result.anchored).toBe(1);
    expect(h.debit).toHaveBeenCalledTimes(1); // exactly-once charge — no double-debit from the recovery
    expect(h.rows[0].status).toBe('anchored');
  });

  it('worker-kill simulation: reaper never touches a materialized (already-debited) row — asserting the credit_deduction_id / anchor_id interaction is untouched', async () => {
    // A row that crashed AFTER the debit (now 'materialized', already charged,
    // anchor BROADCASTING) must be structurally excluded from the reaper's
    // blast radius — re-queuing it would force debit_and_enqueue_anchor to be
    // called a second time on an anchor that is no longer PENDING (rejected by
    // the RPC's p_expected_status guard, but the SAFEST possible fix is to never
    // attempt it). This test pins that the reaper's own DB update never selects
    // a materialized row, so no debit path is ever re-entered for it.
    const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const emitAlert = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rows = [
      {
        id: ART_2,
        org_id: ORG_A,
        status: 'materialized', // already debited: has an anchor_id + credit_deduction_id in prod
        updated_at: STALE,
      },
    ];
    const { db, calls } = makeReaperDb(rows);
    const result = await reapStaleInFlightArtifacts({ db, logger, emitAlert, thresholdMs: 15 * 60 * 1000 });

    expect(result.reaped).toBe(0); // NOT reaped — no lost row here, but also no re-debit risk
    expect(calls.eqStatus).toBe('processing'); // the reaper's guard column is hard-pinned to 'processing'
    expect(rows[0].status).toBe('materialized'); // untouched: still charged, still in flight
  });
});

describe('defaultListDrainableOrgIds (QUEUE-09 fair server-side org enum)', () => {
  const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  /**
   * Minimal `db.rpc('list_drainable_connector_orgs', …)`-shaped mock. The RPC
   * returns `SETOF uuid`, which supabase-js surfaces as an array of plain
   * strings. We capture the rpc name + args so the fairness/limit contract can
   * be asserted, and we do NOT model `.from(...)` — the whole point of QUEUE-09
   * is that the enumerator no longer scans rows, so any `.from` usage is a bug.
   */
  function makeRpcDb(opts: {
    result?: unknown;
    error?: string;
  }): {
    db: ConnectorArtifactDrainDeps['db'];
    calls: Array<{ fn: string; args: unknown }>;
  } {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const db = {
      from() {
        throw new Error('defaultListDrainableOrgIds must NOT scan rows via .from — it must call the RPC');
      },
      rpc(fn: string, args: unknown) {
        calls.push({ fn, args });
        return Promise.resolve(
          opts.error
            ? { data: null, error: { message: opts.error } }
            : { data: opts.result ?? [], error: null },
        );
      },
    } as unknown as ConnectorArtifactDrainDeps['db'];
    return { db, calls };
  }

  it('returns exactly the org_ids the RPC yields (no row scan, no in-memory dedup window)', async () => {
    const { db, calls } = makeRpcDb({ result: [ORG_A, ORG_B, ORG_C] });
    const orgIds = await defaultListDrainableOrgIds(db);
    expect(orgIds).toEqual([ORG_A, ORG_B, ORG_C]);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('list_drainable_connector_orgs');
    expect(calls[0].args).toMatchObject({ p_limit: expect.any(Number) });
  });

  it('fairness: a noisy org and a quiet org are BOTH enumerated — the noisy one cannot crowd out the quiet one', async () => {
    // The RPC returns DISTINCT orgs (GROUP BY org_id), so a noisy org with
    // thousands of drainable rows contributes exactly ONE entry. The old
    // 5000-row scan would have filled its window entirely with the noisy org's
    // rows and never surfaced the quiet org. Here BOTH appear, with the org
    // whose oldest work waited longest first (ORDER BY min(created_at)).
    const NOISY = ORG_A; // imagine >5000 drainable rows server-side
    const QUIET = ORG_B; // a single, older, drainable row
    const { db } = makeRpcDb({ result: [QUIET, NOISY] });
    const orgIds = await defaultListDrainableOrgIds(db);
    expect(orgIds).toContain(NOISY);
    expect(orgIds).toContain(QUIET);
    // The noisy org appears exactly once — it did not consume the whole window.
    expect(orgIds.filter((o) => o === NOISY)).toHaveLength(1);
  });

  it('enumerates a materialized-ONLY org so its confirmation pass can run (QUEUE-06 #1366 reconciliation)', async () => {
    // The RPC's WHERE is status IN ('pending','queued','materialized'), so an org
    // with NO new rows but a prior-pass 'materialized' row (anchor in flight,
    // awaiting confirmMaterializedArtifacts) is STILL returned. If it weren't, the
    // in-flight anchor would never be promoted to 'anchored' — stuck forever.
    const MATERIALIZED_ONLY = ORG_C;
    const DRAINABLE = ORG_A;
    // The server-side predicate is what surfaces the materialized-only org; the
    // mock returns what the RPC would yield for that predicate.
    const { db } = makeRpcDb({ result: [MATERIALIZED_ONLY, DRAINABLE] });
    const orgIds = await defaultListDrainableOrgIds(db);
    expect(orgIds).toContain(MATERIALIZED_ONLY);
    expect(orgIds).toContain(DRAINABLE);
  });

  it('fails LOUD on RPC error: emits a cycle alert and THROWS (no green empty no-op that hides a broken RPC)', async () => {
    const { db } = makeRpcDb({ error: 'rpc boom' });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const emitAlert = vi.fn();
    // A broken/missing list_drainable_connector_orgs RPC (migration unapplied,
    // grant missing, stale schema cache) must NOT report success while draining
    // zero orgs — it must surface as a cycle failure → route 500 → Scheduler retry.
    await expect(defaultListDrainableOrgIds(db, { logger, emitAlert })).rejects.toThrow(/org enumeration failed/);
    expect(emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'cycle', orgId: 'ALL', reason: expect.stringContaining('rpc boom') }),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('fails LOUD when db.rpc is unavailable: cycle alert + throw (misconfiguration, not a transient skip)', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const emitAlert = vi.fn();
    const db = {
      from() {
        throw new Error('must not scan');
      },
    } as unknown as ConnectorArtifactDrainDeps['db'];
    await expect(defaultListDrainableOrgIds(db, { logger, emitAlert })).rejects.toThrow(/db\.rpc unavailable/);
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cycle', orgId: 'ALL' }));
  });

  it('passes a bounded default p_limit (cap on ORGS, not rows)', async () => {
    const { db, calls } = makeRpcDb({ result: [] });
    await defaultListDrainableOrgIds(db);
    const args = calls[0].args as { p_limit: number };
    expect(args.p_limit).toBeGreaterThan(0);
    expect(args.p_limit).toBeLessThanOrEqual(1000);
  });
});

describe('scrubReason (SCRUM-2625 / QUEUE-10 F-4 reason-scrub)', () => {
  // CLAUDE.md §1.6A: no fingerprint or PII may leak into logs/Sentry/alerts.
  // `reason` strings on this drain path originate from raw DB/RPC/Error
  // `.message` values (Postgres error text can echo back literal query
  // parameters, e.g. a duplicate-key violation quoting the offending column
  // value). Truncation alone (the pre-existing `boundReason`) does not
  // remove sensitive content that fits within the length cap — it must be
  // categorized/redacted, not merely shortened.

  it('a raw DB error message containing a fingerprint-looking 64-hex sha256 string does NOT appear verbatim in the scrubbed reason', () => {
    const fakeFingerprint = 'f'.repeat(64); // fingerprint-shaped (CLAUDE.md §1.6/§1.6A protected)
    const raw = `duplicate key value violates unique constraint "anchors_fingerprint_key" Key (fingerprint)=(${fakeFingerprint}) already exists.`;
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain(fakeFingerprint);
    expect(scrubbed.length).toBeLessThanOrEqual(200);
  });

  it('a raw DB error message containing an email address does NOT appear verbatim in the scrubbed reason', () => {
    const raw = 'insert failed: user carson@arkova.io violates check constraint "org_members_email_check"';
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain('carson@arkova.io');
  });

  it('a raw DB error message containing a UUID (potential org_id/anchor_id/user_id leak) does NOT appear verbatim', () => {
    const raw = `update failed for row ${ANCHOR_1}: foreign key violation referencing org ${ORG_A}`;
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain(ANCHOR_1);
    expect(scrubbed).not.toContain(ORG_A);
  });

  // ── PR #1434 review (Carson, P2): case-insensitivity must be STRUCTURAL ─────
  // User/provider values preserve casing (Carson@Arkova.io, uppercase UUIDs in
  // Postgres error text, hex values uppercased by intermediate tooling). The
  // §1.6A guarantee cannot depend on input normalization — over-redaction of an
  // alert reason is harmless, under-redaction is a privacy leak. These tests pin
  // the `i` flag on all three patterns so it can never be dropped in a refactor.

  it('a MIXED-CASE email address (Carson@Arkova.io) does NOT appear verbatim in the scrubbed reason', () => {
    const raw = 'insert failed: user Carson@Arkova.io violates check constraint "org_members_email_check"';
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain('Carson@Arkova.io');
    expect(scrubbed).toContain('[email]');
  });

  it('an UPPERCASE-domain email (ops@ARKOVA.IO) does NOT appear verbatim in the scrubbed reason', () => {
    const raw = 'mail bounce recorded for ops@ARKOVA.IO on connector callback';
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain('ops@ARKOVA.IO');
    expect(scrubbed).toContain('[email]');
  });

  it('an UPPERCASE UUID does NOT appear verbatim in the scrubbed reason', () => {
    const upperUuid = ANCHOR_1.toUpperCase();
    const raw = `update failed for row ${upperUuid}: foreign key violation`;
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain(upperUuid);
    expect(scrubbed).toContain('[uuid]');
  });

  it('an UPPERCASE 64-hex fingerprint-shaped string does NOT appear verbatim (case-insensitive by design: over-redaction is harmless, under-redaction is a §1.6A leak)', () => {
    const upperFingerprint = 'A1B2C3D4'.repeat(8); // 64 hex chars, uppercase
    const raw = `duplicate key: Key (fingerprint)=(${upperFingerprint}) already exists`;
    const scrubbed = scrubReason(raw);
    expect(scrubbed).not.toContain(upperFingerprint);
    expect(scrubbed).toContain('[fingerprint]');
  });

  it('a known-safe coarse category string (e.g. "insufficient_credits") passes through unchanged', () => {
    expect(scrubReason('insufficient_credits')).toBe('insufficient_credits');
    expect(scrubReason('anchor_not_in_expected_status')).toBe('anchor_not_in_expected_status');
    expect(scrubReason('post_debit_error_left_materialized')).toBe('post_debit_error_left_materialized');
    expect(scrubReason('stale_inflight_requeued')).toBe('stale_inflight_requeued');
  });

  it('still bounds length after scrubbing (defense in depth alongside redaction)', () => {
    const raw = `boom ${'x'.repeat(500)} ${'a'.repeat(64)}`;
    const scrubbed = scrubReason(raw);
    expect(scrubbed.length).toBeLessThanOrEqual(200);
  });

  it('defaultEmitAlert-facing path: emitAlert receives a scrubbed reason, never the raw injected DB message, for a row-scoped failure', async () => {
    // End-to-end through the real drain: inject a debit failure whose `.error`
    // is a raw-shaped string carrying a fake fingerprint, and assert the alert
    // payload's `reason` field never contains it verbatim.
    const fakeFingerprint = 'e'.repeat(64);
    const debit = vi.fn(async () => ({
      success: false,
      error: `debit_and_enqueue_anchor failed: constraint violation on fingerprint ${fakeFingerprint}`,
    }));
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })], { debitAndEnqueueAnchor: debit });

    await drainConnectorArtifactsForOrg(ORG_A, h.deps);

    expect(h.alert).toHaveBeenCalled();
    const alertedReasons = h.alert.mock.calls.map((c: unknown[]) => (c[0] as { reason?: string }).reason ?? '');
    for (const reason of alertedReasons) {
      expect(reason).not.toContain(fakeFingerprint);
    }
  });
});

// docusign-bilateral-2026-08 (feasibility spike, flag-off, not going live this
// cycle): defaultMaterializeAnchor's inbound declared-hash branch. A dedicated
// generic chainable+thenable stub (distinct from the connector_artifact-table
// harness above) because this function's own dependencies are org_members
// (actor resolution), anchors (envelope-guard lookups), and atomic publication
// — a different table shape than the rest of this file exercises.
// MERGE NOTE (origin/main bd72f65ff <- this branch): main's CTO ruling R2 made
// `fingerprint_source` REQUIRED on every row this drain materializes, defaulting
// to 'document_bytes' (it is no longer omitted/NULL for non-inbound rows). The
// two "OMITS ..." cases below were written against the pre-R2 behavior and now
// assert the R2 default instead. The inbound declared-hash case is unchanged and
// remains the only producer of 'issuer_record_attestation'.
describe('defaultMaterializeAnchor — fingerprint_source (R19 / migration 0376; R2 default)', () => {
  /** A chainable object whose every method returns itself, and which resolves `result` when awaited at any point in the chain. */
  function chainable(result: { data: unknown; error: unknown }) {
    const obj: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'is', 'neq', 'in', 'order', 'limit', 'insert'];
    for (const m of methods) {
      obj[m] = vi.fn(() => obj);
    }
    obj.maybeSingle = vi.fn(async () => result);
    obj.single = vi.fn(async () => result);
    obj.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return obj;
  }

  function makeDb(args: {
    insertResult: { data: { id: string; public_id: string }; error: unknown };
    insertSpy: (payload: unknown) => void;
  }) {
    vi.mocked(callRpc).mockImplementation(async (_db, name, rpcArgs) => {
      expect(name).toBe('materialize_connector_artifact_anchor');
      args.insertSpy(rpcArgs!.p_anchor_payload);
      return { data: { outcome: 'linked', anchor_id: ANCHOR_1,
        public_id: args.insertResult.data.public_id, created: true }, error: null };
    });
    const from = vi.fn((table: string) => {
      if (table === 'org_members') return chainable({ data: { user_id: MATERIALIZE_USER_ID, role: 'owner' }, error: null });
      if (table === 'anchors') return chainable({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    return { from };
  }

  const MATERIALIZE_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const BASE_ROW = {
    id: ART_1,
    org_id: ORG_A,
    status: 'pending',
    fingerprint_sha256: 'a'.repeat(64),
    byte_length: null,
    source: 'docusign',
    external_ref: 'env-inbound-1',
    anchor_id: null,
    credit_deduction_id: null,
    updated_at: '2026-09-02T00:00:00.000Z',
  };

  it('sets fingerprint_source=issuer_record_attestation when metadata._direction is inbound', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({
      insertResult: { data: { id: 'anchor-inbound-1', public_id: 'ARK-INBOUND-1' }, error: null },
      insertSpy,
    });

    const result = await defaultMaterializeAnchor(
      {
        ...BASE_ROW,
        metadata: { _direction: 'inbound', _sending_account_id: 'acct-FOREIGN', envelope_id: 'env-inbound-1' },
      },
      { db },
    );

    // A successful reply confirms that publication AND linking committed.
    expect(result).toEqual({ outcome: 'linked', anchorId: ANCHOR_1, anchorPublicId: 'ARK-INBOUND-1', created: true });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint_source: 'issuer_record_attestation',
      metadata: expect.objectContaining({ _direction: 'inbound', _sending_account_id: 'acct-FOREIGN' }),
    }));
  });

  it('sets fingerprint_source=document_bytes (R2 default) for a normal outbound/fetched connector row', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({
      insertResult: { data: { id: 'anchor-outbound-1', public_id: 'ARK-OUTBOUND-1' }, error: null },
      insertSpy,
    });

    await defaultMaterializeAnchor(
      { ...BASE_ROW, external_ref: 'env-outbound-1', metadata: { envelope_id: 'env-outbound-1' } },
      { db },
    );

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.fingerprint_source).toBe('document_bytes');
  });

  it('uses the DS-04 member connection owner as the canonical anchor owner', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({
      insertResult: { data: { id: 'anchor-member-1', public_id: 'ARK-MEMBER-1' }, error: null },
      insertSpy,
    });
    const memberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await defaultMaterializeAnchor({
      ...BASE_ROW,
      external_ref: 'env-member-1',
      metadata: {
        queue_scope: 'member', owner_user_id: memberId,
        integration_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
    }, { db });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ user_id: memberId }));
    expect(db.from).not.toHaveBeenCalledWith('org_members');
  });

  it('sets fingerprint_source=document_bytes for a non-inbound _direction value (only _direction==="inbound" reaches the attestation class)', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({
      insertResult: { data: { id: 'anchor-outbound-2', public_id: 'ARK-OUTBOUND-2' }, error: null },
      insertSpy,
    });

    await defaultMaterializeAnchor(
      { ...BASE_ROW, external_ref: 'env-outbound-2', metadata: { _direction: 'outbound' } },
      { db },
    );

    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.fingerprint_source).toBe('document_bytes');
  });
});

// Founder decision 2026-09-25: a Drive file UPDATE must SUPERSEDE the prior
// anchor (status -> SUPERSEDED, new anchor gets parent_anchor_id + an
// incremented version_number via supersede_anchor's own trigger), never
// duplicate it as an unrelated second anchor, and NEVER REVOKE it.
describe('defaultMaterializeAnchor — connector document-update supersession (founder decision 2026-09-25)', () => {
  const OWNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const PRIOR_ANCHOR_ID = 'a3333333-3333-4333-8333-333333333333';
  const NEW_ANCHOR_ID = 'a4444444-4444-4444-8444-444444444444';
  const FP_OLD = 'c'.repeat(64);
  const FP_NEW = 'd'.repeat(64);

  const DRIVE_ROW = {
    id: ART_1,
    org_id: ORG_A,
    status: 'processing',
    fingerprint_sha256: FP_NEW,
    byte_length: 4096,
    source: 'google_drive',
    external_ref: 'drive-file-1',
    metadata: { file_id: 'drive-file-1' },
    anchor_id: null,
    credit_deduction_id: null,
    updated_at: '2026-09-25T00:00:00.000Z',
  };

  /** 'anchors' access is purpose-routed by the requested `select()` columns —
   * the prior-lineage-head lookup asks for `version_number`, the post-
   * supersede public_id fetch asks for exactly `public_id`. This lets one
   * table mock serve both call sites unambiguously (unlike a single canned
   * chainable response, which can't tell them apart). */
  function anchorsTable(opts: {
    prior: { id: string; status: string; fingerprint: string } | null;
    publicId: string | null;
  }) {
    return () => {
      let selectedFields = '';
      const builder: Record<string, unknown> = {
        select(fields: string) { selectedFields = fields; return builder; },
        eq() { return builder; },
        is() { return builder; },
        neq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle: async () => {
          if (selectedFields.includes('version_number')) {
            return { data: opts.prior, error: null };
          }
          if (selectedFields === 'public_id') {
            return { data: opts.publicId ? { public_id: opts.publicId } : null, error: null };
          }
          throw new Error(`unexpected anchors select in test: ${selectedFields}`);
        },
        // findExistingEnvelopeAnchor's terminal call is a bare
        // `await ...limit(...)` (no `.maybeSingle()`) and expects an ARRAY
        // back. Harmless/irrelevant to every test in this block: resolving
        // "no envelope match" lets that unrelated lookup no-op.
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    };
  }

  function orgMembersTable() {
    return () => {
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle: async () => ({ data: { user_id: OWNER_ID, role: 'owner' }, error: null }),
      };
      return builder;
    };
  }

  /** Models the lease-guarded link-back UPDATE `supersedeConnectorAnchor` runs
   * after `supersede_anchor` returns. `succeed: false` models a lost lease
   * (zero rows matched). */
  function connectorArtifactLinkTable(succeed = true) {
    return vi.fn(() => {
      const builder: Record<string, unknown> = {
        update() { return builder; },
        eq() { return builder; },
        select() { return builder; },
        maybeSingle: async () => (succeed ? { data: { id: ART_1 }, error: null } : { data: null, error: null }),
      };
      return builder;
    });
  }

  function makeDb(args: {
    prior: { id: string; status: string; fingerprint: string } | null;
    publicId?: string | null;
    linkSucceeds?: boolean;
  }) {
    const anchors = anchorsTable({ prior: args.prior, publicId: args.publicId ?? 'ARK-NEW-1' });
    const connectorArtifact = connectorArtifactLinkTable(args.linkSucceeds ?? true);
    const from = vi.fn((table: string) => {
      if (table === 'org_members') return orgMembersTable()();
      if (table === 'anchors') return anchors();
      if (table === 'connector_artifact') return connectorArtifact();
      throw new Error(`unexpected table ${table}`);
    });
    return { from, connectorArtifact };
  }

  it('changed fingerprint + a live prior anchor calls supersede_anchor (not a duplicate insert) and links the returned child', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name, rpcArgs) => {
      expect(name).toBe('supersede_anchor');
      expect(rpcArgs).toMatchObject({
        old_anchor_id: PRIOR_ANCHOR_ID,
        new_fingerprint: FP_NEW,
        p_caller_user_id: OWNER_ID,
      });
      return { data: NEW_ANCHOR_ID, error: null };
    });
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_OLD } });

    const result = await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(result).toEqual({ outcome: 'linked', anchorId: NEW_ANCHOR_ID, anchorPublicId: 'ARK-NEW-1', created: true });
    expect(callRpc).toHaveBeenCalledTimes(1);
    // Never a second, unrelated `materialize_connector_artifact_anchor` insert
    // for the same update — supersede_anchor is the ONLY anchor-creating call.
    expect(callRpc).not.toHaveBeenCalledWith(expect.anything(), 'materialize_connector_artifact_anchor', expect.anything());
    // The glue code never issues a raw UPDATE to `anchors` itself (status
    // flip / parent_anchor_id / version_number are entirely the RPC's job —
    // never reimplemented here); the only table this code writes directly is
    // `connector_artifact`, to link the artifact to the RPC's own new anchor.
    expect(db.connectorArtifact).toHaveBeenCalledTimes(1);
  });

  it('the prior anchor is left to the RPC\'s own SUPERSEDED transition, never explicitly REVOKED, by this glue code', async () => {
    // This test pins the CONTRACT this code relies on rather than re-deriving
    // supersede_anchor's own SQL (out of scope — see the RPC's own migration/
    // tests): the reason string this code sends is a supersede reason, and
    // this code performs no direct mutation of `old_anchor_id`'s row at all.
    let capturedReason: unknown;
    vi.mocked(callRpc).mockImplementation(async (_db, _name, rpcArgs) => {
      capturedReason = rpcArgs?.reason;
      return { data: NEW_ANCHOR_ID, error: null };
    });
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_OLD } });

    await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(typeof capturedReason).toBe('string');
    expect(String(capturedReason)).not.toMatch(/revok/i);
  });

  it('idempotent replay: re-processing after supersede already committed does not call supersede_anchor twice', async () => {
    const rpcSpy = vi.fn(async (_db: unknown, name: string, rpcArgs: Record<string, unknown> | undefined) => {
      if (name === 'supersede_anchor') {
        expect(rpcArgs).toMatchObject({ old_anchor_id: PRIOR_ANCHOR_ID, new_fingerprint: FP_NEW });
        return { data: NEW_ANCHOR_ID, error: null };
      }
      if (name === 'materialize_connector_artifact_anchor') {
        // Simulates the atomic RPC's own (user_id, fingerprint) unique-index
        // reuse: same anchor, created:false — never a distinct third anchor.
        return { data: { outcome: 'linked', anchor_id: NEW_ANCHOR_ID, public_id: 'ARK-NEW-1', created: false }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    vi.mocked(callRpc).mockImplementation(rpcSpy);

    // Pass 1: prior head is the OLD anchor with the OLD fingerprint.
    const db1 = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_OLD } });
    const first = await defaultMaterializeAnchor(DRIVE_ROW, { db: db1 });
    expect(first).toMatchObject({ anchorId: NEW_ANCHOR_ID, created: true });

    // Pass 2 (replay/retry of the SAME row): the lineage head is now the
    // anchor supersede_anchor already created, with the SAME fingerprint this
    // row already has — a fresh lookup (never cached) sees this and skips
    // straight to the normal reuse path instead of superseding again.
    const db2 = makeDb({ prior: { id: NEW_ANCHOR_ID, status: 'PENDING', fingerprint: FP_NEW } });
    const second = await defaultMaterializeAnchor(DRIVE_ROW, { db: db2 });
    expect(second).toMatchObject({ anchorId: NEW_ANCHOR_ID, created: false });

    const supersedeCalls = rpcSpy.mock.calls.filter((c) => c[1] === 'supersede_anchor');
    expect(supersedeCalls).toHaveLength(1);
  });

  it('identical fingerprint (no real content change) never calls supersede_anchor', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name) => {
      if (name === 'materialize_connector_artifact_anchor') {
        return { data: { outcome: 'linked', anchor_id: PRIOR_ANCHOR_ID, public_id: 'ARK-SAME-1', created: false }, error: null };
      }
      throw new Error(`unexpected rpc ${name} — identical fingerprint must never supersede`);
    });
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_NEW } });

    const result = await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(result).toMatchObject({ anchorId: PRIOR_ANCHOR_ID, created: false });
    expect(callRpc).not.toHaveBeenCalledWith(expect.anything(), 'supersede_anchor', expect.anything());
  });

  it('first-ever anchor for a file (no prior) never calls supersede_anchor', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name) => {
      if (name === 'materialize_connector_artifact_anchor') {
        return { data: { outcome: 'linked', anchor_id: NEW_ANCHOR_ID, public_id: 'ARK-FIRST-1', created: true }, error: null };
      }
      throw new Error(`unexpected rpc ${name} — no prior anchor exists to supersede`);
    });
    const db = makeDb({ prior: null });

    const result = await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(result).toMatchObject({ anchorId: NEW_ANCHOR_ID, created: true });
    expect(callRpc).not.toHaveBeenCalledWith(expect.anything(), 'supersede_anchor', expect.anything());
  });

  it('a REVOKED prior anchor is never superseded or mutated — fails closed', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name) => {
      throw new Error(`unexpected rpc ${name} — a REVOKED lineage head must never be called into`);
    });
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'REVOKED', fingerprint: FP_OLD } });

    const result = await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(result).toEqual({ outcome: 'prior_anchor_revoked' });
    expect(callRpc).not.toHaveBeenCalled();
    // No compensating write of any kind (never resurrect/mutate the revoked
    // anchor, never link the connector_artifact to it, never mint a fresh
    // independent anchor automatically).
    expect(db.connectorArtifact).not.toHaveBeenCalled();
  });

  it('is gated to google_drive: a DocuSign row with a live, differently-fingerprinted prior never supersedes', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name) => {
      if (name === 'materialize_connector_artifact_anchor') {
        return { data: { outcome: 'linked', anchor_id: NEW_ANCHOR_ID, public_id: 'ARK-DS-1', created: true }, error: null };
      }
      throw new Error(`unexpected rpc ${name} — DocuSign must not be routed through supersession yet`);
    });
    // Same shape as a supersede-eligible row, but source='docusign'. Even
    // though a "prior" with a different fingerprint exists, DocuSign
    // connector_artifact rows carry no external_revision signal in prod
    // (0/27 populated) to correlate an update on — behavior must stay
    // exactly what it was before this change.
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_OLD } });

    const result = await defaultMaterializeAnchor(
      { ...DRIVE_ROW, source: 'docusign', external_ref: 'envelope-1', metadata: {} },
      { db },
    );

    expect(result).toMatchObject({ anchorId: NEW_ANCHOR_ID, created: true });
    expect(callRpc).not.toHaveBeenCalledWith(expect.anything(), 'supersede_anchor', expect.anything());
  });

  it('a lost lease on the link-back after a committed supersede reports lost_lease (never a compensating anchors write)', async () => {
    vi.mocked(callRpc).mockImplementation(async (_db, name) => {
      if (name === 'supersede_anchor') return { data: NEW_ANCHOR_ID, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const db = makeDb({ prior: { id: PRIOR_ANCHOR_ID, status: 'SECURED', fingerprint: FP_OLD }, linkSucceeds: false });

    const result = await defaultMaterializeAnchor(DRIVE_ROW, { db });

    expect(result).toEqual({ outcome: 'lost_lease' });
  });
});

describe('atomic publication response loss and paid retry recovery', () => {
  it.each(['return', 'throw'] as const)('committed publication with %s response failure retains the link for recovery', async (failure) => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A })]);
    let committed: Row | undefined;
    h.deps.materializeAnchor = async (row) => {
      publishLinked(h.rows, row);
      committed = structuredClone(h.rows[0]);
      if (failure === 'throw') throw new Error('response lost after commit');
      return { outcome: 'lost_lease' };
    };
    const result = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(h.rows[0]).toEqual(committed);
    expect(h.rows[0]).toMatchObject({ status: 'materialized', anchor_id: ANCHOR_1 });
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.batchAnchor).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'artifact_materialization_uncertain' }));
  });

  it('a reset paid anchor is re-driven by the SAME id and confirmation never charges it twice', async () => {
    const h = makeHarness([makeRow({ id: ART_1, org_id: ORG_A,
      status: 'materialized', anchor_id: ANCHOR_2, credit_deduction_id: 'existing-debit' })]);
    const paidAnchors = new Set([ANCHOR_2]);
    let newCharges = 0;
    h.deps.debitAndEnqueueAnchor = async ({ anchorId }) => {
      if (!paidAnchors.has(anchorId)) { paidAnchors.add(anchorId); newCharges += 1; }
      return { success: true };
    };
    h.listMaterializedArtifacts.mockResolvedValueOnce([{ id: ART_1, anchor_id: ANCHOR_2 }]);
    h.readAnchorStatus.mockResolvedValueOnce({ id: ANCHOR_2, status: 'PENDING', chain_tx_id: null });
    const first = await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(first).toMatchObject({ reconfirmRequeued: 1, anchored: 1 });
    expect(h.rows[0].anchor_id).toBe(ANCHOR_2);
    expect(h.rows[0].credit_deduction_id).toBe('existing-debit');
    expect(newCharges).toBe(0);
    await drainConnectorArtifactsForOrg(ORG_A, h.deps);
    expect(newCharges).toBe(0);
    expect(h.materialize).toHaveBeenCalledTimes(1);
  });
});
