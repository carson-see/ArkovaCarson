/**
 * Tests for the MEMPOOL_API_URL /api contract fix (SCRUM-3016 / BUG-2026-07-26-003).
 *
 * See mempool-url.ts's module docstring for the full incident writeup. Short
 * version: five call sites read `config.mempoolApiUrl` (the raw
 * MEMPOOL_API_URL env var) and disagreed on whether it already includes a
 * trailing `/api` segment. No single value satisfied all five, and this
 * froze 2 isolated soak rigs for ~24h before being root-caused.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeMempoolHostUrl,
  resolveMempoolApiBase,
  resolveMempoolHostBase,
} from './mempool-url.js';

describe('normalizeMempoolHostUrl', () => {
  it('returns undefined for an unset value', () => {
    expect(normalizeMempoolHostUrl(undefined)).toBeUndefined();
  });

  it('treats an empty string as unset', () => {
    expect(normalizeMempoolHostUrl('')).toBeUndefined();
  });

  it('leaves a bare host untouched', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space')).toBe('https://mempool.space');
  });

  it('strips a trailing slash', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/')).toBe('https://mempool.space');
  });

  it('strips a trailing /api segment', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/api')).toBe('https://mempool.space');
  });

  it('strips a trailing /api/ (segment + slash)', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/api/')).toBe('https://mempool.space');
  });

  it('preserves a network-suffixed path that is not /api', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/signet')).toBe(
      'https://mempool.space/signet',
    );
  });

  it('strips a trailing /api after a network-suffixed path', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/signet/api')).toBe(
      'https://mempool.space/signet',
    );
  });

  it('does not strip "/api" as a mid-path substring, only a trailing segment', () => {
    expect(normalizeMempoolHostUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('resolveMempoolApiBase (for consumers that append no further /api themselves)', () => {
  it('falls back verbatim when unset', () => {
    expect(resolveMempoolApiBase(undefined, 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('falls back verbatim on an empty string', () => {
    expect(resolveMempoolApiBase('', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('appends /api when the operator set a bare host', () => {
    expect(resolveMempoolApiBase('https://mempool.space', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('does not double up /api when the operator already included it', () => {
    expect(resolveMempoolApiBase('https://mempool.space/api', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('normalizes a trailing slash before appending /api', () => {
    expect(resolveMempoolApiBase('https://mempool.space/', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('produces the SAME result regardless of which of the two conventions the operator used (the actual incident)', () => {
    const withApi = resolveMempoolApiBase('https://custom.example.com/api', 'https://mempool.space/api');
    const withoutApi = resolveMempoolApiBase('https://custom.example.com', 'https://mempool.space/api');
    expect(withApi).toBe(withoutApi);
    expect(withApi).toBe('https://custom.example.com/api');
  });
});

describe('resolveMempoolHostBase (for consumers that append /api/... themselves)', () => {
  it('falls back verbatim when unset', () => {
    expect(resolveMempoolHostBase(undefined, 'https://mempool.space')).toBe('https://mempool.space');
  });

  it('returns a bare host unchanged when the operator set one', () => {
    expect(resolveMempoolHostBase('https://custom.example.com', 'https://mempool.space')).toBe(
      'https://custom.example.com',
    );
  });

  it('strips a trailing /api when the operator included it (the actual incident, other direction)', () => {
    expect(resolveMempoolHostBase('https://custom.example.com/api', 'https://mempool.space')).toBe(
      'https://custom.example.com',
    );
  });

  it('produces the SAME result regardless of which of the two conventions the operator used', () => {
    const withApi = resolveMempoolHostBase('https://custom.example.com/api', 'https://mempool.space');
    const withoutApi = resolveMempoolHostBase('https://custom.example.com', 'https://mempool.space');
    expect(withApi).toBe(withoutApi);
    expect(withApi).toBe('https://custom.example.com');
  });
});
