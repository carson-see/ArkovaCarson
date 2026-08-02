import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockEmitRpcFallback } = vi.hoisted(() => ({ mockEmitRpcFallback: vi.fn() }));
vi.mock('../utils/sentry.js', () => ({
  emitRpcFallback: mockEmitRpcFallback,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  RpcUtxoProvider, MempoolUtxoProvider, GetBlockHybridProvider, createUtxoProvider,
  HttpError, RpcApplicationError, retryWithBackoff, isRetryableError, isDuplicateTxError,
  BroadcastRejectedError, isBroadcastRejectedError, isBroadcastRejectText,
} from './utxo-provider.js';
import { logger } from '../utils/logger.js';

function rpcOk(result: unknown) {
  return { ok: true, json: () => Promise.resolve({ result, error: null }) };
}
function rpcErr(message: string, code = -1) {
  return { ok: true, json: () => Promise.resolve({ result: null, error: { message, code } }) };
}

describe('RpcUtxoProvider', () => {
  const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns empty array when no UTXOs', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    expect(await provider.listUnspent('tb1qtest')).toEqual([]);
  });
  it('maps RPC UTXOs and fetches raw tx hex', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([{ txid: 'aaa', vout: 0, amount: 0.001, scriptPubKey: 'deadbeef' }]));
    mockFetch.mockResolvedValueOnce(rpcOk('0200000001...'));
    const utxos = await provider.listUnspent('tb1qtest');
    expect(utxos).toHaveLength(1);
    expect(utxos[0]).toEqual({ txid: 'aaa', vout: 0, valueSats: 100000, rawTxHex: '0200000001...' });
  });
  it('handles null RPC response', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(null));
    expect(await provider.listUnspent('tb1qtest')).toEqual([]);
  });
  it('throws on RPC error', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('Wallet not loaded', -18));
    await expect(provider.listUnspent('tb1qtest')).rejects.toThrow('RPC listunspent error');
  });
  it('throws on HTTP error (4xx — no retry)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(provider.listUnspent('tb1qtest')).rejects.toThrow('HTTP 401');
  });
  it('includes auth header when configured', async () => {
    const authed = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332', rpcAuth: 'user:pass' });
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    await authed.listUnspent('tb1qtest');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:38332', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: expect.stringContaining('Basic') }),
    }));
  });
  it('passes AbortSignal to fetch calls', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    await provider.listUnspent('tb1qtest');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:38332', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('returns txid on broadcastTx success', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk('abc123'));
    expect((await provider.broadcastTx('0200000001...')).txid).toBe('abc123');
  });
  it('throws on broadcastTx RPC error', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('TX rejected'));
    await expect(provider.broadcastTx('bad')).rejects.toThrow('TX rejected');
  });
  it('treats duplicate-submit RPC errors as success', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('Transaction already in block chain', -27));
    const result = await provider.broadcastTx('0200000001...');
    expect(result.txid).toBe('');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ operation: 'RpcUtxoProvider.broadcastTx' }), expect.stringContaining('already in mempool/chain'));
  });
  it('treats txn-already-in-mempool as success', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('txn-already-in-mempool', -26));
    expect((await provider.broadcastTx('0200000001...')).txid).toBe('');
  });
  it('returns chain and block height', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ chain: 'signet', blocks: 150000 }));
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 150000 });
  });
  it('returns parsed transaction', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ txid: 'aaa', confirmations: 5, blocktime: 1710000000, blockhash: 'bbb', vout: [{ scriptPubKey: { hex: 'deadbeef', asm: 'OP_RETURN ...' } }] }));
    const tx = await provider.getRawTransaction('aaa');
    expect(tx.txid).toBe('aaa');
    expect(tx.confirmations).toBe(5);
  });
  it('returns block height', async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ height: 150042 }));
    expect((await provider.getBlockHeader('bbb')).height).toBe(150042);
  });
  it('has correct name', () => { expect(provider.name).toBe('Bitcoin Core RPC'); });
});

