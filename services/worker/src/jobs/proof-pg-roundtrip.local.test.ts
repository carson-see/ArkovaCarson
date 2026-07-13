/**
 * S3-P0 AC5 — PROOF STORAGE CONTRACT round-trip against a REAL local Postgres
 * (local Supabase stack: PostgREST + PG), NOT a mock.
 *
 *   anchor_proofs.block_header       bytea → MUST be written as `\x<hex>` so the
 *                                    stored value is the raw 80 bytes (BUG-4:
 *                                    bare hex stores 160 ASCII bytes).
 *   anchor_proofs.op_return_payload  bytea → same `\x<hex>` contract (36 raw
 *                                    bytes for ARKV‖root).
 *   anchor_proofs.merkle_root        text  → hex as-is.
 *   anchor_proofs.block_hash         text  → hex as-is.
 *
 * Round-trip: write via the REAL upsertAnchorProofs/updateAnchorConfirmationProofs
 * (supabase-js → PostgREST → PG) → read back via PostgREST → decode the 80-byte
 * header → recompute the app-tree branch to merkle_root → additionally assert
 * octet_length() at the SQL layer via psql.
 *
 * ENV-GATED (operator-sanctioned): runs only when PROOF_PG_ROUNDTRIP=1 and a
 * local stack is reachable. Required env:
 *   PROOF_PG_ROUNDTRIP=1
 *   PROOF_PG_ROUNDTRIP_URL          e.g. http://127.0.0.1:54321
 *   PROOF_PG_ROUNDTRIP_SERVICE_KEY  local service_role key (local demo stack only)
 *   PROOF_PG_ROUNDTRIP_DB_URL       e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres
 * NEVER point these at a remote/staging/prod project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATED = process.env.PROOF_PG_ROUNDTRIP === '1';

const REST_URL = process.env.PROOF_PG_ROUNDTRIP_URL ?? 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.PROOF_PG_ROUNDTRIP_SERVICE_KEY ?? '';
const DB_URL = process.env.PROOF_PG_ROUNDTRIP_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function sql(query: string): string {
  return execFileSync('psql', [DB_URL, '-tA', '-c', query], { encoding: 'utf8' }).trim();
}

// Bitcoin genesis block header — a REAL 80-byte header (160 hex chars).
const GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

const USER_ID = randomUUID();
const ANCHOR_A = randomUUID();
const ANCHOR_B = randomUUID();
const FP_A = 'a1'.repeat(32);
const FP_B = 'b2'.repeat(32);
const RECEIPT_ID = `s3p0_roundtrip_${Date.now()}`;
const BATCH_ID = `batch_s3p0_roundtrip_${Date.now()}`;

describe.skipIf(!GATED)('S3-P0 AC5 — anchor_proofs bytea/text round-trip (REAL local PG)', () => {
  // Deferred imports so the un-gated (CI) path never touches worker config.
  let client: import('@supabase/supabase-js').SupabaseClient;
  let upsertAnchorProofs: typeof import('../utils/anchorProofs.js')['upsertAnchorProofs'];
  let updateAnchorConfirmationProofs: typeof import('../utils/anchorProofs.js')['updateAnchorConfirmationProofs'];
  let fromByteaHex: typeof import('../utils/anchorProofs.js')['fromByteaHex'];
  let buildMerkleTree: typeof import('../utils/merkle.js')['buildMerkleTree'];
  let verifyMerkleInclusion: typeof import('../utils/merkle-verify.js')['verifyMerkleInclusion'];

  beforeAll(async () => {
    if (!SERVICE_KEY) {
      throw new Error('PROOF_PG_ROUNDTRIP=1 requires PROOF_PG_ROUNDTRIP_SERVICE_KEY (local stack service key)');
    }
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(REST_URL, SERVICE_KEY, { auth: { persistSession: false } });
    ({ upsertAnchorProofs, updateAnchorConfirmationProofs, fromByteaHex } = await import('../utils/anchorProofs.js'));
    ({ buildMerkleTree } = await import('../utils/merkle.js'));
    ({ verifyMerkleInclusion } = await import('../utils/merkle-verify.js'));

    // Fixture chain: auth.users → profiles → anchors (FKs). Local stack only.
    sql(`INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 's3p0-roundtrip-${USER_ID}@test.local')`);
    sql(`INSERT INTO public.profiles (id, email) VALUES ('${USER_ID}', 's3p0-roundtrip-${USER_ID}@test.local')`);
    sql(`INSERT INTO public.anchors (id, user_id, fingerprint, filename, status) VALUES
      ('${ANCHOR_A}', '${USER_ID}', '${FP_A}', 's3p0-roundtrip-a.pdf', 'PENDING'),
      ('${ANCHOR_B}', '${USER_ID}', '${FP_B}', 's3p0-roundtrip-b.pdf', 'PENDING')`);
  });

  afterAll(() => {
    try {
      sql(`DELETE FROM public.anchors WHERE id IN ('${ANCHOR_A}', '${ANCHOR_B}')`);
      sql(`DELETE FROM public.profiles WHERE id = '${USER_ID}'`);
      sql(`DELETE FROM auth.users WHERE id = '${USER_ID}'`);
    } catch {
      // Best-effort cleanup — rows are uniquely keyed by fresh UUIDs.
    }
  });

  it('writes the producer row shape, reads it back, decodes the 80-byte header, and recomputes the branch to merkle_root', async () => {
    const tree = buildMerkleTree([FP_A, FP_B]);
    const opReturn = `41524b56${tree.root}`;

    // ── Producer write (pre-broadcast intent shape) ──
    await upsertAnchorProofs(client, [
      {
        anchorId: ANCHOR_A,
        receiptId: RECEIPT_ID,
        merkleRoot: tree.root,
        proofPath: tree.proofs.get(FP_A),
        merkleIndex: 0,
        batchId: BATCH_ID,
        opReturnPayload: opReturn,
        rawResponse: {
          broadcast_intent: {
            tx_id: RECEIPT_ID,
            tx_hex: '02000000cafebabe',
            fee_sats: 141,
            prepared_at: new Date().toISOString(),
          },
        },
      },
      {
        anchorId: ANCHOR_B,
        receiptId: RECEIPT_ID,
        merkleRoot: tree.root,
        proofPath: tree.proofs.get(FP_B),
        merkleIndex: 1,
        batchId: BATCH_ID,
        opReturnPayload: opReturn,
      },
    ]);

    // ── Confirmation write (PROOF-03 shape) ──
    const confirmation = await updateAnchorConfirmationProofs(client, [
      { anchorId: ANCHOR_A, blockHeader: GENESIS_HEADER, blockHash: GENESIS_HASH, blockHeight: 800100 },
      { anchorId: ANCHOR_B, blockHeader: GENESIS_HEADER, blockHash: GENESIS_HASH, blockHeight: 800100 },
    ]);
    expect(confirmation).toEqual({ updated: 2, missing: 0 });

    // ── SQL-layer storage assertions: RAW BYTES, not ASCII-hex (BUG-4) ──
    expect(sql(`SELECT octet_length(block_header) FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_A}'`)).toBe('80');
    expect(sql(`SELECT octet_length(op_return_payload) FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_A}'`)).toBe('36');
    // text columns store hex as-is (64 CHARACTERS, not 32 bytes)
    expect(sql(`SELECT length(merkle_root) FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_A}'`)).toBe('64');
    expect(sql(`SELECT length(block_hash) FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_A}'`)).toBe('64');

    // ── Read back over PostgREST (the wire the verify API uses) ──
    const { data, error } = await client
      .from('anchor_proofs')
      .select('merkle_root, proof_path, merkle_index, batch_id, block_header, block_hash, op_return_payload, raw_response, proof_schema_version')
      .eq('anchor_id', ANCHOR_A)
      .single();
    expect(error).toBeNull();

    // bytea → \x-prefixed hex on the wire → plain hex via fromByteaHex.
    const headerHex = fromByteaHex((data as Record<string, unknown>).block_header);
    expect(headerHex).toBe(GENESIS_HEADER);
    expect(Buffer.from(headerHex as string, 'hex')).toHaveLength(80);

    const opReturnHex = fromByteaHex((data as Record<string, unknown>).op_return_payload);
    expect(opReturnHex).toBe(opReturn);

    // text columns come back verbatim.
    expect((data as Record<string, unknown>).merkle_root).toBe(tree.root);
    expect((data as Record<string, unknown>).block_hash).toBe(GENESIS_HASH);

    // The intent record survives the JSONB round-trip.
    const intent = ((data as Record<string, unknown>).raw_response as Record<string, Record<string, unknown>>).broadcast_intent;
    expect(intent.tx_id).toBe(RECEIPT_ID);
    expect(intent.tx_hex).toBe('02000000cafebabe');

    // ── Recompute the stored branch to the stored merkle_root (structural guard armed) ──
    const verdict = verifyMerkleInclusion(
      FP_A,
      (data as Record<string, unknown>).proof_path as import('../utils/merkle.js').MerkleProofEntry[],
      (data as Record<string, unknown>).merkle_root as string,
      { leafIndex: 0, leafCount: 2 },
    );
    expect(verdict).toEqual({ valid: true });
  });

  it('BUG-4 regression: a bare-hex header written WITHOUT the \\x prefix would store 160 ASCII bytes (contract proof)', () => {
    // Proven at the SQL layer with a throwaway cast — this is exactly why
    // toByteaHex must prefix. (No table write: contract demonstration.)
    expect(sql(`SELECT octet_length(('\\x${GENESIS_HEADER}')::bytea)`)).toBe('80');
    expect(sql(`SELECT octet_length(('${GENESIS_HEADER}')::bytea)`)).toBe('160');
  });
});
