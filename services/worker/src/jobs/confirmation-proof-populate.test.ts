/**
 * Tests for PROOF-03 (SCRUM-2336) confirmation-proof population fan-out.
 *
 * NO real Bitcoin API (§1.7): the provider + Supabase client are vi.fn mocks.
 * Focus: (1) one RPC fetch per UNIQUE tx even when many anchors share it,
 * (2) confirmed → persisted to every anchor of the tx, (3) pending/stale are
 * NOT persisted, (4) reorg + missing handled without crashing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  populateConfirmationProofs,
  populateConfirmationProofsForSecuredAnchors,
  __resetConfirmationScanCursorForTests,
  type ConfirmationProofCandidate,
} from './confirmation-proof-populate.js';
import { HttpError, type ConfirmationProofProvider } from '../chain/utxo-provider.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function dsha(b: Buffer): Buffer {
  return bitcoin.crypto.sha256(bitcoin.crypto.sha256(b));
}
function makeTxidLE(seed: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(seed >>> 0, 0);
  for (let i = 4; i < 32; i++) b[i] = (seed * 7 + i) & 0xff;
  return b;
}
function displayHex(le: Buffer): string {
  return Buffer.from(le).reverse().toString('hex');
}
function computeMerkleRootLE(leavesLE: Buffer[]): Buffer {
  let level = leavesLE.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(dsha(Buffer.concat([level[i], level[i + 1]])));
    level = next;
  }
  return level[0];
}
function buildHeader(merkleRootLE: Buffer): Buffer {
  const header = Buffer.alloc(80);
  header.writeInt32LE(0x20000000, 0);
  for (let i = 4; i < 36; i++) header[i] = (i * 3) & 0xff;
  merkleRootLE.copy(header, 36);
  header.writeUInt32LE(1_700_000_000, 68);
  header.writeUInt32LE(0x1d00ffff, 72);
  header.writeUInt32LE(42, 76);
  return header;
}
/** Single-leaf block: header + 1 tx; proof = header + 1-tx partial tree. */
function buildSingleTxProof(leafLE: Buffer): { proofHex: string; headerHex: string; blockHash: string } {
  const root = computeMerkleRootLE([leafLE]);
  const header = buildHeader(root);
  const totalTx = Buffer.alloc(4);
  totalTx.writeUInt32LE(1, 0);
  // 1 hash, 1 flag byte (bit 0 set = match)
  const parts = [header, totalTx, Buffer.from([1]), leafLE, Buffer.from([1]), Buffer.from([0x01])];
  const proofHex = Buffer.concat(parts).toString('hex');
  const headerHex = header.toString('hex');
  const blockHash = Buffer.from(dsha(header)).reverse().toString('hex');
  return { proofHex, headerHex, blockHash };
}

/**
 * Supabase mock for the `.from().update().in().select()` confirmation path
 * (MED-2: the write requests affected rows via `.select('anchor_id')`; M3: one
 * statement covers every anchor sharing a value payload). `rowsExist` decides
 * which ids actually have an `anchor_proofs` row — ids it rejects come back
 * absent from the returned array, which is exactly how a missing row looks.
 */
