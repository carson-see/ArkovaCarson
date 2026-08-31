/**
 * upsertAnchorProofs — FIX-1 (SCRUM-2471) extends the helper to persist the
 * integer merkle_index (PROOF-02 column) alongside the branch.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertAnchorProofs, updateAnchorConfirmationProofs, fromByteaHex } from './anchorProofs.js';

describe('PROOF-05 (SCRUM-2338) — fromByteaHex (bytea read-side normaliser)', () => {
  it('strips the \\x prefix and lowercases valid hex', () => {
    expect(fromByteaHex('\\xAABB01')).toBe('aabb01');
  });
  it('accepts bare hex without a \\x prefix', () => {
    expect(fromByteaHex('aabb01')).toBe('aabb01');
  });
  it('returns null for null/empty/non-string', () => {
    expect(fromByteaHex(null)).toBeNull();
    expect(fromByteaHex(undefined)).toBeNull();
    expect(fromByteaHex('')).toBeNull();
    expect(fromByteaHex('\\x')).toBeNull();
    expect(fromByteaHex(123)).toBeNull();
  });
  it('returns null for malformed (odd-length or non-hex) — never a fabricated value', () => {
    expect(fromByteaHex('\\xABC')).toBeNull(); // odd length
    expect(fromByteaHex('\\xZZ')).toBeNull(); // non-hex
    expect(fromByteaHex('nothex')).toBeNull();
  });
});

function mockClient() {
  const upsert = vi.fn((_rows: Array<Record<string, unknown>>, _opts: { onConflict: string }) => Promise.resolve({ error: null }));
  const from = vi.fn(() => ({ upsert }));
  return { client: { from } as unknown as SupabaseClient, upsert, from };
}

/**
 * Mock client for the PROOF-03 confirmation UPDATE path:
 * `.from().update().in().select()` resolves to `{ error, data }`, where `data`
 * is the array of affected rows. This mirrors the established
 * `.select()`-then-`data.length` pattern (anchorExpirySweep.ts:507-515) — it
 * models REALITY, so ids with no row are simply absent from the returned array.
 * `matchedAnchorIds` decides which ids have a row (default: all of them).
 *
 * (PROOF-03 / MED-2: the prior mock fabricated a `count` the production code
 * never actually requested — masking the bug where `count` was always null.
 * M3: the filter is now `.in()`, because one statement covers every anchor
 * sharing a value payload instead of one round-trip per row.)
 */
