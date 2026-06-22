import type { SupabaseClient } from '@supabase/supabase-js';

export interface AnchorProofUpsertRow {
  anchorId: string;
  receiptId: string;
  blockHeight?: number | null;
  blockTimestamp?: string | null;
  merkleRoot?: string | null;
  proofPath?: unknown;
  /** Integer leaf index in the batch tree (PROOF-02 `merkle_index`). */
  merkleIndex?: number | null;
  batchId?: string | null;
  rawResponse?: unknown;
  /**
   * PROOF-03 (SCRUM-2336): raw 80-byte block header (160-hex) the anchor's tx
   * was mined into. Persisted to `anchor_proofs.block_header`.
   */
  blockHeader?: string | null;
  /**
   * PROOF-03 (SCRUM-2336): the confirmed block hash (64-hex). Persisted to
   * `anchor_proofs.block_hash`.
   */
  blockHash?: string | null;
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

  const dbAny = client as unknown as { from(table: string): { upsert(rows: Record<string, unknown>[], opts: { onConflict: string }): Promise<{ error: Error | null }> } };

  for (let i = 0; i < rows.length; i += PROOF_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + PROOF_UPSERT_CHUNK).map((row) => {
      const mapped: Record<string, unknown> = {
        anchor_id: row.anchorId,
        receipt_id: row.receiptId,
        block_height: row.blockHeight ?? null,
        block_timestamp: row.blockTimestamp ?? null,
        merkle_root: row.merkleRoot ?? null,
        proof_path: row.proofPath ?? null,
        merkle_index: row.merkleIndex ?? null,
        batch_id: row.batchId ?? null,
        raw_response: row.rawResponse ?? null,
      };
      // PROOF-03: only include the bitcoin-tree columns when the caller
      // supplied them, so an app-tree-only upsert (FIX-1 batch/anchor path)
      // does not write explicit nulls over a previously-populated header.
      if (row.blockHeader !== undefined) mapped.block_header = row.blockHeader;
      if (row.blockHash !== undefined) mapped.block_hash = row.blockHash;
      return mapped;
    });

    const { error } = await dbAny
      .from('anchor_proofs')
      .upsert(chunk, { onConflict: 'anchor_id' });

    if (error) throw error;
  }
}

/**
 * PROOF-03 (SCRUM-2336): persist ONLY the bitcoin-tree confirmation columns
 * (`block_header` + `block_hash`) onto EXISTING `anchor_proofs` rows, keyed by
 * `anchor_id`, WITHOUT touching the app-tree columns (`merkle_root`,
 * `proof_path`, `merkle_index`) that FIX-1 already wrote at broadcast time.
 *
 * Uses a per-anchor UPDATE rather than the destructive `upsert` above so a
 * confirmation pass can never clobber the app-tree branch. The `anchor_proofs`
 * row is guaranteed to exist by the time an anchor is SECURED (FIX-1 writes it
 * on the broadcast path); a row that is somehow missing is skipped + counted,
 * never created header-only (a header-only proof row is not a complete proof).
 */
export interface AnchorConfirmationUpdateRow {
  anchorId: string;
  blockHeader: string;
  blockHash: string;
  /** Block height observed at confirmation (kept in sync if it was unset). */
  blockHeight?: number | null;
}

export interface ConfirmationUpdateResult {
  updated: number;
  missing: number;
}

export async function updateAnchorConfirmationProofs(
  client: SupabaseClient,
  rows: AnchorConfirmationUpdateRow[],
): Promise<ConfirmationUpdateResult> {
  if (rows.length === 0) return { updated: 0, missing: 0 };

  const dbAny = client as unknown as {
    from(table: string): {
      update(values: Record<string, unknown>): {
        eq(col: string, val: string): Promise<{ error: Error | null; count: number | null }>;
      };
    };
  };

  let updated = 0;
  let missing = 0;
  for (const row of rows) {
    const values: Record<string, unknown> = {
      block_header: row.blockHeader,
      block_hash: row.blockHash,
    };
    if (row.blockHeight != null) values.block_height = row.blockHeight;

    const { error, count } = await dbAny
      .from('anchor_proofs')
      .update(values)
      .eq('anchor_id', row.anchorId);

    if (error) throw error;
    if (count === 0) missing += 1;
    else updated += 1;
  }

  return { updated, missing };
}
