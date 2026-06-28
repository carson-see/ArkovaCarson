/**
 * Tests for the back-catalogue proof-completeness backfill job
 * (SCRUM-2335 PROOF-02 / SCRUM-2471).
 *
 * Mocks only — NO real DB, NO real chain. Pins the four safety guarantees:
 *   1. DRY-RUN by default writes NOTHING.
 *   2. Execute guard REFUSES without BOTH the flag AND the env token.
 *   3. merkle_index (and the proof branch) is tallied unreconstructable + skipped
 *      (the SCRUM-2471 gap) — never written with a guessed value.
 *   4. Idempotent re-run (already-complete rows skipped) + resumable cursor.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runProofCompletenessBackfill,
  planRowUpdate,
  reconstructOpReturnPayload,
  resolveExecuteGuard,
  PROOF_SCHEMA_VERSION,
  EXECUTE_CONFIRM_TOKEN,
  __testing,
  type BackfillCandidateRow,
  type ChainHeaderSource,
  type BackfillLogger,
} from './backfillProofCompleteness.js';

// SCRUM-1258: the job now imports the typed `config` singleton, whose loader
// validates full prod env at module load. Mock it (route-test pattern, mirrors
// ai-extract-batch.test.ts) so the unit test loads without prod config. Every
// test below injects `deps.confirmToken` directly, which takes precedence over
// `config.proofBackfillConfirm`, so the dry-run default (undefined) here is inert.
vi.mock('../config.js', () => ({
  config: {
    proofBackfillConfirm: undefined,
  },
}));

// ── Test doubles ─────────────────────────────────────────────────────────────

const silentLogger: BackfillLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Records every `.update().eq()` call so a dry-run can assert zero writes. */
interface UpdateCall {
  table: string;
  values: Record<string, unknown>;
  anchorId: string;
}

/**
 * Minimal fake supabase client implementing exactly the chained shape the job
 * uses: `.from(t).select(c).gt(col,v).order(col,opts).limit(n)` for reads and
 * `.from(t).update(v).eq(col,val)` for writes. Reads are served from `pages`,
 * paginated by the `gt('created_at', cursor)` cursor.
 */
