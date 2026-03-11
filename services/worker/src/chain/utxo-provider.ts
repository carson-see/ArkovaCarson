/**
 * UTXO Provider Interface + Implementations
 *
 * Abstracts UTXO fetching and transaction broadcasting so that
 * SignetChainClient can work with either:
 *   - A Bitcoin Core RPC node (requires wallet with imported address)
 *   - A public REST API like Mempool.space (no node required)
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged or exposed
 *   - 1.7: Real API calls mocked in tests
 *
 * Story: P7-TS-12 (UTXO Management)
 */

import { logger } from '../utils/logger.js';

// ─── Shared Types ───────────────────────────────────────────────────────

export interface Utxo {
  /** Transaction ID of the UTXO */
  txid: string;
  /** Output index within the transaction */
  vout: number;
  /** Value in satoshis */
  valueSats: number;
  /** Full raw transaction hex (needed for non-witness PSBT input) */
  rawTxHex: string;
}

export interface BroadcastResult {
  /** Transaction ID returned by the network */
  txid: string;
}

export interface BlockchainInfo {
  /** Current chain name (e.g., "signet", "test", "main") */
  chain: string;
  /** Current block height */
  blocks: number;
}

export interface RawTransaction {
  txid: string;
  confirmations?: number;
  blocktime?: number;
  blockhash?: string;
  vout: Array<{ scriptPubKey: { hex: string; asm: string } }>;
}

export interface BlockHeader {
  height: number;
}

// ─── Interface ──────────────────────────────────────────────────────────

export interface UtxoProvider {
  /** Fetch unspent outputs for the given address */
  listUnspent(address: string): Promise<Utxo[]>;

  /** Broadcast a signed raw transaction hex and return its txid */
  broadcastTx(txHex: string): Promise<BroadcastResult>;

  /** Get current blockchain info (chain name + block height) */
  getBlockchainInfo(): Promise<BlockchainInfo>;

  /** Get a raw transaction by txid (verbose — includes vout details) */
  getRawTransaction(txid: string): Promise<RawTransaction>;

  /** Get block header by block hash */
  getBlockHeader(blockhash: string): Promise<BlockHeader>;

  /** Provider display name for logging */
  readonly name: string;
}

// ─── Bitcoin Core RPC Implementation ────────────────────────────────────

export interface RpcProviderConfig {
  rpcUrl: string;
  rpcAuth?: string;
}

/**
 * Make an RPC call to a Bitcoin Core node.
 */
