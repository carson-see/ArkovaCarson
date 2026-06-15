/**
 * upsertAnchorProofs — FIX-1 (SCRUM-2471) extends the helper to persist the
 * integer merkle_index (PROOF-02 column) alongside the branch.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertAnchorProofs } from './anchorProofs.js';

function mockClient() {
  const upsert = vi.fn((_rows: Array<Record<string, unknown>>, _opts: { onConflict: string }) => Promise.resolve({ error: null }));
  const from = vi.fn(() => ({ upsert }));
  return { client: { from } as unknown as SupabaseClient, upsert, from };
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
});
