/**
 * Mock Chain Client
 *
 * Mock implementation for testing. Per Constitution, mocks are
 * enforced for Stripe and chain APIs in test environments.
 */

import { createHash } from 'node:crypto';
import type {
  ChainClient,
  ChainReceipt,
  PreparedChainTx,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';
import { logger } from '../utils/logger.js';

// In-memory store for mock receipts
const mockReceipts = new Map<string, ChainReceipt>();
const fingerprintToReceipt = new Map<string, string>();

// S3-P0: prepared (signed-but-not-broadcast) mock txs, keyed by tx hex, so
// broadcastSignedTx can resolve the fingerprint the "signed bytes" commit.
const preparedByHex = new Map<string, { txId: string; fingerprint: string }>();

let mockBlockHeight = 800000;

export class MockChainClient implements ChainClient {
  async submitFingerprint(data: SubmitFingerprintRequest): Promise<ChainReceipt> {
    logger.info({ fingerprint: data.fingerprint }, 'Mock: Submitting fingerprint');

    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    mockBlockHeight += 1;

    // DEMO-01: Compute metadata hash if metadata provided
    let metadataHash: string | undefined;
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      const sortedKeys = Object.keys(data.metadata).sort();
      const sorted: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        sorted[key] = data.metadata[key];
      }
      metadataHash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    }

    const receipt: ChainReceipt = {
      receiptId: `mock_receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      blockHeight: mockBlockHeight,
      blockTimestamp: new Date().toISOString(),
      confirmations: 6,
      metadataHash,
    };

    // Store for later verification
    mockReceipts.set(receipt.receiptId, receipt);
    fingerprintToReceipt.set(data.fingerprint, receipt.receiptId);

    logger.info({ receipt }, 'Mock: Fingerprint submitted successfully');

    return receipt;
  }

  async verifyFingerprint(fingerprint: string): Promise<VerificationResult> {
    logger.info({ fingerprint }, 'Mock: Verifying fingerprint');

    const receiptId = fingerprintToReceipt.get(fingerprint);

    if (!receiptId) {
      return {
        verified: false,
        error: 'Fingerprint not found on chain',
      };
    }

    const receipt = mockReceipts.get(receiptId);

    return {
      verified: true,
      receipt,
    };
  }

  async getReceipt(receiptId: string): Promise<ChainReceipt | null> {
    logger.info({ receiptId }, 'Mock: Getting receipt');
    return mockReceipts.get(receiptId) ?? null;
  }

  /**
   * S3-P0: mock prepare — deterministic per fingerprint (the real client's
   * txid is a pure function of the signed bytes; the mock mirrors that so
   * crash-resume tests and USE_MOCKS soak rigs exercise identical semantics).
   * Registers NOTHING on the mock chain — only broadcastSignedTx does.
   */
  async prepareFingerprintTx(data: SubmitFingerprintRequest): Promise<PreparedChainTx> {
    logger.info({ fingerprint: data.fingerprint }, 'Mock: Preparing fingerprint tx (no broadcast)');

    const txId = createHash('sha256')
      .update(`mock_prepared_tx:${data.fingerprint.toLowerCase()}`)
      .digest('hex');
    // Recognizable pseudo raw-tx hex: a mock marker + committed payload.
    const opReturnData = `41524b56${data.fingerprint.toLowerCase()}`; // "ARKV" + fingerprint
    const txHex = `f00dfeed${opReturnData}`;

    preparedByHex.set(txHex, { txId, fingerprint: data.fingerprint.toLowerCase() });

    return { txHex, txId, feeSats: 141, opReturnData };
  }

  /**
   * S3-P0: mock broadcast of previously-"signed" bytes. Idempotent: the same
   * hex always lands the same txId (already-known == success), matching the
   * provider-layer duplicate-tx semantics of the real client.
   */
  async broadcastSignedTx(txHex: string): Promise<ChainReceipt> {
    const prepared = preparedByHex.get(txHex);
    if (!prepared) {
      throw new Error('Mock: unknown signed tx hex — prepareFingerprintTx must produce it first');
    }

    const existing = mockReceipts.get(prepared.txId);
    if (existing) {
      logger.info({ txId: prepared.txId }, 'Mock: signed tx already known — idempotent success');
      return existing;
    }

    mockBlockHeight += 1;
    const receipt: ChainReceipt = {
      receiptId: prepared.txId,
      blockHeight: mockBlockHeight,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
      rawTxHex: txHex,
    };

    mockReceipts.set(receipt.receiptId, receipt);
    fingerprintToReceipt.set(prepared.fingerprint, receipt.receiptId);

    logger.info({ txId: prepared.txId }, 'Mock: signed tx broadcast');
    return receipt;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async hasFunds(): Promise<boolean> {
    return true;
  }
}

// Singleton instance
export const mockChainClient = new MockChainClient();