function mockUpdateClient(matchedAnchorIds?: (id: string) => boolean) {
  const inCalls: Array<{ col: string; ids: string[]; values: Record<string, unknown> }> = [];
  const matches = matchedAnchorIds ?? (() => true);
  const update = vi.fn((values: Record<string, unknown>) => ({
    in: vi.fn((col: string, ids: string[]) => {
      inCalls.push({ col, ids, values });
      return {
        select: vi.fn((_cols: string) =>
          Promise.resolve({
            error: null,
            data: ids.filter(matches).map((anchor_id) => ({ anchor_id })),
          }),
        ),
      };
    }),
  }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as unknown as SupabaseClient, update, from, inCalls };
}

describe('upsertAnchorProofs', () => {
  it('is a no-op for an empty row set', async () => {
    const { client, from } = mockClient();
    await upsertAnchorProofs(client, []);
    expect(from).not.toHaveBeenCalled();
  });

  it('maps merkleIndex → merkle_index in the persisted row', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      {
        anchorId: 'a1',
        receiptId: 'tx1',
        merkleRoot: 'r1',
        proofPath: [{ hash: 'h', position: 'left' }],
        merkleIndex: 3,
        batchId: 'b1',
      },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(persisted[0].merkle_index).toBe(3);
    expect(persisted[0].merkle_root).toBe('r1');
    expect(persisted[0].anchor_id).toBe('a1');
    expect(persisted[0].batch_id).toBe('b1');
  });

  it('writes merkle_index = null when not supplied (back-compat for existing callers)', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      { anchorId: 'a2', receiptId: 'tx2', merkleRoot: 'r2', proofPath: [] },
    ]);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(persisted[0].merkle_index).toBeNull();
  });

  it('preserves the index per-row across a multi-row upsert', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      { anchorId: 'a', receiptId: 'tx', merkleRoot: 'r', proofPath: [], merkleIndex: 0 },
      { anchorId: 'b', receiptId: 'tx', merkleRoot: 'r', proofPath: [], merkleIndex: 1 },
      { anchorId: 'c', receiptId: 'tx', merkleRoot: 'r', proofPath: [], merkleIndex: 2 },
    ]);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(persisted.map((r) => r.merkle_index)).toEqual([0, 1, 2]);
  });

  // ── PROOF-03 (SCRUM-2336): block_header / block_hash mapping ──

  it('maps blockHeader → block_header and blockHash → block_hash when supplied', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      {
        anchorId: 'a1',
        receiptId: 'tx1',
        merkleRoot: 'r1',
        proofPath: [],
        blockHeader: 'ab'.repeat(80),
        blockHash: 'cd'.repeat(32),
      },
    ]);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    // BUG-4: block_header is `bytea` → must be sent as `\x<hex>` (raw bytes), not a
    // bare hex string (which Postgres would store as 160 ASCII bytes). block_hash is text.
    expect(persisted[0].block_header).toBe(`\\x${'ab'.repeat(80)}`);
    expect(persisted[0].block_hash).toBe('cd'.repeat(32));
  });

  it('OMITS block_header / block_hash keys entirely when not supplied (no clobber of an existing header)', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      { anchorId: 'a2', receiptId: 'tx2', merkleRoot: 'r2', proofPath: [] },
    ]);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    // The app-tree-only path must NOT write `block_header: null` — that would
    // wipe a header populated by a prior PROOF-03 confirmation pass.
    expect('block_header' in persisted[0]).toBe(false);
    expect('block_hash' in persisted[0]).toBe(false);
  });

  it('writes explicit null when blockHeader/blockHash are passed as null', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      { anchorId: 'a3', receiptId: 'tx3', blockHeader: null, blockHash: null },
    ]);
    const persisted = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(persisted[0].block_header).toBeNull();
    expect(persisted[0].block_hash).toBeNull();
  });
});