describe('MempoolUtxoProvider', () => {
  const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns all UTXOs including unconfirmed on signet', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([
      { txid: 'aaa', vout: 0, value: 50000, status: { confirmed: true, block_height: 100 } },
      { txid: 'bbb', vout: 1, value: 30000, status: { confirmed: false } },
    ]) });
    // Signet includes unconfirmed UTXOs (change from pending txs)
    const utxos = await provider.listUnspent('tb1qtest');
    expect(utxos).toHaveLength(2);
    expect(utxos[0]).toEqual({ txid: 'aaa', vout: 0, valueSats: 50000, rawTxHex: '' });
    expect(utxos[1]).toEqual({ txid: 'bbb', vout: 1, valueSats: 30000, rawTxHex: '' });
  });
  it('returns unconfirmed UTXOs on signet', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ txid: 'aaa', vout: 0, value: 50000, status: { confirmed: false } }]) });
    const utxos = await provider.listUnspent('tb1qtest');
    expect(utxos).toHaveLength(1);
  });
  it('returns all UTXOs including unconfirmed on mainnet', async () => {
    const mainnetProvider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/api' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([
      { txid: 'aaa', vout: 0, value: 50000, status: { confirmed: true, block_height: 100 } },
      { txid: 'bbb', vout: 1, value: 30000, status: { confirmed: false } },
    ]) });
    const utxos = await mainnetProvider.listUnspent('bc1qtest');
    expect(utxos).toHaveLength(2);
    expect(utxos[0].txid).toBe('aaa');
    expect(utxos[1].txid).toBe('bbb');
  });
  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(provider.listUnspent('tb1qtest')).rejects.toThrow('HTTP 404');
  });
  it('passes AbortSignal to fetch calls', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await provider.listUnspent('tb1qtest');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/address/'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('returns txid from broadcastTx response text', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('abc123def\n') });
    expect((await provider.broadcastTx('0200000001...')).txid).toBe('abc123def');
  });
  it('sends POST to /tx with signal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('txid_result') });
    await provider.broadcastTx('02000000deadbeef');
    expect(mockFetch).toHaveBeenCalledWith('https://mempool.space/signet/api/tx', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '02000000deadbeef', signal: expect.any(AbortSignal),
    }));
  });
  it('trims whitespace from txid response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('  abc123  \n') });
    expect((await provider.broadcastTx('hex')).txid).toBe('abc123');
  });
  it('throws a typed BroadcastRejectedError (with the reject text) on an explicit relay reject', async () => {
    // #1417-HIGH: an explicit mempool reject verdict is typed as a definitive
    // reject (so the intent unwind can fire safely), carrying the verdict text.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('bad-txns-inputs-missingorspent') });
    const err = await provider.broadcastTx('bad').catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastRejectedError);
    expect(err.message).toContain('bad-txns-inputs-missingorspent');
    expect(err.httpStatus).toBe(400);
  });
  it('includes HTTP status in error message (4xx)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, text: () => Promise.resolve('Unprocessable Entity') });
    await expect(provider.broadcastTx('bad')).rejects.toThrow('HTTP 422');
  });
  it('treats duplicate-submit 400 as success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('Transaction already in mempool') });
    const result = await provider.broadcastTx('0200000001...');
    expect(result.txid).toBe('');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ operation: 'MempoolUtxoProvider.broadcastTx' }), expect.stringContaining('already in mempool/chain'));
  });
  it('treats txn-already-known as success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('txn-already-known') });
    expect((await provider.broadcastTx('0200000001...')).txid).toBe('');
  });
  it('returns signet chain and block height', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('150000') });
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 150000 });
  });
  it('infers testnet from URL', async () => {
    const tp = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/testnet/api' });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('2500000') });
    expect((await tp.getBlockchainInfo()).chain).toBe('test');
  });
  it('infers main from URL', async () => {
    const mp = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/api' });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('800000') });
    expect((await mp.getBlockchainInfo()).chain).toBe('main');
  });
  it('maps getRawTransaction response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({
      txid: 'aaa', status: { confirmed: true, block_height: 100, block_hash: 'bbb', block_time: 1710000000 },
      vout: [{ scriptpubkey: 'deadbeef', scriptpubkey_asm: 'OP_RETURN ...', value: 0 }],
    }) });
    const tx = await provider.getRawTransaction('aaa');
    expect(tx.txid).toBe('aaa');
    expect(tx.confirmations).toBe(1);
    expect(tx.vout[0].scriptPubKey.hex).toBe('deadbeef');
  });
  it('returns 0 confirmations for unconfirmed tx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ txid: 'aaa', status: { confirmed: false }, vout: [] }) });
    expect((await provider.getRawTransaction('aaa')).confirmations).toBe(0);
  });
  it('returns block height', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ height: 150042 }) });
    expect((await provider.getBlockHeader('bbb')).height).toBe(150042);
  });
  it('paginates address history to surface an anchor older than the first page (review P2)', async () => {
    // Page 1 (/txs): recent confirmed txs, none is the target anchor.
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([
      { txid: 'p1a', status: { confirmed: true, block_height: 200, block_hash: 'h1', block_time: 1710000000 }, vout: [] },
      { txid: 'p1b', status: { confirmed: true, block_height: 199, block_hash: 'h2', block_time: 1710000001 }, vout: [] },
    ]) });
    // Page 2 (/txs/chain/:cursor): the OLD fully-spent anchor tx lives here.
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([
      { txid: 'OLD_ANCHOR', status: { confirmed: true, block_height: 150, block_hash: 'h3', block_time: 1709000000 },
        vout: [{ scriptpubkey: 'deadbeef', scriptpubkey_asm: 'OP_RETURN ...', value: 0 }] },
    ]) });
    // Page 3: empty → history exhausted, stop.
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    const history = await provider.getAddressTxs('tb1qtreasury');

    // The older-than-first-page anchor is surfaced (false-negative hole closed).
    expect(history.map((t) => t.txid)).toContain('OLD_ANCHOR');
    // Cursor = oldest confirmed of page 1 (p1b) — the confirmed-chain pagination URL.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mempool.space/signet/api/address/tb1qtreasury/txs/chain/p1b',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('has correct name', () => { expect(provider.name).toBe('Mempool.space REST API'); });
  it('uses default Signet URL', () => { expect(new MempoolUtxoProvider().name).toBe('Mempool.space REST API'); });
  it('strips trailing slash from base URL', async () => {
    const sp = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api/' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await sp.listUnspent('tb1q');
    expect(mockFetch).toHaveBeenCalledWith('https://mempool.space/signet/api/address/tb1q/utxo', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe('createUtxoProvider', () => {
  it('creates RPC provider', () => { expect(createUtxoProvider({ type: 'rpc', rpcUrl: 'http://localhost:38332' }).name).toBe('Bitcoin Core RPC'); });
  it('throws if RPC URL missing', () => { expect(() => createUtxoProvider({ type: 'rpc' })).toThrow('BITCOIN_RPC_URL is required'); });
  it('creates Mempool provider', () => { expect(createUtxoProvider({ type: 'mempool' }).name).toBe('Mempool.space REST API'); });
  it('creates Mempool with custom URL', () => { expect(createUtxoProvider({ type: 'mempool', mempoolApiUrl: 'https://custom/api' }).name).toBe('Mempool.space REST API'); });
  it('throws on unknown type', () => { expect(() => createUtxoProvider({ type: 'unknown' as unknown as 'rpc' })).toThrow('Unknown UTXO provider'); });
});

describe('HttpError', () => {
  it('carries status code', () => {
    const err = new HttpError('Server Error', 500);
    expect(err.message).toBe('Server Error');
    expect(err.status).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isRetryableError', () => {
  it('retries 5xx HttpError', () => { expect(isRetryableError(new HttpError('x', 500))).toBe(true); });
  it('does NOT retry 4xx HttpError', () => { expect(isRetryableError(new HttpError('x', 400))).toBe(false); });
  it('retries network TypeError "fetch failed"', () => { expect(isRetryableError(new TypeError('fetch failed'))).toBe(true); });
  it('retries network TypeError "Failed to fetch"', () => { expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true); });
  it('retries network TypeError "NetworkError"', () => { expect(isRetryableError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true); });
  it('retries network TypeError "Load failed"', () => { expect(isRetryableError(new TypeError('Load failed'))).toBe(true); });
  it('does NOT retry non-network TypeError', () => {
    expect(isRetryableError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isRetryableError(new TypeError('x.map is not a function'))).toBe(false);
  });
  it('retries AbortError', () => { expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(true); });
  it('retries ECONNREFUSED', () => { expect(isRetryableError(new Error('connect ECONNREFUSED'))).toBe(true); });
  it('retries ECONNRESET', () => { expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true); });
  it('retries ETIMEDOUT', () => { expect(isRetryableError(new Error('connect ETIMEDOUT'))).toBe(true); });
  it('does NOT retry generic Error', () => { expect(isRetryableError(new Error('Wallet not loaded'))).toBe(false); });
  it('does NOT retry non-Error values', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('isDuplicateTxError', () => {
  it('detects "Transaction already in block chain"', () => { expect(isDuplicateTxError('Transaction already in block chain')).toBe(true); });
  it('detects "txn-already-in-mempool"', () => { expect(isDuplicateTxError('txn-already-in-mempool')).toBe(true); });
  it('detects "txn-already-known"', () => { expect(isDuplicateTxError('txn-already-known')).toBe(true); });
  it('detects "already known"', () => { expect(isDuplicateTxError('already known')).toBe(true); });
  it('detects "already exists"', () => { expect(isDuplicateTxError('tx already exists')).toBe(true); });
  it('is case-insensitive', () => { expect(isDuplicateTxError('TRANSACTION ALREADY IN MEMPOOL')).toBe(true); });
  it('returns false for unrelated', () => {
    expect(isDuplicateTxError('bad-txns-inputs-missingorspent')).toBe(false);
    expect(isDuplicateTxError('TX rejected')).toBe(false);
  });
});

describe('retryWithBackoff', () => {
  const noopDelay = () => Promise.resolve();

  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('retries on 5xx and succeeds', async () => {
    vi.mocked(logger.warn).mockClear();
    const fn = vi.fn().mockRejectedValueOnce(new HttpError('x', 500)).mockResolvedValueOnce('ok');
    expect(await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay, randomFn: () => 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 1000 }), expect.any(String));
  });
  it('retries on network TypeError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce('ok');
    expect(await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('does NOT retry non-network TypeError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));
    await expect(retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).rejects.toThrow('Cannot read properties');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('retries on AbortError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new DOMException('aborted', 'AbortError')).mockResolvedValueOnce('ok');
    expect(await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).toBe('ok');
  });
  it('retries on ECONNREFUSED', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValueOnce('ok');
    expect(await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).toBe('ok');
  });
  it('does NOT retry 4xx', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new HttpError('x', 400));
    await expect(retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('exhausts maxRetries then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 503));
    await expect(retryWithBackoff(fn, { name: 'test', maxRetries: 3, delayFn: noopDelay })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });
  it('applies jitter — randomFn=0.5 gives 75% of base', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(retryWithBackoff(fn, { name: 'test', maxRetries: 3, baseDelayMs: 1000, delayFn: (ms) => { delays.push(ms); return Promise.resolve(); }, randomFn: () => 0.5 })).rejects.toThrow();
    expect(delays).toEqual([750, 1500, 3000]);
  });
  it('jitter randomFn=0 gives minimum 50%', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(retryWithBackoff(fn, { name: 'test', maxRetries: 3, baseDelayMs: 1000, delayFn: (ms) => { delays.push(ms); return Promise.resolve(); }, randomFn: () => 0 })).rejects.toThrow();
    expect(delays).toEqual([500, 1000, 2000]);
  });
  it('jitter randomFn=1 gives maximum 100%', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(retryWithBackoff(fn, { name: 'test', maxRetries: 3, baseDelayMs: 1000, delayFn: (ms) => { delays.push(ms); return Promise.resolve(); }, randomFn: () => 1 })).rejects.toThrow();
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

describe('RpcUtxoProvider retry integration', () => {
  const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
  beforeEach(() => { mockFetch.mockReset(); });

  it('retries on transient 500', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ result: { chain: 'signet', blocks: 100 }, error: null }) });
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 100 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  it('does NOT retry on RPC-level error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ result: null, error: { message: 'Wallet not loaded', code: -18 } }) });
    await expect(provider.getBlockchainInfo()).rejects.toThrow('Wallet not loaded');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// Pins the contract that GetBlockHybridProvider.listUnspent emits a Sentry
// breadcrumb + structured warn log on every mempool.space fallback — the
// R0-8 dashboard alerts if the fallback rate stays at 100% (RPC unused).
describe('GetBlockHybridProvider listUnspent fallback observability', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockEmitRpcFallback.mockReset();
  });

  it('falls back to mempool.space and emits emitRpcFallback when RPC throws', async () => {
    const provider = new GetBlockHybridProvider({
      rpcUrl: 'https://go.getblock.io/fake-token',
      mempoolBaseUrl: 'https://mempool.space/api',
    });
    // RPC call: GetBlock returns "Method not allowed"
    mockFetch.mockResolvedValueOnce(rpcErr('Method not allowed', -32601));
    // Mempool fallback: returns one UTXO
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ txid: 'aa', vout: 0, status: { confirmed: true }, value: 100000 }]),
    });
    // Mempool tx-hex fetch (raw tx body for the UTXO)
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('0200deadbeef') });

    const utxos = await provider.listUnspent('bc1qtest');

    expect(utxos).toHaveLength(1);
    expect(mockEmitRpcFallback).toHaveBeenCalledTimes(1);
    expect(mockEmitRpcFallback).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'getblock',
      method: 'listunspent',
      fallbackTo: 'mempool.space',
      origin: 'GetBlockHybridProvider.listUnspent',
    }));
  });

  it('does NOT emit fallback when RPC succeeds', async () => {
    const provider = new GetBlockHybridProvider({
      rpcUrl: 'https://go.getblock.io/fake-token',
      mempoolBaseUrl: 'https://mempool.space/api',
    });
    mockFetch.mockResolvedValueOnce(rpcOk([{ txid: 'aa', vout: 0, amount: 0.001 }]));

    const utxos = await provider.listUnspent('bc1qtest');

    expect(utxos).toHaveLength(1);
    expect(mockEmitRpcFallback).not.toHaveBeenCalled();
  });

  // BUG-2026-08-01-F10: prod (`arkova-worker`, us-central1) logs
  // `GetBlockHybridProvider.listUnspent: RPC fallback to mempool.space —
  // reason: "RPC listunspent failed: HTTP 405"` on 100% of calls. That
  // message shape is `rpcCall`'s bare HttpError path (transport-level
  // `!response.ok`, body did NOT contain a parseable `{error}` JSON-RPC
  // envelope) — GENUINELY DIFFERENT from the `rpcErr(...)` helper above,
  // which simulates a `200 OK` body carrying `{error:{message,code}}`
  // (an RpcApplicationError). The prior test therefore pinned a failure
  // shape the RPC endpoint has never actually produced. This test pins the
  // REAL one: a literal HTTP 405 with a non-JSON-RPC body (GetBlock's
  // shared-node gateway rejects the `listunspent` WALLET RPC method before
  // it ever reaches Bitcoin Core — Core itself would answer wallet-not-
  // loaded as a JSON-RPC error, typically HTTP-500-wrapped per the
  // #1408-Finding-1 comment above, not a bare 405). Root cause is the
  // GetBlock shared-plan method allowlist (config/provider-tier), not a
  // wrong URL/verb/method name in `rpcCall` — see
  // `docs/staging/SOAK-FINDINGS-2026-08.md` F-10 for the full writeup.
  it('falls back to mempool.space on a literal HTTP 405 with no JSON-RPC error envelope (real GetBlock shared-endpoint shape, BUG-2026-08-01-F10)', async () => {
    const provider = new GetBlockHybridProvider({
      rpcUrl: 'https://go.getblock.io/fake-token',
      mempoolBaseUrl: 'https://mempool.space/api',
    });
    // GetBlock's gateway 405s the wallet RPC method at the transport layer —
    // no `{error}` envelope in the body, so `tryParseRpcErrorBody` returns
    // null and `rpcCall` throws a bare HttpError (matches the `RPC
    // listunspent failed: HTTP 405` reason string observed in prod logs).
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 405,
      text: () => Promise.resolve('405 Method Not Allowed'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ txid: 'bb', vout: 1, status: { confirmed: true }, value: 50000 }]),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('0200deadbeef') });

    const utxos = await provider.listUnspent('bc1qtest');

    // Correct request shape reached GetBlock first: POST, JSON-RPC 2.0 body,
    // the exact `listunspent` params BitcoinChainClient relies on.
    const [rpcUrl, rpcInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(rpcUrl).toBe('https://go.getblock.io/fake-token');
    expect(rpcInit.method).toBe('POST');
    expect(JSON.parse(rpcInit.body as string)).toMatchObject({
      jsonrpc: '2.0',
      method: 'listunspent',
      params: [1, 9999999, ['bc1qtest']],
    });

    // Result still comes from the mempool fallback.
    expect(utxos).toEqual([{ txid: 'bb', vout: 1, valueSats: 50000, rawTxHex: '' }]);

    // Observability pins the EXACT reason string prod alerting keys off —
    // if `rpcCall`'s HttpError message format ever drifts, this fails loudly
    // instead of silently breaking the R0-8 / SCRUM-1254 fallback-rate view.
    expect(mockEmitRpcFallback).toHaveBeenCalledTimes(1);
    expect(mockEmitRpcFallback).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'getblock',
      method: 'listunspent',
      fallbackTo: 'mempool.space',
      origin: 'GetBlockHybridProvider.listUnspent',
      error: expect.objectContaining({
        name: 'HttpError',
        message: 'RPC listunspent failed: HTTP 405',
      }),
    }));
  });
});