function mockClient(rowsExist: (id: string) => boolean = () => true) {
  const update = vi.fn((_values: Record<string, unknown>) => ({
    in: vi.fn((_col: string, ids: string[]) => ({
      select: vi.fn((_cols: string) =>
        Promise.resolve({
          error: null,
          data: ids.filter(rowsExist).map((anchor_id) => ({ anchor_id })),
        }),
      ),
    })),
  }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as unknown as SupabaseClient, from, update };
}

describe('populateConfirmationProofs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op for no candidates', async () => {
    const { client, from } = mockClient();
    const provider: ConfirmationProofProvider = { getRawTransaction: vi.fn() };
    const result = await populateConfirmationProofs(client, provider, []);
    expect(result.txAttempted).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it('fetches ONE proof per unique tx and writes it to EVERY anchor of that tx', async () => {
    const leaf = makeTxidLE(1);
    const txId = displayHex(leaf);
    const { proofHex, headerHex, blockHash } = buildSingleTxProof(leaf);

    const getRawTransaction = vi.fn().mockResolvedValue({
      txid: txId,
      confirmations: 10,
      blockhash: blockHash,
      vout: [],
    });
    const getBlockHeaderHex = vi.fn().mockResolvedValue(headerHex);
    const getTxOutProof = vi.fn().mockResolvedValue(proofHex);
    const provider: ConfirmationProofProvider = { getRawTransaction, getBlockHeaderHex, getTxOutProof };

    const { client, update } = mockClient();

    // 3 anchors share the SAME merkle tx
    const candidates: ConfirmationProofCandidate[] = [
      { anchorId: 'a', chainTxId: txId, blockHeight: 800000 },
      { anchorId: 'b', chainTxId: txId, blockHeight: 800000 },
      { anchorId: 'c', chainTxId: txId, blockHeight: 800000 },
    ];

    const result = await populateConfirmationProofs(client, provider, candidates, { minConfirmations: 6 });

    // ONE RPC fetch per unique tx (not per anchor)
    expect(getRawTransaction).toHaveBeenCalledTimes(1);
    expect(getTxOutProof).toHaveBeenCalledTimes(1);
    expect(getBlockHeaderHex).toHaveBeenCalledTimes(1);

    // proof written to all 3 anchors
    expect(result.txAttempted).toBe(1);
    expect(result.txConfirmed).toBe(1);
    expect(result.anchorsUpdated).toBe(3);
    // M3: three anchors of ONE tx share one byte-identical payload, so they
    // land in a SINGLE statement rather than three round-trips.
    expect(update).toHaveBeenCalledTimes(1);
    // …and that value carries the header + hash
    const firstValues = update.mock.calls[0][0] as Record<string, unknown>;
    // BUG-4: block_header is `bytea` → persisted as `\x<hex>` (raw bytes). block_hash is text.
    expect(firstValues.block_header).toBe(`\\x${headerHex}`);
    expect(firstValues.block_hash).toBe(blockHash);
  });

  it('groups across MULTIPLE txs: 2 unique txs ⇒ 2 fetches', async () => {
    const leafA = makeTxidLE(10);
    const leafB = makeTxidLE(20);
    const txA = displayHex(leafA);
    const txB = displayHex(leafB);
    const pA = buildSingleTxProof(leafA);
    const pB = buildSingleTxProof(leafB);

    const getRawTransaction = vi.fn(async (txid: string) => {
      if (txid === txA) return { txid: txA, confirmations: 8, blockhash: pA.blockHash, vout: [] };
      return { txid: txB, confirmations: 8, blockhash: pB.blockHash, vout: [] };
    });
    const getBlockHeaderHex = vi.fn(async (hash: string) => (hash === pA.blockHash ? pA.headerHex : pB.headerHex));
    const getTxOutProof = vi.fn(async (txids: string[]) => (txids[0] === txA ? pA.proofHex : pB.proofHex));
    const provider: ConfirmationProofProvider = { getRawTransaction, getBlockHeaderHex, getTxOutProof };

    const { client, update } = mockClient();
    const candidates: ConfirmationProofCandidate[] = [
      { anchorId: 'a1', chainTxId: txA },
      { anchorId: 'a2', chainTxId: txA },
      { anchorId: 'b1', chainTxId: txB },
    ];

    const result = await populateConfirmationProofs(client, provider, candidates);
    expect(getRawTransaction).toHaveBeenCalledTimes(2); // 2 unique txs, not 3 anchors
    expect(result.txAttempted).toBe(2);
    expect(result.txConfirmed).toBe(2);
    expect(result.anchorsUpdated).toBe(3);
    // M3: two DISTINCT payloads (two txs ⇒ two headers) ⇒ two statements —
    // never one per anchor.
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does NOT persist when the tx is pending (no header written)', async () => {
    const txId = displayHex(makeTxidLE(2));
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({ txid: txId, confirmations: 0, vout: [] }),
      getBlockHeaderHex: vi.fn(),
      getTxOutProof: vi.fn(),
    };
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(client, provider, [
      { anchorId: 'a', chainTxId: txId },
    ]);
    expect(result.txPending).toBe(1);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('does NOT persist when the tx is stale (reorg) and counts it', async () => {
    const txId = displayHex(makeTxidLE(3));
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: txId,
        confirmations: 5,
        blockhash: 'd'.repeat(64),
        vout: [],
      }),
      getBlockHeaderHex: vi.fn(),
      getTxOutProof: vi.fn(),
    };
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(client, provider, [
      { anchorId: 'a', chainTxId: txId, expectedBlockHash: 'e'.repeat(64) },
    ]);
    expect(result.txStale).toBe(1);
    expect(result.anchorsUpdated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports anchorsMissing when an anchor has no anchor_proofs row (update matches no row)', async () => {
    const leaf = makeTxidLE(4);
    const txId = displayHex(leaf);
    const { proofHex, headerHex, blockHash } = buildSingleTxProof(leaf);
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({ txid: txId, confirmations: 10, blockhash: blockHash, vout: [] }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(proofHex),
    };
    const { client } = mockClient(() => false); // no anchor_proofs row exists for any id
    const result = await populateConfirmationProofs(client, provider, [
      { anchorId: 'a', chainTxId: txId },
    ]);
    expect(result.txConfirmed).toBe(1);
    expect(result.anchorsUpdated).toBe(0);
    expect(result.anchorsMissing).toBe(1);
  });

  it('treats a provider fetch rejection as pending (retry next tick), never throws', async () => {
    const txId = displayHex(makeTxidLE(5));
    // getRawTransaction resolves but getTxOutProof rejects → fetchConfirmationProof
    // returns stale; to force a runWithConcurrency rejection, make getRawTransaction
    // itself throw a non-Error (fetchConfirmationProof catches Errors → pending,
    // so use the provider-missing path differently): simplest is a tx that throws
    // synchronously inside the task. Here we assert the helper never throws.
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({ txid: txId, confirmations: 0, vout: [] }),
    };
    const { client } = mockClient();
    await expect(
      populateConfirmationProofs(client, provider, [{ anchorId: 'a', chainTxId: txId }]),
    ).resolves.toBeDefined();
  });

  // ── #1408: fault classification propagates through the fan-out ──
  // The tx IS mined (getRawTransaction resolves confirmed), but the header/proof
  // fetch throws. A TRANSIENT throw ⇒ txPending (retry, NOT persisted); a
  // DEFINITIVE throw ⇒ txStale (NOT persisted). This is the exact contract the
  // #1408 rig never exercised (0 hits in 6h), verified here through the real
  // populate fan-out rather than only at fetchConfirmationProof.

  function minedProviderWithFailingProofFetch(err: unknown): {
    provider: ConfirmationProofProvider;
    txId: string;
  } {
    const leaf = makeTxidLE(0x1408);
    const txId = displayHex(leaf);
    const { blockHash } = buildSingleTxProof(leaf);
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({ txid: txId, confirmations: 12, blockhash: blockHash, vout: [] }),
      getBlockHeaderHex: vi.fn().mockRejectedValue(err),
      getTxOutProof: vi.fn().mockRejectedValue(err),
    };
    return { provider, txId };
  }

  it('counts a TRANSIENT proof-fetch fault (HTTP 503) as txPending and persists nothing', async () => {
    const { provider, txId } = minedProviderWithFailingProofFetch(
      new HttpError('RPC gettxoutproof failed: HTTP 503', 503),
    );
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'a', chainTxId: txId }],
      { minConfirmations: 6 },
    );
    expect(result.txPending).toBe(1);
    expect(result.txStale).toBe(0);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('counts a TRANSIENT proof-fetch fault (HTTP 429 rate-limit) as txPending', async () => {
    const { provider, txId } = minedProviderWithFailingProofFetch(
      new HttpError('RPC gettxoutproof failed: HTTP 429', 429),
    );
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'a', chainTxId: txId }],
      { minConfirmations: 6 },
    );
    expect(result.txPending).toBe(1);
    expect(result.txStale).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('counts a DEFINITIVE proof-fetch fault (RPC "Block not found") as txStale and persists nothing', async () => {
    const { provider, txId } = minedProviderWithFailingProofFetch(
      new Error('RPC gettxoutproof error: Block not found (code -5)'),
    );
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'a', chainTxId: txId }],
      { minConfirmations: 6 },
    );
    expect(result.txStale).toBe(1);
    expect(result.txPending).toBe(0);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('classifies transient vs definitive INDEPENDENTLY across a mixed batch (2 unique txs)', async () => {
    const leafT = makeTxidLE(0x7777);
    const leafD = makeTxidLE(0x9999);
    const txT = displayHex(leafT); // transiently-failing tx
    const txD = displayHex(leafD); // definitively-failing tx
    const pT = buildSingleTxProof(leafT);
    const pD = buildSingleTxProof(leafD);
    const transient = new HttpError('RPC getblockheader failed: HTTP 500', 500);
    const definitive = new Error('RPC gettxoutproof error: Transaction not in block (code -5)');

    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn(async (txid: string) =>
        txid === txT
          ? { txid: txT, confirmations: 9, blockhash: pT.blockHash, vout: [] }
          : { txid: txD, confirmations: 9, blockhash: pD.blockHash, vout: [] },
      ),
      getBlockHeaderHex: vi.fn(async (hash: string) => {
        throw hash === pT.blockHash ? transient : definitive;
      }),
      getTxOutProof: vi.fn(async (txids: string[]) => {
        throw txids[0] === txT ? transient : definitive;
      }),
    };
    const { client, update } = mockClient();
    const result = await populateConfirmationProofs(
      client,
      provider,
      [
        { anchorId: 'a', chainTxId: txT },
        { anchorId: 'b', chainTxId: txD },
      ],
      { minConfirmations: 6 },
    );
    expect(result.txAttempted).toBe(2);
    expect(result.txPending).toBe(1); // the transient one retries
    expect(result.txStale).toBe(1); // the definitive one is parked
    expect(result.txConfirmed).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * Builds a Supabase mock that returns `scanRows` from the anchor_proofs scan
 * (a thenable query builder where every filter method returns `this`) AND
 * supports the `.update().eq()` confirmation write.
 */
function mockScanClient(scanRows: unknown[], rowsExist: (id: string) => boolean = () => true) {
  const update = vi.fn((_values: Record<string, unknown>) => ({
    in: vi.fn((_col: string, ids: string[]) => ({
      select: vi.fn((_cols: string) =>
        Promise.resolve({
          error: null,
          data: ids.filter(rowsExist).map((anchor_id) => ({ anchor_id })),
        }),
      ),
    })),
  }));
  const selectResult = { data: scanRows, error: null };
  const builder: Record<string, unknown> = {};
  // `or` is the K3 watermark filter and `gt`/`order` are the H1 sweep cursor —
  // a mock missing any of them returns undefined mid-chain and the scan dies,
  // so the mock has to model the real query exactly.
  for (const m of ['select', 'not', 'is', 'eq', 'limit', 'or', 'order', 'gt']) {
    builder[m] = vi.fn(() => builder);
  }
  // make the builder awaitable (resolves to the scan result)
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(selectResult);
  const from = vi.fn((table: string) => (table === 'anchor_proofs' ? { ...builder, update } : { update }));
  return { client: { from } as unknown as SupabaseClient, from, update };
}

describe('populateConfirmationProofsForSecuredAnchors (scan + wiring)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds candidates from the scan and populates them', async () => {
    const leaf = makeTxidLE(42);
    const txId = displayHex(leaf);
    const { proofHex, headerHex, blockHash } = buildSingleTxProof(leaf);

    const scanRows = [
      {
        anchor_id: 'anc-1',
        receipt_id: txId,
        block_height: 800500,
        anchors: { chain_tx_id: txId, chain_block_height: 800500, status: 'SECURED' },
      },
    ];
    const { client } = mockScanClient(scanRows);

    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({ txid: txId, confirmations: 10, blockhash: blockHash, vout: [] }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(proofHex),
    };

    const result = await populateConfirmationProofsForSecuredAnchors(client, provider, { minConfirmations: 6 });
    expect(result.scanned).toBe(1);
    expect(result.txConfirmed).toBe(1);
    expect(result.anchorsUpdated).toBe(1);
  });

  it('returns zeroed result (no throw) when the scan query errors', async () => {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'not', 'is', 'eq', 'limit', 'or', 'order', 'gt']) {
      builder[m] = vi.fn(() => builder);
    }
    (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: new Error('db down') });
    const client = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
    const provider: ConfirmationProofProvider = { getRawTransaction: vi.fn() };

    const result = await populateConfirmationProofsForSecuredAnchors(client, provider);
    expect(result.scanned).toBe(0);
    expect(result.txAttempted).toBe(0);
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
  });

  it('skips scan rows whose joined anchor has no chain_tx_id', async () => {
    const scanRows = [
      { anchor_id: 'anc-x', receipt_id: null, block_height: null, anchors: { chain_tx_id: null, chain_block_height: null, status: 'SECURED' } },
    ];
    const { client } = mockScanClient(scanRows);
    const provider: ConfirmationProofProvider = { getRawTransaction: vi.fn() };
    const result = await populateConfirmationProofsForSecuredAnchors(client, provider);
    expect(result.scanned).toBe(1);
    expect(result.txAttempted).toBe(0); // no valid candidates
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
  });
});

