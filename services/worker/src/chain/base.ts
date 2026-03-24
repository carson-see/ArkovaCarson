/**
 * Base L2 Chain Client
 *
 * Implementation of the ChainClient interface for Base (Ethereum L2).
 * Anchors document fingerprints by sending 0-value transactions with
 * calldata containing an ARKV prefix + SHA-256 fingerprint.
 *
 * Strategy: Self-referential calldata approach (similar to Bitcoin OP_RETURN).
 *   - Send 0 ETH to the treasury address itself
 *   - Calldata: 0x41524b56 ("ARKV") + fingerprint (32 bytes)
 *   - Optional metadata hash appended after fingerprint
 *
 * Supports:
 *   - Base Mainnet (chainId 8453)
 *   - Base Sepolia testnet (chainId 84532)
 *
 * Constitution refs:
 *   - 1.4: Treasury/signing keys server-side only, never logged
 *   - 1.6: generateFingerprint is client-side only — this file never imports it
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Hash,
  type TransactionReceipt,
  parseGwei,
  formatEther,
  hexToBytes,
  bytesToHex,
  toHex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type {
  ChainClient,
  ChainReceipt,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────

/** ARKV prefix as hex (4 bytes: 0x41524b56) */
const ARKV_PREFIX_HEX = '41524b56';
const ARKV_PREFIX_BYTES = new Uint8Array([0x41, 0x52, 0x4b, 0x56]);

/** Maximum retries for transient RPC failures */
const MAX_RETRIES = 3;

/** Base delay between retries in ms (exponential backoff) */
const RETRY_BASE_DELAY_MS = 1_000;

/** Confirmation polling interval in ms */
const CONFIRMATION_POLL_MS = 2_000;

/** Timeout for waiting for tx receipt (5 minutes) */
const RECEIPT_TIMEOUT_MS = 300_000;

/**
 * Truncated metadata hash length in bytes (appended after fingerprint in calldata).
 * Matches Bitcoin client's 8-byte default for consistency.
 */
const METADATA_HASH_TRUNCATED_BYTES = 8;

// ─── Configuration ───────────────────────────────────────────────────────

export interface BaseChainClientConfig {
  /** Private key for signing transactions (hex, with or without 0x prefix) — NEVER log */
  privateKey: `0x${string}`;
  /** Chain to use: 'base' for mainnet (8453) or 'base-sepolia' for testnet (84532) */
  network: 'base' | 'base-sepolia';
  /** Optional RPC URL override (defaults to public RPC for the chain) */
  rpcUrl?: string;
  /** Optional custom viem PublicClient (for testing / mock transport) */
  publicClient?: PublicClient;
  /** Optional custom viem WalletClient (for testing / mock transport) */
  walletClient?: WalletClient;
  /** Gas limit ceiling in gwei — reject if estimated gas price exceeds */
  maxGasPriceGwei?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Compute a canonical JSON representation of metadata for deterministic hashing.
 * Keys sorted alphabetically — matches Bitcoin client behavior.
 */
export function canonicalMetadataJson(metadata: Record<string, unknown>): string {
  const sortedKeys = Object.keys(metadata).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = metadata[key];
  }
  return JSON.stringify(sorted);
}

/**
 * SHA-256 hash of canonical metadata JSON.
 * Returns the full 64-char hex hash.
 */
export function hashMetadata(metadata: Record<string, unknown>): string {
  const canonical = canonicalMetadataJson(metadata);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build calldata for an anchor transaction.
 *
 * Format: ARKV (4 bytes) + fingerprint (32 bytes) + [metadataHash (8 bytes)]
 * Total: 36 bytes without metadata, 44 bytes with metadata
 *
 * @returns Hex-encoded calldata with 0x prefix
 */
export function buildAnchorCalldata(
  fingerprint: string,
  metadataHash?: string,
): `0x${string}` {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }

  let calldataHex = ARKV_PREFIX_HEX + fingerprint.toLowerCase();

  if (metadataHash) {
    if (!/^[a-f0-9]{64}$/i.test(metadataHash)) {
      throw new Error('Metadata hash must be a 64-character hex string (SHA-256)');
    }
    // Truncate to METADATA_HASH_TRUNCATED_BYTES (8 bytes = 16 hex chars)
    calldataHex += metadataHash.toLowerCase().slice(0, METADATA_HASH_TRUNCATED_BYTES * 2);
  }

  return `0x${calldataHex}`;
}

