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
import { emitRpcFallback } from '../utils/sentry.js';
import { MEMPOOL_API_BASES, resolveMempoolApiBase } from '../utils/mempool-url.js';

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

// ─── RpcApplicationError ────────────────────────────────────────────────

/**
 * JSON-RPC application-level error — the `{error: {code, message}}` envelope
 * a Bitcoin Core-compatible endpoint returns when the METHOD failed (as
 * opposed to the transport). Definitive by classification: `isRetryableError`
 * returns false for it, because retrying `sendrawtransaction` on
 * `bad-txns-*` / `min relay fee not met` / `Not all transactions found`
 * cannot succeed.
 *
 * S3-C2 review #1408-Finding-1: Bitcoin-Core-faithful endpoints wrap EVERY
 * RPC_* application error in an HTTP 500 (`HTTP_INTERNAL_SERVER_ERROR`), so
 * the envelope can arrive on a non-OK response. `httpStatus` preserves that
 * transport status as metadata; the application error is the real failure.
 */
export class RpcApplicationError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code (e.g. -5 RPC_INVALID_ADDRESS_OR_KEY, -27 RPC_VERIFY_ALREADY_IN_CHAIN) */
    public readonly code?: number,
    /** HTTP transport status the envelope arrived on (500 on Core-faithful endpoints) */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RpcApplicationError';
  }
}

/**
 * A transaction lookup is affirmative absence only when the provider returned
 * its native not-found verdict. Authentication, quota, transport, timeout,
 * malformed-response, and every other failure remain ambiguous.
 */
export function isDefinitiveTransactionAbsence(error: unknown): boolean {
  if (error instanceof RpcApplicationError) return error.code === -5;
  if (error instanceof HttpError) return error.status === 404;
  return false;
}

// ─── BroadcastRejectedError ─────────────────────────────────────────────

/**
 * A DEFINITIVE broadcast rejection: the node/API examined the transaction and
 * refused mempool admission (dust, min-relay-fee, bad-txns-*, non-final, …).
 * The signed bytes provably never relayed, so — and ONLY so — is it safe to
 * unwind a persisted broadcast intent (refund + delete proof rows + revert to
 * PENDING).
 *
 * #1417-HIGH (double-broadcast): the intent unwind previously keyed off
 * `!isRetryableError(err)`, which lumped auth (401), quota (402 — GetBlock at
 * the 3am drain), not-found (404), and unknown errors in with genuine rejects.
 * A 402/401 on a tx that had ALREADY broadcast then unwound it → the next tick
 * re-claimed and broadcast a SECOND, DIFFERENT mainnet tx while the first was
 * live. This typed error, thrown ONLY for a real mempool reject, is the sole
 * unwind trigger; everything else DEFERS (row stays BROADCASTING + intent).
 */
export class BroadcastRejectedError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code when the reject came from an RPC endpoint. */
    public readonly code?: number,
    /** HTTP status when the reject came from a REST endpoint (e.g. mempool.space 400). */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BroadcastRejectedError';
  }
}

/**
 * Explicit mempool/relay reject strings. These are the node's own verdict text
 * for a tx it examined and refused — a DEFINITIVE reject, distinct from a
 * transport/auth/quota failure that never got a verdict. Deliberately DOES NOT
 * include duplicate-tx phrases (those mean a prior broadcast SUCCEEDED — see
 * DUPLICATE_TX_PATTERNS) nor generic HTTP status text.
 */
const BROADCAST_REJECT_PATTERNS = [
  'dust',
  'min relay fee not met',
  'mempool min fee not met',
  'insufficient fee',
  'insufficient priority',
  'absurdly-high-fee',
  'bad-txns',
  'non-mandatory-script-verify-flag',
  'mandatory-script-verify-flag-failed',
  'non-final',
  'non-bip68-final',
  'txn-mempool-conflict',
  'too-long-mempool-chain',
  'tx-size',
  'scriptsig-not-pushonly',
  'no-witness-data',
  'bad-witness-nonstandard',
];
// NOTE: deliberately conservative. Over-broad tokens ('version', 'rejected',
// bare 'scriptpubkey') were EXCLUDED — the HIGH is about never over-unwinding,
// so a substring that could appear in a non-reject proxy/error message must not
// trigger the intent unwind. A real reject that slips this net simply DEFERS to
// reconcile (safe), never double-broadcasts.