describe('updateAnchorConfirmationProofs (PROOF-03)', () => {
  it('is a no-op for an empty row set', async () => {
    const { client, from } = mockUpdateClient();
    const result = await updateAnchorConfirmationProofs(client, []);
    expect(from).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, missing: 0 });
  });

  it('updates ONLY block_header + block_hash (never app-tree columns) keyed by anchor_id', async () => {
    const { client, update, inCalls } = mockUpdateClient();
    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-1', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(result).toEqual({ updated: 1, missing: 0 });
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toEqual({ block_header: `\\x${'aa'.repeat(80)}`, block_hash: 'bb'.repeat(32) });
    // crucially: no merkle_root / proof_path / merkle_index touched
    expect('merkle_root' in values).toBe(false);
    expect('proof_path' in values).toBe(false);
    expect('merkle_index' in values).toBe(false);
    expect(inCalls[0]).toMatchObject({ col: 'anchor_id', ids: ['anc-1'] });
  });

  it('includes block_height only when provided', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-1', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32), blockHeight: 800123 },
      { anchorId: 'anc-2', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    // Different value payloads ⇒ two statements, each carrying its own values.
    const withHeight = update.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(withHeight.some((v) => v.block_height === 800123)).toBe(true);
    expect(withHeight.some((v) => !('block_height' in v))).toBe(true);
  });

  // M3: the backfill is ~667k rows. One PostgREST round-trip per row at
  // 2,000 rows per */15 run is ~334 runs ≈ 83.5 hours of pure latency. The
  // workload's own shape makes that unnecessary: anchors in a merkle batch
  // share ONE tx, so they share ONE proof, so header/hash/branch/index are
  // BYTE-IDENTICAL across the whole group. Collapse identical payloads into a
  // single `.in()` statement.
  it('M3: collapses a merkle batch into ONE statement per chunk, not one per anchor', async () => {
    const { client, update, inCalls } = mockUpdateClient();
    const shared = { blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32), blockHeight: 800123 };
    const rows = Array.from({ length: 180 }, (_, i) => ({ anchorId: `anc-${i}`, ...shared }));

    const result = await updateAnchorConfirmationProofs(client, rows);

    expect(result).toEqual({ updated: 180, missing: 0 });
    // 180 byte-identical payloads fit inside one `chunkForInFilter` chunk, so
    // this is ONE round-trip where it used to be 180.
    expect(update).toHaveBeenCalledTimes(1);
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0].ids).toHaveLength(180);
  });

  it('M3: leaves the chunk WIDTH to chunkForInFilter, which bounds it by encoded wire bytes', async () => {
    // Deliberately NOT asserting a chunk size of our own choosing: picking that
    // number by hand is the mistake the `no-hand-rolled-in-filter-chunk` lint
    // exists to stop (it reached production three times). What this pins is the
    // properties that matter — every row is covered exactly once, and the work
    // is a handful of statements rather than one per row.
    const { client, inCalls } = mockUpdateClient();
    const shared = { blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) };
    const rows = Array.from({ length: 1200 }, (_, i) => ({ anchorId: `anc-${i}`, ...shared }));

    const result = await updateAnchorConfirmationProofs(client, rows);

    expect(result).toEqual({ updated: 1200, missing: 0 });
    expect(inCalls.length).toBeGreaterThan(1);
    expect(inCalls.length).toBeLessThan(rows.length / 10);
    expect(inCalls.reduce((n, c) => n + c.ids.length, 0)).toBe(1200);
    // Every id appears exactly once across the chunks — no gaps, no repeats.
    const seen = inCalls.flatMap((c) => c.ids);
    expect(new Set(seen).size).toBe(1200);
  });

  // MED-2 regression: an update that matches NO row must increment `anchorsMissing`.
  // Previously `updateAnchorConfirmationProofs` read `count` without requesting it,
  // so `count` was always null, `count===0` never fired, and EVERY row counted as
  // updated (missing was permanently 0). The `.select('anchor_id')` ⇒ empty-array
  // signal makes the missing-row case actually observable.
  it('counts an update matching no row as missing (skipped, not created)', async () => {
    // Batching must not blur the missing-row signal: the returned rows say
    // exactly which ids existed, so the shortfall within the SAME statement is
    // still counted honestly.
    const { client } = mockUpdateClient((id) => id === 'has-row');
    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'has-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
      { anchorId: 'no-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(result).toEqual({ updated: 1, missing: 1 });
  });

  it('requests the affected rows via .select(anchor_id) so the missing-row case is observable', async () => {
    // The prod helper MUST call .select(...) after the filter — without it the
    // missing-row branch can never fire (the MED-2 bug). Assert the select call
    // happens and is scoped to a lightweight column.
    const selectSpy = vi.fn((_cols: string) => Promise.resolve({ error: null, data: [] as Array<{ anchor_id: string }> }));
    const inFilter = vi.fn((_col: string, _ids: string[]) => ({ select: selectSpy }));
    const update = vi.fn((_values: Record<string, unknown>) => ({ in: inFilter }));
    const from = vi.fn(() => ({ update }));
    const client = { from } as unknown as SupabaseClient;

    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'no-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(selectSpy).toHaveBeenCalledWith('anchor_id');
    expect(result).toEqual({ updated: 0, missing: 1 });
  });
});

// =============================================================================
// S3-P0 (batch producer) — op_return_payload persistence + intent raw_response
// =============================================================================

