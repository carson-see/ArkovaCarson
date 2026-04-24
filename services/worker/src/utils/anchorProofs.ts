import type { SupabaseClient } from '@supabase/supabase-js';

export interface AnchorProofUpsertRow {
  anchorId: string;
  receiptId: string;
  blockHeight?: number | null;
  blockTimestamp?: string | null;
  merkleRoot?: string | null;
  proofPath?: unknown;
  batchId?: string | null;
  rawResponse?: unknown;
}

const PROOF_UPSERT_CHUNK = 500;

/**
 * Persists Merkle proof data outside the hot anchors table so status updates
 * do not have to rewrite wide JSONB rows.
 */
export async function upsertAnchorProofs(
  client: SupabaseClient,
  rows: AnchorProofUpsertRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const dbAny = client as any;

  for (let i = 0; i < rows.length; i += PROOF_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + PROOF_UPSERT_CHUNK).map((row) => ({
      anchor_id: row.anchorId,
      receipt_id: row.receiptId,
      block_height: row.blockHeight ?? null,
      block_timestamp: row.blockTimestamp ?? null,
      merkle_root: row.merkleRoot ?? null,
      proof_path: row.proofPath ?? null,
      batch_id: row.batchId ?? null,
      raw_response: row.rawResponse ?? null,
    }));

    const { error } = await dbAny
      .from('anchor_proofs')
      .upsert(chunk, { onConflict: 'anchor_id' });

    if (error) throw error;
  }
}
