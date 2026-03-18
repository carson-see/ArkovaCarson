#!/usr/bin/env tsx
/**
 * Derive WIF + SegWit address from BIP39 mnemonic
 *
 * Derives the first receiving address at BIP84 path: m/84'/1'/0'/0/0
 * (testnet Native SegWit P2WPKH — same derivation Sparrow uses)
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/derive-wif-from-mnemonic.ts
 *
 * You will be prompted to enter your mnemonic and optional passphrase.
 * The WIF is printed ONCE — copy it to your .env file.
 *
 * SECURITY: Never commit or share the output. Constitution 1.4.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import BIP32Factory from 'bip32';
import * as bip39 from 'bip39';
import * as readline from 'readline';

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const TESTNET = bitcoin.networks.testnet; // testnet4 uses same params

function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('=== Arkova WIF Derivation from BIP39 Mnemonic ===\n');
  console.log('This derives the WIF for the first receive address at m/84\'/1\'/0\'/0/0');
  console.log('(Same derivation path Sparrow uses for Native SegWit testnet)\n');

  const mnemonic = await prompt('Enter your 24-word mnemonic: ');

  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('ERROR: Invalid mnemonic. Check your words and try again.');
    process.exit(1);
  }

  const passphrase = await prompt('Enter passphrase (leave empty if none): ');

  // Derive seed from mnemonic + passphrase
  const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);

  // Derive BIP84 testnet path: m/84'/1'/0'/0/0
  const root = bip32.fromSeed(seed, TESTNET);
  const child = root.derivePath("m/84'/1'/0'/0/0");

  if (!child.privateKey) {
    console.error('ERROR: Failed to derive private key');
    process.exit(1);
  }

  // Get WIF
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), {
    network: TESTNET,
    compressed: true,
  });
  const wif = keyPair.toWIF();

  // Get SegWit address (P2WPKH)
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: TESTNET,
  });

  console.log('\n=== RESULTS ===');
  console.log(`Derivation: m/84'/1'/0'/0/0`);
  console.log(`Address:    ${address}`);
  console.log(`WIF:        ${wif}`);
  console.log('');

  if (address === 'tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r') {
    console.log('ADDRESS MATCHES your Sparrow wallet. Copy the WIF to .env.');
  } else {
    console.log(`WARNING: Address does not match tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`);
    console.log('Check your mnemonic and passphrase.');
  }

  console.log('\nCopy this WIF to services/worker/.env as BITCOIN_TREASURY_WIF');
  console.log('WARNING: Shown ONCE. Never commit to source control (Constitution 1.4).');
}

main().catch(console.error);
