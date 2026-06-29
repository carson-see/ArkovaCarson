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
 * `.from().update().eq().select()` resolves to `{ error, data }`, where `data`
 * is the array of affected rows (`[{ anchor_id }]` for a real row, `[]` when no
 * row matched). This mirrors the established `.select()`-then-`data.length`
 * pattern (anchorExpirySweep.ts:507-515) — it models REALITY, so an update that
 * matches no row genuinely returns an empty array. `matchedRows[i]` controls
 * whether the i-th update finds its row (default: found).
 *
 * (PROOF-03 / MED-2: the prior mock fabricated a `count` the production code
 * never actually requested — masking the bug where `count` was always null.)
 */
function mockUpdateClient(matchedRows: Array<boolean> = []) {
  const eqCalls: Array<{ col: string; val: string; values: Record<string, unknown> }> = [];
  let callIdx = 0;
  const update = vi.fn((values: Record<string, unknown>) => ({
    eq: vi.fn((col: string, val: string) => {
      eqCalls.push({ col, val, values });
      const idx = callIdx;
      callIdx += 1;
      return {
        select: vi.fn((_cols: string) => {
          const found = matchedRows[idx] ?? true;
          return Promise.resolve({ error: null, data: found ? [{ anchor_id: val }] : [] });
        }),
      };
    }),
  }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as unknown as SupabaseClient, update, from, eqCalls };
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
    const { client, update, eqCalls } = mockUpdateClient([true]);
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
    expect(eqCalls[0]).toMatchObject({ col: 'anchor_id', val: 'anc-1' });
  });

  it('includes block_height only when provided', async () => {
    const { client, update } = mockUpdateClient([true, true]);
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-1', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32), blockHeight: 800123 },
      { anchorId: 'anc-2', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(update.mock.calls[0][0]).toMatchObject({ block_height: 800123 });
    expect('block_height' in (update.mock.calls[1][0] as Record<string, unknown>)).toBe(false);
  });

  // MED-2 regression: an update that matches NO row must increment `anchorsMissing`.
  // Previously `updateAnchorConfirmationProofs` read `count` without requesting it,
  // so `count` was always null, `count===0` never fired, and EVERY row counted as
  // updated (missing was permanently 0). The `.select('anchor_id')` ⇒ empty-array
  // signal makes the missing-row case actually observable.
  it('counts an update matching no row as missing (skipped, not created)', async () => {
    // First anchor has a row, second matches none (empty data array).
    const { client } = mockUpdateClient([true, false]);
    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'has-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
      { anchorId: 'no-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(result).toEqual({ updated: 1, missing: 1 });
  });

  it('requests the affected rows via .select(anchor_id) so the missing-row case is observable', async () => {
    // The prod helper MUST call .select(...) after .eq(...) — without it the
    // missing-row branch can never fire (the MED-2 bug). Assert the select call
    // happens and is scoped to a lightweight column.
    const selectSpy = vi.fn((_cols: string) => Promise.resolve({ error: null, data: [] as Array<{ anchor_id: string }> }));
    const eq = vi.fn((_col: string, _val: string) => ({ select: selectSpy }));
    const update = vi.fn((_values: Record<string, unknown>) => ({ eq }));
    const from = vi.fn(() => ({ update }));
    const client = { from } as unknown as SupabaseClient;

    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'no-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(selectSpy).toHaveBeenCalledWith('anchor_id');
    expect(result).toEqual({ updated: 0, missing: 1 });
  });
});