/**
 * Parse calldata to extract fingerprint and optional metadata hash.
 * Returns null if calldata doesn't match ARKV format.
 */
export function parseAnchorCalldata(calldata: string): {
  fingerprint: string;
  metadataHashTruncated?: string;
} | null {
  // Strip 0x prefix
  const hex = calldata.startsWith('0x') ? calldata.slice(2) : calldata;

  // Must start with ARKV prefix
  if (!hex.toLowerCase().startsWith(ARKV_PREFIX_HEX)) {
    return null;
  }

  const afterPrefix = hex.slice(ARKV_PREFIX_HEX.length);

  // Fingerprint is 64 hex chars (32 bytes)
  if (afterPrefix.length < 64) {
    return null;
  }

  const fingerprint = afterPrefix.slice(0, 64).toLowerCase();

  // Optional metadata hash (16 hex chars = 8 bytes)
  const remaining = afterPrefix.slice(64);
  const metadataHashTruncated = remaining.length >= METADATA_HASH_TRUNCATED_BYTES * 2
    ? remaining.slice(0, METADATA_HASH_TRUNCATED_BYTES * 2).toLowerCase()
    : undefined;

  return { fingerprint, metadataHashTruncated };
}

/**
 * Resolve the viem chain config from a network name.
 */
function resolveChain(network: 'base' | 'base-sepolia'): Chain {
  return network === 'base' ? base : baseSepolia;
}