describe('SCRUM-2692 GetBlock hybrid receipt absence quorum', () => {
  const TXID = 'ab'.repeat(32);
  const MEMPOOL_TX = {
    txid: TXID,
    status: { confirmed: false },
    vout: [],
  };

  beforeEach(() => {
    mockFetch.mockReset();
    mockEmitRpcFallback.mockReset();
  });

  function provider() {
    return new GetBlockHybridProvider({
      rpcUrl: 'https://go.getblock.io/fake-token',
      mempoolBaseUrl: 'https://mempool.space/signet/api',
    });
  }

  it('returns the transaction when GetBlock misses but independent mempool.space finds it', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('No such mempool or blockchain transaction', -5));
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MEMPOOL_TX) });

    await expect(provider().getRawTransaction(TXID)).resolves.toMatchObject({
      txid: TXID,
      confirmations: 0,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('reports definitive absence only when GetBlock and mempool.space both return not-found', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('No such mempool or blockchain transaction', -5));
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(provider().getRawTransaction(TXID)).rejects.toMatchObject({ code: -5 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('propagates a secondary-source outage instead of converting the GetBlock miss to absence', async () => {
    mockFetch.mockResolvedValueOnce(rpcErr('No such mempool or blockchain transaction', -5));
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(provider().getRawTransaction(TXID)).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns the transaction when GetBlock is unavailable but independent mempool.space finds it', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MEMPOOL_TX) });

    await expect(provider().getRawTransaction(TXID)).resolves.toMatchObject({ txid: TXID });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('propagates the GetBlock outage when mempool.space reports not-found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(provider().getRawTransaction(TXID)).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('MempoolUtxoProvider retry integration', () => {
  const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
  beforeEach(() => { mockFetch.mockReset(); });

  it('retries on 503', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('150000') });
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 150000 });
  });
  it('does NOT retry 400 non-duplicate', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('bad-txns-inputs-missingorspent') });
    await expect(provider.broadcastTx('bad')).rejects.toThrow('HTTP 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it('retries on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ txid: 'aaa', status: { confirmed: true, block_height: 100, block_hash: 'bbb', block_time: 1710000000 }, vout: [] }) });
    expect((await provider.getRawTransaction('aaa')).txid).toBe('aaa');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── PROOF-03 (SCRUM-2336): inclusion-proof provider methods ────────────────

