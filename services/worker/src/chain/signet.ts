/**
 * Bitcoin Signet Chain Client
 *
 * Real implementation of the ChainClient interface using bitcoinjs-lib.
 * Constructs OP_RETURN transactions to anchor document fingerprints
 * on Bitcoin Signet (testnet). Treasury WIF loaded from env — never logged.
 *
 * Constitution refs:
 *   - 1.1: bitcoinjs-lib + AWS KMS (target)
 *   - 1.4: Treasury/signing keys server-side only, never logged
 *   - 1.6: generateFingerprint is client-side only — this file never imports it
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { logger } from '../utils/logger.js';
import type {
  ChainClient,
  ChainReceipt,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';

const ECPair = ECPairFactory(ecc);

// Signet uses testnet network parameters
const SIGNET_NETWORK = bitcoin.networks.testnet;

// OP_RETURN prefix for Arkova anchors (4 bytes: 'ARKV')
const OP_RETURN_PREFIX = Buffer.from('ARKV');

// Maximum OP_RETURN payload is 80 bytes. Prefix (4) + SHA-256 hash (32) = 36 bytes.
const MAX_OP_RETURN_DATA = 80;

export interface SignetConfig {
  /** Treasury WIF for signing transactions — NEVER log this */
  treasuryWif: string;
  /** Bitcoin RPC URL (Signet node) */
  rpcUrl: string;
  /** RPC authentication (user:pass) — optional */
  rpcAuth?: string;
}

/**
 * Make an RPC call to the Bitcoin Signet node.
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

  const json = (await response.json()) as { result?: unknown; error?: { message: string; code: number } };

  if (json.error) {
    throw new Error(`RPC ${method} error: ${json.error.message} (code ${json.error.code})`);
  }

  return json.result;
}

/**
 * Build an OP_RETURN transaction embedding a document fingerprint.
 *
 * Transaction structure:
 *   Input:  Largest UTXO from treasury address
 *   Output 0: OP_RETURN <ARKV><sha256_hex_as_bytes>
 *   Output 1: Change back to treasury (input - fee)
 */
export function buildOpReturnTransaction(
  fingerprint: string,
  utxo: { txid: string; vout: number; value: number; scriptPubKey: string },
  keyPair: ReturnType<typeof ECPair.fromWIF>,
  feeRate: number = 2, // sat/vbyte — Signet minimum
): { txHex: string; txId: string } {
  // Validate fingerprint is a 64-char hex string (SHA-256)
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }

  const fingerprintBytes = Buffer.from(fingerprint, 'hex');
  const opReturnData = Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes]);

  if (opReturnData.length > MAX_OP_RETURN_DATA) {
    throw new Error(`OP_RETURN data exceeds ${MAX_OP_RETURN_DATA} bytes`);
  }

  // Build the OP_RETURN output script
  const opReturnScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    opReturnData,
  ]);

  // Estimate transaction size for fee calculation
  // P2PKH: ~148 bytes input + 34 bytes per output + 10 bytes overhead
  // With OP_RETURN (~47 bytes) + change output (34 bytes)
  const estimatedSize = 148 + 47 + 34 + 10; // ~239 vbytes
  const fee = Math.ceil(estimatedSize * feeRate);

  const changeAmount = utxo.value - fee;

  if (changeAmount < 0) {
    throw new Error(
      `Insufficient funds: UTXO value ${utxo.value} sats, estimated fee ${fee} sats`,
    );
  }

  // Dust threshold check — don't create unspendable change
  const DUST_THRESHOLD = 546; // satoshis
  const hasChange = changeAmount >= DUST_THRESHOLD;

  const psbt = new bitcoin.Psbt({ network: SIGNET_NETWORK });

  // Add input
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    nonWitnessUtxo: Buffer.from(utxo.scriptPubKey, 'hex'),
  });

  // Add OP_RETURN output (value = 0)
  psbt.addOutput({
    script: opReturnScript,
    value: 0,
  });

  // Add change output if above dust
  if (hasChange) {
    const { address } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: SIGNET_NETWORK,
    });

    if (!address) {
      throw new Error('Failed to derive change address from key pair');
    }

    psbt.addOutput({
      address,
      value: changeAmount,
    });
  }

  // Sign
  psbt.signInput(0, {
    publicKey: Buffer.from(keyPair.publicKey),
    sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
  });

  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();

  return {
    txHex: tx.toHex(),
    txId: tx.getId(),
  };
}

export class SignetChainClient implements ChainClient {
  private readonly keyPair: ReturnType<typeof ECPair.fromWIF>;
  private readonly rpcUrl: string;
  private readonly rpcAuth?: string;
  private readonly address: string;

