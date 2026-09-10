import type { SupabaseClient } from '@supabase/supabase-js';
import type { MerkleProofEntry } from './merkle.js';
import { chunkForInFilter } from './postgrest-filter.js';

/**
 * Encode a hex string for a Postgres `bytea` column via PostgREST. A bare hex
 * string is stored as its ASCII bytes (2x size — a malformed 160-byte "header"),
 * whereas the `\x<hex>` form is hex-decoded to the raw bytes. Null/undefined pass
 * through. (BUG-4, soak-caught: `block_header` is `bytea`; `block_hash` and
 * `merkle_root` are `text`, so only `block_header` needs this.)
 */
function toByteaHex(hex: string | null | undefined): string | null | undefined {
  if (hex == null) return hex;
  return hex.startsWith('\\x') ? hex : `\\x${hex}`;
}

/**
 * Read-side inverse of {@link toByteaHex}. PostgREST returns a `bytea` column as
 * a `\x`-prefixed hex string (e.g. `\x0100...`). For the wire we expose plain
 * lowercase hex (no `\x`), matching how `block_header` / `op_return_payload` are
 * presented everywhere else (confirmation-proof.ts emits bare 160-hex). A value
 * that is null/empty, not a string, or not valid hex returns `null` — we never
 * forward a malformed payload as if it were a real header (Constitution §1.5:
 * honest representation, never fabricated).
 */
export function fromByteaHex(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  return hex.toLowerCase();
}

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
  /**
   * S3-P0: the raw OP_RETURN payload the batch tx commits, as plain hex —
   * "ARKV"(4B) + app-tree root(32B), NO version byte (chain/signet.ts shape).
   * Persisted to `anchor_proofs.op_return_payload` (bytea → `\x`-prefixed).
   * Undefined = key omitted entirely (no clobber of an existing value).
   */
  opReturnPayload?: string | null;
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
      if (row.blockHeader !== undefined) mapped.block_header = toByteaHex(row.blockHeader);
      if (row.blockHash !== undefined) mapped.block_hash = row.blockHash;
      // S3-P0: same omit-when-undefined contract for op_return_payload (bytea).
      if (row.opReturnPayload !== undefined) {
        mapped.op_return_payload = toByteaHex(row.opReturnPayload);
      }
      return mapped;
    });

    const { error } = await dbAny
      .from('anchor_proofs')
      .upsert(chunk, { onConflict: 'anchor_id' });

    if (error) throw error;
  }
}

/**
 * PROOF-03 (SCRUM-2336) + R1: persist ONLY the bitcoin-tree confirmation
 * columns (`block_header`, `block_hash`, and — R1 — `tx_inclusion_branch` +
 * `tx_block_index`) onto EXISTING `anchor_proofs` rows, keyed by `anchor_id`,
 * WITHOUT touching the app-tree columns (`merkle_root`, `proof_path`,
 * `merkle_index`) that FIX-1 already wrote at broadcast time.
 *
 * All four bitcoin-tree values are written in ONE row UPDATE, so a branch can
 * never be persisted apart from the header it was derived under (the K1 reorg
 * invariant is structural here, not a convention the caller has to remember).
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
  /**
   * R1: the BITCOIN-tree inclusion branch proving this tx is committed by the
   * merkleroot inside `blockHeader` (migration 0427 `tx_inclusion_branch`).
   *
   * Siblings are BYTE-REVERSED (display) hex and fold with Bitcoin's
   * double-SHA256 positional rule — a DIFFERENT convention from the layer-1
   * app-tree `proofPath`, which is why it carries a different name. An empty
   * array is a complete branch (single-tx block), not a missing one.
   *
   * `undefined` omits the key entirely so a header-only write can never clobber
   * an already-populated branch; `null` writes an explicit null.
   */
  txInclusionBranch?: MerkleProofEntry[] | null;
  /**
   * R1: 0-based index of the tx within its block (migration 0427
   * `tx_block_index`). 0 is a real position (coinbase), never a blank — the
   * mapping below is `undefined`-guarded, NOT falsy-guarded, for that reason.
   */
  txBlockIndex?: number | null;
}

export interface ConfirmationUpdateResult {
  updated: number;
  missing: number;
}

/** A 32-byte hash in display hex — the only shape a bitcoin-tree sibling may take. */
const SIBLING_HASH_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * H3 + H4: is this branch/index pair internally coherent enough to persist?
 *
 * Migration 0427 declines a CHECK constraint on the grounds that "the writer
 * and the reader both validate shape and reject anything malformed as NULL".
 * The reader did. The writer validated NOTHING — it forwarded whatever it was
 * handed straight into an unconstrained `jsonb` column, so
 * `[{"hash":"","position":"left"}]` would be persisted and then published as
 * genuine inclusion evidence. This is the writer's half of that sentence.
 *
 * The rules are the SAME ones `verify-proof.ts` applies on read, deliberately:
 *   - both halves present (a branch with no index is not evidence),
 *   - every sibling exactly 64 hex characters (a non-32-byte value cannot take
 *     part in a double-SHA256 fold at all),
 *   - `0 <= index < 2^branch.length` (a height-L tree holds at most 2^L leaves),
 *   - each level's sibling side matches that level's bit of the index.
 */