describe('S3-P0 — upsertAnchorProofs op_return_payload (bytea) support', () => {
  it('maps opReturnPayload → op_return_payload with the \\x bytea prefix (BUG-4 contract)', async () => {
    const { client, upsert } = mockClient();
    const arkvPayload = `41524b56${'ab'.repeat(32)}`; // "ARKV" + 32-byte root
    await upsertAnchorProofs(client, [
      { anchorId: 'a1', receiptId: 'tx1', opReturnPayload: arkvPayload },
    ]);
    const rows = upsert.mock.calls[0][0];
    expect(rows[0].op_return_payload).toBe(`\\x${arkvPayload}`);
  });

  it('OMITS the op_return_payload key entirely when not supplied (no clobber)', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [{ anchorId: 'a1', receiptId: 'tx1' }]);
    const rows = upsert.mock.calls[0][0];
    expect('op_return_payload' in rows[0]).toBe(false);
  });

  it('writes explicit null when opReturnPayload is passed as null', async () => {
    const { client, upsert } = mockClient();
    await upsertAnchorProofs(client, [
      { anchorId: 'a1', receiptId: 'tx1', opReturnPayload: null },
    ]);
    const rows = upsert.mock.calls[0][0];
    expect(rows[0].op_return_payload).toBeNull();
  });

  it('passes rawResponse through to raw_response (broadcast-intent record carrier)', async () => {
    const { client, upsert } = mockClient();
    const intent = {
      broadcast_intent: {
        tx_id: 'txid-1',
        tx_hex: '02000000deadbeef',
        fee_sats: 141,
        prepared_at: '2026-07-06T00:00:00.000Z',
      },
    };
    await upsertAnchorProofs(client, [
      { anchorId: 'a1', receiptId: 'txid-1', rawResponse: intent },
    ]);
    const rows = upsert.mock.calls[0][0];
    expect(rows[0].raw_response).toEqual(intent);
  });
});

// =============================================================================
// R1 — bitcoin-tree INCLUSION branch (tx → block merkleroot) + tx block index
// =============================================================================
//
// `fetchConfirmationProof` already computes and validates both, and then the
// populate job threw them away: only `block_header` / `block_hash` were ever
// persisted. Without the branch a verifier has to ask a node for an inclusion
// proof, which is exactly the dependency the bundle exists to remove.
//
// Naming (K2): these are the BITCOIN-tree fields and follow the Bitcoin
// double-SHA256 positional rule over BYTE-REVERSED (display) hex. They are
// deliberately NOT named `merkle_proof` / `merkle_index` — those belong to the
// layer-1 APP tree, which uses a different convention. Two branches with two
// orientations must never share one name.