describe('PROOF-03 getBlockHeaderHex / getTxOutProof', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('RpcUtxoProvider.getBlockHeaderHex calls getblockheader with verbose=false', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(rpcOk('00'.repeat(80)));
    const hex = await provider.getBlockHeaderHex('b'.repeat(64));
    expect(hex).toBe('00'.repeat(80));
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.method).toBe('getblockheader');
    expect(body.params).toEqual(['b'.repeat(64), false]);
  });

  it('RpcUtxoProvider.getTxOutProof passes [txids, blockhash]', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(rpcOk('deadbeef'));
    const proof = await provider.getTxOutProof(['a'.repeat(64)], 'b'.repeat(64));
    expect(proof).toBe('deadbeef');
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.method).toBe('gettxoutproof');
    expect(body.params).toEqual([['a'.repeat(64)], 'b'.repeat(64)]);
  });

  it('RpcUtxoProvider.getTxOutProof omits blockhash when not given', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(rpcOk('cafe'));
    await provider.getTxOutProof(['a'.repeat(64)]);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.params).toEqual([['a'.repeat(64)]]);
  });

  it('GetBlockHybridProvider routes header + proof through the RPC node', async () => {
    const provider = new GetBlockHybridProvider({
      rpcUrl: 'https://go.getblock.io/fake-token',
      mempoolBaseUrl: 'https://mempool.space/api',
    });
    mockFetch.mockResolvedValueOnce(rpcOk('11'.repeat(80)));
    expect(await provider.getBlockHeaderHex('b'.repeat(64))).toBe('11'.repeat(80));
    const hdrBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(hdrBody.method).toBe('getblockheader');
    expect(hdrBody.params).toEqual(['b'.repeat(64), false]);

    mockFetch.mockResolvedValueOnce(rpcOk('aabbcc'));
    expect(await provider.getTxOutProof(['a'.repeat(64)], 'b'.repeat(64))).toBe('aabbcc');
    const proofBody = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body);
    expect(proofBody.method).toBe('gettxoutproof');
  });

  it('MempoolUtxoProvider.getBlockHeaderHex fetches the /block/:hash/header text endpoint', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('22'.repeat(80) + '\n') });
    const hex = await provider.getBlockHeaderHex('b'.repeat(64));
    expect(hex).toBe('22'.repeat(80));
    expect(mockFetch.mock.calls[0][0]).toBe('https://mempool.space/signet/api/block/' + 'b'.repeat(64) + '/header');
  });

  it('MempoolUtxoProvider does NOT implement getTxOutProof (forces honest pending, no fabricated branch)', () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    expect((provider as unknown as { getTxOutProof?: unknown }).getTxOutProof).toBeUndefined();
  });
});

