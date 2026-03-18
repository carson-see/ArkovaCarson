#!/usr/bin/env tsx
/**
 * Signet Treasury Keypair Generator
 *
 * Generates a new Bitcoin Signet keypair for the Arkova treasury wallet.
 * Outputs the WIF (private key) and P2PKH address.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/generate-signet-keypair.ts
 *
 * SECURITY:
 *   - The WIF is printed ONCE to stdout. Copy it immediately to your .env file.
 *   - Never commit, log, or share the WIF (Constitution 1.4).
 *   - The address is safe to share publicly (needed for faucet funding).
 *
 * Story: P7-TS-11
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);
const SIGNET_NETWORK = bitcoin.networks.testnet; // Signet uses testnet params

function generateSignetKeypair(): { wif: string; address: string } {
  const keyPair = ECPair.makeRandom({ network: SIGNET_NETWORK });

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: SIGNET_NETWORK,
  });

  if (!address) {
    throw new Error('Failed to derive address from generated keypair');
  }

  const wif = keyPair.toWIF();

  return { wif, address };
}

// --- Main ---

console.log('=== Arkova Signet Treasury Keypair Generator ===\n');

const { wif, address } = generateSignetKeypair();

console.log(`Network:  Bitcoin Signet (testnet params)`);
console.log(`Address:  ${address}`);
console.log(`WIF:      ${wif}`);
console.log('');
console.log('--- NEXT STEPS ---');
console.log('1. Copy the WIF to your .env file as BITCOIN_TREASURY_WIF');
console.log('2. Fund the address via a Signet faucet:');
console.log('   - https://signetfaucet.com');
console.log('   - https://alt.signetfaucet.com');
console.log('3. Confirm balance at: https://mempool.space/signet/address/' + address);
console.log('4. Set BITCOIN_RPC_URL to your Signet node (e.g., http://localhost:38332)');
console.log('5. Set ENABLE_PROD_NETWORK_ANCHORING=true in .env');
console.log('');
console.log('WARNING: The WIF above is shown ONCE. Store it securely.');
console.log('         Never commit it to source control (Constitution 1.4).');