  constructor(signetConfig: SignetConfig) {
    // Parse the treasury WIF — validation happens here.
    // The WIF itself is NEVER logged (Constitution 1.4).
    try {
      this.keyPair = ECPair.fromWIF(signetConfig.treasuryWif, SIGNET_NETWORK);
    } catch {
      throw new Error('Invalid BITCOIN_TREASURY_WIF — cannot parse as WIF for Signet network');
    }

    const { address } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(this.keyPair.publicKey),
      network: SIGNET_NETWORK,
    });

    if (!address) {
      throw new Error('Failed to derive treasury address from WIF');
    }

    this.address = address;
    this.rpcUrl = signetConfig.rpcUrl;
    this.rpcAuth = signetConfig.rpcAuth;

    // Log only the address, NEVER the WIF
    logger.info({ address: this.address }, 'Signet chain client initialized');
  }

  async submitFingerprint(data: SubmitFingerprintRequest): Promise<ChainReceipt> {
    logger.info({ fingerprint: data.fingerprint }, 'Submitting fingerprint to Signet');

    // 1. List unspent UTXOs for the treasury address
    const utxos = (await rpcCall(
      this.rpcUrl,
      'listunspent',
      [1, 9999999, [this.address]],
      this.rpcAuth,
    )) as Array<{ txid: string; vout: number; amount: number; scriptPubKey: string }>;

    if (!utxos || utxos.length === 0) {
      throw new Error(`No UTXOs available for treasury address ${this.address}`);
    }

    // Pick the largest UTXO
    const utxo = utxos.reduce((best, current) =>
      current.amount > best.amount ? current : best,
    );

    // Convert BTC amount to satoshis
    const utxoSats = {
      txid: utxo.txid,
      vout: utxo.vout,
      value: Math.round(utxo.amount * 1e8),
      scriptPubKey: utxo.scriptPubKey,
    };

    // 2. Get raw transaction for the UTXO (needed for non-witness input)
    const rawTxHex = (await rpcCall(
      this.rpcUrl,
      'getrawtransaction',
      [utxo.txid, false],
      this.rpcAuth,
    )) as string;

    // Use the raw tx hex as nonWitnessUtxo
    const utxoWithRaw = {
      ...utxoSats,
      scriptPubKey: rawTxHex,
    };

    // 3. Build and sign the OP_RETURN transaction
    const { txHex, txId } = buildOpReturnTransaction(
      data.fingerprint,
      utxoWithRaw,
      this.keyPair,
    );

    // 4. Broadcast
    await rpcCall(this.rpcUrl, 'sendrawtransaction', [txHex], this.rpcAuth);

    logger.info({ txId, fingerprint: data.fingerprint }, 'Fingerprint anchored on Signet');

    // 5. Get the current block height for the receipt
    const blockchainInfo = (await rpcCall(
      this.rpcUrl,
      'getblockchaininfo',
      [],
      this.rpcAuth,
    )) as { blocks: number };

    return {
      receiptId: txId,
      blockHeight: blockchainInfo.blocks,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0, // Just broadcast, not yet confirmed
    };
  }

  async verifyFingerprint(fingerprint: string): Promise<VerificationResult> {
    logger.info({ fingerprint }, 'Verifying fingerprint on Signet');

    // Search for the fingerprint in recent transactions
    // This is a simplified approach — production would use an indexer
    try {
      const txIds = (await rpcCall(
        this.rpcUrl,
        'listtransactions',
        ['*', 100, 0, true],
        this.rpcAuth,
      )) as Array<{ txid: string; confirmations: number; blockheight?: number; blocktime?: number }>;

      for (const txEntry of txIds) {
        const rawTx = (await rpcCall(
          this.rpcUrl,
          'getrawtransaction',
          [txEntry.txid, true],
          this.rpcAuth,
        )) as {
          txid: string;
          vout: Array<{ scriptPubKey: { hex: string; asm: string } }>;
          confirmations?: number;
          blocktime?: number;
        };

        // Check each output for our OP_RETURN with the fingerprint
        for (const output of rawTx.vout) {
          if (output.scriptPubKey.asm.startsWith('OP_RETURN')) {
            const hexData = output.scriptPubKey.hex;
            // OP_RETURN script: 6a (OP_RETURN) + push length + data
            // Our data: ARKV prefix (4 bytes) + fingerprint (32 bytes)
            const expectedSuffix = OP_RETURN_PREFIX.toString('hex') + fingerprint.toLowerCase();

            if (hexData.includes(expectedSuffix)) {
              return {
                verified: true,
                receipt: {
                  receiptId: rawTx.txid,
                  blockHeight: txEntry.blockheight ?? 0,
                  blockTimestamp: txEntry.blocktime
                    ? new Date(txEntry.blocktime * 1000).toISOString()
                    : new Date().toISOString(),
                  confirmations: rawTx.confirmations ?? 0,
                },
              };
            }
          }
        }
      }

      return {
        verified: false,
        error: 'Fingerprint not found in recent transactions',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ fingerprint, error: message }, 'Verification failed');
      return {
        verified: false,
        error: `Verification error: ${message}`,
      };
    }
  }

  async getReceipt(receiptId: string): Promise<ChainReceipt | null> {
    logger.info({ receiptId }, 'Getting receipt from Signet');

    try {
      const rawTx = (await rpcCall(
        this.rpcUrl,
        'getrawtransaction',
        [receiptId, true],
        this.rpcAuth,
      )) as {
        txid: string;
        confirmations?: number;
        blocktime?: number;
        blockhash?: string;
      };

      let blockHeight = 0;
      if (rawTx.blockhash) {
        const blockHeader = (await rpcCall(
          this.rpcUrl,
          'getblockheader',
          [rawTx.blockhash],
          this.rpcAuth,
        )) as { height: number };
        blockHeight = blockHeader.height;
      }

      return {
        receiptId: rawTx.txid,
        blockHeight,
        blockTimestamp: rawTx.blocktime
          ? new Date(rawTx.blocktime * 1000).toISOString()
          : new Date().toISOString(),
        confirmations: rawTx.confirmations ?? 0,
      };
    } catch {
      logger.warn({ receiptId }, 'Receipt not found on Signet');
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const info = (await rpcCall(
        this.rpcUrl,
        'getblockchaininfo',
        [],
        this.rpcAuth,
      )) as { chain: string; blocks: number };

      // Verify we're actually on signet/testnet
      const isSignet = info.chain === 'signet' || info.chain === 'test';
      logger.info(
        { chain: info.chain, blocks: info.blocks, healthy: isSignet },
        'Signet health check',
      );
      return isSignet;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Signet health check failed');
      return false;
    }
  }
}
