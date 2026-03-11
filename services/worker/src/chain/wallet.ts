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

/** Signet uses testnet network parameters */
export const SIGNET_NETWORK = bitcoin.networks.testnet;

export interface SignetKeypair {
  /** WIF-encoded private key — NEVER log or commit */
  wif: string;
  /** P2PKH address derived from the public key — safe to share */
  address: string;
}

/**
 * Generate a new random Signet keypair.
 * The WIF must be stored securely in env vars — never committed to source.
 */
export function generateSignetKeypair(): SignetKeypair {
  const keyPair = ECPair.makeRandom({ network: SIGNET_NETWORK });

  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: SIGNET_NETWORK,
  });

  if (!address) {
    throw new Error('Failed to derive address from generated keypair');
  }

  return { wif: keyPair.toWIF(), address };
}

/**
 * Derive the P2PKH address from a WIF-encoded private key.
 * Validates the WIF is parseable for Signet (testnet params).
 */
export function addressFromWif(wif: string): string {
  const keyPair = ECPair.fromWIF(wif, SIGNET_NETWORK);

  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: SIGNET_NETWORK,
  });

  if (!address) {
    throw new Error('Failed to derive address from WIF');
  }

  return address;
}

/**
 * Validate that a WIF string is parseable for the Signet network.
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
