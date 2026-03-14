/**
 * Unit tests for UTXO Provider implementations
 *
 * P7-TS-12: Tests for RpcUtxoProvider, MempoolUtxoProvider, and factory.
 * All network calls are mocked — Constitution requires no real Bitcoin API calls in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  RpcUtxoProvider,
  MempoolUtxoProvider,
  createUtxoProvider,
  HttpError,
  retryWithBackoff,
} from './utxo-provider.js';

import { logger } from '../utils/logger.js';

// ─── RpcUtxoProvider ─────────────────────────────────────────────────────

describe('RpcUtxoProvider', () => {
  const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  function rpcOk(result: unknown) {
    return { ok: true, json: () => Promise.resolve({ result, error: null }) };
  }

  function rpcErr(message: string, code = -1) {
    return { ok: true, json: () => Promise.resolve({ result: null, error: { message, code } }) };
  }

  describe('listUnspent', () => {
    it('returns empty array when no UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk([]));
      const utxos = await provider.listUnspent('tb1qtest');
      expect(utxos).toEqual([]);
    });

    it('maps RPC UTXOs and fetches raw tx hex', async () => {
      // listunspent
      mockFetch.mockResolvedValueOnce(rpcOk([
        { txid: 'aaa', vout: 0, amount: 0.001, scriptPubKey: 'deadbeef' },
      ]));
      // getrawtransaction for raw hex
      mockFetch.mockResolvedValueOnce(rpcOk('0200000001...'));

      const utxos = await provider.listUnspent('tb1qtest');
      expect(utxos).toHaveLength(1);
      expect(utxos[0]).toEqual({
        txid: 'aaa',
        vout: 0,
        valueSats: 100000,
        rawTxHex: '0200000001...',
      });
    });

    it('handles null RPC response', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk(null));
      const utxos = await provider.listUnspent('tb1qtest');
      expect(utxos).toEqual([]);
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
      const authedProvider = new RpcUtxoProvider({
        rpcUrl: 'http://localhost:38332',
        rpcAuth: 'user:pass',
      });

      mockFetch.mockResolvedValueOnce(rpcOk([]));
      await authedProvider.listUnspent('tb1qtest');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:38332',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Basic'),
          }),
        }),
      );
    });
  });

  describe('broadcastTx', () => {
    it('returns txid on success', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk('abc123'));
      const result = await provider.broadcastTx('0200000001...');
      expect(result.txid).toBe('abc123');
    });

    it('throws on RPC error', async () => {
      mockFetch.mockResolvedValueOnce(rpcErr('TX rejected'));
      await expect(provider.broadcastTx('bad')).rejects.toThrow('TX rejected');
    });
  });

  describe('getBlockchainInfo', () => {
    it('returns chain and block height', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk({ chain: 'signet', blocks: 150000 }));
      const info = await provider.getBlockchainInfo();
      expect(info).toEqual({ chain: 'signet', blocks: 150000 });
    });
  });

  describe('getRawTransaction', () => {
    it('returns parsed transaction', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk({
        txid: 'aaa',
        confirmations: 5,
        blocktime: 1710000000,
        blockhash: 'bbb',
        vout: [{ scriptPubKey: { hex: 'deadbeef', asm: 'OP_RETURN ...' } }],
      }));

      const tx = await provider.getRawTransaction('aaa');
      expect(tx.txid).toBe('aaa');
      expect(tx.confirmations).toBe(5);
      expect(tx.vout).toHaveLength(1);
    });
  });

  describe('getBlockHeader', () => {
    it('returns block height', async () => {
      mockFetch.mockResolvedValueOnce(rpcOk({ height: 150042 }));
      const header = await provider.getBlockHeader('bbb');
      expect(header.height).toBe(150042);
    });
  });

  it('has correct name', () => {
    expect(provider.name).toBe('Bitcoin Core RPC');
  });
});

// ─── MempoolUtxoProvider ─────────────────────────────────────────────────

describe('MempoolUtxoProvider', () => {
  const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('listUnspent', () => {
    it('returns only confirmed UTXOs', async () => {
      // GET /address/:address/utxo
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { txid: 'aaa', vout: 0, value: 50000, status: { confirmed: true, block_height: 100 } },
          { txid: 'bbb', vout: 1, value: 30000, status: { confirmed: false } },
        ]),
      });
      // GET /tx/:txid/hex for confirmed UTXO
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('0200000001...'),
      });

      const utxos = await provider.listUnspent('tb1qtest');
      expect(utxos).toHaveLength(1);
      expect(utxos[0]).toEqual({
        txid: 'aaa',
        vout: 0,
        valueSats: 50000,
        rawTxHex: '0200000001...',
      });
    });

    it('returns empty when all UTXOs are unconfirmed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { txid: 'aaa', vout: 0, value: 50000, status: { confirmed: false } },
        ]),
      });

      const utxos = await provider.listUnspent('tb1qtest');
      expect(utxos).toEqual([]);
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(provider.listUnspent('tb1qtest')).rejects.toThrow('HTTP 404');
    });
  });

  describe('broadcastTx', () => {
    it('returns txid from response text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('abc123def\n'),
      });
      const result = await provider.broadcastTx('0200000001...');
      expect(result.txid).toBe('abc123def');
    });

    it('sends POST to /tx with plain text Content-Type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('txid_result'),
      });
      await provider.broadcastTx('02000000deadbeef');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://mempool.space/signet/api/tx',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '02000000deadbeef',
        }),
      );
    });

    it('trims whitespace from txid response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('  abc123  \n'),
      });
      const result = await provider.broadcastTx('hex');
      expect(result.txid).toBe('abc123');
    });

    it('throws on broadcast error with error text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad-txns-inputs-missingorspent'),
      });
      await expect(provider.broadcastTx('bad')).rejects.toThrow('broadcast failed');
    });

    it('includes HTTP status in error message (4xx — no retry)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve('Unprocessable Entity'),
      });
      await expect(provider.broadcastTx('bad')).rejects.toThrow('HTTP 422');
    });
  });

  describe('getBlockchainInfo', () => {
    it('returns signet chain and block height', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('150000'),
      });
      const info = await provider.getBlockchainInfo();
      expect(info).toEqual({ chain: 'signet', blocks: 150000 });
    });

    it('infers testnet from URL', async () => {
      const testnetProvider = new MempoolUtxoProvider({
        baseUrl: 'https://mempool.space/testnet/api',
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('2500000'),
      });
      const info = await testnetProvider.getBlockchainInfo();
      expect(info.chain).toBe('test');
    });

    it('infers main from URL without network prefix', async () => {
      const mainProvider = new MempoolUtxoProvider({
        baseUrl: 'https://mempool.space/api',
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('800000'),
      });
      const info = await mainProvider.getBlockchainInfo();
      expect(info.chain).toBe('main');
    });
  });

  describe('getRawTransaction', () => {
    it('maps Mempool API response to RawTransaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          txid: 'aaa',
          status: { confirmed: true, block_height: 100, block_hash: 'bbb', block_time: 1710000000 },
          vout: [
            { scriptpubkey: 'deadbeef', scriptpubkey_asm: 'OP_RETURN ...', value: 0 },
          ],
        }),
      });

      const tx = await provider.getRawTransaction('aaa');
      expect(tx.txid).toBe('aaa');
      expect(tx.confirmations).toBe(1); // confirmed = 1
      expect(tx.blocktime).toBe(1710000000);
      expect(tx.blockhash).toBe('bbb');
      expect(tx.vout[0].scriptPubKey.hex).toBe('deadbeef');
      expect(tx.vout[0].scriptPubKey.asm).toBe('OP_RETURN ...');
    });

    it('returns 0 confirmations for unconfirmed tx', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          txid: 'aaa',
          status: { confirmed: false },
          vout: [],
        }),
      });

      const tx = await provider.getRawTransaction('aaa');
      expect(tx.confirmations).toBe(0);
      expect(tx.blockhash).toBeUndefined();
    });
  });

  describe('getBlockHeader', () => {
    it('returns block height', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ height: 150042 }),
      });
      const header = await provider.getBlockHeader('bbb');
      expect(header.height).toBe(150042);
    });
  });

  it('has correct name', () => {
    expect(provider.name).toBe('Mempool.space REST API');
  });

  it('uses default Signet URL when no config', () => {
    const defaultProvider = new MempoolUtxoProvider();
    expect(defaultProvider.name).toBe('Mempool.space REST API');
  });

  it('strips trailing slash from base URL', async () => {
    const slashProvider = new MempoolUtxoProvider({
      baseUrl: 'https://mempool.space/signet/api/',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });
    await slashProvider.listUnspent('tb1q');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mempool.space/signet/api/address/tb1q/utxo',
    );
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────

describe('createUtxoProvider', () => {
  it('creates RPC provider', () => {
    const provider = createUtxoProvider({ type: 'rpc', rpcUrl: 'http://localhost:38332' });
    expect(provider.name).toBe('Bitcoin Core RPC');
  });

  it('throws if RPC URL missing for rpc type', () => {
    expect(() => createUtxoProvider({ type: 'rpc' })).toThrow('BITCOIN_RPC_URL is required');
  });

  it('creates Mempool provider with default URL', () => {
    const provider = createUtxoProvider({ type: 'mempool' });
    expect(provider.name).toBe('Mempool.space REST API');
  });

  it('creates Mempool provider with custom URL', () => {
    const provider = createUtxoProvider({
      type: 'mempool',
      mempoolApiUrl: 'https://custom.mempool.space/signet/api',
    });
    expect(provider.name).toBe('Mempool.space REST API');
  });

  it('throws on unknown provider type', () => {
    expect(() => createUtxoProvider({ type: 'unknown' as any })).toThrow('Unknown UTXO provider');
  });
});

// ─── HttpError ──────────────────────────────────────────────────────────

describe('HttpError', () => {
  it('carries status code', () => {
    const err = new HttpError('Server Error', 500);
    expect(err.message).toBe('Server Error');
    expect(err.status).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── retryWithBackoff ───────────────────────────────────────────────────

describe('retryWithBackoff', () => {
  const noopDelay = () => Promise.resolve();

  it('returns result on first success without retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { name: 'test', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx HttpError and succeeds on 2nd attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError('Internal Server Error', 500))
      .mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(fn, { name: 'test-5xx', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, maxRetries: 3, delayMs: 1000, operation: 'test-5xx' }),
      expect.stringContaining('Retrying'),
    );
  });

  it('retries on 502 Bad Gateway', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError('Bad Gateway', 502))
      .mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(fn, { name: 'test-502', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network TypeError (fetch failure)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(fn, { name: 'test-network', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on AbortError (timeout)', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    const fn = vi.fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(fn, { name: 'test-abort', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNREFUSED error', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:38332');
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(fn, { name: 'test-econnrefused', delayFn: noopDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx HttpError (400)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new HttpError('Bad Request', 400));

    await expect(retryWithBackoff(fn, { name: 'test-400', delayFn: noopDelay }))
      .rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 404 HttpError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new HttpError('Not Found', 404));

    await expect(retryWithBackoff(fn, { name: 'test-404', delayFn: noopDelay }))
      .rejects.toThrow('Not Found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on non-retryable Error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('RPC listunspent error: Wallet not loaded (code -18)'));

    await expect(retryWithBackoff(fn, { name: 'test-rpc-err', delayFn: noopDelay }))
      .rejects.toThrow('Wallet not loaded');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts max retries then throws original error', async () => {
    const err = new HttpError('Service Unavailable', 503);
    const fn = vi.fn().mockRejectedValue(err);

    await expect(retryWithBackoff(fn, { name: 'test-exhaust', maxRetries: 3, delayFn: noopDelay }))
      .rejects.toThrow('Service Unavailable');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('uses exponential backoff delays (1s, 2s, 4s)', async () => {
    const delays: number[] = [];
    const trackingDelay = (ms: number) => { delays.push(ms); return Promise.resolve(); };

    const fn = vi.fn().mockRejectedValue(new HttpError('Down', 500));

    await expect(retryWithBackoff(fn, { name: 'test-delays', maxRetries: 3, baseDelayMs: 1000, delayFn: trackingDelay }))
      .rejects.toThrow('Down');

    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('logs each retry attempt with structured fields', async () => {
    vi.mocked(logger.warn).mockClear();

    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError('Error', 500))
      .mockRejectedValueOnce(new HttpError('Error', 500))
      .mockResolvedValueOnce('ok');

    await retryWithBackoff(fn, { name: 'test-logging', delayFn: noopDelay });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, operation: 'test-logging' }),
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, operation: 'test-logging' }),
      expect.any(String),
    );
  });

  it('respects custom maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('Down', 500));

    await expect(retryWithBackoff(fn, { name: 'test-custom', maxRetries: 1, delayFn: noopDelay }))
      .rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});

// ─── RpcUtxoProvider retry integration ──────────────────────────────────

describe('RpcUtxoProvider retry integration', () => {
  const provider = new RpcUtxoProvider({ rpcUrl: 'http://localhost:38332' });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('retries on transient 500 and succeeds on 2nd call', async () => {
    // First call: 500
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: { chain: 'signet', blocks: 100 }, error: null }),
    });

    const info = await provider.getBlockchainInfo();
    expect(info).toEqual({ chain: 'signet', blocks: 100 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on RPC-level error (JSON error response)', async () => {
    // RPC-level errors have ok:true but json.error set — these are application errors, not transient
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: null, error: { message: 'Wallet not loaded', code: -18 } }),
    });

    await expect(provider.getBlockchainInfo()).rejects.toThrow('Wallet not loaded');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── MempoolUtxoProvider retry integration ──────────────────────────────

describe('MempoolUtxoProvider retry integration', () => {
  const provider = new MempoolUtxoProvider({ baseUrl: 'https://mempool.space/signet/api' });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('retries on transient 503 and succeeds', async () => {
    // First call: 503
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('150000'),
    });

    const info = await provider.getBlockchainInfo();
    expect(info).toEqual({ chain: 'signet', blocks: 150000 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400 bad request for broadcastTx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('bad-txns-inputs-missingorspent'),
    });

    await expect(provider.broadcastTx('bad')).rejects.toThrow('HTTP 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network failure for getRawTransaction', async () => {
    // First call: network error
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        txid: 'aaa',
        status: { confirmed: true, block_height: 100, block_hash: 'bbb', block_time: 1710000000 },
        vout: [],
      }),
    });

    const tx = await provider.getRawTransaction('aaa');
    expect(tx.txid).toBe('aaa');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
