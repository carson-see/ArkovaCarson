/**
 * Tests for lazyWithRetry (SCRUM-2246 / HARDEN-1-C).
 *
 * Covers the stale-chunk recovery contract:
 *  (a) reject-once-then-succeed → resolves, no reload
 *  (b) always chunk-error → exactly one reload, sentinel set
 *  (c) sentinel already set → no second reload, error propagates
 *  (d) non-chunk error → no reload
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  loadWithRetry,
  RETRY_SENTINEL_KEY,
} from './lazyWithRetry';

/** A representative chunk-load error message from each major browser. */
const CHROME_MSG = 'Failed to fetch dynamically imported module: https://app.arkova.ai/assets/DashboardPage-a1b2c3.js';
const FIREFOX_MSG = 'error loading dynamically imported module: https://app.arkova.ai/assets/DashboardPage-a1b2c3.js';
const SAFARI_MSG = 'Importing a module script failed.';
const VITE_PRELOAD_MSG = 'Unable to preload CSS for /assets/DashboardPage-a1b2c3.js';

function makeChunkError(message: string): Error {
  return new Error(message);
}

describe('isChunkLoadError', () => {
  it('matches Chrome chunk-load message', () => {
    expect(isChunkLoadError(makeChunkError(CHROME_MSG))).toBe(true);
  });

  it('matches Firefox chunk-load message', () => {
    expect(isChunkLoadError(makeChunkError(FIREFOX_MSG))).toBe(true);
  });

  it('matches Safari chunk-load message', () => {
    expect(isChunkLoadError(makeChunkError(SAFARI_MSG))).toBe(true);
  });

  it('matches Vite preload-failure message', () => {
    expect(isChunkLoadError(makeChunkError(VITE_PRELOAD_MSG))).toBe(true);
  });

  it('does NOT match an ordinary runtime error', () => {
    expect(isChunkLoadError(makeChunkError('Cannot read properties of undefined'))).toBe(false);
  });

  it('does NOT match non-error values', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('loadWithRetry', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reloadSpy = vi.fn();
    // jsdom's location.reload is not implemented; replace it with a spy.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { ...globalThis.location, reload: reloadSpy },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  // (a) reject-once-then-succeed → resolves, no reload
  it('retries a transient chunk failure and resolves without reloading', async () => {
    const mod = { default: () => null };
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw makeChunkError(CHROME_MSG);
      return mod;
    });

    const result = await loadWithRetry(loader, { retries: 2, backoffMs: 1 });

    expect(result).toBe(mod);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RETRY_SENTINEL_KEY)).toBeNull();
  });

  // (b) always chunk-error → exactly one reload, sentinel set
  it('reloads exactly once and sets the sentinel on persistent chunk failure', async () => {
    const loader = vi.fn(async () => {
      throw makeChunkError(FIREFOX_MSG);
    });

    // The reload path never resolves the import in real life (the page reloads),
    // so the returned promise stays pending; assert the side effects instead.
    void loadWithRetry(loader, { retries: 2, backoffMs: 1 });

    await vi.waitFor(() => {
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
    expect(sessionStorage.getItem(RETRY_SENTINEL_KEY)).not.toBeNull();
  });

  // (c) sentinel already set → no second reload, error propagates
  it('does not reload again when the sentinel is already set, and rethrows', async () => {
    sessionStorage.setItem(RETRY_SENTINEL_KEY, '1');
    const err = makeChunkError(SAFARI_MSG);
    const loader = vi.fn(async () => {
      throw err;
    });

    await expect(loadWithRetry(loader, { retries: 2, backoffMs: 1 })).rejects.toBe(err);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  // (d) non-chunk error → no reload (and propagates without retrying past the limit)
  it('does not reload on a non-chunk error and propagates it', async () => {
    const err = makeChunkError('Cannot read properties of undefined (reading "x")');
    const loader = vi.fn(async () => {
      throw err;
    });

    await expect(loadWithRetry(loader, { retries: 2, backoffMs: 1 })).rejects.toBe(err);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RETRY_SENTINEL_KEY)).toBeNull();
    // Non-chunk errors should fail fast, not burn through retries.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('clears the sentinel after a successful load (so a later deploy can recover again)', async () => {
    sessionStorage.setItem(RETRY_SENTINEL_KEY, '1');
    const mod = { default: () => null };
    const loader = vi.fn(async () => mod);

    const result = await loadWithRetry(loader, { retries: 2, backoffMs: 1 });

    expect(result).toBe(mod);
    expect(sessionStorage.getItem(RETRY_SENTINEL_KEY)).toBeNull();
  });
});
