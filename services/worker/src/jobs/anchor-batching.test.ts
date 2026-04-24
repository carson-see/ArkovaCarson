import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHORS_PER_BITCOIN_TX,
  MIN_ANCHORS_PER_BITCOIN_TX,
  resolveAnchorBatchSize,
} from './anchor-batching.js';

describe('anchor batching contract', () => {
  it('pins the platform-wide Bitcoin transaction cap to 10k anchors', () => {
    expect(MAX_ANCHORS_PER_BITCOIN_TX).toBe(10_000);
  });

  it('defaults invalid values to the 10k cap', () => {
    expect(resolveAnchorBatchSize()).toBe(10_000);
    expect(resolveAnchorBatchSize('not-a-number')).toBe(10_000);
  });

  it('allows lower test overrides but never below the floor', () => {
    expect(resolveAnchorBatchSize(500)).toBe(500);
    expect(resolveAnchorBatchSize(1)).toBe(MIN_ANCHORS_PER_BITCOIN_TX);
  });

  it('never allows an override above 10k', () => {
    expect(resolveAnchorBatchSize(50_000)).toBe(10_000);
  });
});
