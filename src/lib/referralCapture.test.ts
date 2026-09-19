/**
 * SCRUM-5024 — referral capture.
 *
 * The module runs `captureReferralCodeFromUrl()` at import time, so every test
 * re-imports it under `vi.resetModules()` with the URL and storage already
 * arranged. That is the real production sequence, not a convenience.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const KEY = 'arkova.referral';

function installStorage(): Storage {
  const map = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true, writable: true });
  return fake;
}

function setUrl(url: string): void {
  window.history.replaceState(null, '', url);
}

async function importFresh() {
  vi.resetModules();
  return import('./referralCapture');
}

describe('referralCapture', () => {
  let store: Storage;

  beforeEach(() => {
    store = installStorage();
    setUrl('/signup');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('normalizeReferralCode', () => {
    it('upper-cases and trims a valid code', async () => {
      const { normalizeReferralCode } = await importFresh();
      expect(normalizeReferralCode('  abcd2345 ')).toBe('ABCD2345');
    });

    it('rejects the ambiguous characters the DB CHECK rejects', async () => {
      const { normalizeReferralCode } = await importFresh();
      // referral_codes_code_format: ^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$
      // I, L, O, 0 and 1 are NOT in that class. A looser client regex such as
      // [A-Z2-9] would admit I/L/O and park a code guaranteed to come back
      // unknown_code from record_org_referral.
      expect(normalizeReferralCode('IBCD2345')).toBeNull();
      expect(normalizeReferralCode('LBCD2345')).toBeNull();
      expect(normalizeReferralCode('OBCD2345')).toBeNull();
      expect(normalizeReferralCode('0BCD2345')).toBeNull();
      expect(normalizeReferralCode('1BCD2345')).toBeNull();
    });

    it('rejects the wrong length and non-strings', async () => {
      const { normalizeReferralCode } = await importFresh();
      expect(normalizeReferralCode('ABCD234')).toBeNull();
      expect(normalizeReferralCode('ABCD23456')).toBeNull();
      expect(normalizeReferralCode('')).toBeNull();
      expect(normalizeReferralCode(null)).toBeNull();
      expect(normalizeReferralCode(undefined)).toBeNull();
    });
  });

  describe('capture at import', () => {
    it('parks a valid ?ref and strips it from the URL', async () => {
      setUrl('/signup?ref=abcd2345&utm_source=partner');
      const mod = await importFresh();

      expect(mod.readReferralCode()).toBe('ABCD2345');
      expect(window.location.search).toBe('?utm_source=partner');
      expect(window.location.search).not.toContain('ref=');
    });

    it('strips an INVALID ?ref too, and parks nothing', async () => {
      setUrl('/signup?ref=not-a-code');
      const mod = await importFresh();

      expect(window.location.search).toBe('');
      expect(store.getItem(KEY)).toBeNull();
      expect(mod.readReferralCode()).toBeNull();
    });

    it('leaves an unrelated URL untouched', async () => {
      setUrl('/signup?utm_source=partner');
      const mod = await importFresh();

      expect(window.location.search).toBe('?utm_source=partner');
      expect(mod.readReferralCode()).toBeNull();
    });

    it('preserves the hash while stripping ref', async () => {
      setUrl('/signup?ref=ABCD2345#section');
      await importFresh();
      expect(window.location.hash).toBe('#section');
      expect(window.location.search).toBe('');
    });

    it('last partner link wins', async () => {
      setUrl('/signup?ref=ABCD2345');
      await importFresh();
      setUrl('/signup?ref=PQRS6789');
      const mod = await importFresh();
      expect(mod.readReferralCode()).toBe('PQRS6789');
    });
  });

  describe('readReferralCode', () => {
    it('returns null and clears the entry once past the TTL', async () => {
      setUrl('/signup?ref=ABCD2345');
      const mod = await importFresh();
      const capturedAt = JSON.parse(store.getItem(KEY) as string).capturedAt as number;

      // Exact boundary, not a range: at exactly TTL the code is still live;
      // one millisecond later it is not.
      expect(mod.readReferralCode(capturedAt + mod.REFERRAL_TTL_MS)).toBe('ABCD2345');
      expect(mod.readReferralCode(capturedAt + mod.REFERRAL_TTL_MS + 1)).toBeNull();
      expect(store.getItem(KEY)).toBeNull();
    });

    it('drops a malformed stored entry instead of re-parsing it every load', async () => {
      const mod = await importFresh();
      store.setItem(KEY, '{not json');
      expect(mod.readReferralCode()).toBeNull();
      expect(store.getItem(KEY)).toBeNull();
    });

    it('drops a stored entry whose code no longer matches the DB format', async () => {
      const mod = await importFresh();
      store.setItem(KEY, JSON.stringify({ code: 'IIIIIIII', capturedAt: Date.now() }));
      expect(mod.readReferralCode()).toBeNull();
      expect(store.getItem(KEY)).toBeNull();
    });

    it('drops a stored entry with no usable capturedAt', async () => {
      const mod = await importFresh();
      store.setItem(KEY, JSON.stringify({ code: 'ABCD2345' }));
      expect(mod.readReferralCode()).toBeNull();
      expect(store.getItem(KEY)).toBeNull();
    });
  });

  it('clearReferralCode removes the parked code', async () => {
    setUrl('/signup?ref=ABCD2345');
    const mod = await importFresh();
    expect(mod.readReferralCode()).toBe('ABCD2345');
    mod.clearReferralCode();
    expect(mod.readReferralCode()).toBeNull();
  });

  it('survives a localStorage that throws on every call', async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        get length(): number {
          throw new Error('denied');
        },
        clear: () => {
          throw new Error('denied');
        },
        getItem: () => {
          throw new Error('denied');
        },
        key: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      } as unknown as Storage,
    });
    setUrl('/signup?ref=ABCD2345');
    const mod = await importFresh();

    // The URL is still cleaned and nothing throws; only cross-reload
    // persistence is lost.
    expect(window.location.search).toBe('');
    expect(mod.readReferralCode()).toBeNull();
    expect(() => mod.clearReferralCode()).not.toThrow();
  });
});
