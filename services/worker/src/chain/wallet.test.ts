import { describe, it, expect } from 'vitest';
import {
  generateSignetKeypair,
  addressFromWif,
  isValidSignetWif,
  SIGNET_NETWORK,
} from './wallet.js';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

describe('wallet utilities (P7-TS-11)', () => {
  describe('generateSignetKeypair', () => {
    it('generates a valid keypair', () => {
      const { wif, address } = generateSignetKeypair();
      expect(wif).toBeTruthy();
      expect(address).toBeTruthy();
    });

    it('generates WIF parseable by ECPair', () => {
      const { wif } = generateSignetKeypair();
      const keyPair = ECPair.fromWIF(wif, SIGNET_NETWORK);
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(33); // compressed
    });

    it('generates address starting with tb1 (testnet P2WPKH)', () => {
      const { address } = generateSignetKeypair();
      expect(address).toMatch(/^tb1/);
    });

    it('generates unique keypairs on each call', () => {
      const a = generateSignetKeypair();
      const b = generateSignetKeypair();
      expect(a.wif).not.toBe(b.wif);
      expect(a.address).not.toBe(b.address);
    });

    it('generates address derivable from WIF', () => {
      const { wif, address } = generateSignetKeypair();
      const derived = addressFromWif(wif);
      expect(derived).toBe(address);
    });
  });

  describe('addressFromWif', () => {
    it('derives correct address from known test WIF', () => {
      // Generate a keypair and verify round-trip
      const keyPair = ECPair.makeRandom({ network: SIGNET_NETWORK });
      const { address: expected } = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: SIGNET_NETWORK,
      });
      const derived = addressFromWif(keyPair.toWIF());
      expect(derived).toBe(expected);
    });

    it('throws on invalid WIF', () => {
      expect(() => addressFromWif('not-a-valid-wif')).toThrow();
    });

    it('throws on mainnet WIF (wrong network)', () => {
      const mainnetKey = ECPair.makeRandom({ network: bitcoin.networks.bitcoin });
      const mainnetWif = mainnetKey.toWIF();
      expect(() => addressFromWif(mainnetWif)).toThrow();
    });
  });

  describe('isValidSignetWif', () => {
    it('returns true for valid Signet WIF', () => {
      const { wif } = generateSignetKeypair();
      expect(isValidSignetWif(wif)).toBe(true);
    });

    it('returns false for invalid string', () => {
      expect(isValidSignetWif('garbage')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidSignetWif('')).toBe(false);
    });

    it('returns false for mainnet WIF', () => {
      const mainnetKey = ECPair.makeRandom({ network: bitcoin.networks.bitcoin });
      expect(isValidSignetWif(mainnetKey.toWIF())).toBe(false);
    });
  });

  describe('SIGNET_NETWORK', () => {
    it('uses testnet parameters', () => {
      expect(SIGNET_NETWORK).toBe(bitcoin.networks.testnet);
    });
  });
});