function makeFakeClient(allRows: BackfillCandidateRow[]) {
  const updateCalls: UpdateCall[] = [];
  let readError: { message: string } | null = null;
  let writeErrorForAnchorId: string | null = null;

  const sorted = [...allRows].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const client = {
    from(table: string) {
      return {
        // ── read chain ──
        select(_cols: string) {
          return {
            gt(_col: string, cursor: string) {
              return {
                order(_oc: string, _opts: { ascending: boolean }) {
                  return {
                    async limit(n: number) {
                      if (readError) return { data: null, error: readError };
                      const page = sorted.filter((r) => r.created_at > cursor).slice(0, n);
                      return { data: page, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        // ── write chain ──
        update(values: Record<string, unknown>) {
          return {
            async eq(_col: string, anchorId: string) {
              if (writeErrorForAnchorId && writeErrorForAnchorId === anchorId) {
                return { error: { message: 'simulated row write failure' } };
              }
              updateCalls.push({ table, values, anchorId });
              return { error: null };
            },
          };
        },
      };
    },
  };

  return {
    client: client as unknown as Parameters<typeof runProofCompletenessBackfill>[0]['client'],
    updateCalls,
    setReadError: (e: { message: string } | null) => {
      readError = e;
    },
    failWriteFor: (anchorId: string) => {
      writeErrorForAnchorId = anchorId;
    },
  };
}

/** Chain header source: returns a deterministic header for known tx ids. */
function makeChain(known: Record<string, { blockHash: string; blockHeader: Buffer }>): {
  chain: ChainHeaderSource;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    chain: {
      async getBlockHeaderForTx(txId: string) {
        calls.push(txId);
        return known[txId] ?? null;
      },
    },
  };
}

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const HEADER_BYTES = Buffer.alloc(80, 0x11);

function row(overrides: Partial<BackfillCandidateRow>): BackfillCandidateRow {
  return {
    anchor_id: 'anchor-1',
    chain_tx_id: 'tx-1',
    merkle_root: ROOT_A,
    block_hash: null,
    block_header: null,
    op_return_payload: null,
    merkle_index: null,
    proof_schema_version: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── 1. DRY-RUN by default writes nothing ─────────────────────────────────────

describe('runProofCompletenessBackfill: DRY-RUN is the default', () => {
  it('writes NOTHING and reports dryRun=true when no flags are set', async () => {
    const rows = [
      row({ anchor_id: 'a1', chain_tx_id: 'tx-1', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ anchor_id: 'a2', chain_tx_id: 'tx-2', created_at: '2026-01-02T00:00:00.000Z' }),
    ];
    const { client, updateCalls } = makeFakeClient(rows);
    const { chain, calls } = makeChain({
      'tx-1': { blockHash: 'hash-1', blockHeader: HEADER_BYTES },
      'tx-2': { blockHash: 'hash-2', blockHeader: HEADER_BYTES },
    });

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger },
      {}, // no execute, no token
    );

    expect(summary.dryRun).toBe(true);
    expect(updateCalls).toHaveLength(0); // <-- the core guarantee
    expect(summary.rowsScanned).toBe(2);
    expect(summary.wouldUpdate).toBe(2); // both rows have writable columns
    // Chain still consulted to compute the plan, but nothing persisted.
    expect(calls.sort()).toEqual(['tx-1', 'tx-2']);
  });

  it('plan includes proof_schema_version + op_return + block fields, but never merkle_index', async () => {
    const rows = [row({ anchor_id: 'a1', chain_tx_id: 'tx-1' })];
    const { client } = makeFakeClient(rows);
    const { chain } = makeChain({ 'tx-1': { blockHash: 'hash-1', blockHeader: HEADER_BYTES } });

    const summary = await runProofCompletenessBackfill({ client, chain, logger: silentLogger }, {});

    expect(summary.dryRun).toBe(true);
    expect(summary.unreconstructable.merkleIndex).toBe(1);
    expect(summary.rowsBlockedOnScrum2471).toBe(1);
  });
});

// ── 2. Execute guard refuses without BOTH flag AND env token ─────────────────

describe('resolveExecuteGuard: requires BOTH flag and env token', () => {
  it('refuses when neither is set', () => {
    expect(resolveExecuteGuard(undefined, undefined).permitted).toBe(false);
  });
  it('refuses when only the execute flag is set', () => {
    const g = resolveExecuteGuard(true, undefined);
    expect(g.permitted).toBe(false);
    expect(g.reason).toMatch(/env confirmation/i);
  });
  it('refuses when only the env token is set (no flag)', () => {
    const g = resolveExecuteGuard(false, EXECUTE_CONFIRM_TOKEN);
    expect(g.permitted).toBe(false);
    expect(g.reason).toMatch(/execute flag/i);
  });
  it('refuses when the env token is wrong', () => {
    expect(resolveExecuteGuard(true, 'yes').permitted).toBe(false);
  });
  it('permits ONLY when both are correct', () => {
    const g = resolveExecuteGuard(true, EXECUTE_CONFIRM_TOKEN);
    expect(g.permitted).toBe(true);
    expect(g.reason).toBeNull();
  });
});

describe('runProofCompletenessBackfill: execute flag alone still does NOT write', () => {
  it('refuses + stays dry-run when execute=true but env token missing', async () => {
    const rows = [row({ anchor_id: 'a1', chain_tx_id: 'tx-1' })];
    const { client, updateCalls } = makeFakeClient(rows);
    const { chain } = makeChain({ 'tx-1': { blockHash: 'h', blockHeader: HEADER_BYTES } });

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger, confirmToken: undefined },
      { execute: true },
    );

    expect(summary.dryRun).toBe(true);
    expect(summary.refusalReason).toMatch(/env confirmation/i);
    expect(updateCalls).toHaveLength(0);
  });
});

// ── 3. EXECUTE writes (both guards satisfied) + reconstructable columns only ──

describe('runProofCompletenessBackfill: EXECUTE writes reconstructable columns', () => {
  it('writes block_hash/header/op_return/schema_version but NEVER merkle_index', async () => {
    const rows = [row({ anchor_id: 'a1', chain_tx_id: 'tx-1', merkle_root: ROOT_A })];
    const { client, updateCalls } = makeFakeClient(rows);
    const { chain } = makeChain({ 'tx-1': { blockHash: 'block-hash-1', blockHeader: HEADER_BYTES } });

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger, confirmToken: EXECUTE_CONFIRM_TOKEN },
      { execute: true },
    );

    expect(summary.dryRun).toBe(false);
    expect(updateCalls).toHaveLength(1);
    const v = updateCalls[0].values;
    expect(v.block_hash).toBe('block-hash-1');
    expect(v.block_header).toEqual(HEADER_BYTES);
    expect(v.op_return_payload).toEqual(Buffer.concat([Buffer.from('ARKV'), Buffer.from(ROOT_A, 'hex')]));
    expect(v.proof_schema_version).toBe(PROOF_SCHEMA_VERSION);
    // The SCRUM-2471 invariant: merkle_index is NEVER in the write payload.
    expect(v).not.toHaveProperty('merkle_index');
    expect(summary.unreconstructable.merkleIndex).toBe(1);
    expect(summary.rowsBlockedOnScrum2471).toBe(1);
  });

  it('one row write failure does not abort the batch (job convention)', async () => {
    const rows = [
      row({ anchor_id: 'good', chain_tx_id: 'tx-1', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ anchor_id: 'bad', chain_tx_id: 'tx-2', created_at: '2026-01-02T00:00:00.000Z' }),
    ];
    const { client, updateCalls, failWriteFor } = makeFakeClient(rows);
    failWriteFor('bad');
    const { chain } = makeChain({
      'tx-1': { blockHash: 'h1', blockHeader: HEADER_BYTES },
      'tx-2': { blockHash: 'h2', blockHeader: HEADER_BYTES },
    });

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger, confirmToken: EXECUTE_CONFIRM_TOKEN },
      { execute: true },
    );

    // Both were planned; 'good' written, 'bad' logged-and-skipped.
    expect(summary.wouldUpdate).toBe(2);
    expect(updateCalls.map((c) => c.anchorId)).toEqual(['good']);
  });
});

// ── 4. Unreconstructable / skip taxonomy ─────────────────────────────────────

describe('planRowUpdate: per-column reconstructability', () => {
  const { chain } = makeChain({ 'tx-1': { blockHash: 'h', blockHeader: HEADER_BYTES } });

  it('tallies block_hash/header unreconstructable when chain_tx_id is null', async () => {
    const { plan, skippedNoTxId } = await planRowUpdate(row({ chain_tx_id: null }), chain);
    expect(skippedNoTxId).toBe(true);
    expect(plan?.unreconstructableColumns).toContain('block_hash');
    expect(plan?.unreconstructableColumns).toContain('block_header');
    // op_return + schema_version still computed from stored data.
    expect(plan?.set.op_return_payload).toBeDefined();
    expect(plan?.set.proof_schema_version).toBe(PROOF_SCHEMA_VERSION);
  });

  it('tallies block unreconstructable when the chain header cannot be resolved', async () => {
    const { chain: missing } = makeChain({}); // tx-1 unknown
    const { plan } = await planRowUpdate(row({ chain_tx_id: 'tx-1' }), missing);
    expect(plan?.unreconstructableColumns).toEqual(
      expect.arrayContaining(['block_hash', 'block_header', 'merkle_index']),
    );
    expect(plan?.set).not.toHaveProperty('block_hash');
  });

  it('marks op_return unreconstructable when merkle_root is malformed/absent', async () => {
    const { plan } = await planRowUpdate(row({ merkle_root: 'not-hex', chain_tx_id: 'tx-1' }), chain);
    expect(plan?.unreconstructableColumns).toContain('op_return_payload');
    expect(plan?.set).not.toHaveProperty('op_return_payload');
  });
});

describe('reconstructOpReturnPayload', () => {
  it('returns ARKV-tagged root for a valid 32-byte hex root', () => {
    expect(reconstructOpReturnPayload(ROOT_B)).toEqual(
      Buffer.concat([Buffer.from('ARKV'), Buffer.from(ROOT_B, 'hex')]),
    );
  });
  it('returns null for malformed / null roots', () => {
    expect(reconstructOpReturnPayload(null)).toBeNull();
    expect(reconstructOpReturnPayload('abc')).toBeNull();
    expect(reconstructOpReturnPayload('z'.repeat(64))).toBeNull();
  });
});

// ── 5. Idempotency + cursor / batching ───────────────────────────────────────

describe('runProofCompletenessBackfill: idempotency', () => {
  it('skips rows that are already fully complete (safe re-run)', async () => {
    const complete = row({
      anchor_id: 'done',
      block_hash: 'h',
      block_header: 'deadbeef',
      op_return_payload: 'cafe',
      merkle_index: 3,
      proof_schema_version: 1,
    });
    const { client, updateCalls } = makeFakeClient([complete]);
    const { chain, calls } = makeChain({});

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger, confirmToken: EXECUTE_CONFIRM_TOKEN },
      { execute: true },
    );

    expect(summary.skippedAlreadyComplete).toBe(1);
    expect(summary.wouldUpdate).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(calls).toHaveLength(0); // no chain fetch for an already-complete row
  });
});

