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
} from './utxo-provider.js';

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

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(provider.listUnspent('tb1qtest')).rejects.toThrow('HTTP 500');
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

    it('throws on broadcast error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad-txns-inputs-missingorspent'),
      });
      await expect(provider.broadcastTx('bad')).rejects.toThrow('broadcast failed');
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
