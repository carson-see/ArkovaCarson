/**
 * F-D0-5 (fullsoak 2026-08-12, day0-bl2-secured-e2e-evidence.md §2.6a): a
 * `fetch(...)` whose REQUEST is guarded by `AbortSignal.timeout(...)` can still
 * park forever on the BODY read — `await response.json()` / `.text()` carries
 * no deadline of its own, and a provider that stalls after sending headers
 * leaves the awaiting job suspended indefinitely. In production that parked
 * await kept a run-lease heartbeat renewing for 35+ minutes while
 * SUBMITTED→SECURED promotion was disabled for every tenant.
 *
 * These tests pin the primitive that closes that hole: a bounded body read
 * that ALWAYS settles by its deadline, regardless of whether the runtime's
 * fetch implementation honors an abort mid-body-read.
 */

import { describe, it, expect, vi } from 'vitest';
import { BodyReadTimeoutError, readJsonBounded, readTextBounded } from './body-read-timeout.js';

/** A body read that never settles — the exact prod failure mode. */
const parked = <T>(): Promise<T> => new Promise<T>(() => {});

describe('readJsonBounded', () => {
  it('passes a timely body straight through', async () => {
    const response = { json: () => Promise.resolve({ txid: 'abc', status: { confirmed: true } }) };
    await expect(readJsonBounded(response, 'https://mempool.space/api/tx/abc', 1_000)).resolves.toEqual({
      txid: 'abc',
      status: { confirmed: true },
    });
  });

  it('rejects a parked body read at the deadline instead of waiting forever', async () => {
    const response = { json: () => parked() };
    const started = Date.now();
    await expect(
      readJsonBounded(response, 'https://mempool.space/api/tx/abc', 30),
    ).rejects.toThrow(BodyReadTimeoutError);
    // Generous ceiling — the point is "settles promptly", not exact timing.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('names the url and deadline in the error, for log correlation', async () => {
    const response = { json: () => parked() };
    await expect(
      readJsonBounded(response, 'https://mempool.space/api/tx/abc', 30),
    ).rejects.toThrow(/mempool\.space\/api\/tx\/abc.*30ms/);
  });

  it('propagates a real read error unchanged, not as a timeout', async () => {
    const response = { json: () => Promise.reject(new Error('bad json body')) };
    await expect(readJsonBounded(response, 'https://x/api', 1_000)).rejects.toThrow('bad json body');
  });

  it('attempts best-effort stream cancellation and survives a locked stream', async () => {
    // A stream locked by the pending read REJECTS its cancel() per WHATWG —
    // that rejection must be swallowed, not surfaced over the timeout error.
    const cancel = vi.fn(() => Promise.reject(new TypeError('ReadableStream is locked')));
    const response = { json: () => parked(), body: { cancel } };
    await expect(readJsonBounded(response, 'https://x/api', 20)).rejects.toThrow(BodyReadTimeoutError);
    expect(cancel).toHaveBeenCalled();
  });

  it('observes a body that settles after the deadline so it cannot become an unhandled rejection', async () => {
    let rejectLate!: (error: Error) => void;
    const response = {
      json: () => new Promise<never>((_, reject) => { rejectLate = reject; }),
    };
    await expect(readJsonBounded(response, 'https://x/api', 20)).rejects.toThrow(BodyReadTimeoutError);
    // The socket dies long after we gave up. Vitest fails the run on an
    // unhandled rejection, so surviving this IS the assertion.
    rejectLate(new Error('socket closed long after the deadline'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('readTextBounded', () => {
  it('passes a timely body straight through', async () => {
    const response = { text: () => Promise.resolve('123456') };
    await expect(
      readTextBounded(response, 'https://mempool.space/api/blocks/tip/height', 1_000),
    ).resolves.toBe('123456');
  });

  it('rejects a parked body read at the deadline instead of waiting forever', async () => {
    const response = { text: () => parked<string>() };
    await expect(
      readTextBounded(response, 'https://mempool.space/api/blocks/tip/height', 30),
    ).rejects.toThrow(BodyReadTimeoutError);
  });
});