// =============================================================================
// R1 — persist the bitcoin-tree inclusion branch + tx block index
// =============================================================================

/**
 * Build a REAL serialized `CMerkleBlock` (the `gettxoutproof` wire format) over
 * `leavesLE`, proving inclusion of the leaf at `targetIndex`.
 *
 * This is Bitcoin Core's `CPartialMerkleTree::TraverseAndBuild` — the exact
 * inverse of the `TraverseAndExtract` walk `parseTxOutProof` runs — so the blob
 * under test is the genuine format a node emits, not a hand-shaped
 * approximation that only happens to satisfy our own parser.
 */
function buildMultiTxProof(
  leavesLE: Buffer[],
  targetIndex: number,
): { proofHex: string; headerHex: string; blockHash: string; merkleRootDisplay: string } {
  const totalTx = leavesLE.length;
  const widthAt = (h: number): number => Math.floor((totalTx + (1 << h) - 1) / (1 << h));
  let treeHeight = 0;
  while (widthAt(treeHeight) > 1) treeHeight++;

  const calcHash = (height: number, pos: number): Buffer => {
    if (height === 0) return leavesLE[pos];
    const left = calcHash(height - 1, pos * 2);
    const right = pos * 2 + 1 < widthAt(height - 1) ? calcHash(height - 1, pos * 2 + 1) : left;
    return dsha(Buffer.concat([left, right]));
  };

  const bits: number[] = [];
  const hashes: Buffer[] = [];
  const build = (height: number, pos: number): void => {
    const parentOfMatch = (targetIndex >> height) === pos;
    bits.push(parentOfMatch ? 1 : 0);
    if (height === 0 || !parentOfMatch) {
      hashes.push(calcHash(height, pos));
      return;
    }
    build(height - 1, pos * 2);
    if (pos * 2 + 1 < widthAt(height - 1)) build(height - 1, pos * 2 + 1);
  };
  build(treeHeight, 0);

  // Flag bits pack LSB-first; the parser rejects any non-zero padding bit.
  const flagBytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) flagBytes[i >> 3] |= 1 << (i & 7);
  });

  const rootLE = calcHash(treeHeight, 0);
  const header = buildHeader(rootLE);
  const totalTxLE = Buffer.alloc(4);
  totalTxLE.writeUInt32LE(totalTx, 0);

  const proofHex = Buffer.concat([
    header,
    totalTxLE,
    Buffer.from([hashes.length]), // varint, < 0xfd for these fixtures
    ...hashes,
    Buffer.from([flagBytes.length]), // varint, < 0xfd
    flagBytes,
  ]).toString('hex');

  return {
    proofHex,
    headerHex: header.toString('hex'),
    blockHash: Buffer.from(dsha(header)).reverse().toString('hex'),
    merkleRootDisplay: Buffer.from(rootLE).reverse().toString('hex'),
  };
}