describe('runProofCompletenessBackfill: batching + resumable cursor', () => {
  it('paginates across multiple batches and reports the final cursor', async () => {
    // Use the clamp floor (50) as the batch size; 120 rows => batches of 50,50,20.
    const N = 120;
    // Lexicographically ordered, valid ISO: millisecond field zero-padded to 4 digits.
    const ts = (i: number) => `2026-01-01T00:00:00.${String(i).padStart(4, '0')}Z`;
    const rows = Array.from({ length: N }, (_, i) =>
      row({ anchor_id: `a${i}`, chain_tx_id: `tx-${i}`, created_at: ts(i) }),
    );
    const { client, updateCalls } = makeFakeClient(rows);
    const known: Record<string, { blockHash: string; blockHeader: Buffer }> = {};
    rows.forEach((r, i) => {
      known[`tx-${i}`] = { blockHash: `h${i}`, blockHeader: HEADER_BYTES };
    });
    const { chain } = makeChain(known);

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger, confirmToken: EXECUTE_CONFIRM_TOKEN },
      { execute: true, batchSize: __testing.MIN_BATCH_SIZE },
    );

    expect(summary.batchesProcessed).toBe(3);
    expect(summary.rowsScanned).toBe(N);
    expect(updateCalls).toHaveLength(N);
    expect(summary.finalCursor).toBe(ts(N - 1));
  });

  it('respects maxBatches as a staged-rehearsal cap', async () => {
    const N = 120;
    // Lexicographically ordered, valid ISO: millisecond field zero-padded to 4 digits.
    const ts = (i: number) => `2026-01-01T00:00:00.${String(i).padStart(4, '0')}Z`;
    const rows = Array.from({ length: N }, (_, i) =>
      row({ anchor_id: `a${i}`, chain_tx_id: `tx-${i}`, created_at: ts(i) }),
    );
    const { client } = makeFakeClient(rows);
    const { chain } = makeChain(
      Object.fromEntries(rows.map((_, i) => [`tx-${i}`, { blockHash: `h${i}`, blockHeader: HEADER_BYTES }])),
    );

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger },
      { batchSize: __testing.MIN_BATCH_SIZE, maxBatches: 1 },
    );

    expect(summary.batchesProcessed).toBe(1);
    expect(summary.rowsScanned).toBe(__testing.MIN_BATCH_SIZE);
  });

  it('honors a startAfterCreatedAt resume cursor', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ anchor_id: `a${i}`, chain_tx_id: `tx-${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );
    const { client } = makeFakeClient(rows);
    const known: Record<string, { blockHash: string; blockHeader: Buffer }> = {};
    rows.forEach((r, i) => (known[`tx-${i}`] = { blockHash: `h${i}`, blockHeader: HEADER_BYTES }));
    const { chain } = makeChain(known);

    const summary = await runProofCompletenessBackfill(
      { client, chain, logger: silentLogger },
      { startAfterCreatedAt: '2026-01-02T00:00:00.000Z' },
    );

    // Only rows with created_at > 2026-01-02 => a2, a3 => 2 rows.
    expect(summary.rowsScanned).toBe(2);
  });

  it('stops cleanly and throws on a source read error', async () => {
    const { client, setReadError } = makeFakeClient([row({})]);
    setReadError({ message: 'statement timeout' });
    const { chain } = makeChain({});

    await expect(
      runProofCompletenessBackfill({ client, chain, logger: silentLogger }, {}),
    ).rejects.toThrow(/source query failed/i);
  });
});

describe('clampBatchSize', () => {
  it('clamps to [MIN, MAX] and defaults safely', () => {
    expect(__testing.clampBatchSize(undefined)).toBe(__testing.DEFAULT_BATCH_SIZE);
    expect(__testing.clampBatchSize(1)).toBe(__testing.MIN_BATCH_SIZE);
    expect(__testing.clampBatchSize(999999)).toBe(__testing.MAX_BATCH_SIZE);
    expect(__testing.clampBatchSize(NaN)).toBe(__testing.DEFAULT_BATCH_SIZE);
  });
});
