import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  RpcUtxoProvider, MempoolUtxoProvider, createUtxoProvider,
  HttpError, retryWithBackoff, isRetryableError, isDuplicateTxError,
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

  it('returns only confirmed UTXOs', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([
      { txid: 'aaa', vout: 0, value: 50000, status: { confirmed: true, block_height: 100 } },
      { txid: 'bbb', vout: 1, value: 30000, status: { confirmed: false } },
    ]) });
    // No rawTxHex fetch — P2WPKH uses witnessUtxo, not nonWitnessUtxo
    const utxos = await provider.listUnspent('tb1qtest');
    expect(utxos).toHaveLength(1);
    expect(utxos[0]).toEqual({ txid: 'aaa', vout: 0, valueSats: 50000, rawTxHex: '' });
  });
  it('returns empty when all UTXOs are unconfirmed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ txid: 'aaa', vout: 0, value: 50000, status: { confirmed: false } }]) });
    expect(await provider.listUnspent('tb1qtest')).toEqual([]);
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
  it('throws on broadcast error with error text', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('bad-txns-inputs-missingorspent') });
    await expect(provider.broadcastTx('bad')).rejects.toThrow('broadcast failed');
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
