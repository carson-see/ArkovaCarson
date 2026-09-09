/**
 * safeStorage tests — SCRUM-3167 review batch round 2 (R8).
 *
 * `mfaPolicy.ts`'s date-override read and `mfaCapabilityCooldown.ts`'s
 * read/write/remove each hand-rolled the identical
 * try/catch-swallow-and-return-a-safe-default pattern around
 * `localStorage`/`sessionStorage` access (real browsers throw in private
 * browsing / storage-disabled / quota-exceeded conditions — and, in this
 * repo's own vitest environment, the global `localStorage` is a
 * non-functional Node built-in stub that throws on every call, so this
 * try/catch is exercised on every local test run, not just a theoretical
 * edge case). One shared helper, one place to keep the contract honest.
 */
import { describe, expect, it, vi } from 'vitest';
import { readItem, writeItem, removeItem } from './safeStorage';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('safeStorage', () => {
  it('readItem returns the stored value', () => {
    const storage = fakeStorage();
    storage.setItem('k', 'v');
    expect(readItem(storage, 'k')).toBe('v');
  });

  it('readItem returns null for a missing key', () => {
    expect(readItem(fakeStorage(), 'missing')).toBeNull();
  });

  it('readItem returns null (not throw) when storage.getItem throws', () => {
    const storage = fakeStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => readItem(storage, 'k')).not.toThrow();
    expect(readItem(storage, 'k')).toBeNull();
  });

  it('writeItem writes the value', () => {
    const storage = fakeStorage();
    writeItem(storage, 'k', 'v');
    expect(storage.getItem('k')).toBe('v');
  });

  it('writeItem does not throw when storage.setItem throws', () => {
    const storage = fakeStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeItem(storage, 'k', 'v')).not.toThrow();
  });

  it('removeItem removes the value', () => {
    const storage = fakeStorage();
    storage.setItem('k', 'v');
    removeItem(storage, 'k');
    expect(storage.getItem('k')).toBeNull();
  });

  it('removeItem does not throw when storage.removeItem throws', () => {
    const storage = fakeStorage();
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => removeItem(storage, 'k')).not.toThrow();
  });
});
