#!/usr/bin/env tsx
/**
 * Signet Balance Checker
 *
 * Verifies the treasury wallet has been funded on Signet by querying
 * the configured RPC node for UTXOs. Also validates connectivity.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/check-signet-balance.ts
 *
 * Requires .env:
 *   BITCOIN_TREASURY_WIF=<your WIF>
 *   BITCOIN_RPC_URL=<signet node URL>
 *   BITCOIN_RPC_AUTH=<user:pass> (optional)
 *
 * Story: P7-TS-11
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

// Load .env from worker directory
dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const ECPair = ECPairFactory(ecc);
const SIGNET_NETWORK = bitcoin.networks.testnet;

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
  rpcAuth?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (rpcAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(rpcAuth).toString('base64')}`;
  }

  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
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

async function main(): Promise<void> {
  console.log('=== Arkova Signet Balance Checker ===\n');

  const wif = process.env.BITCOIN_TREASURY_WIF;
  const rpcUrl = process.env.BITCOIN_RPC_URL;
  const rpcAuth = process.env.BITCOIN_RPC_AUTH;

  if (!wif) {
    console.error('ERROR: BITCOIN_TREASURY_WIF not set in .env');
    process.exit(1);
  }
  if (!rpcUrl) {
    console.error('ERROR: BITCOIN_RPC_URL not set in .env');
    process.exit(1);
  }

  // Derive address from WIF
  let address: string;
  try {
    const keyPair = ECPair.fromWIF(wif, SIGNET_NETWORK);
    const payment = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: SIGNET_NETWORK,
    });
    address = payment.address!;
  } catch {
    console.error('ERROR: Invalid BITCOIN_TREASURY_WIF — cannot parse as WIF');
    process.exit(1);
  }

  console.log(`Address:  ${address}`);
  console.log(`RPC URL:  ${rpcUrl}`);
  console.log('');

  // 1. Check node connectivity
  console.log('--- Node Connectivity ---');
  try {
    const info = (await rpcCall(rpcUrl, 'getblockchaininfo', [], rpcAuth)) as {
      chain: string;
      blocks: number;
      headers: number;
      verificationprogress: number;
    };
    console.log(`Chain:    ${info.chain}`);
    console.log(`Blocks:   ${info.blocks}`);
    console.log(`Headers:  ${info.headers}`);
    console.log(`Sync:     ${(info.verificationprogress * 100).toFixed(2)}%`);

    if (info.chain !== 'signet' && info.chain !== 'test') {
      console.warn(`\nWARNING: Expected chain 'signet' or 'test', got '${info.chain}'`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`FAILED: Cannot connect to Signet node — ${msg}`);
    console.error('Ensure BITCOIN_RPC_URL and BITCOIN_RPC_AUTH are correct.');
    process.exit(1);
  }

  // 2. Check UTXOs
  console.log('\n--- Treasury UTXOs ---');
  try {
    const utxos = (await rpcCall(rpcUrl, 'listunspent', [0, 9999999, [address]], rpcAuth)) as Array<{
      txid: string;
      vout: number;
      amount: number;
      confirmations: number;
    }>;

    if (utxos.length === 0) {
      console.log('No UTXOs found. Treasury is unfunded.');
      console.log(`\nFund via faucet: https://signetfaucet.com`);
      console.log(`Address to fund: ${address}`);
      console.log(`Explorer: https://mempool.space/signet/address/${address}`);
      process.exit(0);
    }

    let totalSats = 0;
    for (const utxo of utxos) {
      const sats = Math.round(utxo.amount * 1e8);
      totalSats += sats;
      console.log(`  txid: ${utxo.txid}:${utxo.vout}`);
      console.log(`  amount: ${utxo.amount} BTC (${sats} sats)`);
      console.log(`  confirmations: ${utxo.confirmations}`);
      console.log('');
    }

    console.log(`Total: ${utxos.length} UTXO(s), ${totalSats} sats (${totalSats / 1e8} BTC)`);

    // Estimate capacity: ~478 sats per OP_RETURN tx at 2 sat/vbyte
    const estimatedTxs = Math.floor(totalSats / 478);
    console.log(`Estimated anchoring capacity: ~${estimatedTxs} transactions`);
    console.log(`\nExplorer: https://mempool.space/signet/address/${address}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`FAILED: Cannot list UTXOs — ${msg}`);
    console.error('The RPC node may not have the wallet loaded or the address imported.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