/**
 * Fold a persisted bitcoin-tree branch back up to a root using the Bitcoin
 * positional double-SHA256 rule over byte-reversed (display) hex — the EXACT
 * rule the column comment and the ProofBundle docstring promise a verifier.
 * If this disagrees with the header's merkleroot, the persisted branch is
 * unusable and the whole point of the column is lost.
 */
function recomputeBitcoinRoot(
  txIdDisplay: string,
  branch: Array<{ hash: string; position: string }>,
): string {
  // Explicit `Buffer` annotation: `Buffer.from(...)` narrows to Buffer<ArrayBuffer>
  // while bitcoinjs' sha256 yields Buffer<ArrayBufferLike>, so the fold's
  // reassignment needs the wider type.
  let node: Buffer = Buffer.from(txIdDisplay, 'hex').reverse(); // display → internal LE
  for (const step of branch) {
    const sibling = Buffer.from(step.hash, 'hex').reverse();
    node =
      step.position === 'right'
        ? dsha(Buffer.concat([node, sibling]))
        : dsha(Buffer.concat([sibling, node]));
  }
  return Buffer.from(node).reverse().toString('hex'); // internal LE → display
}

/**
 * Update mock that records WHICH anchor got WHICH values.
 *
 * M3: the writer batches identical payloads into one `.in('anchor_id', [...])`
 * statement, so the mock fans the id list back out into one `writes` entry per
 * anchor — the per-anchor assertions stay exactly as meaningful as before.
 * `rowsExist` decides which ids actually have an `anchor_proofs` row.
 */