// ─── S3-C2: chain-resilience hardening ───────────────────────────────────────
// Bounded retry termination, backoff delay bounding, 429-as-transient, and
// per-provider broadcast idempotency ("already-known" == success) regressions.

describe('S3-C2 retryWithBackoff bounded termination (no infinite loop)', () => {
  const noopDelay = () => Promise.resolve();

  it('always-failing retryable error reaches a terminal throw after default attempts (1 + 3 retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('persistent 503', 503));
    await expect(retryWithBackoff(fn, { name: 'test', delayFn: noopDelay })).rejects.toThrow('persistent 503');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('maxRetries: Infinity is clamped to the hard cap (8) — terminates, never loops', async () => {
    let calls = 0;
    // Escape hatch: if the cap were NOT enforced, the fn eventually succeeds and
    // the rejection assertion fails FAST instead of the test hanging forever.
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls > 50) return Promise.resolve('escaped-the-cap');
      return Promise.reject(new HttpError('always 500', 500));
    });
    await expect(
      retryWithBackoff(fn, { name: 'test', maxRetries: Infinity, delayFn: noopDelay }),
    ).rejects.toThrow('always 500');
    expect(fn).toHaveBeenCalledTimes(9); // 1 initial + 8 (hard cap)
  });

  it('maxRetries: NaN falls back to the default and rethrows the REAL error (not undefined)', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('real error', 502));
    await expect(
      retryWithBackoff(fn, { name: 'test', maxRetries: Number.NaN, delayFn: noopDelay }),
    ).rejects.toThrow('real error');
    expect(fn).toHaveBeenCalledTimes(4); // default 3 retries
  });

  it('negative maxRetries clamps to 0 — single attempt, immediate terminal throw', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('boom', 500));
    await expect(
      retryWithBackoff(fn, { name: 'test', maxRetries: -5, delayFn: noopDelay }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fractional maxRetries floors (2.7 → 2 retries: 3 attempts, 2 delays)', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(
      retryWithBackoff(fn, {
        name: 'test',
        maxRetries: 2.7,
        delayFn: (ms) => { delays.push(ms); return Promise.resolve(); },
      }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });
});