function isCoherentInclusionPair(branch: MerkleProofEntry[], index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  if (branch.length > 31) return false;
  if (index >= 1 << branch.length) return false;
  return branch.every((entry, level) => {
    if (entry == null || typeof entry.hash !== 'string' || !SIBLING_HASH_HEX_RE.test(entry.hash)) {
      return false;
    }
    const expected = ((index >> level) & 1) === 0 ? 'right' : 'left';
    return entry.position === expected;
  });
}

/** Build the column→value payload for one confirmation update. */
function buildConfirmationValues(row: AnchorConfirmationUpdateRow): Record<string, unknown> {
  const values: Record<string, unknown> = {
    // BUG-4 (soak-caught): block_header is `bytea` — a bare hex string stores as
    // ASCII bytes (160) not the raw 80-byte header. toByteaHex sends `\x<hex>`.
    block_header: toByteaHex(row.blockHeader),
    block_hash: row.blockHash,
  };
  if (row.blockHeight != null) values.block_height = row.blockHeight;

  // R1 + H4: the branch and the index are ONE fact and move together.
  //
  // Omit-when-undefined (same contract as block_header on the upsert path) so a
  // caller that does not know about the bitcoin-tree columns cannot null out a
  // branch a previous pass already backfilled. `0` and `[]` are REAL values and
  // must survive — hence explicit `undefined` tests, not truthiness: tx 0 of a
  // block and a single-tx block's empty branch are both complete answers.
  //
  // What changed (H4): the two keys used to be emitted INDEPENDENTLY, so a
  // caller supplying only one wrote half a pair — and a branch with a NULL
  // index then dropped out of the populate scan's watermark entirely, leaving a
  // row that was unrepairable while `/proof` published a branch no verifier
  // could order-check. Now: write BOTH or NEITHER.
  const bothCleared = row.txInclusionBranch === null && row.txBlockIndex === null;
  if (bothCleared) {
    // A deliberate clear of the pair is coherent, and is how a caller retracts
    // evidence it no longer stands behind.
    values.tx_inclusion_branch = null;
    values.tx_block_index = null;
    return values;
  }
  if (
    Array.isArray(row.txInclusionBranch) &&
    typeof row.txBlockIndex === 'number' &&
    isCoherentInclusionPair(row.txInclusionBranch, row.txBlockIndex)
  ) {
    values.tx_inclusion_branch = row.txInclusionBranch;
    values.tx_block_index = row.txBlockIndex;
  }
  // Anything else — half a pair, a malformed branch, an index that contradicts
  // the branch — writes NEITHER key. The header/hash still land, so the row is
  // not left unwritten, and the scan will come back for the missing evidence.
  return values;
}

export async function updateAnchorConfirmationProofs(
  client: SupabaseClient,
  rows: AnchorConfirmationUpdateRow[],
): Promise<ConfirmationUpdateResult> {
  if (rows.length === 0) return { updated: 0, missing: 0 };

  // MED-2: `.update()` does NOT return a row count unless explicitly requested
  // (the prior code read `count` without `{ count: 'exact' }`, so it was always
  // null — every row counted as updated and `missing` was stuck at 0, making
  // the "no anchor_proofs row" warn unreachable). Use the established
  // `.select(...)`-then-`data` signal (anchorExpirySweep.ts:507-515): the
  // returned rows name exactly which anchors existed, so the shortfall inside a
  // statement is a real missing-row count.
  const dbAny = client as unknown as {
    from(table: string): {
      update(values: Record<string, unknown>): {
        in(col: string, vals: string[]): {
          select(cols: string): Promise<{ error: Error | null; data: Array<{ anchor_id: string }> | null }>;
        };
      };
    };
  };

  // M3: ONE statement per distinct value payload, not one per row.
  //
  // This was a per-row `.update().eq()` loop — one PostgREST round-trip each.
  // Against the ~667k-row backfill at 2,000 rows per */15 run that is ~334 runs
  // ≈ 83.5 hours of pure request latency. The workload's own shape makes it
  // unnecessary: anchors in a merkle batch share ONE transaction, therefore ONE
  // confirmation proof, therefore BYTE-IDENTICAL header/hash/branch/index — up
  // to 10,000 rows differing in nothing but their id. Group by the payload and
  // send each group as a single `.in('anchor_id', [...])` UPDATE, chunked by
  // `chunkForInFilter` (real encoded wire bytes, not a hand-picked count).
  //
  // Still an UPDATE, never an upsert: a missing `anchor_proofs` row must stay
  // missing (a header-only proof row is not a proof), which an INSERT-on-conflict
  // would silently create.
  const groups = new Map<string, { values: Record<string, unknown>; anchorIds: string[] }>();
  for (const row of rows) {
    const values = buildConfirmationValues(row);
    const key = JSON.stringify(values);
    const existing = groups.get(key);
    if (existing) existing.anchorIds.push(row.anchorId);
    else groups.set(key, { values, anchorIds: [row.anchorId] });
  }

  let updated = 0;
  let missing = 0;
  for (const { values, anchorIds } of groups.values()) {
    // `chunkForInFilter` bounds each request by REAL encoded wire bytes, not a
    // hand-picked count — picking that count is the mistake that reached prod
    // three times, which is why the repo lints against hand-rolled chunk loops.
    for (const chunk of chunkForInFilter(anchorIds)) {
      const { error, data } = await dbAny
        .from('anchor_proofs')
        .update(values)
        .in('anchor_id', chunk.values)
        .select('anchor_id');

      if (error) throw error;
      const matched = data?.length ?? 0;
      updated += matched;
      missing += chunk.values.length - matched;
    }
  }

  return { updated, missing };
}
