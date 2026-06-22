/**
 * upsertAnchorProofs — FIX-1 (SCRUM-2471) extends the helper to persist the
 * integer merkle_index (PROOF-02 column) alongside the branch.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertAnchorProofs, updateAnchorConfirmationProofs } from './anchorProofs.js';

function mockClient() {
  const upsert = vi.fn((_rows: Array<Record<string, unknown>>, _opts: { onConflict: string }) => Promise.resolve({ error: null }));
  const from = vi.fn(() => ({ upsert }));
  return { client: { from } as unknown as SupabaseClient, upsert, from };
}

/**
 * Mock client for the PROOF-03 confirmation UPDATE path: `.from().update().eq()`
 * resolves to `{ error, count }`. `counts` controls the per-call `count`.
 */
function mockUpdateClient(counts: Array<number | null> = []) {
  const eqCalls: Array<{ col: string; val: string; values: Record<string, unknown> }> = [];
  let callIdx = 0;
  const update = vi.fn((values: Record<string, unknown>) => ({
    eq: vi.fn((col: string, val: string) => {
      eqCalls.push({ col, val, values });
      const count = counts[callIdx] ?? 1;
      callIdx += 1;
      return Promise.resolve({ error: null, count });
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
    expect(persisted[0].block_header).toBe('ab'.repeat(80));
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
    const { client, update, eqCalls } = mockUpdateClient([1]);
    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-1', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(result).toEqual({ updated: 1, missing: 0 });
    const values = update.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toEqual({ block_header: 'aa'.repeat(80), block_hash: 'bb'.repeat(32) });
    // crucially: no merkle_root / proof_path / merkle_index touched
    expect('merkle_root' in values).toBe(false);
    expect('proof_path' in values).toBe(false);
    expect('merkle_index' in values).toBe(false);
    expect(eqCalls[0]).toMatchObject({ col: 'anchor_id', val: 'anc-1' });
  });

  it('includes block_height only when provided', async () => {
    const { client, update } = mockUpdateClient([1, 1]);
    await updateAnchorConfirmationProofs(client, [
      { anchorId: 'anc-1', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32), blockHeight: 800123 },
      { anchorId: 'anc-2', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(update.mock.calls[0][0]).toMatchObject({ block_height: 800123 });
    expect('block_height' in (update.mock.calls[1][0] as Record<string, unknown>)).toBe(false);
  });

  it('counts rows with count===0 as missing (skipped, not created)', async () => {
    // First anchor has a row (count 1), second has none (count 0).
    const { client } = mockUpdateClient([1, 0]);
    const result = await updateAnchorConfirmationProofs(client, [
      { anchorId: 'has-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
      { anchorId: 'no-row', blockHeader: 'aa'.repeat(80), blockHash: 'bb'.repeat(32) },
    ]);
    expect(result).toEqual({ updated: 1, missing: 1 });
  });
});