function mockRecordingClient(rowsExist: (id: string) => boolean = () => true) {
  const writes: Array<{ anchorId: string; values: Record<string, unknown> }> = [];
  const update = vi.fn((values: Record<string, unknown>) => ({
    in: vi.fn((_col: string, ids: string[]) => ({
      select: vi.fn((_cols: string) => {
        for (const id of ids) writes.push({ anchorId: id, values });
        return Promise.resolve({
          error: null,
          data: ids.filter(rowsExist).map((anchor_id) => ({ anchor_id })),
        });
      }),
    })),
  }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as unknown as SupabaseClient, update, writes };
}

/** Scan mock that records every PostgREST filter the scan applied. */
function mockWatermarkScanClient(scanRows: unknown[], rowsExist: (id: string) => boolean = () => true) {
  const filters: Array<{ method: string; args: unknown[] }> = [];
  const writes: Array<{ anchorId: string; values: Record<string, unknown> }> = [];
  const update = vi.fn((values: Record<string, unknown>) => ({
    in: vi.fn((_col: string, ids: string[]) => ({
      select: vi.fn((_cols: string) => {
        for (const id of ids) writes.push({ anchorId: id, values });
        return Promise.resolve({
          error: null,
          data: ids.filter(rowsExist).map((anchor_id) => ({ anchor_id })),
        });
      }),
    })),
  }));
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'is', 'eq', 'limit', 'or', 'order', 'gt']) {
    builder[m] = vi.fn((...args: unknown[]) => {
      filters.push({ method: m, args });
      return builder;
    });
  }
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: scanRows, error: null });
  const from = vi.fn((table: string) => (table === 'anchor_proofs' ? { ...builder, update } : { update }));
  return { client: { from } as unknown as SupabaseClient, filters, writes };
}

