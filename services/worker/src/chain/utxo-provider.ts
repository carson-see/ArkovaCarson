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
 * Story: P7-TS-12 (UTXO Management), DH-09 (Retry Logic)
 */

import { logger } from '../utils/logger.js';

// ─── HttpError ──────────────────────────────────────────────────────────

/**
 * Error subclass that carries an HTTP status code.
 * Used to distinguish retryable (5xx) from non-retryable (4xx) failures.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// ─── Retry with Exponential Backoff ─────────────────────────────────────

interface RetryOptions {
  /** Max number of retries after the initial attempt */
  maxRetries?: number;
  /** Base delay in ms (doubles each retry with jitter) */
  baseDelayMs?: number;
  /** Operation name for structured logging */
  name: string;
  /** Injectable delay function for testability */
  delayFn?: (ms: number) => Promise<void>;
  /** Injectable random function for testability (returns 0-1) */
  randomFn?: () => number;
}

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Default request timeout in milliseconds (30 seconds) */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Create an AbortSignal that times out after the given duration.
 * When the signal fires, fetch will throw an AbortError which
 * isRetryableError() catches for retry.
 */
function createTimeoutSignal(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/** Network-related TypeError message patterns that indicate transient failures */
const NETWORK_TYPE_ERROR_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'networkerror',
  'network request failed',
  'load failed',
];

/** Patterns indicating a duplicate transaction submission (previous attempt succeeded) */
const DUPLICATE_TX_PATTERNS = [
  'transaction already in block chain',
  'transaction already in mempool',
  'txn-already-in-mempool',
  'txn-already-known',
  'already known',
  'already exists',
  'tx already exists',
];

/**
 * Check if an error message indicates the transaction was already submitted
 * (meaning a previous retry attempt actually succeeded).
 */
export function isDuplicateTxError(message: string): boolean {
  const lower = message.toLowerCase();
  return DUPLICATE_TX_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Determine if an error is transient and should be retried.
 *
 * Retryable:
 *   - HttpError with 5xx status
 *   - TypeError with network-related message (fetch failures)
 *   - AbortError / DOMException (timeout)
 *   - Errors with ECONNREFUSED, ECONNRESET, ETIMEDOUT in message
 *
 * NOT retryable:
 *   - HttpError with 4xx status (bad request, not found, etc.)
 *   - TypeError from programming bugs (non-network messages)
 *   - RPC-level application errors (JSON error response)
 *   - Any other unknown error
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status >= 500;
  }

  if (error instanceof TypeError) {
    // Only retry network-related TypeErrors, not programming bugs
    const msg = error.message.toLowerCase();
    return NETWORK_TYPE_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
  }

  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return true;
  }

  if (error instanceof Error) {
    const msg = error.message;
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Execute an async function with retry and exponential backoff with jitter.
 *
 * Only retries on transient errors (5xx, network failures).
 * Non-retryable errors (4xx, application errors) throw immediately.
 * Jitter prevents thundering herd by randomizing delay in [50%, 100%) of base.
 *
 * @param fn - Async function to execute
 * @param opts - Retry options (maxRetries, baseDelayMs, name, delayFn, randomFn)
 * @returns Result of fn()
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const delay = opts.delayFn ?? defaultDelay;
  const random = opts.randomFn ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        break;
      }

      // Jitter: multiply by random factor in [0.5, 1.0) to prevent thundering herd
      const delayMs = Math.round(
        baseDelayMs * Math.pow(2, attempt) * (0.5 + random() * 0.5),
      );
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          operation: opts.name,
          error: errorMessage,
        },
        `Retrying ${opts.name} after transient error`,
      );

      await delay(delayMs);
    }
  }

  throw lastError;
}

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