/**
 * Does this text carry an explicit mempool/relay rejection verdict (as opposed
 * to a transport/auth/quota failure)? Used to type the REST-provider reject
 * path and, defensively, to classify plain Errors carrying the reject text.
 */
export function isBroadcastRejectText(message: string): boolean {
  const lower = message.toLowerCase();
  // A duplicate is a prior SUCCESS, never a reject — guard against overlap.
  if (isDuplicateTxError(lower)) return false;
  return BROADCAST_REJECT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * The double-broadcast unwind gate. TRUE only for a DEFINITIVE broadcast
 * rejection; every auth/quota/transport/timeout/unknown error returns FALSE so
 * the caller DEFERS (never unwinds a possibly-live tx). #1417-HIGH.
 *
 *   BroadcastRejectedError                          → true (typed)
 *   RpcApplicationError (JSON-RPC method verdict)   → true (node refused the method)
 *   Error whose message is explicit reject text     → true (REST reject not yet typed)
 *   HttpError (401/402/404/5xx), timeouts, unknown  → false → DEFER
 */
export function isBroadcastRejectedError(error: unknown): boolean {
  if (error instanceof BroadcastRejectedError) return true;
  // A JSON-RPC application error from sendrawtransaction is the node's
  // method-level verdict — a definitive reject, regardless of HTTP wrapping.
  if (error instanceof RpcApplicationError) return true;
  // Transport-class failures (HttpError, AbortError, network TypeErrors) are
  // NEVER a broadcast verdict — the node may never have seen the tx. DEFER.
  if (error instanceof HttpError) return false;
  // A plain Error can still carry explicit reject text (REST paths that haven't
  // been retyped); only the reject-text set counts, never generic messages.
  if (error instanceof Error) return isBroadcastRejectText(error.message);
  return false;
}

// ─── Retry with Exponential Backoff ─────────────────────────────────────

interface RetryOptions {
  /**
   * Max number of retries after the initial attempt. Sanitized (S3-C2): floored
   * to an integer and clamped to [0, HARD_MAX_RETRIES]; NaN falls back to the
   * default. No caller can configure an unbounded retry loop.
   */
  maxRetries?: number;
  /**
   * Base delay in ms (doubles each retry with jitter). Sanitized (S3-C2):
   * non-finite or non-positive values fall back to the default.
   */
  baseDelayMs?: number;
  /** Operation name for structured logging */
  name: string;
  /** Injectable delay function for testability */
  delayFn?: (ms: number) => Promise<void>;
  /** Injectable random function for testability (returns 0-1) */
  randomFn?: () => number;
}

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * S3-C2: hard upper bound on retries. `retryWithBackoff` clamps every caller's
 * `maxRetries` to this, so EVERY retry path reaches a terminal state (success
 * or throw) in at most `1 + HARD_MAX_RETRIES` attempts — even if a caller
 * passes `Infinity`.
 */
export const HARD_MAX_RETRIES = 8;

/**
 * S3-C2: upper bound on a single backoff delay (pre-jitter). Exponential
 * growth is capped here so a high base delay + high retry count cannot stall
 * an operation for minutes per attempt.
 */
export const MAX_BACKOFF_DELAY_MS = 30_000;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

/** Clamp maxRetries to [0, HARD_MAX_RETRIES]; NaN/undefined → default. */
function sanitizeMaxRetries(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return DEFAULT_MAX_RETRIES;
  return Math.min(Math.max(Math.floor(value), 0), HARD_MAX_RETRIES);
}

/** Non-finite or non-positive baseDelayMs → default. */
function sanitizeBaseDelayMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_BASE_DELAY_MS;
  return value;
}

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
 *   - HttpError 429 (rate limit — transient by definition, S3-C2)
 *   - TypeError with network-related message (fetch failures)
 *   - AbortError / DOMException (timeout)
 *   - Errors with ECONNREFUSED, ECONNRESET, ETIMEDOUT in message
 *
 * NOT retryable:
 *   - HttpError with any other 4xx status (bad request, not found, etc.)
 *   - TypeError from programming bugs (non-network messages)
 *   - RPC-level application errors (JSON error response)
 *   - Any other unknown error
 */