async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
  rpcAuth?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (rpcAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(rpcAuth).toString('base64')}`;
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  const response = await fetch(rpcUrl, { method: 'POST', headers, body });

  if (!response.ok) {
    throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };

  if (json.error) {
    throw new Error(`RPC ${method} error: ${json.error.message} (code ${json.error.code})`);
  }

  return json.result;
}

/**
 * UTXO provider backed by a Bitcoin Core JSON-RPC node.
 *
 * Requires the treasury address to be imported into the node's wallet
 * (e.g., via `importaddress`). Best for self-hosted Signet nodes.
 */
export class RpcUtxoProvider implements UtxoProvider {
  readonly name = 'Bitcoin Core RPC';

  constructor(private readonly config: RpcProviderConfig) {}

  async listUnspent(address: string): Promise<Utxo[]> {
    // listunspent minconf=1, maxconf=9999999, addresses=[address]
    const rpcUtxos = (await rpcCall(
      this.config.rpcUrl,
      'listunspent',
      [1, 9999999, [address]],
      this.config.rpcAuth,
    )) as Array<{
      txid: string;
      vout: number;
      amount: number;
      scriptPubKey: string;
    }>;

    if (!rpcUtxos || rpcUtxos.length === 0) {
      return [];
    }

    // Fetch raw tx hex for each UTXO (needed for nonWitnessUtxo in PSBT)
    const utxos: Utxo[] = [];
    for (const u of rpcUtxos) {
      const rawTxHex = (await rpcCall(
        this.config.rpcUrl,
        'getrawtransaction',
        [u.txid, false],
        this.config.rpcAuth,
      )) as string;

      utxos.push({
        txid: u.txid,
        vout: u.vout,
        valueSats: Math.round(u.amount * 1e8),
        rawTxHex,
      });
    }

    return utxos;
  }

  async broadcastTx(txHex: string): Promise<BroadcastResult> {
    const txid = (await rpcCall(
      this.config.rpcUrl,
      'sendrawtransaction',
      [txHex],
      this.config.rpcAuth,
    )) as string;

    return { txid };
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const info = (await rpcCall(
      this.config.rpcUrl,
      'getblockchaininfo',
      [],
      this.config.rpcAuth,
    )) as { chain: string; blocks: number };

    return { chain: info.chain, blocks: info.blocks };
  }

  async getRawTransaction(txid: string): Promise<RawTransaction> {
    return (await rpcCall(
      this.config.rpcUrl,
      'getrawtransaction',
      [txid, true],
      this.config.rpcAuth,
    )) as RawTransaction;
  }

  async getBlockHeader(blockhash: string): Promise<BlockHeader> {
    return (await rpcCall(
      this.config.rpcUrl,
      'getblockheader',
      [blockhash],
      this.config.rpcAuth,
    )) as BlockHeader;
  }
}

// ─── Mempool.space REST API Implementation ──────────────────────────────

export interface MempoolProviderConfig {
  /** Base URL for Mempool API. Defaults to https://mempool.space/signet/api */
  baseUrl?: string;
}

/** Default Mempool.space Signet API endpoint */
const DEFAULT_MEMPOOL_SIGNET_URL = 'https://mempool.space/signet/api';

/**
 * UTXO provider backed by the Mempool.space REST API.
 *
 * No local node required — queries the public Mempool.space Signet
 * instance. Suitable for development and Signet testing.
 *
 * API docs: https://mempool.space/docs/api/rest
 */
export class MempoolUtxoProvider implements UtxoProvider {
  readonly name = 'Mempool.space REST API';
  private readonly baseUrl: string;

  constructor(config: MempoolProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_MEMPOOL_SIGNET_URL).replace(
      /\/$/,
      '',
    );
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    // GET /api/address/:address/utxo
    const url = `${this.baseUrl}/address/${address}/utxo`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Mempool API GET ${url} failed: HTTP ${response.status}`,
      );
    }

    const mempoolUtxos = (await response.json()) as Array<{
      txid: string;
      vout: number;
      value: number; // satoshis
      status: { confirmed: boolean; block_height?: number };
    }>;

    // Filter to confirmed UTXOs only (1+ confirmations)
    const confirmed = mempoolUtxos.filter((u) => u.status.confirmed);

    if (confirmed.length === 0) {
      return [];
    }

    // Fetch raw tx hex for each UTXO
    const utxos: Utxo[] = [];
    for (const u of confirmed) {
      const rawTxHex = await this.fetchRawTxHex(u.txid);
      utxos.push({
        txid: u.txid,
        vout: u.vout,
        valueSats: u.value,
        rawTxHex,
      });
    }

    return utxos;
  }

  async broadcastTx(txHex: string): Promise<BroadcastResult> {
    // POST /api/tx  (body is raw tx hex as plain text)
    const url = `${this.baseUrl}/tx`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Mempool API broadcast failed: HTTP ${response.status} — ${errorText}`,
      );
    }

    // Response body is the txid as plain text
    const txid = (await response.text()).trim();
    return { txid };
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    // GET /api/blocks/tip/height  → current block height (number)
    const heightUrl = `${this.baseUrl}/blocks/tip/height`;
    const heightResp = await fetch(heightUrl);

    if (!heightResp.ok) {
      throw new Error(
        `Mempool API GET ${heightUrl} failed: HTTP ${heightResp.status}`,
      );
    }

    const blocks = Number.parseInt(await heightResp.text(), 10);

    // Mempool.space Signet API doesn't expose a "chain" field directly,
    // but we know from the base URL. We infer from the URL path.
    const isSignet = this.baseUrl.includes('/signet');
    const isTestnet = this.baseUrl.includes('/testnet');

    return {
      chain: isSignet ? 'signet' : isTestnet ? 'test' : 'main',
      blocks,
    };
  }

  async getRawTransaction(txid: string): Promise<RawTransaction> {
    // GET /api/tx/:txid  → transaction details (JSON)
    const url = `${this.baseUrl}/tx/${txid}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Mempool API GET ${url} failed: HTTP ${response.status}`,
      );
    }

    const mempoolTx = (await response.json()) as {
      txid: string;
      status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
      };
      vout: Array<{
        scriptpubkey: string;
        scriptpubkey_asm: string;
        value: number;
      }>;
    };

    return {
      txid: mempoolTx.txid,
      confirmations: mempoolTx.status.confirmed ? 1 : 0, // Mempool doesn't give exact count
      blocktime: mempoolTx.status.block_time,
      blockhash: mempoolTx.status.block_hash,
      vout: mempoolTx.vout.map((v) => ({
        scriptPubKey: {
          hex: v.scriptpubkey,
          asm: v.scriptpubkey_asm,
        },
      })),
    };
  }

  async getBlockHeader(blockhash: string): Promise<BlockHeader> {
    // GET /api/block/:hash  → block details (includes height)
    const url = `${this.baseUrl}/block/${blockhash}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Mempool API GET ${url} failed: HTTP ${response.status}`,
      );
    }

    const block = (await response.json()) as { height: number };
    return { height: block.height };
  }

  /**
   * Fetch the raw transaction hex for a given txid.
   * GET /api/tx/:txid/hex
   */
  private async fetchRawTxHex(txid: string): Promise<string> {
    const url = `${this.baseUrl}/tx/${txid}/hex`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Mempool API GET ${url} failed: HTTP ${response.status}`,
      );
    }

    return (await response.text()).trim();
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

export type UtxoProviderType = 'rpc' | 'mempool';

export interface UtxoProviderFactoryConfig {
  type: UtxoProviderType;
  rpcUrl?: string;
  rpcAuth?: string;
  mempoolApiUrl?: string;
}

/**
 * Create a UTXO provider based on configuration.
 *
 * - 'rpc': Requires rpcUrl. Uses Bitcoin Core JSON-RPC.
 * - 'mempool': Uses Mempool.space Signet REST API. No node required.
 */
export function createUtxoProvider(
  factoryConfig: UtxoProviderFactoryConfig,
): UtxoProvider {
  if (factoryConfig.type === 'rpc') {
    if (!factoryConfig.rpcUrl) {
      throw new Error('BITCOIN_RPC_URL is required for RPC UTXO provider');
    }
    logger.info({ provider: 'rpc', rpcUrl: factoryConfig.rpcUrl }, 'Creating RPC UTXO provider');
    return new RpcUtxoProvider({
      rpcUrl: factoryConfig.rpcUrl,
      rpcAuth: factoryConfig.rpcAuth,
    });
  }

  if (factoryConfig.type === 'mempool') {
    const baseUrl = factoryConfig.mempoolApiUrl ?? DEFAULT_MEMPOOL_SIGNET_URL;
    logger.info({ provider: 'mempool', baseUrl }, 'Creating Mempool.space UTXO provider');
    return new MempoolUtxoProvider({ baseUrl });
  }

  throw new Error(`Unknown UTXO provider type: ${factoryConfig.type}`);
}
