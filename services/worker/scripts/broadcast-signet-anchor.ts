#!/usr/bin/env tsx
/**
 * Signet OP_RETURN Broadcast Script
 *
 * Performs a real OP_RETURN anchor broadcast on Bitcoin Signet using
 * BitcoinChainClient with WifSigningProvider + MempoolUtxoProvider +
 * StaticFeeEstimator. This is the operational validation for CRIT-2.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/broadcast-signet-anchor.ts
 *
 * Requires .env:
 *   BITCOIN_TREASURY_WIF=<your WIF>
 *
 * Optional .env:
 *   MEMPOOL_API_URL=https://mempool.space/signet/api  (default)
 *
 * The script:
 *   1. Derives the treasury address from the WIF
 *   2. Checks UTXOs via Mempool.space Signet API
 *   3. Creates a test fingerprint (SHA-256 of "arkova-signet-e2e-broadcast-{timestamp}")
 *   4. Broadcasts an OP_RETURN transaction with ARKV prefix
 *   5. Prints the txId and explorer link for verification
 *
 * SECURITY:
 *   - WIF is never logged or printed (Constitution 1.4)
 *   - Uses Mempool.space REST API — no local node required
 *
 * Story: CRIT-2 Step 1 (Signet E2E Broadcast)
 */

import { createHash } from 'crypto';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

// Load .env BEFORE any worker imports (config.ts fires at import time)
dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// Dynamic imports — must come after dotenv so config.ts sees env vars
const { BitcoinChainClient } = await import('../src/chain/signet.js');
const { WifSigningProvider } = await import('../src/chain/signing-provider.js');
const { MempoolUtxoProvider } = await import('../src/chain/utxo-provider.js');
const { StaticFeeEstimator } = await import('../src/chain/fee-estimator.js');

async function main(): Promise<void> {
  console.log('=== Arkova Signet E2E Broadcast ===\n');

  const wif = process.env.BITCOIN_TREASURY_WIF;
  const mempoolUrl = process.env.MEMPOOL_API_URL ?? 'https://mempool.space/signet/api';

  if (!wif) {
    console.error('ERROR: BITCOIN_TREASURY_WIF not set in .env');
    console.error('Run: npx tsx scripts/generate-signet-keypair.ts');
    process.exit(1);
  }

  // 1. Initialize providers
  console.log('1. Initializing providers...');
  const signingProvider = new WifSigningProvider(wif);
  const utxoProvider = new MempoolUtxoProvider({ baseUrl: mempoolUrl });
  const feeEstimator = new StaticFeeEstimator(1); // 1 sat/vbyte for Signet

  // 2. Create BitcoinChainClient
  console.log('2. Creating BitcoinChainClient...');
  const client = new BitcoinChainClient({
    signingProvider,
    utxoProvider,
    feeEstimator,
  });

  // Derive address for display (address is logged by constructor)
  const bitcoin = await import('bitcoinjs-lib');
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: signingProvider.getPublicKey(),
    network: bitcoin.networks.testnet,
  });

  console.log(`   Address: ${address}`);
  console.log(`   Provider: ${utxoProvider.name}`);
  console.log(`   Signer: ${signingProvider.name}`);
  console.log(`   Fee estimator: ${feeEstimator.name}`);

  // 3. Check UTXOs
  console.log('\n3. Checking UTXOs...');
  const utxos = await utxoProvider.listUnspent(address);

  if (utxos.length === 0) {
    console.error('ERROR: No confirmed UTXOs. Treasury is unfunded or unconfirmed.');
    console.error(`Fund via: https://signetfaucet.com (address: ${address})`);
    process.exit(1);
  }

  const totalSats = utxos.reduce((sum, u) => sum + u.valueSats, 0);
  console.log(`   Found ${utxos.length} UTXO(s) totaling ${totalSats} sats`);
  for (const u of utxos) {
    console.log(`   - ${u.txid}:${u.vout} (${u.valueSats} sats)`);
  }

  // 4. Generate a test fingerprint
  const testPayload = `arkova-signet-e2e-broadcast-${Date.now()}`;
  const fingerprint = createHash('sha256').update(testPayload).digest('hex');
  console.log(`\n4. Test fingerprint: ${fingerprint}`);
  console.log(`   Payload: "${testPayload}"`);

  // 5. Broadcast
  console.log('\n5. Broadcasting OP_RETURN transaction...');
  try {
    const receipt = await client.submitFingerprint({
      fingerprint,
      timestamp: new Date().toISOString(),
      metadata: { source: 'signet-e2e-broadcast-script', payload: testPayload },
    });

    console.log('\n=== BROADCAST SUCCESSFUL ===');
    console.log(`   TX ID:        ${receipt.receiptId}`);
    console.log(`   Block Height: ${receipt.blockHeight}`);
    console.log(`   Timestamp:    ${receipt.blockTimestamp}`);
    console.log(`   Confirmations: ${receipt.confirmations}`);
    console.log(`\n   Explorer: https://mempool.space/signet/tx/${receipt.receiptId}`);
    console.log(`   Address: https://mempool.space/signet/address/${address}`);
    console.log('\n--- RECORD THIS ---');
    console.log(`First successful Signet anchor TX: ${receipt.receiptId}`);
    console.log(`Fingerprint: ${fingerprint}`);
    console.log(`Date: ${new Date().toISOString()}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nBROADCAST FAILED: ${msg}`);

    if (msg.includes('No UTXOs')) {
      console.error('The treasury address has no spendable UTXOs.');
    } else if (msg.includes('Insufficient funds')) {
      console.error('The largest UTXO cannot cover the transaction fee.');
    } else if (msg.includes('broadcast failed')) {
      console.error('The transaction was rejected by the network.');
      console.error('This may be due to dust outputs, fee issues, or a spent UTXO.');
    }

    process.exit(1);
  }

  // 6. Verify the anchor
  console.log('\n6. Verifying anchor on chain...');
  try {
    const verification = await client.verifyFingerprint(fingerprint);
    console.log(`   Verified: ${verification.verified}`);
    if (verification.receipt) {
      console.log(`   Receipt ID: ${verification.receipt.receiptId}`);
    }
    if (verification.error) {
      console.log(`   Note: ${verification.error}`);
      console.log('   (This is expected — the TX may need a confirmation before UTXO scan finds it)');
    }
  } catch {
    console.log('   Verification will succeed after 1+ confirmation.');
  }

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