export function isRetryableError(error: unknown): boolean {
  // JSON-RPC application error = the METHOD definitively failed (regardless
  // of the HTTP status it was wrapped in — #1408-Finding-1). Never retryable:
  // resubmitting the same call cannot change a definitive verdict.
  if (error instanceof RpcApplicationError) {
    return false;
  }

  // A definitive broadcast rejection is likewise never retryable — the node
  // examined the tx and refused it (#1417-HIGH).
  if (error instanceof BroadcastRejectedError) {
    return false;
  }

  if (error instanceof HttpError) {
    // 5xx = server-side transient. 429 = rate limit — transient by definition
    // (S3-C2); backoff-and-retry is exactly the right response to it.
    return error.status >= 500 || error.status === 429;
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
  const maxRetries = sanitizeMaxRetries(opts.maxRetries);
  const baseDelayMs = sanitizeBaseDelayMs(opts.baseDelayMs);
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

      // Exponential growth capped at MAX_BACKOFF_DELAY_MS (S3-C2), THEN
      // jitter: multiply by random factor in [0.5, 1.0) to prevent thundering
      // herd. Jitter only ever shortens the capped delay.
      const delayMs = Math.round(
        Math.min(baseDelayMs * Math.pow(2, attempt), MAX_BACKOFF_DELAY_MS) *
          (0.5 + random() * 0.5),
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
  /** Full raw transaction hex (legacy P2PKH only — unused by P2WPKH signing) */
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
  /**
   * PROOF-03 (SCRUM-2336): get the RAW 80-byte block header (160-hex) for a
   * block hash. Optional — providers that can't supply it (e.g. a plain
   * mempool REST provider without the endpoint) omit it and the
   * confirmation-proof fetch degrades to `pending`.
   */
  getBlockHeaderHex?(blockhash: string): Promise<string>;
  /**
   * PROOF-03 (SCRUM-2336): get the Bitcoin Merkle inclusion proof for one or
   * more txids within a block (`gettxoutproof`). Returns the serialized
   * `CMerkleBlock` hex (header + partial merkle tree). Optional for the same
   * reason as `getBlockHeaderHex`.
   */
  getTxOutProof?(txids: string[], blockhash?: string): Promise<string>;
  /**
   * BUG-2026-06-24-004: Fetch the transaction HISTORY for an address (confirmed
   * + mempool), most-recent first. Unlike `listUnspent`, this surfaces fully-spent
   * transactions — anchor TXs whose value-0 OP_RETURN output and change have both
   * been spent by later anchors never appear in the UTXO set, so verification must
   * walk history to find them. Optional: providers without an address index (e.g.
   * a bare Bitcoin Core RPC node) may omit it; callers fall back to the UTXO scan.
   */
  getAddressTxs?(address: string): Promise<RawTransaction[]>;
  /** Provider display name for logging */
  readonly name: string;
}

/**
 * The slice of {@link UtxoProvider} that {@link fetchConfirmationProof} needs:
 * a tx lookup plus the two optional inclusion-proof methods. Lets the
 * confirmation-proof module depend on a narrow interface (and the test mocks
 * stay small) without pulling in the whole UTXO/broadcast surface.
 */
export interface ConfirmationProofProvider {
  getRawTransaction(txid: string): Promise<RawTransaction>;
  getBlockHeaderHex?(blockhash: string): Promise<string>;
  getTxOutProof?(txids: string[], blockhash?: string): Promise<string>;
}

// ─── Bitcoin Core RPC Implementation ────────────────────────────────────

export interface RpcProviderConfig {
  rpcUrl: string;
  rpcAuth?: string;
}

/**
 * Best-effort extraction of a JSON-RPC `{error}` envelope from a non-OK
 * response body (#1408-Finding-1). Returns null when the body is missing,
 * unreadable, non-JSON, or carries no error object — the caller then falls
 * back to the bare (retryable-if-5xx) HttpError, so the fail-safe transient
 * classification is unchanged for genuinely broken responses.
 */
async function tryParseRpcErrorBody(
  response: { text?: () => Promise<string> },
): Promise<{ message: string; code?: number } | null> {
  try {
    if (typeof response.text !== 'function') return null;
    const parsed = JSON.parse(await response.text()) as {
      error?: { message?: unknown; code?: unknown } | null;
    };
    if (
      parsed !== null && typeof parsed === 'object' &&
      parsed.error != null && typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string'
    ) {
      return {
        message: parsed.error.message,
        code: typeof parsed.error.code === 'number' ? parsed.error.code : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
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
    // #1408-Finding-1: Bitcoin-Core-faithful endpoints wrap JSON-RPC
    // application errors in HTTP 500. Parse the body FIRST — if it carries an
    // `{error}` envelope, the application error is the real (definitive)
    // failure and must reach the transient-vs-definitive classifier and
    // isDuplicateTxError. Only a body with no parseable envelope stays a bare
    // HttpError (retryable on 5xx — fail-safe unchanged).
    const appError = await tryParseRpcErrorBody(response);
    if (appError) {
      throw new RpcApplicationError(
        `RPC ${method} error: ${appError.message} (code ${appError.code ?? 'unknown'}) [HTTP ${response.status}]`,
        appError.code,
        response.status,
      );
    }
    throw new HttpError(`RPC ${method} failed: HTTP ${response.status}`, response.status);
  }

  const json = (await response.json()) as { result?: unknown; error?: { message: string; code: number } };
  if (json.error) {
    throw new RpcApplicationError(
      `RPC ${method} error: ${json.error.message} (code ${json.error.code})`,
      json.error.code,
      response.status,
    );
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

  /** PROOF-03: raw 80-byte header via `getblockheader <hash> false`. */
  async getBlockHeaderHex(blockhash: string): Promise<string> {
    return retryWithBackoff(async () => {
      return (await rpcCall(this.config.rpcUrl, 'getblockheader', [blockhash, false], this.config.rpcAuth)) as string;
    }, { name: 'RpcUtxoProvider.getBlockHeaderHex' });
  }

  /** PROOF-03: Merkle inclusion proof via `gettxoutproof [txids] (blockhash)`. */
  async getTxOutProof(txids: string[], blockhash?: string): Promise<string> {
    return retryWithBackoff(async () => {
      const params: unknown[] = blockhash ? [txids, blockhash] : [txids];
      return (await rpcCall(this.config.rpcUrl, 'gettxoutproof', params, this.config.rpcAuth)) as string;
    }, { name: 'RpcUtxoProvider.getTxOutProof' });
  }
}

// ─── Mempool.space REST API Implementation ──────────────────────────────

export interface MempoolProviderConfig {
  baseUrl?: string;
}

/**
 * Per-network bases now come from the shared map in `utils/mempool-url.ts`
 * (BUG-2026-08-11). This module used to keep a private copy; the duplicate
 * is what let `chain/fee-estimator.ts` and `jobs/treasury-cache.ts` drift
 * onto a mainnet-only default while this file was already per-network.
 *
 * NOTE: the alias is deliberately NOT `mempoolApiBaseForNetwork()` at every
 * use below. That helper falls back to MAINNET for an unset network, but two
 * of the three sites here default to **testnet4** instead, and silently
 * flipping an unset-network deployment onto mainnet is the very bug class
 * this change exists to close. Shared values, per-site defaults.
 */
const MEMPOOL_URLS = MEMPOOL_API_BASES;

export class MempoolUtxoProvider implements UtxoProvider {
  readonly name = 'Mempool.space REST API';
  private readonly baseUrl: string;

  constructor(config: MempoolProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? MEMPOOL_URLS.testnet4).replace(/\/$/, '');
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/address/${address}/utxo`;
      const response = await fetch(url, { signal: createTimeoutSignal() });
      if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
      const mempoolUtxos = (await response.json()) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }>;
      // Include all UTXOs (confirmed + unconfirmed) on all networks.
      // Our own change outputs are safe to spend unconfirmed (child-pays-for-parent).
      // This prevents the treasury from getting stuck waiting for confirmations between batches.
      const spendable = mempoolUtxos;
      if (spendable.length === 0) return [];
      // P2WPKH signing uses witnessUtxo (script + value), not rawTxHex.
      // Skip the extra HTTP call per UTXO — rawTxHex is only needed for legacy P2PKH (nonWitnessUtxo).
      return spendable.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: u.value, rawTxHex: '' }));
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
        // #1417-HIGH: an explicit relay/mempool reject verdict is DEFINITIVE —
        // type it so the intent unwind can fire safely. A bare non-OK with no
        // reject text (auth 401 / quota 402 / transport 5xx) stays an HttpError,
        // which the unwind gate DEFERS (the tx may still be live).
        if (isBroadcastRejectText(errorText)) {
          throw new BroadcastRejectedError(
            `Mempool API broadcast rejected: HTTP ${response.status} — ${errorText}`,
            undefined,
            response.status,
          );
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

  /**
   * PROOF-03 documented fallback: mempool.space serves the raw 80-byte header
   * at `/block/:hash/header` (160-hex text). Default source is GetBlock RPC;
   * this exists so a mempool-only deployment can still fetch the header.
   */
  async getBlockHeaderHex(blockhash: string): Promise<string> {
    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/block/${blockhash}/header`;
      const response = await fetch(url, { signal: createTimeoutSignal() });
      if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
      return (await response.text()).trim();
    }, { name: 'MempoolUtxoProvider.getBlockHeaderHex' });
  }

  // NOTE: mempool.space has NO `gettxoutproof`-equivalent that returns the
  // serialized CMerkleBlock format `parseTxOutProof` expects (its
  // `/tx/:txid/merkle-proof` returns a different JSON shape — block_height,
  // merkle[], pos). We deliberately do NOT implement `getTxOutProof` here:
  // the confirmation-proof fetch then reports `pending` for a mempool-only
  // provider rather than fabricating an unverifiable branch (§1.5). GetBlock
  // RPC is the supported inclusion-proof source (DISC-03).

  /**
   * BUG-2026-06-24-004: Address transaction history (confirmed + mempool), PAGINATED.
   * mempool.space `/address/:addr/txs` returns mempool txs + the most-recent 25
   * confirmed, newest first; `/address/:addr/txs/chain/:last_txid` walks 25 older
   * confirmed txs at a time. A single page misses fully-spent anchors older than
   * the first page (review P2 / false-negative hole for aged anchors), so we follow
   * the confirmed chain until history is exhausted — bounded by `MAX_HISTORY_TXS`
   * so a large treasury address can't unbound the scan (DoS/latency guard).
   */
  async getAddressTxs(address: string): Promise<RawTransaction[]> {
    const MAX_HISTORY_TXS = 500; // ~20 confirmed pages; bounded cap
    type MempoolTx = {
      txid: string;
      status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
      vout: Array<{ scriptpubkey: string; scriptpubkey_asm: string; value: number }>;
    };
    const toRaw = (t: MempoolTx): RawTransaction => ({
      txid: t.txid,
      confirmations: t.status.confirmed ? 1 : 0,
      blocktime: t.status.block_time,
      blockhash: t.status.block_hash,
      vout: t.vout.map((v) => ({ scriptPubKey: { hex: v.scriptpubkey, asm: v.scriptpubkey_asm } })),
    });
    const fetchPage = (url: string): Promise<MempoolTx[]> =>
      retryWithBackoff(async () => {
        const response = await fetch(url, { signal: createTimeoutSignal() });
        if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
        return (await response.json()) as MempoolTx[];
      }, { name: 'MempoolUtxoProvider.getAddressTxs' });

    // First page: mempool + most-recent 25 confirmed (newest first).
    const first = await fetchPage(`${this.baseUrl}/address/${address}/txs`);
    const out: RawTransaction[] = first.map(toRaw);
    // Oldest confirmed txid in a newest-first page is the pagination cursor.
    const oldestConfirmed = (page: MempoolTx[]): string | undefined =>
      [...page].reverse().find((t) => t.status.confirmed)?.txid;
    let cursor = oldestConfirmed(first);
    while (cursor && out.length < MAX_HISTORY_TXS) {
      const page = await fetchPage(`${this.baseUrl}/address/${address}/txs/chain/${cursor}`);
      if (page.length === 0) break;
      out.push(...page.map(toRaw));
      cursor = oldestConfirmed(page);
    }
    return out;
  }


  private async fetchRawTxHex(txid: string): Promise<string> {
    const url = `${this.baseUrl}/tx/${txid}/hex`;
    const response = await fetch(url, { signal: createTimeoutSignal() });
    if (!response.ok) throw new HttpError(`Mempool API GET ${url} failed: HTTP ${response.status}`, response.status);
    return (await response.text()).trim();
  }
}

// ─── GetBlock Hybrid Provider ────────────────────────────────────────────
// Uses mempool.space for UTXO listing (read-only public data) but routes
// broadcasting and RPC queries through a dedicated GetBlock Bitcoin Core node.
// This ensures transaction broadcasting goes through our own node rather than
// public mempool.space infrastructure.

export class GetBlockHybridProvider implements UtxoProvider {
  readonly name = 'GetBlock Hybrid (RPC broadcast + Mempool UTXO)';
  private readonly mempool: MempoolUtxoProvider;
  private readonly rpcUrl: string;
  private readonly rpcAuth?: string;

  constructor(config: { rpcUrl: string; rpcAuth?: string; mempoolBaseUrl?: string }) {
    this.rpcUrl = config.rpcUrl;
    this.rpcAuth = config.rpcAuth;
    this.mempool = new MempoolUtxoProvider({ baseUrl: config.mempoolBaseUrl ?? MEMPOOL_URLS.mainnet });
  }

  /** Try RPC node for UTXO listing first, fall back to mempool.space */
  async listUnspent(address: string): Promise<Utxo[]> {
    try {
      const rpcUtxos = (await rpcCall(this.rpcUrl, 'listunspent', [1, 9999999, [address]], this.rpcAuth)) as Array<{ txid: string; vout: number; amount: number }>;
      if (rpcUtxos && rpcUtxos.length >= 0) {
        return rpcUtxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueSats: Math.round(u.amount * 1e8),
          rawTxHex: '',
        }));
      }
    } catch (err) {
      // SCRUM-1262 (R1-8): per the GetBlock RPC matrix, the shared endpoint
      // returns "Method not allowed" on listunspent (forensic 1/8). Falls
      // back to public mempool.space — partial sovereignty leak. The
      // counter below feeds the R0-8 / SCRUM-1254 db-health-monitor view
      // so we can dashboard the fallback rate and alert if it stays at
      // 100% (i.e. the RPC is functionally unused). Sentry breadcrumb +
      // structured warn log (logger.warn is picked up by GCP Cloud Logging
      // sink and the Arize tracing exporter when enabled).
      // /simplify pass: pair extracted to emitRpcFallback() so future RPC
      // fallback sites (getrawtransaction / getblockheader / fee estimation)
      // emit the same locked shape.
      emitRpcFallback({
        provider: 'getblock',
        method: 'listunspent',
        error: err,
        fallbackTo: 'mempool.space',
        logger,
        origin: 'GetBlockHybridProvider.listUnspent',
      });
    }
    return this.mempool.listUnspent(address);
  }

  /** Broadcast through dedicated GetBlock RPC node */
  async broadcastTx(txHex: string): Promise<BroadcastResult> {
    return retryWithBackoff(async () => {
      try {
        const txid = (await rpcCall(this.rpcUrl, 'sendrawtransaction', [txHex], this.rpcAuth)) as string;
        return { txid };
      } catch (error) {
        if (error instanceof Error && isDuplicateTxError(error.message)) {
          logger.info({ operation: 'GetBlockHybridProvider.broadcastTx' }, 'Transaction already in mempool/chain — treating as success');
          return { txid: '' };
        }
        throw error;
      }
    }, { name: 'GetBlockHybridProvider.broadcastTx' });
  }

  /** Use RPC for blockchain info */
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return retryWithBackoff(async () => {
      const info = (await rpcCall(this.rpcUrl, 'getblockchaininfo', [], this.rpcAuth)) as { chain: string; blocks: number };
      return { chain: info.chain, blocks: info.blocks };
    }, { name: 'GetBlockHybridProvider.getBlockchainInfo' });
  }

  /**
   * Receipt recovery uses a two-source absence quorum. A hit from either the
   * dedicated GetBlock node or independent mempool.space is authoritative.
   * Absence is surfaced only when BOTH sources return their native not-found
   * verdict; any outage/disagreement throws so the journal recovery HOLDs.
   */
  async getRawTransaction(txid: string): Promise<RawTransaction> {
    let rpcError: unknown;
    try {
      return await retryWithBackoff(async () => {
        return (await rpcCall(this.rpcUrl, 'getrawtransaction', [txid, true], this.rpcAuth)) as RawTransaction;
      }, { name: 'GetBlockHybridProvider.getRawTransaction.rpc' });
    } catch (error) {
      rpcError = error;
      emitRpcFallback({
        provider: 'getblock',
        method: 'getrawtransaction',
        error,
        fallbackTo: 'mempool.space',
        logger,
        origin: 'GetBlockHybridProvider.getRawTransaction',
      });
    }

    try {
      return await this.mempool.getRawTransaction(txid);
    } catch (mempoolError) {
      const rpcAbsent = isDefinitiveTransactionAbsence(rpcError);
      const mempoolAbsent = isDefinitiveTransactionAbsence(mempoolError);
      if (rpcAbsent && mempoolAbsent) {
        // Preserve the RPC -5 type so BitcoinChainClient can map the unanimous
        // verdict to null. No single-source miss reaches that branch.
        throw rpcError;
      }
      // One source was unavailable/ambiguous. Preserve that error rather than
      // allowing the other source's not-found response to authorize REVERT.
      if (!rpcAbsent) throw rpcError;
      throw mempoolError;
    }
  }

  /** Use RPC for block header lookup */
  async getBlockHeader(blockhash: string): Promise<BlockHeader> {
    return retryWithBackoff(async () => {
      return (await rpcCall(this.rpcUrl, 'getblockheader', [blockhash], this.rpcAuth)) as BlockHeader;
    }, { name: 'GetBlockHybridProvider.getBlockHeader' });
  }

  /**
   * PROOF-03 (SCRUM-2336): raw 80-byte header via GetBlock RPC
   * `getblockheader <hash> false`. GetBlock is the sovereign inclusion-proof
   * source (DISC-03) — same node as broadcast.
   */
  async getBlockHeaderHex(blockhash: string): Promise<string> {
    return retryWithBackoff(async () => {
      return (await rpcCall(this.rpcUrl, 'getblockheader', [blockhash, false], this.rpcAuth)) as string;
    }, { name: 'GetBlockHybridProvider.getBlockHeaderHex' });
  }

  /**
   * PROOF-03 (SCRUM-2336): Merkle inclusion proof via GetBlock RPC
   * `gettxoutproof [txids] (blockhash)`. Passing the blockhash pins the proof
   * to the exact block, so a reorged-out tx fails loudly rather than resolving
   * against a different block.
   */
  async getTxOutProof(txids: string[], blockhash?: string): Promise<string> {
    return retryWithBackoff(async () => {
      const params: unknown[] = blockhash ? [txids, blockhash] : [txids];
      return (await rpcCall(this.rpcUrl, 'gettxoutproof', params, this.rpcAuth)) as string;
    }, { name: 'GetBlockHybridProvider.getTxOutProof' });
  }

  /**
   * BUG-2026-06-24-004: Address transaction history.
   * The shared GetBlock RPC endpoint exposes no address index (same matrix as
   * the `listUnspent` "Method not allowed" forensic), so history is served via
   * public mempool.space — the same already-accepted partial-sovereignty leak as
   * UTXO listing. Needed so verification can find fully-spent historical anchors.
   */
  async getAddressTxs(address: string): Promise<RawTransaction[]> {
    return this.mempool.getAddressTxs(address);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

export type UtxoProviderType = 'rpc' | 'mempool' | 'getblock';

export interface UtxoProviderFactoryConfig {
  type: UtxoProviderType;
  rpcUrl?: string;
  rpcAuth?: string;
  mempoolApiUrl?: string;
  network?: string;
}

export function createUtxoProvider(factoryConfig: UtxoProviderFactoryConfig): UtxoProvider {
  if (factoryConfig.type === 'rpc') {
    if (!factoryConfig.rpcUrl) throw new Error('BITCOIN_RPC_URL is required for RPC UTXO provider');
    logger.info({ provider: 'rpc', rpcUrl: factoryConfig.rpcUrl }, 'Creating RPC UTXO provider');
    return new RpcUtxoProvider({ rpcUrl: factoryConfig.rpcUrl, rpcAuth: factoryConfig.rpcAuth });
  }
  if (factoryConfig.type === 'getblock') {
    if (!factoryConfig.rpcUrl) throw new Error('BITCOIN_RPC_URL is required for GetBlock hybrid provider');
    // SCRUM-3016: MEMPOOL_URLS entries all include /api — this provider's
    // mempool fallback builds requests as `${baseUrl}/address/...`, `${baseUrl}/tx`,
    // never appending /api itself, so an operator-set MEMPOOL_API_URL must
    // resolve to that same "with /api" shape regardless of which convention
    // they used (see mempool-url.ts).
    const mempoolBaseUrl = resolveMempoolApiBase(
      factoryConfig.mempoolApiUrl,
      MEMPOOL_URLS[factoryConfig.network ?? 'mainnet'] ?? MEMPOOL_URLS.mainnet,
    );
    logger.info({ provider: 'getblock', rpcUrl: factoryConfig.rpcUrl, mempoolBaseUrl }, 'Creating GetBlock hybrid UTXO provider');
    return new GetBlockHybridProvider({ rpcUrl: factoryConfig.rpcUrl, rpcAuth: factoryConfig.rpcAuth, mempoolBaseUrl });
  }
  if (factoryConfig.type === 'mempool') {
    const baseUrl = resolveMempoolApiBase(
      factoryConfig.mempoolApiUrl,
      MEMPOOL_URLS[factoryConfig.network ?? 'testnet4'] ?? MEMPOOL_URLS.testnet4,
    );
    logger.info({ provider: 'mempool', baseUrl }, 'Creating Mempool.space UTXO provider');
    return new MempoolUtxoProvider({ baseUrl });
  }
  throw new Error(`Unknown UTXO provider type: ${factoryConfig.type}`);
}