/**
 * Sleep for exponential backoff retries.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retries and exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on validation errors, user errors, or not-found
      if (
        lastError.message.includes('insufficient funds') ||
        lastError.message.includes('nonce too low') ||
        lastError.message.includes('Fingerprint must be') ||
        lastError.message.includes('Metadata hash must be') ||
        lastError.message.includes('not found') ||
        lastError.message.includes('could not be found')
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { operation, attempt: attempt + 1, maxRetries, error: lastError.message, retryDelayMs: delay },
          `Retrying ${operation} after transient error`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastError!;
}

// ─── Base Chain Client ───────────────────────────────────────────────────

export class BaseChainClient implements ChainClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: PrivateKeyAccount;
  private readonly chain: Chain;
  private readonly networkName: 'base' | 'base-sepolia';
  private readonly maxGasPriceGwei?: number;

  constructor(clientConfig: BaseChainClientConfig) {
    this.networkName = clientConfig.network;
    this.chain = resolveChain(clientConfig.network);
    this.maxGasPriceGwei = clientConfig.maxGasPriceGwei;

    // Derive account from private key — NEVER log the key (Constitution 1.4)
    this.account = privateKeyToAccount(clientConfig.privateKey);

    // Use injected clients (for testing) or create real ones
    if (clientConfig.publicClient) {
      this.publicClient = clientConfig.publicClient;
    } else {
      const transport = http(clientConfig.rpcUrl);
      this.publicClient = createPublicClient({
        chain: this.chain,
        transport,
      });
    }

    if (clientConfig.walletClient) {
      this.walletClient = clientConfig.walletClient;
    } else {
      const transport = http(clientConfig.rpcUrl);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: this.chain,
        transport,
      });
    }

    // Log only the address, NEVER the private key (Constitution 1.4)
    logger.info(
      {
        address: this.account.address,
        chain: this.chain.name,
        chainId: this.chain.id,
        network: this.networkName,
      },
      'Base L2 chain client initialized',
    );
  }

  /**
   * Submit a fingerprint to be anchored on Base L2.
   *
   * Sends a 0-value transaction to self with ARKV-prefixed calldata.
   */
  async submitFingerprint(
    data: SubmitFingerprintRequest,
  ): Promise<ChainReceipt> {
    logger.info(
      { fingerprint: data.fingerprint, hasMetadata: !!data.metadata, chain: this.chain.name },
      'Submitting fingerprint to Base L2',
    );

    // 1. Compute metadata hash if metadata provided
    let fullMetadataHash: string | undefined;
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      fullMetadataHash = hashMetadata(data.metadata);
      logger.info(
        { metadataHash: fullMetadataHash },
        'Metadata hash computed for calldata',
      );
    }

    // 2. Build calldata
    const calldata = buildAnchorCalldata(data.fingerprint, fullMetadataHash);
    logger.debug({ calldataLength: calldata.length, calldata }, 'Anchor calldata built');

    // 3. Estimate gas and check fee ceiling
    const gasEstimate = await withRetry(
      async () => {
        const [gasLimit, gasPrice] = await Promise.all([
          this.publicClient.estimateGas({
            account: this.account,
            to: this.account.address,
            value: 0n,
            data: calldata,
          }),
          this.publicClient.getGasPrice(),
        ]);

        return { gasLimit, gasPrice };
      },
      'gas estimation',
    );

    const { gasLimit, gasPrice } = gasEstimate;
    const gasPriceGwei = Number(gasPrice) / 1e9;

    logger.debug(
      { gasLimit: gasLimit.toString(), gasPriceGwei, chain: this.chain.name },
      'Gas estimated for anchor transaction',
    );

    // Fee ceiling check
    if (this.maxGasPriceGwei && gasPriceGwei > this.maxGasPriceGwei) {
      throw new Error(
        `Gas price ${gasPriceGwei.toFixed(4)} gwei exceeds ceiling ${this.maxGasPriceGwei} gwei — anchor deferred`,
      );
    }

    // 4. Send transaction with retries
    const txHash = await withRetry(
      () => this.walletClient.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: this.account.address,
        value: 0n,
        data: calldata,
        gas: gasLimit,
      }),
      'send transaction',
    );

    logger.info(
      { txHash, fingerprint: data.fingerprint, chain: this.chain.name },
      'Anchor transaction sent to Base L2',
    );

    // 5. Wait for receipt
    const receipt = await withRetry(
      () => this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: RECEIPT_TIMEOUT_MS,
        pollingInterval: CONFIRMATION_POLL_MS,
      }),
      'wait for receipt',
    );

    if (receipt.status === 'reverted') {
      throw new Error(`Anchor transaction reverted: ${txHash}`);
    }

    // 6. Calculate fee in wei (store in feeSats field for interface compat)
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;

    logger.info(
      {
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        feeWei: feeWei.toString(),
        feeEth: formatEther(feeWei),
        fingerprint: data.fingerprint,
        metadataHash: fullMetadataHash,
      },
      'Fingerprint anchored on Base L2',
    );

    // 7. Get block for timestamp
    const block = await withRetry(
      () => this.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
      'get block',
    );

    return {
      receiptId: txHash,
      blockHeight: Number(receipt.blockNumber),
      blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      confirmations: 1, // Just confirmed
      metadataHash: fullMetadataHash,
      rawTxHex: calldata, // Store calldata as raw tx reference
      feeWei: feeWei.toString(), // EVM fee in wei — NOT satoshis; consumers must check chain type
    };
  }

  /**
   * Verify a fingerprint exists on Base L2 by checking a known transaction's calldata.
   *
   * NOTE: Unlike Bitcoin's UTXO scan, Base verification requires knowing the txHash.
   * For production, use the chain index (anchor_chain_index table) for O(1) lookup.
   * This method verifies a specific transaction if a receiptId-like fingerprint is provided,
   * or returns not-found if no index is available.
   */
  async verifyFingerprint(
    fingerprint: string,
  ): Promise<VerificationResult> {
    logger.info({ fingerprint, chain: this.chain.name }, 'Verifying fingerprint on Base L2');

    try {
      // On EVM chains, we cannot scan all transactions efficiently.
      // Verification should be done via the chain index (DB lookup).
      // If a txHash is stored, use getReceipt + calldata check.
      // For now, return not-verified with guidance to use getReceipt.
      return {
        verified: false,
        error: 'Base L2 verification requires transaction hash — use chain index for lookup, then getReceipt to verify calldata',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ fingerprint, error: message }, 'Base L2 verification failed');
      return {
        verified: false,
        error: `Verification error: ${message}`,
      };
    }
  }

  /**
   * Get receipt details by transaction hash.
   * Verifies the transaction contains ARKV-prefixed calldata.
   */
  async getReceipt(receiptId: string): Promise<ChainReceipt | null> {
    logger.info({ receiptId, chain: this.chain.name }, 'Getting receipt from Base L2');

    try {
      const txHash = receiptId as Hash;

      // Fetch both tx and receipt in parallel
      const [tx, receipt] = await Promise.all([
        withRetry(
          () => this.publicClient.getTransaction({ hash: txHash }),
          'get transaction',
        ),
        withRetry(
          () => this.publicClient.getTransactionReceipt({ hash: txHash }),
          'get transaction receipt',
        ),
      ]);

      if (!tx || !receipt) {
        logger.warn({ receiptId }, 'Transaction not found on Base L2');
        return null;
      }

      // Verify it's an ARKV anchor transaction
      const input = tx.input;
      const parsed = parseAnchorCalldata(input);
      if (!parsed) {
        logger.warn({ receiptId, input }, 'Transaction is not an ARKV anchor');
        return null;
      }

      // Get block for timestamp
      const block = await withRetry(
        () => this.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
        'get block',
      );

      // Get current block for confirmations
      const currentBlock = await withRetry(
        () => this.publicClient.getBlockNumber(),
        'get block number',
      );

      const confirmations = Number(currentBlock - receipt.blockNumber);
      const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;

      return {
        receiptId: txHash,
        blockHeight: Number(receipt.blockNumber),
        blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
        confirmations,
        metadataHash: parsed.metadataHashTruncated
          ? parsed.metadataHashTruncated
          : undefined,
        rawTxHex: input,
        feeWei: feeWei.toString(), // EVM fee in wei — NOT satoshis; consumers must check chain type
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ receiptId, error: message }, 'Failed to get receipt from Base L2');
      return null;
    }
  }

  /**
   * Verify a specific transaction contains a given fingerprint in its calldata.
   * This is the recommended verification path for Base L2:
   *   1. Look up txHash from chain index
   *   2. Call verifyTransaction(txHash, fingerprint) to confirm
   */
  async verifyTransaction(
    txHash: string,
    fingerprint: string,
  ): Promise<VerificationResult> {
    logger.info(
      { txHash, fingerprint, chain: this.chain.name },
      'Verifying transaction calldata on Base L2',
    );

    try {
      const tx = await withRetry(
        () => this.publicClient.getTransaction({ hash: txHash as Hash }),
        'get transaction',
      );

      if (!tx) {
        return {
          verified: false,
          error: 'Transaction not found',
        };
      }

      // Parse calldata
      const parsed = parseAnchorCalldata(tx.input);
      if (!parsed) {
        return {
          verified: false,
          error: 'Transaction is not an ARKV anchor',
        };
      }

      // Compare fingerprints
      if (parsed.fingerprint !== fingerprint.toLowerCase()) {
        return {
          verified: false,
          error: 'Fingerprint does not match transaction calldata',
        };
      }

      // Get receipt for block info
      const receipt = await this.getReceipt(txHash);
      if (!receipt) {
        return {
          verified: false,
          error: 'Transaction receipt not available',
        };
      }

      return {
        verified: true,
        receipt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ txHash, fingerprint, error: message }, 'Transaction verification failed');
      return {
        verified: false,
        error: `Verification error: ${message}`,
      };
    }
  }

  /**
   * Check Base L2 chain health by querying the latest block.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const [blockNumber, chainId] = await Promise.all([
        this.publicClient.getBlockNumber(),
        this.publicClient.getChainId(),
      ]);

      const isValid = chainId === this.chain.id;

      logger.info(
        {
          chainId,
          expectedChainId: this.chain.id,
          blockNumber: blockNumber.toString(),
          healthy: isValid,
          chain: this.chain.name,
        },
        'Base L2 health check',
      );

      return isValid;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, chain: this.chain.name }, 'Base L2 health check failed');
      return false;
    }
  }

  /**
   * Get the treasury address (derived from private key).
   * Public getter for diagnostics — safe to expose address, never key.
   */
  get treasuryAddress(): string {
    return this.account.address;
  }

  /**
   * Get the chain ID this client is configured for.
   */
  get chainId(): number {
    return this.chain.id;
  }
}