describe('updateAnchorConfirmationProofs — tx-inclusion branch + tx block index (R1)', () => {
  const HEADER = 'aa'.repeat(80);
  const HASH = 'bb'.repeat(32);
  const BRANCH = [
    { hash: 'cc'.repeat(32), position: 'right' as const },
    { hash: 'dd'.repeat(32), position: 'left' as const },
  ];

  // BRANCH is [right, left] ⇒ index bit0 = 0, bit1 = 1 ⇒ the only index it can
  // belong to is 2. (Same rule the reader enforces — see verify-proof.ts.)
  const INDEX = 2;

  it('persists tx_inclusion_branch + tx_block_index alongside the header', async () => {
    const { client, update } = mockUpdateClient();
    const result = await updateAnchorConfirmationProofs(client, [
      {
        anchorId: 'anc-1',
        blockHeader: HEADER,
        blockHash: HASH,
        txInclusionBranch: BRANCH,
        txBlockIndex: INDEX,
      },
    ]);
    expect(result).toEqual({ updated: 1, missing: 0 });
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    // jsonb column — the branch goes over the wire as a real array, NOT a
    // \x-encoded bytea and NOT a JSON string.
    expect(values.tx_inclusion_branch).toEqual(BRANCH);
    expect(values.tx_block_index).toBe(INDEX);
    // Still never touches the app tree.
    expect('proof_path' in values).toBe(false);
    expect('merkle_index' in values).toBe(false);
  });

  it('OMITS both keys when not supplied — an app-tree/header-only write cannot clobber an already-backfilled branch', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-2', blockHeader: HEADER, blockHash: HASH },
    ]);
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect('tx_inclusion_branch' in values).toBe(false);
    expect('tx_block_index' in values).toBe(false);
  });

  it('persists tx_block_index 0 — the first tx in a block must not be dropped as falsy', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-3', blockHeader: HEADER, blockHash: HASH, txInclusionBranch: [], txBlockIndex: 0 },
    ]);
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect(values.tx_block_index).toBe(0);
    // A single-tx block has NO siblings: an empty branch is the correct,
    // complete answer and must persist as `[]`, never collapse to null.
    expect(values.tx_inclusion_branch).toEqual([]);
  });

  // ── H3/H4: the WRITER validates too ────────────────────────────────────────
  //
  // Migration 0427's header states that "the writer and the reader both
  // validate shape and reject anything malformed as NULL", and offers that as
  // the reason no CHECK constraint is needed. The reader did; the writer
  // validated NOTHING — it forwarded whatever it was handed straight into a
  // jsonb column. Either that sentence becomes true or it has to be deleted;
  // this makes it true.

  it('H4: refuses to write half a pair — a branch with no index writes NEITHER', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-4', blockHeader: HEADER, blockHash: HASH, txInclusionBranch: BRANCH },
    ]);
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect('tx_inclusion_branch' in values).toBe(false);
    expect('tx_block_index' in values).toBe(false);
    // …and the header still lands, so the row is not left unwritten.
    expect(values.block_header).toBe(`\\x${HEADER}`);
  });

  it('H4: refuses to write half a pair — an index with no branch writes NEITHER', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-5', blockHeader: HEADER, blockHash: HASH, txBlockIndex: INDEX },
    ]);
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect('tx_inclusion_branch' in values).toBe(false);
    expect('tx_block_index' in values).toBe(false);
  });

  it('H3: refuses to write a branch whose siblings are not 64-hex', async () => {
    for (const badHash of ['', 'cc', 'z'.repeat(64), 'c'.repeat(65)]) {
      const { client, update } = mockUpdateClient();
      await updateAnchorConfirmationProofs(client, [
        {
          anchorId: 'anc-6',
          blockHeader: HEADER,
          blockHash: HASH,
          txInclusionBranch: [{ hash: badHash, position: 'right' }, BRANCH[1]],
          txBlockIndex: INDEX,
        },
      ]);
      const values = update.mock.calls[0][0] as Record<string, unknown>;
      expect('tx_inclusion_branch' in values, `hash=${JSON.stringify(badHash)}`).toBe(false);
      expect('tx_block_index' in values).toBe(false);
    }
  });

  it('H4: refuses to write a pair whose index contradicts the branch it ships with', async () => {
    for (const wrongIndex of [0, 1, 3, 4, 99]) {
      const { client, update } = mockUpdateClient();
      await updateAnchorConfirmationProofs(client, [
        {
          anchorId: 'anc-7',
          blockHeader: HEADER,
          blockHash: HASH,
          txInclusionBranch: BRANCH,
          txBlockIndex: wrongIndex,
        },
      ]);
      const values = update.mock.calls[0][0] as Record<string, unknown>;
      expect('tx_inclusion_branch' in values, `index=${wrongIndex}`).toBe(false);
      expect('tx_block_index' in values, `index=${wrongIndex}`).toBe(false);
    }
  });

  it('an explicit null PAIR is a deliberate clear and still writes both', async () => {
    const { client, update } = mockUpdateClient();
    await updateAnchorConfirmationProofs(client, [
      {
        anchorId: 'anc-8',
        blockHeader: HEADER,
        blockHash: HASH,
        txInclusionBranch: null,
        txBlockIndex: null,
      },
    ]);
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect(values.tx_inclusion_branch).toBeNull();
    expect(values.tx_block_index).toBeNull();
  });
});