describe('S3-C2 backoff delay bounding', () => {
  it('per-attempt delay is capped at 30s even as the exponential grows', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(
      retryWithBackoff(fn, {
        name: 'test',
        maxRetries: 4,
        baseDelayMs: 10_000,
        delayFn: (ms) => { delays.push(ms); return Promise.resolve(); },
        randomFn: () => 1,
      }),
    ).rejects.toThrow();
    // Uncapped would be [10000, 20000, 40000, 80000].
    expect(delays).toEqual([10_000, 20_000, 30_000, 30_000]);
  });

  it('non-finite baseDelayMs falls back to the default (1000ms)', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(
      retryWithBackoff(fn, {
        name: 'test',
        maxRetries: 3,
        baseDelayMs: Number.NaN,
        delayFn: (ms) => { delays.push(ms); return Promise.resolve(); },
        randomFn: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('non-positive baseDelayMs falls back to the default (1000ms)', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new HttpError('x', 500));
    await expect(
      retryWithBackoff(fn, {
        name: 'test',
        maxRetries: 3,
        baseDelayMs: -100,
        delayFn: (ms) => { delays.push(ms); return Promise.resolve(); },
        randomFn: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

describe('S3-C2 HTTP 429 (rate limit) is transient', () => {
  it('isRetryableError retries HttpError 429', () => {
    expect(isRetryableError(new HttpError('rate limited', 429))).toBe(true);
  });
  it('still does NOT retry other 4xx (404)', () => {
    expect(isRetryableError(new HttpError('not found', 404))).toBe(false);
  });
  it('MempoolUtxoProvider retries a 429 then succeeds', async () => {
    mockFetch.mockReset();
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('160000') });
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 160000 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('S3-C2 broadcast idempotency — already-known == success (per provider path)', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  // ── RpcUtxoProvider path ──
  it('RpcUtxoProvider: duplicate on a RETRY attempt (first broadcast landed, response lost) is success', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }); // response lost
    mockFetch.mockResolvedValueOnce(rpcErr('txn-already-in-mempool', -26)); // retry: it actually landed
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('RpcUtxoProvider: every known already-known variant maps to success', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    const variants = [
      'Transaction already in block chain',
      'transaction already in mempool',
      'txn-already-in-mempool',
      'txn-already-known',
      'already known',
      'tx already exists',
    ];
    for (const variant of variants) {
      mockFetch.mockResolvedValueOnce(rpcErr(variant, -27));
      expect((await provider.broadcastTx('0200aabb')).txid).toBe('');
    }
    expect(mockFetch).toHaveBeenCalledTimes(variants.length);
  });

  // ── MempoolUtxoProvider path ──
  it('MempoolUtxoProvider: duplicate after a transient 503 retry is success', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('service unavailable') });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('txn-already-known') });
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('MempoolUtxoProvider: HTTP 500 carrying duplicate text is success on the FIRST attempt (no retry churn)', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('Transaction already in block chain') });
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ── GetBlockHybridProvider path (production broadcast route) ──
  it('GetBlockHybridProvider: returns txid on success', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockResolvedValueOnce(rpcOk('feedface'));
    expect((await provider.broadcastTx('0200aabb')).txid).toBe('feedface');
  });

  it('GetBlockHybridProvider: duplicate RPC error is success', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockResolvedValueOnce(rpcErr('Transaction already in block chain', -27));
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'GetBlockHybridProvider.broadcastTx' }),
      expect.stringContaining('already in mempool/chain'),
    );
  });

  it('GetBlockHybridProvider: duplicate on a RETRY attempt is success', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
    mockFetch.mockResolvedValueOnce(rpcErr('txn-already-known', -26));
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('GetBlockHybridProvider: non-duplicate RPC error throws without retry (terminal)', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockResolvedValueOnce(rpcErr('bad-txns-inputs-missingorspent', -25));
    await expect(provider.broadcastTx('0200aabb')).rejects.toThrow('bad-txns-inputs-missingorspent');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('GetBlockHybridProvider: persistent 500 exhausts bounded retries then throws (terminal)', async () => {
    vi.useFakeTimers();
    try {
      const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      const pending = provider.broadcastTx('0200aabb');
      const guard = expect(pending).rejects.toThrow('HTTP 500');
      await vi.advanceTimersByTimeAsync(120_000);
      await guard;
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries — bounded
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('S3-C2 confirmation-proof provider methods — bounded retry', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('RpcUtxoProvider.getTxOutProof retries a transient 500 then succeeds', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    mockFetch.mockResolvedValueOnce(rpcOk('cafe'));
    expect(await provider.getTxOutProof(['a'.repeat(64)], 'b'.repeat(64))).toBe('cafe');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('RpcUtxoProvider.getTxOutProof exhausts bounded retries then throws (terminal)', async () => {
    vi.useFakeTimers();
    try {
      const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const pending = provider.getTxOutProof(['a'.repeat(64)]);
      const guard = expect(pending).rejects.toThrow('HTTP 503');
      await vi.advanceTimersByTimeAsync(120_000);
      await guard;
      expect(mockFetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('GetBlockHybridProvider.getBlockHeaderHex retries a transient network failure then succeeds', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    mockFetch.mockResolvedValueOnce(rpcOk('ab'.repeat(80)));
    expect(await provider.getBlockHeaderHex('b'.repeat(64))).toBe('ab'.repeat(80));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── S3-C2 review #1408-Finding-1: HTTP-wrapped JSON-RPC application errors ──
// Bitcoin-Core-faithful endpoints wrap JSON-RPC application errors in HTTP 500
// (`HTTP_INTERNAL_SERVER_ERROR` for every RPC_* app error). rpcCall must parse
// the response body FIRST on !response.ok: an `{error}` envelope is the REAL,
// definitive failure. A bare HttpError 500 would (a) misclassify a definitive
// app error as transient (burning the retry budget) and (b) hide
// "transaction already in block chain" from the duplicate==success path.
// Non-JSON / unreadable 5xx bodies keep the fail-safe retryable HttpError.

describe('S3-C2 #1408-Finding-1: rpcCall surfaces HTTP-wrapped JSON-RPC application errors', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  /** A Bitcoin-Core-faithful failure: HTTP error status, JSON-RPC error body. */
  function httpWrappedRpcErr(status: number, message: string, code: number) {
    const body = JSON.stringify({ result: null, error: { message, code }, id: 1 });
    return { ok: false, status, text: () => Promise.resolve(body) };
  }

  it('(i) HTTP 500 + {error:{code:-5}} throws a definitive RpcApplicationError — NO retry', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(httpWrappedRpcErr(500, 'Not all transactions found', -5));
    await expect(provider.getTxOutProof(['a'.repeat(64)])).rejects.toMatchObject({
      name: 'RpcApplicationError',
      code: -5,
      httpStatus: 500,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // definitive → classifier must not retry
  });

  it('(i) classifier: RpcApplicationError is NOT retryable (definitive), even when HTTP-wrapped', () => {
    const err = new RpcApplicationError(
      'RPC gettxoutproof error: Not all transactions found (code -5)', -5, 500,
    );
    expect(isRetryableError(err)).toBe(false);
    expect(err.httpStatus).toBe(500);
  });

  it('(ii) HTTP 500 + {error:{code:-27, already in block chain}} → duplicate == success', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(httpWrappedRpcErr(500, 'transaction already in block chain', -27));
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe(''); // prior broadcast landed — success, not unwind
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('(ii) GetBlockHybridProvider: HTTP-wrapped duplicate on broadcast is success too', async () => {
    const provider = new GetBlockHybridProvider({ rpcUrl: 'https://go.getblock.io/fake-token' });
    mockFetch.mockResolvedValueOnce(httpWrappedRpcErr(500, 'txn-already-in-mempool', -26));
    const result = await provider.broadcastTx('0200aabb');
    expect(result.txid).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('(iii) HTTP 500 with a non-JSON body stays a retryable HttpError (fail-safe unchanged)', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('<html>Internal Server Error</html>') });
    mockFetch.mockResolvedValueOnce(rpcOk({ chain: 'signet', blocks: 100 }));
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 100 });
    expect(mockFetch).toHaveBeenCalledTimes(2); // retried as transient
  });

  it('(iii) HTTP 500 whose JSON body has NO {error} envelope stays a retryable HttpError', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('{"result":null}') });
    mockFetch.mockResolvedValueOnce(rpcOk({ chain: 'signet', blocks: 100 }));
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 100 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('(iii) unreadable 5xx body (no text()) stays a retryable HttpError — parse never crashes classification', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 }); // legacy-mock shape: no .text
    mockFetch.mockResolvedValueOnce(rpcOk({ chain: 'signet', blocks: 100 }));
    expect(await provider.getBlockchainInfo()).toEqual({ chain: 'signet', blocks: 100 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP 4xx with a JSON-RPC error body also surfaces the application error (status preserved)', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(httpWrappedRpcErr(404, 'Method not found', -32601));
    await expect(provider.getBlockchainInfo()).rejects.toMatchObject({
      name: 'RpcApplicationError',
      code: -32601,
      httpStatus: 404,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('in-envelope RPC error on HTTP 200 throws the SAME typed RpcApplicationError (single error shape)', async () => {
    const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });
    mockFetch.mockResolvedValueOnce(rpcErr('Wallet not loaded', -18));
    await expect(provider.getBlockchainInfo()).rejects.toMatchObject({
      name: 'RpcApplicationError',
      code: -18,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── S3-P0 #1417-HIGH: typed broadcast-reject classifier ─────────────────────
// The double-broadcast HIGH turns on ONE predicate: the intent unwind (refund +
// delete proofs + revert-to-PENDING) may fire ONLY when the node/API gave a
// DEFINITIVE broadcast rejection. Auth (401), quota (402), not-found (404),
// transport 5xx, timeouts, and unknown errors must all DEFER (row stays
// BROADCASTING; the live tx is never orphaned by a second, different broadcast).

describe('S3-P0 #1417 isBroadcastRejectText — explicit mempool-API reject strings', () => {
  it.each([
    'sendrawtransaction RPC error: dust',
    'min relay fee not met',
    'bad-txns-inputs-missingorspent',
    'non-mandatory-script-verify-flag',
    'insufficient fee, rejected',
    'txn-mempool-conflict',
    'mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation)',
    'non-final',
    'bad-txns-in-belowout',
    'absurdly-high-fee',
    'too-long-mempool-chain',
  ])('classifies %j as a definitive broadcast reject', (text) => {
    expect(isBroadcastRejectText(text)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBroadcastRejectText('MIN RELAY FEE NOT MET')).toBe(true);
  });

  it.each([
    'HTTP 402 Payment Required',
    'HTTP 401 Unauthorized',
    'HTTP 404 Not Found',
    'HTTP 500 Internal Server Error',
    'connect ETIMEDOUT 1.2.3.4:8332',
    'fetch failed',
    'transaction already in mempool', // duplicate == success, NOT a reject
    // Conservative: broad tokens that could appear in a non-reject
    // proxy/transport message are deliberately NOT classified as rejects — the
    // HIGH is about never OVER-unwinding. These DEFER (a genuine reject slipping
    // the net just waits for reconcile — safe; a false positive would double-broadcast).
    'request rejected by upstream proxy',
    'unsupported protocol version',
    'invalid scriptpubkey format in your query',
  ])('does NOT classify %j as a broadcast reject', (text) => {
    expect(isBroadcastRejectText(text)).toBe(false);
  });
});

describe('S3-P0 #1417 isBroadcastRejectedError — the unwind gate', () => {
  it('BroadcastRejectedError → true (typed definitive reject)', () => {
    expect(isBroadcastRejectedError(new BroadcastRejectedError('dust', -26))).toBe(true);
  });

  it('RpcApplicationError from sendrawtransaction → true (node method-level verdict)', () => {
    // A JSON-RPC application error IS a definitive broadcast reject.
    expect(isBroadcastRejectedError(new RpcApplicationError('bad-txns (code -26)', -26, 500))).toBe(true);
  });

  it('plain Error carrying explicit reject text → true (mempool-API text path)', () => {
    expect(isBroadcastRejectedError(new Error('Mempool API broadcast failed: HTTP 400 — min relay fee not met'))).toBe(true);
  });

  it('HttpError 402 (GetBlock quota) → false — DEFER, tx may be live', () => {
    expect(isBroadcastRejectedError(new HttpError('quota exceeded', 402))).toBe(false);
  });

  it('HttpError 401 (auth) → false — DEFER', () => {
    expect(isBroadcastRejectedError(new HttpError('unauthorized', 401))).toBe(false);
  });

  it('HttpError 404 → false — DEFER (a lookup 404 is not a broadcast reject)', () => {
    expect(isBroadcastRejectedError(new HttpError('not found', 404))).toBe(false);
  });

  it('HttpError 5xx → false — DEFER (transient transport)', () => {
    expect(isBroadcastRejectedError(new HttpError('bad gateway', 502))).toBe(false);
  });

  it('timeout / network Error → false — DEFER', () => {
    expect(isBroadcastRejectedError(new Error('connect ETIMEDOUT 1.2.3.4:8332'))).toBe(false);
    expect(isBroadcastRejectedError(new TypeError('fetch failed'))).toBe(false);
  });

  it('unknown / non-error values → false — DEFER (fail-safe: never unwind on ambiguity)', () => {
    expect(isBroadcastRejectedError(new Error('Wallet not loaded'))).toBe(false);
    expect(isBroadcastRejectedError('string')).toBe(false);
    expect(isBroadcastRejectedError(null)).toBe(false);
    expect(isBroadcastRejectedError(undefined)).toBe(false);
  });
});

describe('S3-P0 #1417 MempoolUtxoProvider.broadcastTx error typing', () => {
  const mockFetch = vi.fn();
  beforeEach(() => { global.fetch = mockFetch as unknown as typeof fetch; mockFetch.mockReset(); });

  it('explicit reject text → BroadcastRejectedError (unwind), NOT a bare HttpError', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('min relay fee not met') });
    await expect(provider.broadcastTx('deadbeef')).rejects.toMatchObject({ name: 'BroadcastRejectedError' });
  });

  it('402 quota with no reject text → bare HttpError (DEFER, not a reject)', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValue({ ok: false, status: 402, text: () => Promise.resolve('Payment Required') });
    const err = await provider.broadcastTx('deadbeef').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(BroadcastRejectedError);
    expect(isBroadcastRejectedError(err)).toBe(false);
  });

  it('duplicate text → success (txid empty), never a reject', async () => {
    const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('txn-already-in-mempool') });
    expect(await provider.broadcastTx('deadbeef')).toEqual({ txid: '' });
  });
});