async function rpcCall(
  rpcUrl: string, method: string, params: unknown[] = [], rpcAuth?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (rpcAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(rpcAuth).toString('base64')}`;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });

  const response = await fetch(rpcUrl, { method: 'POST', headers, body, signal: createTimeoutSignal() });

  if (!response.ok) {
    throw new HttpError(`RPC ${method} failed: HTTP ${response.status}`, response.status);
  }

  const json = (await response.json()) as { result?: unknown; error?: { message: string; code: number } };
  if (json.error) {
    throw new Error(`RPC ${method} error: ${json.error.message} (code ${json.error.code})`);
  }
  return json.result;
}

export class RpcUtxoProvider implements UtxoProvider {
  readonly name = 'Bitcoin Core RPC';
  constructor(private readonly config: RpcProviderConfig) {}

  async listUnspent(address: string): Promise<Utxo[]> {
    return retryWithBackoff(async () => {
      const rpcUtxos = (await rpcCall(this.config.rpcUrl, 'listunspent', [1, 9999999, [address]], this.config.rpcAuth)) as Array<{ txid: string; vout: number; amount: number; scriptPubKey: string }>;
      if (!rpcUtxos || rpcUtxos.length === 0) return [];
      const utxos: Utxo[] = [];
      for (const u of rpcUtxos) {
        const rawTxHex = (await rpcCall(this.config.rpcUrl, 'getrawtransaction', [u.txid, false], this.config.rpcAuth)) as string;
        utxos.push({ txid: u.txid, vout: u.vout, valueSats: Math.round(u.amount * 1e8), rawTxHex });
      }
      return utxos;
    }, { name: 'RpcUtxoProvider.listUnspent' });
  }

  async broadcastTx(txHex: string): Promise<BroadcastResult> {
    return retryWithBackoff(async () => {
      try {
        const txid = (await rpcCall(this.config.rpcUrl, 'sendrawtransaction', [txHex], this.config.rpcAuth)) as string;
        return { txid };
      } catch (error) {
        if (error instanceof Error && isDuplicateTxError(error.message)) {
          logger.info({ operation: 'RpcUtxoProvider.broadcastTx' }, 'Transaction already in mempool/chain — treating as success');
          return { txid: '' };
        }
        throw error;
      }
    }, { name: 'RpcUtxoProvider.broadcastTx' });
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return retryWithBackoff(async () => {
      const info = (await rpcCall(this.config.rpcUrl, 'getblockchaininfo', [], this.config.rpcAuth)) as { chain: string; blocks: number };
      return { chain: info.chain, blocks: info.blocks };
    }, { name: 'RpcUtxoProvider.getBlockchainInfo' });
  }

  async getRawTransaction(txid: string): Promise<RawTransaction> {
    return retryWithBackoff(async () => {
      return (await rpcCall(this.config.rpcUrl, 'getrawtransaction', [txid, true], this.config.rpcAuth)) as RawTransaction;
    }, { name: 'RpcUtxoProvider.getRawTransaction' });
  }

  async getBlockHeader(blockhash: string): Promise<BlockHeader> {
    return retryWithBackoff(async () => {
      return (await rpcCall(this.config.rpcUrl, 'getblockheader', [blockhash], this.config.rpcAuth)) as BlockHeader;
    }, { name: 'RpcUtxoProvider.getBlockHeader' });
  }
}

// ─── Mempool.space REST API Implementation ──────────────────────────────

export interface MempoolProviderConfig {
  baseUrl?: string;
}

const DEFAULT_MEMPOOL_TESTNET4_URL = 'https://mempool.space/testnet4/api';
const _DEFAULT_MEMPOOL_SIGNET_URL = 'https://mempool.space/signet/api';

export class MempoolUtxoProvider implements UtxoProvider {
  readonly name = 'Mempool.space REST API';
  private readonly baseUrl: string;

  constructor(config: MempoolProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_MEMPOOL_TESTNET4_URL).replace(/\/$/, '');
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/address/${address}/utxo`;
      const response = await fetch(url, { signal: createTimeoutSignal() });
      if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
      const mempoolUtxos = (await response.json()) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }>;
      const confirmed = mempoolUtxos.filter((u) => u.status.confirmed);
      if (confirmed.length === 0) return [];
      const utxos: Utxo[] = [];
      for (const u of confirmed) {
        const rawTxHex = await this.fetchRawTxHex(u.txid);
        utxos.push({ txid: u.txid, vout: u.vout, valueSats: u.value, rawTxHex });
      }
      return utxos;
    }, { name: 'MempoolUtxoProvider.listUnspent' });
  }

  async broadcastTx(txHex: string): Promise<BroadcastResult> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/tx`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex, signal: createTimeoutSignal() });
      if (!response.ok) {
        const errorText = await response.text();
        if (isDuplicateTxError(errorText)) {
          logger.info({ operation: 'MempoolUtxoProvider.broadcastTx', httpStatus: response.status }, 'Transaction already in mempool/chain — treating as success');
          return { txid: '' };
        }
        throw new HttpError(`Mempool API broadcast failed: HTTP ${response.status} — ${errorText}`, response.status);
      }
      const txid = (await response.text()).trim();
      return { txid };
    }, { name: 'MempoolUtxoProvider.broadcastTx' });
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return retryWithBackoff(async () => {
      const heightUrl = `${this.baseUrl}/blocks/tip/height`;
      const heightResp = await fetch(heightUrl, { signal: createTimeoutSignal() });
      if (!heightResp.ok) throw new HttpError(`Mempool API GET ${heightUrl} failed: HTTP ${heightResp.status}`, heightResp.status);
      const blocks = Number.parseInt(await heightResp.text(), 10);
      const isSignet = this.baseUrl.includes('/signet');
      const isTestnet4 = this.baseUrl.includes('/testnet4');
      const isTestnet = !isTestnet4 && this.baseUrl.includes('/testnet');
      return { chain: isSignet ? 'signet' : isTestnet4 ? 'testnet4' : isTestnet ? 'test' : 'main', blocks };
    }, { name: 'MempoolUtxoProvider.getBlockchainInfo' });
  }

  async getRawTransaction(txid: string): Promise<RawTransaction> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/tx/${txid}`;
      const response = await fetch(url, { signal: createTimeoutSignal() });
      if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
      const mempoolTx = (await response.json()) as { txid: string; status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number }; vout: Array<{ scriptpubkey: string; scriptpubkey_asm: string; value: number }> };
      return {
        txid: mempoolTx.txid,
        confirmations: mempoolTx.status.confirmed ? 1 : 0,
        blocktime: mempoolTx.status.block_time,
        blockhash: mempoolTx.status.block_hash,
        vout: mempoolTx.vout.map((v) => ({ scriptPubKey: { hex: v.scriptpubkey, asm: v.scriptpubkey_asm } })),
      };
    }, { name: 'MempoolUtxoProvider.getRawTransaction' });
  }

  async getBlockHeader(blockhash: string): Promise<BlockHeader> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/block/${blockhash}`;
      const response = await fetch(url, { signal: createTimeoutSignal() });
      if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
      const block = (await response.json()) as { height: number };
      return { height: block.height };
    }, { name: 'MempoolUtxoProvider.getBlockHeader' });
  }

  private async fetchRawTxHex(txid: string): Promise<string> {
    const url = `${this.baseUrl}/tx/${txid}/hex`;
    const response = await fetch(url, { signal: createTimeoutSignal() });
    if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
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

export function createUtxoProvider(factoryConfig: UtxoProviderFactoryConfig): UtxoProvider {
  if (factoryConfig.type === 'rpc') {
    if (!factoryConfig.rpcUrl) throw new Error('BITCOIN_RPC_URL is required for RPC UTXO provider');
    logger.info({ provider: 'rpc', rpcUrl: factoryConfig.rpcUrl }, 'Creating RPC UTXO provider');
    return new RpcUtxoProvider({ rpcUrl: factoryConfig.rpcUrl, rpcAuth: factoryConfig.rpcAuth });
  }
  if (factoryConfig.type === 'mempool') {
    const baseUrl = factoryConfig.mempoolApiUrl ?? DEFAULT_MEMPOOL_TESTNET4_URL;
    logger.info({ provider: 'mempool', baseUrl }, 'Creating Mempool.space UTXO provider');
    return new MempoolUtxoProvider({ baseUrl });
  }
  throw new Error(`Unknown UTXO provider type: ${factoryConfig.type}`);
}
