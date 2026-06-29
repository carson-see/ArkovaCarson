/**
 * sourceProofInput — assemble the machine-readable proof inputs for the audit
 * certificate, INCLUDING a sourced `leaf_count`.
 *
 * PROOF-04 (SCRUM-2337) second-pass P1
 * -----------------------------------
 * The embedded `proof_bundle` packet carries `leaf_count` — the total leaf
 * count of the batch Merkle tree. That field is what arms the CVE-2012-2459
 * structural guard in the offline verifier (a duplicated-leaf / odd-node tree
 * can forge an inclusion proof unless the verifier also checks the leaf count).
 *
 * The original download path never sourced it: the `anchor_proofs` row is a
 * single row (one proof per anchor — the FK is one-to-one) and carries no
 * `leaf_count` column, so the embedded packet always shipped `leaf_count: null`
 * and the certificate could not run the full guard for any BATCH proof.
 *
 * This helper derives `leaf_count` the SAME way the server does (PROOF-05 /
 * #1354): a batch member's `anchor_proofs.batch_id` is shared by every leaf in
 * that batch, so the leaf count is just the number of `anchor_proofs` rows with
 * that `batch_id`. We run an RLS-scoped `head: true` COUNT (a number, never
 * rows) — no document bytes, no PII leave the query (§1.6). RLS scopes the count
 * to rows the viewer may see, exactly like the proof row itself.
 *
 * Single-leaf / un-batched SECURED records (no `batch_id`, empty inclusion
 * branch — the tree root equals the document fingerprint) have a leaf count of
 * 1 by construction; we set `leaf_count = 1` without a query.
 *
 * Completeness gate
 * -----------------
 * If a record IS a batch member (`batch_id` present) but the count cannot be
 * sourced (RLS / network error, or a null/zero count), we DO NOT claim a
 * complete offline proof: `leaf_count` stays `null` and `complete` is `false`.
 * The page uses `complete` to avoid presenting the embedded packet as a
 * runnable-offline proof for such records (see RecordDetailPage.onDownloadProof).
 *
 * Client-side only (§1.6): this runs in the browser against the user's
 * RLS-scoped Supabase session. It never imports the worker, never reads
 * document bytes, and the returned `ProofInput` is a strict allow-list of
 * cryptographic fields (no filename / issuer / file size / record id).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import type { MerkleProofEntry, ProofInput } from './generateAuditReport';
import { isProofDownloadable } from './statusDisplay';

/** The app's RLS-scoped browser Supabase client. */
export type ProofSourceClient = SupabaseClient<Database>;

/** Minimal anchor fields the proof packet derives from (no PII beyond what the
 *  packet already allow-lists; `id` is used only to scope the DB read). */
export interface ProofSourceAnchor {
  id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
}

export interface ProofSourceResult {
  /** The assembled proof inputs, or `undefined` when no packet should embed
   *  (non-SECURED, or no `anchor_proofs` row). */
  proof: ProofInput | undefined;
  /**
   * `true` only when a fully-sourced packet (including `leaf_count`) is
   * available. `false` for non-SECURED records, records without a proof row,
   * and — critically — batch members whose `leaf_count` could not be sourced.
   * The UI must not present an incomplete packet as a complete offline proof.
   */
  complete: boolean;
}

/** Columns selected from `anchor_proofs` for the embedded packet (+ `batch_id`
 *  so we can derive `leaf_count`). Strict allow-list: no document bytes / PII. */
const PROOF_COLUMNS =
  'merkle_root, proof_path, merkle_index, batch_id, block_hash, block_header, block_height, op_return_payload, proof_schema_version, block_timestamp, receipt_id';

interface AnchorProofRow {
  merkle_root: string | null;
  proof_path: unknown;
  merkle_index: number | null;
  batch_id: string | null;
  block_hash: string | null;
  block_header: string | null;
  block_height: number | null;
  op_return_payload: string | null;
  proof_schema_version: number | null;
  block_timestamp: string | null;
  receipt_id: string | null;
}

/** Type guard: a value is a well-formed `{ hash, position }` Merkle entry. */
function isMerkleEntry(v: unknown): v is MerkleProofEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.hash === 'string' && (e.position === 'left' || e.position === 'right');
}

/**
 * Fetch the proof row + derive `leaf_count`, returning the inputs the audit
 * report needs plus a completeness flag. See module header for the rules.
 */
export async function sourceProofInput(
  supabase: ProofSourceClient,
  anchor: ProofSourceAnchor,
): Promise<ProofSourceResult> {
  // Gate fails closed: only genuinely SECURED records carry a complete proof.
  if (!isProofDownloadable(anchor.status)) {
    return { proof: undefined, complete: false };
  }

  const { data } = await supabase
    .from('anchor_proofs')
    .select(PROOF_COLUMNS)
    .eq('anchor_id', anchor.id)
    .maybeSingle();

  const proofRow = (data ?? null) as AnchorProofRow | null;
  if (!proofRow) {
    // SECURED but no proof row persisted (yet) — nothing to embed.
    return { proof: undefined, complete: false };
  }

  // `proof_path` is the SAME branch shape the verify-proof API and PROOF-07 CLI
  // consume. Validate + PRESERVE the structured `{ hash, position }` entries;
  // never flatten to strings (that drops the side the offline verifier needs to
  // recompute the root). Drop only malformed rows.
  const merkleProof: MerkleProofEntry[] | null = Array.isArray(proofRow.proof_path)
    ? (proofRow.proof_path as unknown[]).filter(isMerkleEntry)
    : null;

  // A non-empty inclusion branch (or a non-null batch_id) means this leaf lives
  // in a multi-leaf batch tree. A single-leaf tree has an empty branch and the
  // root equals the document fingerprint — its leaf count is 1 by construction.
  const isBatchMember =
    proofRow.batch_id != null || (merkleProof != null && merkleProof.length > 0);

  let leafCount: number | null;
  let complete: boolean;

  if (!isBatchMember) {
    // Single-leaf / un-batched: leaf_count is 1, fully sourced.
    leafCount = 1;
    complete = true;
  } else if (proofRow.batch_id != null) {
    // Derive leaf_count the way the server does: count the anchor_proofs rows
    // that share this batch_id. RLS-scoped, head:true → a number, no rows / PII.
    const { count, error } = await supabase
      .from('anchor_proofs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', proofRow.batch_id);

    if (!error && typeof count === 'number' && count > 0) {
      leafCount = count;
      complete = true;
    } else {
      // Could not source leaf_count for a batch member → do not claim complete.
      leafCount = null;
      complete = false;
    }
  } else {
    // Batch-shaped branch but no batch_id to count by — cannot source the leaf
    // count, so the packet is not a complete offline proof.
    leafCount = null;
    complete = false;
  }

  const proof: ProofInput = {
    fingerprint: anchor.fingerprint,
    merkle_root: proofRow.merkle_root,
    merkle_proof: merkleProof,
    merkle_index: proofRow.merkle_index,
    leaf_count: leafCount,
    tx_id: anchor.chain_tx_id ?? proofRow.receipt_id ?? null,
    block_height: proofRow.block_height ?? anchor.chain_block_height ?? null,
    block_hash: proofRow.block_hash,
    block_header: proofRow.block_header,
    op_return_payload: proofRow.op_return_payload,
    proof_schema_version: proofRow.proof_schema_version,
    // Machine field is `block_timestamp` (the human-readable PDF label still
    // reads "Network Observed Time").
    block_timestamp: proofRow.block_timestamp ?? anchor.chain_timestamp ?? null,
  };

  return { proof, complete };
}