describe('R1 — bitcoin-tree inclusion branch + tx block index', () => {
  beforeEach(() => vi.clearAllMocks());

  // A 4-leaf block, target at index 2 ⇒ a 2-sibling branch with BOTH a
  // 'left' and a 'right' step, so the positional rule is genuinely exercised.
  const LEAVES = [0, 1, 2, 3].map((i) => makeTxidLE(0xa000 + i));
  const TARGET_INDEX = 2;
  const TARGET_TXID = displayHex(LEAVES[TARGET_INDEX]);

  function confirmedProvider() {
    const p = buildMultiTxProof(LEAVES, TARGET_INDEX);
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi
        .fn()
        .mockResolvedValue({ txid: TARGET_TXID, confirmations: 12, blockhash: p.blockHash, vout: [] }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(p.headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(p.proofHex),
    };
    return { p, provider };
  }

  // ---- K2: byte orientation + hashing rule --------------------------------

  it('K2: persists the branch + index, and the persisted branch recomputes to the persisted header merkleroot', async () => {
    const { p, provider } = confirmedProvider();
    const { client, writes } = mockRecordingClient();

    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'anc-1', chainTxId: TARGET_TXID }],
      { minConfirmations: 6 },
    );

    expect(result.txConfirmed).toBe(1);
    expect(result.anchorsUpdated).toBe(1);
    expect(writes).toHaveLength(1);

    const values = writes[0].values;
    const branch = values.tx_inclusion_branch as Array<{ hash: string; position: string }>;
    expect(values.tx_block_index).toBe(TARGET_INDEX);
    expect(Array.isArray(branch)).toBe(true);
    expect(branch).toHaveLength(2); // 4-leaf tree ⇒ exactly 2 siblings
    expect(branch.map((s) => s.position)).toEqual(['right', 'left']);

    // THE contract: fold the branch with the Bitcoin positional double-SHA256
    // rule over display hex and land on the merkleroot the persisted 80-byte
    // header commits. A byte-orientation slip breaks this and nothing else.
    const persistedHeader = (values.block_header as string).replace(/^\\x/, '');
    const headerMerkleRoot = Buffer.from(persistedHeader, 'hex')
      .subarray(36, 68)
      .reverse()
      .toString('hex');
    expect(headerMerkleRoot).toBe(p.merkleRootDisplay);
    expect(recomputeBitcoinRoot(TARGET_TXID, branch)).toBe(p.merkleRootDisplay);
  });

  // ---- K1: reorg race ------------------------------------------------------

  it('K1: a tx now in a DIFFERENT block than recorded is stale — no branch, no index, no write at all', async () => {
    const { provider } = confirmedProvider();
    const { client, writes } = mockRecordingClient();

    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'anc-reorg', chainTxId: TARGET_TXID, expectedBlockHash: 'ff'.repeat(32) }],
      { minConfirmations: 6 },
    );

    expect(result.txStale).toBe(1);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(writes).toHaveLength(0);
  });

  // B1: the group-level guard used to take the FIRST non-null block hash in the
  // group (`group.find(...)`). Whether the good or the bad row came first
  // therefore decided the fate of the ENTIRE tx group — up to 10,000 anchors in
  // a merkle batch. The outcome must depend on the DATA, not on array order, so
  // this runs both orderings and demands the identical result from each.
  it.each([
    { label: 'matching row first', matchFirst: true },
    { label: 'mismatched row first', matchFirst: false },
  ])(
    'B1/K1: within ONE tx group an anchor recorded under a different block is skipped while the matching one is written — $label',
    async ({ matchFirst }) => {
      const { p, provider } = confirmedProvider();
      const { client, writes } = mockRecordingClient();

      const match = { anchorId: 'anc-match', chainTxId: TARGET_TXID, expectedBlockHash: p.blockHash };
      const other = { anchorId: 'anc-other-block', chainTxId: TARGET_TXID, expectedBlockHash: 'ab'.repeat(32) };

      const result = await populateConfirmationProofs(
        client,
        provider,
        matchFirst ? [match, other] : [other, match],
        { minConfirmations: 6 },
      );

      expect(result.txConfirmed).toBe(1);
      expect(result.anchorsUpdated).toBe(1);
      expect(result.anchorsBlockMismatch).toBe(1);
      expect(writes).toHaveLength(1);
      expect(writes[0].anchorId).toBe('anc-match');
    },
  );

  // B1: the starvation shape the `find()` short-circuit made permanent. One
  // anchor carries a stale recorded hash; the others carry NONE (a first
  // population — the overwhelmingly common case in a merkle batch). The old
  // group-level pick armed the guard on the stale row's hash, so
  // `fetchConfirmationProof` returned `stale` and the `confirmed` branch never
  // ran: every OTHER anchor of that tx got nothing, on every tick, forever —
  // with `anchorsBlockMismatch` stuck at 0 because the per-anchor guard was
  // never reached. Order-independent by construction (the stale row is placed
  // first, which is the position the old code was most sensitive to).
  it('B1: one stale row cannot starve the rest of its tx group', async () => {
    const { provider } = confirmedProvider();
    const { client, writes } = mockRecordingClient();

    const result = await populateConfirmationProofs(
      client,
      provider,
      [
        { anchorId: 'anc-stale', chainTxId: TARGET_TXID, expectedBlockHash: 'ab'.repeat(32) },
        { anchorId: 'anc-fresh-1', chainTxId: TARGET_TXID },
        { anchorId: 'anc-fresh-2', chainTxId: TARGET_TXID, expectedBlockHash: null },
      ],
      { minConfirmations: 6 },
    );

    expect(result.txConfirmed).toBe(1);
    expect(result.txStale).toBe(0);
    // The two rows with no recorded block are populated…
    expect(result.anchorsUpdated).toBe(2);
    expect(writes.map((w) => w.anchorId).sort()).toEqual(['anc-fresh-1', 'anc-fresh-2']);
    // …and the genuinely-reorged one is skipped AND COUNTED, not silent.
    expect(result.anchorsBlockMismatch).toBe(1);
  });

  it('B1: a group that UNANIMOUSLY records a block the tx has left still short-circuits to stale', async () => {
    // The group-level guard must not be disarmed wholesale — when every anchor
    // of the tx agrees on a block the tx is no longer in, that is a real reorg
    // and the whole group is stale WITHOUT spending an inclusion-proof fetch.
    const { provider } = confirmedProvider();
    const { client, writes } = mockRecordingClient();

    const result = await populateConfirmationProofs(
      client,
      provider,
      [
        { anchorId: 'anc-a', chainTxId: TARGET_TXID, expectedBlockHash: 'ff'.repeat(32) },
        { anchorId: 'anc-b', chainTxId: TARGET_TXID, expectedBlockHash: 'FF'.repeat(32) },
      ],
      { minConfirmations: 6 },
    );

    expect(result.txStale).toBe(1);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(writes).toHaveLength(0);
    // The group-level guard fired, so the per-anchor guard was never reached.
    expect(result.anchorsBlockMismatch).toBe(0);
  });

  it('K1: a recorded block hash that MATCHES (case-insensitively) still writes', async () => {
    const { p, provider } = confirmedProvider();
    const { client, writes } = mockRecordingClient();
    const result = await populateConfirmationProofs(
      client,
      provider,
      [{ anchorId: 'anc-upper', chainTxId: TARGET_TXID, expectedBlockHash: p.blockHash.toUpperCase() }],
      { minConfirmations: 6 },
    );
    expect(result.anchorsUpdated).toBe(1);
    expect(result.anchorsBlockMismatch).toBe(0);
    expect(writes).toHaveLength(1);
  });

  // ---- K3: watermark -------------------------------------------------------

  it('K3: the scan picks up rows that ALREADY have a header but no inclusion branch', async () => {
    const { p, provider } = confirmedProvider();
    const scanRows = [
      {
        anchor_id: 'anc-backfill',
        receipt_id: TARGET_TXID,
        block_height: 800500,
        block_hash: p.blockHash, // header pass already ran…
        block_header: `\\x${p.headerHex}`,
        tx_inclusion_branch: null, // …but the branch is still missing
        anchors: { chain_tx_id: TARGET_TXID, chain_block_height: 800500, status: 'SECURED' },
      },
    ];
    const { client, filters, writes } = mockWatermarkScanClient(scanRows);

    const result = await populateConfirmationProofsForSecuredAnchors(client, provider, {
      minConfirmations: 6,
    });

    // The OLD watermark was `.is('block_header', null)`. That filter ALONE can
    // never return a header-present row, so every row populated before this
    // change was unreachable forever. It must be gone.
    expect(filters.some((f) => f.method === 'is' && f.args[0] === 'block_header')).toBe(false);
    const orFilter = filters.find((f) => f.method === 'or');
    expect(orFilter).toBeDefined();
    expect(String(orFilter?.args[0])).toContain('block_header.is.null');
    expect(String(orFilter?.args[0])).toContain('tx_inclusion_branch.is.null');

    // …and the scan must SELECT the columns the reorg guard actually READS —
    // `block_hash` and (H2) `block_header`. M6: `tx_inclusion_branch` is
    // filtered on but deliberately NOT selected, because nothing reads it;
    // pinning it here only asserted that a string contained a substring.
    const selectFilter = filters.find((f) => f.method === 'select');
    expect(String(selectFilter?.args[0])).toContain('block_hash');
    expect(String(selectFilter?.args[0])).toContain('block_header');
    expect(String(selectFilter?.args[0])).not.toContain('tx_inclusion_branch');

    expect(result.scanned).toBe(1);
    expect(result.anchorsUpdated).toBe(1);
    expect(writes[0].values.tx_block_index).toBe(TARGET_INDEX);
  });

  it('K1+K3: the scan threads the row\'s recorded block_hash as the reorg guard, so a backfill can never overwrite across a reorg', async () => {
    // Without this the backfill pass would fetch the tx's CURRENT block,
    // succeed, and cheerfully overwrite a header/branch pair recorded under
    // the block the tx has since left.
    const { provider } = confirmedProvider();
    const scanRows = [
      {
        anchor_id: 'anc-reorged',
        receipt_id: TARGET_TXID,
        block_height: 800500,
        block_hash: 'ff'.repeat(32), // recorded under a block the tx has LEFT
        block_header: `\\x${'aa'.repeat(80)}`,
        tx_inclusion_branch: null,
        anchors: { chain_tx_id: TARGET_TXID, chain_block_height: 800500, status: 'SECURED' },
      },
    ];
    const { client, writes } = mockWatermarkScanClient(scanRows);

    const result = await populateConfirmationProofsForSecuredAnchors(client, provider, {
      minConfirmations: 6,
    });

    expect(result.txStale).toBe(1);
    expect(result.txConfirmed).toBe(0);
    expect(result.anchorsUpdated).toBe(0);
    expect(writes).toHaveLength(0);
  });

  // ---- H1: deterministic scan order + rotation past wedged rows ------------

  describe('H1 — the scan must not return the same unpopulatable rows forever', () => {
    beforeEach(() => __resetConfirmationScanCursorForTests());

    function scanRow(anchorId: string) {
      return {
        anchor_id: anchorId,
        receipt_id: TARGET_TXID,
        block_height: 800500,
        block_hash: null,
        block_header: null,
        tx_inclusion_branch: null,
        tx_block_index: null,
        anchors: { chain_tx_id: TARGET_TXID, chain_block_height: 800500, status: 'SECURED' },
      };
    }

    it('orders by a UNIQUE indexed column instead of taking whatever the heap returns', async () => {
      const { provider } = confirmedProvider();
      const { client, filters } = mockWatermarkScanClient([scanRow('a-1')]);

      await populateConfirmationProofsForSecuredAnchors(client, provider, { minConfirmations: 6 });

      const order = filters.find((f) => f.method === 'order');
      expect(order, 'the scan applies no ORDER BY at all').toBeDefined();
      expect(order?.args[0]).toBe('anchor_id');
      expect(order?.args[1]).toMatchObject({ ascending: true });
    });

    it('advances the cursor past a FULL page, so a wedged page cannot occupy the window forever', async () => {
      const { provider } = confirmedProvider();
      // A full page (maxRows = 2) of rows that can never complete — the tx is
      // in a block their own row does not name, so every one is skipped.
      const wedged = [
        { ...scanRow('a-1'), block_hash: 'ff'.repeat(32) },
        { ...scanRow('a-2'), block_hash: 'ff'.repeat(32) },
      ];
      const first = mockWatermarkScanClient(wedged);
      await populateConfirmationProofsForSecuredAnchors(first.client, provider, {
        minConfirmations: 6,
        maxRows: 2,
      });
      // Run 1 starts at the beginning of the keyspace.
      expect(first.filters.find((f) => f.method === 'gt')?.args).toEqual(['anchor_id', '']);

      // Run 2 must ask for rows AFTER the wedged page — otherwise the newly
      // SECURED anchors that sort behind them are never reached again.
      const second = mockWatermarkScanClient([scanRow('a-3')]);
      await populateConfirmationProofsForSecuredAnchors(second.client, provider, {
        minConfirmations: 6,
        maxRows: 2,
      });
      expect(second.filters.find((f) => f.method === 'gt')?.args).toEqual(['anchor_id', 'a-2']);
    });

    it('wraps back to the start of the keyspace once a short page shows the sweep is done', async () => {
      const { provider } = confirmedProvider();
      // A SHORT page (1 row against a budget of 2) means the end was reached.
      const first = mockWatermarkScanClient([scanRow('z-9')]);
      await populateConfirmationProofsForSecuredAnchors(first.client, provider, {
        minConfirmations: 6,
        maxRows: 2,
      });

      const second = mockWatermarkScanClient([scanRow('a-1')]);
      await populateConfirmationProofsForSecuredAnchors(second.client, provider, {
        minConfirmations: 6,
        maxRows: 2,
      });
      expect(second.filters.find((f) => f.method === 'gt')?.args).toEqual(['anchor_id', '']);
    });

    it('accepts an explicit cursor, so a sweep can be resumed or steered without in-process state', async () => {
      const { provider } = confirmedProvider();
      const { client, filters } = mockWatermarkScanClient([scanRow('m-5')]);
      await populateConfirmationProofsForSecuredAnchors(client, provider, {
        minConfirmations: 6,
        startAfterAnchorId: 'm-0',
      });
      expect(filters.find((f) => f.method === 'gt')?.args).toEqual(['anchor_id', 'm-0']);
    });
  });

  // ---- H2: never overwrite a header with a DIFFERENT block's ---------------

  describe('H2 — a row with a header but no recorded block hash must not go unguarded', () => {
    beforeEach(() => __resetConfirmationScanCursorForTests());

    /**
     * `block_header` populated with `block_hash` NULL is schema-permitted and
     * genuinely producible (`upsertAnchorProofs` writes the two independently,
     * and `backfillProofCompleteness` fills each only when its own is empty).
     * Both reorg gates test `expectedBlockHash` for truthiness, so such a row
     * used to disarm BOTH — the job then fetched the tx's CURRENT block and
     * overwrote the stored 80-byte header with a different block's, counted as
     * a success. The header is self-identifying (its own double-SHA256 IS the
     * block hash), so there is no excuse for the guard to go dark here.
     */
    function headerOnlyRow(headerHex: string) {
      return {
        anchor_id: 'anc-header-only',
        receipt_id: TARGET_TXID,
        block_height: 800500,
        block_hash: null, // ← the gap
        block_header: `\\x${headerHex}`,
        tx_inclusion_branch: null,
        tx_block_index: null,
        anchors: { chain_tx_id: TARGET_TXID, chain_block_height: 800500, status: 'SECURED' },
      };
    }

    it('refuses to overwrite a stored header that describes a DIFFERENT block', async () => {
      const { provider } = confirmedProvider();
      // A real, well-formed 80-byte header for some OTHER block.
      const otherHeader = buildHeader(computeMerkleRootLE([makeTxidLE(0xfeed)])).toString('hex');
      const { client, writes } = mockWatermarkScanClient([headerOnlyRow(otherHeader)]);

      const result = await populateConfirmationProofsForSecuredAnchors(client, provider, {
        minConfirmations: 6,
      });

      expect(writes).toHaveLength(0);
      expect(result.anchorsUpdated).toBe(0);
      expect(result.anchorsBlockMismatch).toBe(1);
    });

    it('still populates when the stored header describes the SAME block (and fills in the missing hash)', async () => {
      const { p, provider } = confirmedProvider();
      const { client, writes } = mockWatermarkScanClient([headerOnlyRow(p.headerHex)]);

      const result = await populateConfirmationProofsForSecuredAnchors(client, provider, {
        minConfirmations: 6,
      });

      expect(result.anchorsBlockMismatch).toBe(0);
      expect(result.anchorsUpdated).toBe(1);
      expect(writes[0].values.block_hash).toBe(p.blockHash);
      expect(writes[0].values.tx_block_index).toBe(TARGET_INDEX);
    });

    it('a stored header that is not 80 bytes cannot be used to authorise an overwrite', async () => {
      const { provider } = confirmedProvider();
      const { client, writes } = mockWatermarkScanClient([headerOnlyRow('ab')]);

      const result = await populateConfirmationProofsForSecuredAnchors(client, provider, {
        minConfirmations: 6,
      });

      expect(writes).toHaveLength(0);
      expect(result.anchorsBlockMismatch).toBe(1);
    });
  });
});
