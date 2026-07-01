/**
 * PROOF-04 (SCRUM-2337) — second-pass P1: source `leaf_count` for the embedded
 * proof packet.
 *
 * The PDF audit certificate embeds the canonical `proof_bundle` packet, and
 * `leaf_count` is what arms the CVE-2012-2459 structural guard in the offline
 * verifier. The download path must SOURCE that value, not leave it `null`.
 *
 * `sourceProofInput` derives `leaf_count` the same way the server does
 * (PROOF-05): it counts the `anchor_proofs` rows that share the proof row's
 * `batch_id` (RLS-scoped, `head: true` count — a number, never rows / bytes /
 * PII). These tests assert:
 *  - a batched proof embeds the correct NON-null `leaf_count` (= batch row count)
 *    and is reported `complete`,
 *  - a single-leaf / un-batched SECURED record gets `leaf_count = 1`, complete,
 *  - a batched record whose `leaf_count` cannot be sourced (count error / null)
 *    is NOT reported complete — so the UI will not present it as a complete
 *    offline proof,
 *  - non-SECURED records and records with no proof row yield no packet,
 *  - the count query is `head: true` (no rows materialised — §1.6 / RLS).
 */
import { describe, expect, it, vi } from 'vitest';
import { sourceProofInput, type ProofSourceAnchor } from './sourceProofInput';

const FP = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);
const BRANCH = [
  { hash: 'c'.repeat(64), position: 'left' as const },
  { hash: 'e'.repeat(64), position: 'right' as const },
];

function securedAnchor(overrides: Partial<ProofSourceAnchor> = {}): ProofSourceAnchor {
  return {
    id: 'anchor-1',
    fingerprint: FP,
    status: 'SECURED',
    chain_tx_id: 'd'.repeat(64),
    chain_block_height: 850123,
    chain_timestamp: '2026-06-02T03:00:00Z',
    ...overrides,
  };
}

const BATCHED_ROW = {
  merkle_root: ROOT,
  proof_path: BRANCH,
  merkle_index: 3,
  batch_id: 'batch_1711234567890_5',
  block_hash: 'f'.repeat(64),
  block_header: '0'.repeat(160),
  block_height: 850123,
  op_return_payload: '6a20' + ROOT,
  proof_schema_version: 1,
  block_timestamp: '2026-06-02T03:00:00Z',
  receipt_id: 'd'.repeat(64),
};

const SINGLE_LEAF_ROW = {
  merkle_root: FP, // single-leaf tree: root == fingerprint
  proof_path: [], // empty branch
  merkle_index: 0,
  batch_id: null,
  block_hash: 'f'.repeat(64),
  block_header: '0'.repeat(160),
  block_height: 850123,
  op_return_payload: '6a20' + FP,
  proof_schema_version: 1,
  block_timestamp: '2026-06-02T03:00:00Z',
  receipt_id: 'd'.repeat(64),
};

/**
 * Minimal Supabase mock. `proofRow` is returned from the `anchor_proofs`
 * single-row `.maybeSingle()`; `count`/`countError` drive the head:true count
 * query that derives `leaf_count`. Records which queries used `head: true`.
 */
function makeSupabase(opts: {
  proofRow: Record<string, unknown> | null;
  count?: number | null;
  countError?: unknown;
}) {
  const headFlags: boolean[] = [];
  const eqFilters: Record<string, unknown>[] = [];

  const client = {
    from: vi.fn((_table: string) => {
      // First call: row fetch (object select, no count opts) → maybeSingle.
      // Second call: count query (head:true) → returns { count }.
      const builder: Record<string, unknown> = {};
      let isCountQuery = false;

      builder.select = vi.fn((_cols: string, selOpts?: { count?: string; head?: boolean }) => {
        if (selOpts?.head) {
          isCountQuery = true;
          headFlags.push(selOpts.head === true);
        }
        return builder;
      });
      builder.eq = vi.fn((col: string, val: unknown) => {
        eqFilters.push({ [col]: val });
        // A count query terminates on .eq() (no maybeSingle); resolve as thenable.
        if (isCountQuery) {
          return Promise.resolve({
            count: opts.count ?? null,
            error: opts.countError ?? null,
          });
        }
        return builder;
      });
      builder.maybeSingle = vi.fn(() =>
        Promise.resolve({ data: opts.proofRow, error: null }),
      );
      return builder;
    }),
  };

  return { client, headFlags, eqFilters };
}

describe('PROOF-04 sourceProofInput — leaf_count sourcing (P1)', () => {
  it('derives leaf_count from the batch row count for a batched proof', async () => {
    const { client, headFlags } = makeSupabase({ proofRow: BATCHED_ROW, count: 8 });
    const result = await sourceProofInput(client as never, securedAnchor());

    expect(result.complete).toBe(true);
    expect(result.proof).toBeDefined();
    expect(result.proof!.leaf_count).toBe(8);
    expect(result.proof!.merkle_root).toBe(ROOT);
    expect(result.proof!.merkle_proof).toEqual(BRANCH);
    expect(result.proof!.merkle_index).toBe(3);
    // §1.6 / RLS: the count query must be head:true (a number, no rows).
    expect(headFlags).toContain(true);
  });

  it('treats a single-leaf / un-batched SECURED record as leaf_count = 1, complete', async () => {
    const { client } = makeSupabase({ proofRow: SINGLE_LEAF_ROW });
    const result = await sourceProofInput(client as never, securedAnchor());

    expect(result.complete).toBe(true);
    expect(result.proof).toBeDefined();
    expect(result.proof!.leaf_count).toBe(1);
  });

  it('does NOT present a batched packet as complete when leaf_count cannot be sourced', async () => {
    // batch_id present (so the record IS a batch member) but the count errors.
    const { client } = makeSupabase({
      proofRow: BATCHED_ROW,
      count: null,
      countError: { message: 'rls / network failure' },
    });
    const result = await sourceProofInput(client as never, securedAnchor());

    // The packet may still be built, but it must be flagged incomplete so the
    // UI does not claim a complete offline proof.
    expect(result.complete).toBe(false);
    expect(result.proof?.leaf_count ?? null).toBeNull();
  });

  it('emits no packet for a non-SECURED record (gate fails closed)', async () => {
    const { client } = makeSupabase({ proofRow: BATCHED_ROW, count: 8 });
    const result = await sourceProofInput(
      client as never,
      securedAnchor({ status: 'PENDING' }),
    );
    expect(result.proof).toBeUndefined();
    expect(result.complete).toBe(false);
  });

  it('emits no packet when the anchor has no proof row', async () => {
    const { client } = makeSupabase({ proofRow: null });
    const result = await sourceProofInput(client as never, securedAnchor());
    expect(result.proof).toBeUndefined();
    expect(result.complete).toBe(false);
  });

  it('never carries document bytes / PII — only cryptographic proof fields', async () => {
    const { client } = makeSupabase({ proofRow: BATCHED_ROW, count: 8 });
    const result = await sourceProofInput(client as never, securedAnchor());
    const serialized = JSON.stringify(result.proof);
    expect(serialized).not.toMatch(/file_?name|file_?size|issuer|user_id|org_id/i);
    expect(serialized).not.toMatch(/document_bytes|raw_bytes|content/i);
  });
});
