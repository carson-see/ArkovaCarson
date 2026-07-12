/**
 * PROOF-03 / #1408 — Confirmation-proof FAULT-INJECTION tests.
 *
 * The chain-resilience rig (#1408) never exercised the transient-vs-definitive
 * RPC-failure classification for `/jobs/populate-confirmation-proofs`: it got 0
 * hits in 6h, so the classification path is UNVERIFIED. These tests drive
 * `fetchConfirmationProof` against a fault-injecting provider and assert the
 * classification contract that the confirmation-proof pipeline depends on:
 *
 *   - TRANSIENT header/inclusion-proof failure (HTTP 5xx, HTTP 429, timeout /
 *     AbortError, ECONNRESET/ETIMEDOUT, generic network TypeError) MUST classify
 *     `pending` — the row is recoverable and the next cron tick retries. We must
 *     NOT poison a recoverable anchor as `stale`.
 *   - DEFINITIVE header/inclusion-proof failure (JSON-RPC application error, e.g.
 *     `gettxoutproof` "Block not found" / "Transaction not in block", or an HTTP
 *     4xx) MUST classify `stale` — retrying can't help; a human/reorg path owns it.
 *
 * The distinction is load-bearing: `pending` is retried forever (backlog age is
 * the dead-man's-switch signal), while `stale` stops retrying. Misclassifying a
 * transient 5xx as `stale` silently drops a proof that WOULD have populated on
 * the next tick — exactly the confirmation-proof gap on the 2.97M SECURED /
 * ~6,110 STORED backlog.
 *
 * NO real Bitcoin API (§1.7): the provider is a `vi.fn()` fault injector. The
 * confirmed happy-path proof blob is built in-process (same CMerkleBlock builder
 * as confirmation-proof.test.ts) so a fault on the SECOND call is isolated from
 * proof-shape concerns.
 */

import { describe, it, expect, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  fetchConfirmationProof,
  type ConfirmationProofProvider,
} from './confirmation-proof.js';
import { HttpError } from './utxo-provider.js';

// ─── in-process proof fixture (one confirmed tx) ────────────────────────────

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
/** A single-tx (coinbase-only) block: merkleroot == the one leaf. */
function buildSingleTxFixture(seed = 4242) {
  const leaf = makeTxidLE(seed);
  const header = buildHeader(leaf);
  const totalTx = Buffer.alloc(4);
  totalTx.writeUInt32LE(1, 0);
  const proofHex = Buffer.concat([
    header,
    totalTx,
    Buffer.from([1]), // 1 hash
    leaf,
    Buffer.from([1]), // 1 flag byte
    Buffer.from([0x01]), // bit 0 = match
  ]).toString('hex');
  return {
    txId: displayHex(leaf),
    headerHex: header.toString('hex'),
    proofHex,
    blockHash: Buffer.from(dsha(header)).reverse().toString('hex'),
  };
}

const fx = buildSingleTxFixture();

/** A provider that RESOLVES getRawTransaction (tx is mined) but throws
 *  `err` from BOTH inclusion-proof calls — the fault-injection surface. */
function providerFailingProofFetch(err: unknown): ConfirmationProofProvider {
  return {
    getRawTransaction: vi.fn().mockResolvedValue({
      txid: fx.txId,
      confirmations: 12,
      blockhash: fx.blockHash,
      vout: [],
    }),
    getBlockHeaderHex: vi.fn().mockRejectedValue(err),
    getTxOutProof: vi.fn().mockRejectedValue(err),
  };
}

// ─── TRANSIENT faults → pending (retryable) ─────────────────────────────────

describe('fetchConfirmationProof — TRANSIENT header/proof faults classify pending (retry)', () => {
  const timeoutErr = (() => {
    // AbortSignal.timeout fires a DOMException named 'AbortError'.
    const e =
      typeof DOMException !== 'undefined'
        ? new DOMException('The operation timed out', 'AbortError')
        : Object.assign(new Error('The operation timed out'), { name: 'AbortError' });
    return e;
  })();

  const cases: Array<[string, unknown]> = [
    ['HTTP 500 (GetBlock node overloaded)', new HttpError('RPC gettxoutproof failed: HTTP 500', 500)],
    ['HTTP 503 (service unavailable)', new HttpError('RPC getblockheader failed: HTTP 503', 503)],
    ['HTTP 429 (rate limited)', new HttpError('RPC gettxoutproof failed: HTTP 429', 429)],
    ['request timeout (AbortError)', timeoutErr],
    ['ECONNRESET', new Error('read ECONNRESET')],
    ['ETIMEDOUT', new Error('connect ETIMEDOUT 1.2.3.4:443')],
    ['network TypeError (fetch failed)', new TypeError('fetch failed')],
  ];

  it.each(cases)('classifies %s as pending (not stale)', async (_label, err) => {
    const provider = providerFailingProofFetch(err);
    const proof = await fetchConfirmationProof(provider, { chainTxId: fx.txId, minConfirmations: 6 });
    // The whole point: a transient failure is recoverable → retry next tick.
    expect(proof.status).toBe('pending');
    // Never fabricate a branch on a failed fetch.
    expect(proof.merkleBranch).toBeUndefined();
    expect(proof.blockHeader).toBeUndefined();
    // confirmations (already known from getRawTransaction) may still ride along.
    expect(proof.confirmations).toBe(12);
  });
});

// ─── DEFINITIVE faults → stale (non-retryable) ──────────────────────────────

describe('fetchConfirmationProof — DEFINITIVE header/proof faults classify stale (no retry)', () => {
  const cases: Array<[string, unknown]> = [
    // JSON-RPC application errors are surfaced by rpcCall() as plain Error
    // "RPC <method> error: <message> (code <n>)" — never retried.
    ['gettxoutproof "Block not found" (RPC app error)', new Error('RPC gettxoutproof error: Block not found (code -5)')],
    ['gettxoutproof "Transaction not in block" (RPC app error)', new Error('RPC gettxoutproof error: Transaction not in block (code -5)')],
    ['getblockheader "Block not found" (RPC app error)', new Error('RPC getblockheader error: Block not found (code -5)')],
    ['HTTP 400 (bad request)', new HttpError('RPC gettxoutproof failed: HTTP 400', 400)],
    ['HTTP 404 (not found)', new HttpError('RPC getblockheader failed: HTTP 404', 404)],
  ];

  it.each(cases)('classifies %s as stale (definitive)', async (_label, err) => {
    const provider = providerFailingProofFetch(err);
    const proof = await fetchConfirmationProof(provider, { chainTxId: fx.txId, minConfirmations: 6 });
    expect(proof.status).toBe('stale');
    expect(proof.merkleBranch).toBeUndefined();
    expect(proof.blockHeader).toBeUndefined();
  });
});

// ─── the confirmed path is unaffected ───────────────────────────────────────

describe('fetchConfirmationProof — fault classification does not disturb the confirmed path', () => {
  it('still returns confirmed when the fetch succeeds', async () => {
    const provider: ConfirmationProofProvider = {
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: fx.txId,
        confirmations: 12,
        blockhash: fx.blockHash,
        vout: [],
      }),
      getBlockHeaderHex: vi.fn().mockResolvedValue(fx.headerHex),
      getTxOutProof: vi.fn().mockResolvedValue(fx.proofHex),
    };
    const proof = await fetchConfirmationProof(provider, { chainTxId: fx.txId, minConfirmations: 6 });
    expect(proof.status).toBe('confirmed');
    expect(proof.blockHeader).toBe(fx.headerHex);
  });
});
