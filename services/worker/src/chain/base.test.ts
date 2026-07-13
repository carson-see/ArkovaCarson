/**
 * Unit tests for BaseChainClient (Base L2)
 *
 * Tests use mocked viem transports — no real RPC calls.
 * Follows the same patterns as mock.test.ts and signet.test.ts.
 *
 * Per Constitution 1.7: Tests must not call real chain APIs — use mock interfaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (must come before imports) ─────────────────────────────

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'test',
    useMocks: true,
    logLevel: 'info',
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

// ─── Imports ─────────────────────────────────────────────────────────────

import {
  BaseChainClient,
  buildAnchorCalldata,
  parseAnchorCalldata,
  canonicalMetadataJson,
  hashMetadata,
  type BaseChainClientConfig,
} from './base.js';
import type { ChainClient, SubmitFingerprintRequest } from './types.js';

// ─── Test fixtures ───────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const TEST_FINGERPRINT = 'a'.repeat(64); // valid 64-char hex
const TEST_METADATA = { docType: 'contract', jurisdiction: 'US-DE' };
const TEST_TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_BLOCK_NUMBER = 12345678n;
const TEST_BLOCK_TIMESTAMP = 1700000000n;
const TEST_GAS_USED = 21500n;
const TEST_GAS_PRICE = 100000000n; // 0.1 gwei
const TEST_CHAIN_ID_SEPOLIA = 84532;
const TEST_CHAIN_ID_BASE = 8453;

// ─── Mock viem clients ──────────────────────────────────────────────────

function createMockPublicClient(overrides: Record<string, unknown> = {}) {
  return {
    estimateGas: vi.fn().mockResolvedValue(21500n),
    getGasPrice: vi.fn().mockResolvedValue(TEST_GAS_PRICE),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      blockNumber: TEST_BLOCK_NUMBER,
      gasUsed: TEST_GAS_USED,
      effectiveGasPrice: TEST_GAS_PRICE,
      transactionHash: TEST_TX_HASH,
    }),
    getBlock: vi.fn().mockResolvedValue({
      number: TEST_BLOCK_NUMBER,
      timestamp: TEST_BLOCK_TIMESTAMP,
    }),
    getBlockNumber: vi.fn().mockResolvedValue(TEST_BLOCK_NUMBER + 5n),
    getChainId: vi.fn().mockResolvedValue(TEST_CHAIN_ID_SEPOLIA),
    getTransaction: vi.fn().mockResolvedValue({
      hash: TEST_TX_HASH,
      input: buildAnchorCalldata(TEST_FINGERPRINT),
      blockNumber: TEST_BLOCK_NUMBER,
    }),
    getTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      blockNumber: TEST_BLOCK_NUMBER,
      gasUsed: TEST_GAS_USED,
      effectiveGasPrice: TEST_GAS_PRICE,
      transactionHash: TEST_TX_HASH,
    }),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockWalletClient() {
  return {
    sendTransaction: vi.fn().mockResolvedValue(TEST_TX_HASH),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createTestConfig(overrides: Partial<BaseChainClientConfig> = {}): BaseChainClientConfig {
  const publicClient = createMockPublicClient();
  const walletClient = createMockWalletClient();
  return {
    privateKey: TEST_PRIVATE_KEY,
    network: 'base-sepolia',
    publicClient,
    walletClient,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('BaseChainClient', () => {
  // ── Helper functions ──

  describe('buildAnchorCalldata', () => {
    it('builds correct calldata with fingerprint only', () => {
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT);
      expect(calldata).toBe(`0x41524b56${'a'.repeat(64)}`);
      expect(calldata.length).toBe(2 + 8 + 64); // 0x + ARKV(8hex) + fingerprint(64hex)
    });

    it('builds correct calldata with fingerprint and metadata hash', () => {
      const metadataHash = 'b'.repeat(64);
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT, metadataHash);
      // ARKV(8hex) + fingerprint(64hex) + truncated metadata(16hex)
      expect(calldata).toBe(`0x41524b56${'a'.repeat(64)}${'b'.repeat(16)}`);
      expect(calldata.length).toBe(2 + 8 + 64 + 16);
    });

    it('rejects invalid fingerprint (too short)', () => {
      expect(() => buildAnchorCalldata('abc123')).toThrow('Fingerprint must be a 64-character hex string');
    });

    it('rejects invalid fingerprint (not hex)', () => {
      expect(() => buildAnchorCalldata('g'.repeat(64))).toThrow('Fingerprint must be a 64-character hex string');
    });

    it('rejects invalid metadata hash', () => {
      expect(() => buildAnchorCalldata(TEST_FINGERPRINT, 'short')).toThrow('Metadata hash must be a 64-character hex string');
    });

    it('normalizes fingerprint to lowercase', () => {
      const upper = 'A'.repeat(64);
      const calldata = buildAnchorCalldata(upper);
      expect(calldata).toBe(`0x41524b56${'a'.repeat(64)}`);
    });
  });

  describe('parseAnchorCalldata', () => {
    it('parses calldata with fingerprint only', () => {
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT);
      const result = parseAnchorCalldata(calldata);
      expect(result).not.toBeNull();
      expect(result!.fingerprint).toBe(TEST_FINGERPRINT);
      expect(result!.metadataHashTruncated).toBeUndefined();
    });

    it('parses calldata with fingerprint and metadata hash', () => {
      const metadataHash = 'b'.repeat(64);
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT, metadataHash);
      const result = parseAnchorCalldata(calldata);
      expect(result).not.toBeNull();
      expect(result!.fingerprint).toBe(TEST_FINGERPRINT);
      expect(result!.metadataHashTruncated).toBe('b'.repeat(16));
    });

    it('returns null for non-ARKV calldata', () => {
      const result = parseAnchorCalldata('0xdeadbeef');
      expect(result).toBeNull();
    });

    it('returns null for empty calldata', () => {
      const result = parseAnchorCalldata('0x');
      expect(result).toBeNull();
    });

    it('returns null for calldata with ARKV prefix but too short', () => {
      const result = parseAnchorCalldata('0x41524b56' + 'aa'.repeat(10));
      expect(result).toBeNull();
    });

    it('handles calldata without 0x prefix', () => {
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT);
      const result = parseAnchorCalldata(calldata.slice(2)); // strip 0x
      expect(result).not.toBeNull();
      expect(result!.fingerprint).toBe(TEST_FINGERPRINT);
    });

    it('roundtrips correctly', () => {
      const metadataHash = 'c'.repeat(64);
      const calldata = buildAnchorCalldata(TEST_FINGERPRINT, metadataHash);
      const parsed = parseAnchorCalldata(calldata);
      expect(parsed!.fingerprint).toBe(TEST_FINGERPRINT);
      expect(parsed!.metadataHashTruncated).toBe('c'.repeat(16));
    });
  });

  // ── SCRUM-2591 canonical-decode CONTRACT (adversarial corpus) ──
  //
  // CONTRACT SPEC: parseAnchorCalldata is a CANONICAL decoder, not a loose
  // substring scan. Anchor calldata for the Base/EVM path is EXACTLY
  //   ARKV (4 bytes) + fingerprint (32 bytes)            → 36 bytes, or
  //   ARKV (4 bytes) + fingerprint (32) + metadataHash(8) → 44 bytes.
  // ANY other shape — trailing junk after the committed payload, a prefix that
  // begins at a non-zero offset, a truncated metadata region, an odd-length or
  // non-hex string — MUST decode to null. This mirrors the Bitcoin-side
  // structural-decode contract enforced by signet.ts:extractAnchorFingerprint
  // (BUG-2026-06-24-004): a payload that merely *contains* ARKV<fingerprint>
  // somewhere is NOT a canonical anchor and must be rejected.
  describe('parseAnchorCalldata — canonical-decode contract (SCRUM-2591)', () => {
    const ARKV = '41524b56';
    const FP = 'a'.repeat(64); // 32-byte fingerprint
    const META8 = 'b'.repeat(16); // 8-byte truncated metadata hash

    it('(a) rejects ARKV+fingerprint embedded as a substring with trailing junk', () => {
      // A canonical 36-byte payload with 1 extra trailing byte is NOT canonical.
      const withJunk = `0x${ARKV}${FP}ff`;
      expect(parseAnchorCalldata(withJunk)).toBeNull();
    });

    it('(a2) rejects a long buffer that merely CONTAINS ARKV+fingerprint after the committed region', () => {
      // 44-byte canonical (36 + 8 metadata) followed by another full ARKV+fp.
      const embedded = `0x${ARKV}${FP}${META8}${ARKV}${FP}`;
      expect(parseAnchorCalldata(embedded)).toBeNull();
    });

    it('(b) rejects an absent/wrong prefix', () => {
      expect(parseAnchorCalldata(`0xdeadbeef${FP}`)).toBeNull();
      // Right length (36 bytes) but wrong 4-byte prefix.
      expect(parseAnchorCalldata(`0x00000000${FP}`)).toBeNull();
    });

    it('(c) rejects the ARKV prefix at a non-zero offset inside the buffer', () => {
      // One junk byte, THEN ARKV+fingerprint — a substring scanner would match.
      const offset = `0xab${ARKV}${FP}`;
      expect(parseAnchorCalldata(offset)).toBeNull();
    });

    it('(d) rejects a truncated buffer (< 36 bytes committed)', () => {
      // ARKV + only 16 fingerprint bytes.
      expect(parseAnchorCalldata(`0x${ARKV}${'a'.repeat(32)}`)).toBeNull();
    });

    it('(d2) rejects a truncated metadata region (37..43 bytes — between the two legal lengths)', () => {
      // Canonical 36-byte payload + a partial (4-byte) metadata region = 40 bytes.
      const partialMeta = `0x${ARKV}${FP}${'b'.repeat(8)}`;
      expect(parseAnchorCalldata(partialMeta)).toBeNull();
    });

    it('(e) rejects odd-length hex (not whole bytes)', () => {
      // 71 hex chars after 0x — not a whole number of bytes.
      expect(parseAnchorCalldata(`0x${ARKV}${FP}a`)).toBeNull();
    });

    it('(g) rejects non-hex characters in the calldata', () => {
      const nonHex = `0x${ARKV}${'z'.repeat(64)}`;
      expect(parseAnchorCalldata(nonHex)).toBeNull();
    });

    it('accepts the two — and only the two — canonical lengths (36 and 44 bytes)', () => {
      const only36 = parseAnchorCalldata(`0x${ARKV}${FP}`);
      expect(only36).not.toBeNull();
      expect(only36!.fingerprint).toBe(FP);
      expect(only36!.metadataHashTruncated).toBeUndefined();

      const with44 = parseAnchorCalldata(`0x${ARKV}${FP}${META8}`);
      expect(with44).not.toBeNull();
      expect(with44!.fingerprint).toBe(FP);
      expect(with44!.metadataHashTruncated).toBe(META8);
    });

    it('(h) returns the fingerprint in lowercase regardless of input case', () => {
      const upper = `0x${ARKV.toUpperCase()}${'A'.repeat(64)}`;
      const parsed = parseAnchorCalldata(upper);
      expect(parsed).not.toBeNull();
      expect(parsed!.fingerprint).toBe('a'.repeat(64));
    });
  });

  describe('canonicalMetadataJson', () => {
    it('sorts keys alphabetically', () => {
      const json = canonicalMetadataJson({ z: '1', a: '2', m: '3' });
      expect(json).toBe('{"a":"2","m":"3","z":"1"}');
    });

    it('handles empty metadata', () => {
      const json = canonicalMetadataJson({});
      expect(json).toBe('{}');
    });
  });

  describe('hashMetadata', () => {
    it('returns 64-char hex SHA-256', () => {
      const hash = hashMetadata(TEST_METADATA);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic', () => {
      const h1 = hashMetadata(TEST_METADATA);
      const h2 = hashMetadata(TEST_METADATA);
      expect(h1).toBe(h2);
    });

    it('changes with different metadata', () => {
      const h1 = hashMetadata(TEST_METADATA);
      const h2 = hashMetadata({ ...TEST_METADATA, extra: 'field' });
      expect(h1).not.toBe(h2);
    });

    it('is key-order independent', () => {
      const h1 = hashMetadata({ a: '1', b: '2' });
      const h2 = hashMetadata({ b: '2', a: '1' });
      expect(h1).toBe(h2);
    });
  });

  // ── Interface compliance ──

  describe('interface compliance', () => {
    it('implements ChainClient interface', () => {
      const cfg = createTestConfig();
      const client: ChainClient = new BaseChainClient(cfg);
      expect(client).toBeDefined();
      expect(typeof client.submitFingerprint).toBe('function');
      expect(typeof client.verifyFingerprint).toBe('function');
      expect(typeof client.getReceipt).toBe('function');
      expect(typeof client.healthCheck).toBe('function');
    });

    it('exposes treasury address (never the key)', () => {
      const cfg = createTestConfig();
      const client = new BaseChainClient(cfg);
      expect(client.treasuryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('exposes chain ID', () => {
      const cfg = createTestConfig({ network: 'base-sepolia' });
      const client = new BaseChainClient(cfg);
      expect(client.chainId).toBe(TEST_CHAIN_ID_SEPOLIA);
    });
  });

  // ── Constructor ──

  describe('constructor', () => {
    it('creates client for base-sepolia', () => {
      const cfg = createTestConfig({ network: 'base-sepolia' });
      const client = new BaseChainClient(cfg);
      expect(client.chainId).toBe(84532);
    });

    it('creates client for base mainnet', () => {
      const cfg = createTestConfig({ network: 'base' });
      const client = new BaseChainClient(cfg);
      expect(client.chainId).toBe(8453);
    });
  });

  // ── submitFingerprint ──

  describe('submitFingerprint', () => {
    let client: BaseChainClient;
    let mockPublicClient: ReturnType<typeof createMockPublicClient>;
    let mockWalletClient: ReturnType<typeof createMockWalletClient>;

    beforeEach(() => {
      mockPublicClient = createMockPublicClient();
      mockWalletClient = createMockWalletClient();
      client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublicClient,
        walletClient: mockWalletClient,
      });
    });

    it('submits fingerprint and returns receipt', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      const receipt = await client.submitFingerprint(request);

      expect(receipt.receiptId).toBe(TEST_TX_HASH);
      expect(receipt.blockHeight).toBe(Number(TEST_BLOCK_NUMBER));
      expect(receipt.confirmations).toBe(1);
      expect(receipt.blockTimestamp).toBeTruthy();
      expect(receipt.feeWei).toBe((TEST_GAS_USED * TEST_GAS_PRICE).toString());
    });

    it('includes metadata hash in receipt when metadata provided', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
        metadata: TEST_METADATA,
      };

      const receipt = await client.submitFingerprint(request);
      expect(receipt.metadataHash).toBeTruthy();
      expect(receipt.metadataHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sends transaction with correct calldata', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await client.submitFingerprint(request);

      expect(mockWalletClient.sendTransaction).toHaveBeenCalledTimes(1);
      const callArgs = mockWalletClient.sendTransaction.mock.calls[0][0];
      expect(callArgs.value).toBe(0n);
      expect(callArgs.data).toBe(buildAnchorCalldata(TEST_FINGERPRINT));
      // Self-referential: to === from
      expect(callArgs.to).toBe(client.treasuryAddress);
    });

    it('sends transaction with metadata in calldata', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
        metadata: TEST_METADATA,
      };

      await client.submitFingerprint(request);

      const callArgs = mockWalletClient.sendTransaction.mock.calls[0][0];
      const metaHash = hashMetadata(TEST_METADATA);
      expect(callArgs.data).toBe(buildAnchorCalldata(TEST_FINGERPRINT, metaHash));
    });

    it('estimates gas before sending', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await client.submitFingerprint(request);

      expect(mockPublicClient.estimateGas).toHaveBeenCalledTimes(1);
      expect(mockPublicClient.getGasPrice).toHaveBeenCalledTimes(1);
    });

    it('waits for transaction receipt', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await client.submitFingerprint(request);

      expect(mockPublicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: TEST_TX_HASH }),
      );
    });

    it('throws on reverted transaction', async () => {
      mockPublicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        blockNumber: TEST_BLOCK_NUMBER,
        gasUsed: TEST_GAS_USED,
        effectiveGasPrice: TEST_GAS_PRICE,
        transactionHash: TEST_TX_HASH,
      });

      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await expect(client.submitFingerprint(request)).rejects.toThrow('reverted');
    });

    it('rejects when gas price exceeds ceiling', async () => {
      const highGasClient = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: createMockPublicClient({
          getGasPrice: vi.fn().mockResolvedValue(2_000_000_000n), // 2 gwei
        }),
        walletClient: createMockWalletClient(),
        maxGasPriceGwei: 1, // 1 gwei ceiling
      });

      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await expect(highGasClient.submitFingerprint(request)).rejects.toThrow('exceeds ceiling');
    });

    it('stores calldata in rawTxHex field', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      const receipt = await client.submitFingerprint(request);
      expect(receipt.rawTxHex).toBe(buildAnchorCalldata(TEST_FINGERPRINT));
    });

    it('calculates fee in wei stored as feeWei string', async () => {
      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      const receipt = await client.submitFingerprint(request);
      // gasUsed (21500) * gasPrice (100000000) = 2150000000000
      expect(receipt.feeWei).toBe((TEST_GAS_USED * TEST_GAS_PRICE).toString());
    });
  });

  // ── verifyFingerprint ──

  describe('verifyFingerprint', () => {
    it('returns not-verified with guidance for chain index', async () => {
      const cfg = createTestConfig();
      const client = new BaseChainClient(cfg);

      const result = await client.verifyFingerprint(TEST_FINGERPRINT);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('chain index');
    });
  });

  // ── verifyTransaction ──

  describe('verifyTransaction', () => {
    let client: BaseChainClient;
    let mockPublicClient: ReturnType<typeof createMockPublicClient>;

    beforeEach(() => {
      mockPublicClient = createMockPublicClient();
      client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublicClient,
        walletClient: createMockWalletClient(),
      });
    });

    it('verifies matching fingerprint in transaction calldata', async () => {
      const result = await client.verifyTransaction(TEST_TX_HASH, TEST_FINGERPRINT);
      expect(result.verified).toBe(true);
      expect(result.receipt).toBeDefined();
      expect(result.receipt!.receiptId).toBe(TEST_TX_HASH);
    });

    it('rejects non-matching fingerprint', async () => {
      const differentFingerprint = 'b'.repeat(64);
      const result = await client.verifyTransaction(TEST_TX_HASH, differentFingerprint);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('does not match');
    });

    it('rejects non-ARKV transaction', async () => {
      mockPublicClient.getTransaction.mockResolvedValue({
        hash: TEST_TX_HASH,
        input: '0xdeadbeef',
        blockNumber: TEST_BLOCK_NUMBER,
      });

      const result = await client.verifyTransaction(TEST_TX_HASH, TEST_FINGERPRINT);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('not an ARKV anchor');
    });

    it('handles transaction not found', async () => {
      mockPublicClient.getTransaction.mockResolvedValue(null);

      const result = await client.verifyTransaction(TEST_TX_HASH, TEST_FINGERPRINT);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles RPC errors gracefully', async () => {
      mockPublicClient.getTransaction.mockRejectedValue(new Error('nonce too low'));

      const result = await client.verifyTransaction(TEST_TX_HASH, TEST_FINGERPRINT);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Verification error');
    });
  });

  // ── getReceipt ──

  describe('getReceipt', () => {
    let client: BaseChainClient;
    let mockPublicClient: ReturnType<typeof createMockPublicClient>;

    beforeEach(() => {
      mockPublicClient = createMockPublicClient();
      client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublicClient,
        walletClient: createMockWalletClient(),
      });
    });

    it('returns receipt for ARKV transaction', async () => {
      const receipt = await client.getReceipt(TEST_TX_HASH);
      expect(receipt).not.toBeNull();
      expect(receipt!.receiptId).toBe(TEST_TX_HASH);
      expect(receipt!.blockHeight).toBe(Number(TEST_BLOCK_NUMBER));
      expect(receipt!.confirmations).toBe(5); // currentBlock - blockNumber
      expect(receipt!.blockTimestamp).toBeTruthy();
      expect(receipt!.feeWei).toBe((TEST_GAS_USED * TEST_GAS_PRICE).toString());
    });

    it('returns null for non-ARKV transaction', async () => {
      mockPublicClient.getTransaction.mockResolvedValue({
        hash: TEST_TX_HASH,
        input: '0xdeadbeef',
        blockNumber: TEST_BLOCK_NUMBER,
      });

      const receipt = await client.getReceipt(TEST_TX_HASH);
      expect(receipt).toBeNull();
    });

    it('returns null on RPC error', async () => {
      mockPublicClient.getTransaction.mockRejectedValue(new Error('not found'));

      const receipt = await client.getReceipt(TEST_TX_HASH);
      expect(receipt).toBeNull();
    });

    it('includes rawTxHex (calldata) in receipt', async () => {
      const receipt = await client.getReceipt(TEST_TX_HASH);
      expect(receipt!.rawTxHex).toBe(buildAnchorCalldata(TEST_FINGERPRINT));
    });

    it('calculates confirmations from current block', async () => {
      mockPublicClient.getBlockNumber.mockResolvedValue(TEST_BLOCK_NUMBER + 100n);

      const receipt = await client.getReceipt(TEST_TX_HASH);
      expect(receipt!.confirmations).toBe(100);
    });
  });

  // ── healthCheck ──

  describe('healthCheck', () => {
    it('returns true when chain ID matches', async () => {
      const cfg = createTestConfig();
      const client = new BaseChainClient(cfg);

      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
    });

    it('returns false when chain ID does not match', async () => {
      const mockPublic = createMockPublicClient({
        getChainId: vi.fn().mockResolvedValue(999),
      });
      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublic,
        walletClient: createMockWalletClient(),
      });

      const healthy = await client.healthCheck();
      expect(healthy).toBe(false);
    });

    it('returns false on RPC error', async () => {
      const mockPublic = createMockPublicClient({
        getBlockNumber: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      });
      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublic,
        walletClient: createMockWalletClient(),
      });

      const healthy = await client.healthCheck();
      expect(healthy).toBe(false);
    });

    it('checks correct chain ID for base mainnet', async () => {
      const mockPublic = createMockPublicClient({
        getChainId: vi.fn().mockResolvedValue(TEST_CHAIN_ID_BASE),
      });
      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base',
        publicClient: mockPublic,
        walletClient: createMockWalletClient(),
      });

      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  // ── Retry behavior ──

  describe('retry behavior', () => {
    it('retries transient gas estimation failures', async () => {
      const mockPublic = createMockPublicClient();
      mockPublic.estimateGas
        .mockRejectedValueOnce(new Error('RPC timeout'))
        .mockResolvedValueOnce(21500n);

      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublic,
        walletClient: createMockWalletClient(),
      });

      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      const receipt = await client.submitFingerprint(request);
      expect(receipt.receiptId).toBe(TEST_TX_HASH);
      expect(mockPublic.estimateGas).toHaveBeenCalledTimes(2);
    });

    it('does not retry validation errors (nonce too low)', async () => {
      const mockWallet = createMockWalletClient();
      mockWallet.sendTransaction.mockRejectedValue(new Error('nonce too low'));

      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: createMockPublicClient(),
        walletClient: mockWallet,
      });

      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await expect(client.submitFingerprint(request)).rejects.toThrow('nonce too low');
      expect(mockWallet.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not retry insufficient funds errors', async () => {
      const mockWallet = createMockWalletClient();
      mockWallet.sendTransaction.mockRejectedValue(new Error('insufficient funds for gas'));

      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: createMockPublicClient(),
        walletClient: mockWallet,
      });

      const request: SubmitFingerprintRequest = {
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      };

      await expect(client.submitFingerprint(request)).rejects.toThrow('insufficient funds');
      expect(mockWallet.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── End-to-end flow ──

  describe('end-to-end anchor flow', () => {
    it('submit -> getReceipt roundtrip', async () => {
      const mockPublic = createMockPublicClient();
      const mockWallet = createMockWalletClient();

      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublic,
        walletClient: mockWallet,
      });

      // Submit
      const submitResult = await client.submitFingerprint({
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
        metadata: TEST_METADATA,
      });

      expect(submitResult.receiptId).toBeTruthy();
      expect(submitResult.metadataHash).toBeTruthy();

      // Update mock to return calldata with metadata
      const metaHash = hashMetadata(TEST_METADATA);
      mockPublic.getTransaction.mockResolvedValue({
        hash: TEST_TX_HASH,
        input: buildAnchorCalldata(TEST_FINGERPRINT, metaHash),
        blockNumber: TEST_BLOCK_NUMBER,
      });

      // Get receipt
      const receipt = await client.getReceipt(submitResult.receiptId);
      expect(receipt).not.toBeNull();
      expect(receipt!.receiptId).toBe(submitResult.receiptId);
      expect(receipt!.metadataHash).toBe(metaHash.slice(0, 16));
    });

    it('submit -> verifyTransaction roundtrip', async () => {
      const mockPublic = createMockPublicClient();
      const mockWallet = createMockWalletClient();

      const client = new BaseChainClient({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base-sepolia',
        publicClient: mockPublic,
        walletClient: mockWallet,
      });

      // Submit
      const submitResult = await client.submitFingerprint({
        fingerprint: TEST_FINGERPRINT,
        timestamp: new Date().toISOString(),
      });

      // Verify
      const verifyResult = await client.verifyTransaction(submitResult.receiptId, TEST_FINGERPRINT);
      expect(verifyResult.verified).toBe(true);
      expect(verifyResult.receipt).toBeDefined();
    });
  });
});
