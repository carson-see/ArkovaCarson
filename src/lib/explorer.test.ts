/**
 * Unit tests for explorer link helpers (BETA-01)
 */

import { describe, it, expect } from 'vitest';
import { getExplorerTxUrl, getExplorerBlockUrl } from './explorer';

describe('getExplorerTxUrl', () => {
  it('returns null for null txid', () => {
    expect(getExplorerTxUrl(null)).toBeNull();
  });

  it('returns null for undefined txid', () => {
    expect(getExplorerTxUrl(undefined)).toBeNull();
  });

  it('builds testnet4 URL when network is testnet4', () => {
    const url = getExplorerTxUrl('abc123', 'testnet4');
    expect(url).toBe('https://mempool.space/testnet4/tx/abc123');
  });

  it('builds mainnet URL without network path prefix', () => {
    const url = getExplorerTxUrl('abc123', 'mainnet');
    expect(url).toBe('https://mempool.space/tx/abc123');
  });

  it('builds signet URL', () => {
    const url = getExplorerTxUrl('abc123', 'signet');
    expect(url).toBe('https://mempool.space/signet/tx/abc123');
  });

  it('builds testnet URL', () => {
    const url = getExplorerTxUrl('abc123', 'testnet');
    expect(url).toBe('https://mempool.space/testnet/tx/abc123');
  });
});

describe('getExplorerBlockUrl', () => {
  it('returns null for null blockHeight', () => {
    expect(getExplorerBlockUrl(null)).toBeNull();
  });

  it('returns null for zero blockHeight', () => {
    expect(getExplorerBlockUrl(0)).toBeNull();
  });

  it('returns null for negative blockHeight', () => {
    expect(getExplorerBlockUrl(-1)).toBeNull();
  });

  it('builds testnet4 block URL', () => {
    const url = getExplorerBlockUrl(200100, 'testnet4');
    expect(url).toBe('https://mempool.space/testnet4/block/200100');
  });

  it('builds mainnet block URL', () => {
    const url = getExplorerBlockUrl(800001, 'mainnet');
    expect(url).toBe('https://mempool.space/block/800001');
  });
});
