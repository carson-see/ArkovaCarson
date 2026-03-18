/**
 * Signet Treasury Wallet Utilities
 *
 * Provides keypair generation and address derivation for the Arkova
 * treasury wallet on Bitcoin Signet. Used by CLI scripts and tests.
 *
 * Constitution refs:
 *   - 1.1: bitcoinjs-lib + ECPair
 *   - 1.4: Treasury keys server-side only, never logged
 *
 * Story: P7-TS-11
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

/** Signet/testnet/testnet4 all use testnet network parameters in bitcoinjs-lib */
export const SIGNET_NETWORK = bitcoin.networks.testnet;

/** Alias — testnet4 uses the same bitcoinjs-lib network params as testnet */
export const TESTNET4_NETWORK = bitcoin.networks.testnet;

export interface SignetKeypair {
  /** WIF-encoded private key — NEVER log or commit */
  wif: string;
  /** P2WPKH (SegWit) address derived from the public key — safe to share */
  address: string;
}

/**
 * Generate a new random keypair for testnet-family networks (signet, testnet, testnet4).
 * The WIF must be stored securely in env vars — never committed to source.
 */
export function generateSignetKeypair(): SignetKeypair {
  const keyPair = ECPair.makeRandom({ network: SIGNET_NETWORK });

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: SIGNET_NETWORK,
  });

  if (!address) {
    throw new Error('Failed to derive address from generated keypair');
  }

  return { wif: keyPair.toWIF(), address };
}

/** Alias for testnet4 keypair generation (same underlying function) */
export const generateTestnet4Keypair = generateSignetKeypair;

/**
 * Derive the P2WPKH (SegWit) address from a WIF-encoded private key.
 * Validates the WIF is parseable for testnet-family networks (signet/testnet/testnet4).
 */
export function addressFromWif(wif: string): string {
  const keyPair = ECPair.fromWIF(wif, SIGNET_NETWORK);

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: SIGNET_NETWORK,
  });

  if (!address) {
    throw new Error('Failed to derive address from WIF');
  }

  return address;
}

/**
 * Validate that a WIF string is parseable for testnet-family networks.
 * Returns true if valid, false otherwise.
 */
export function isValidSignetWif(wif: string): boolean {
  try {
    ECPair.fromWIF(wif, SIGNET_NETWORK);
    return true;
  } catch {
    return false;
  }
}

/** Alias for testnet4 WIF validation (same underlying function) */
export const isValidTestnet4Wif = isValidSignetWif;
