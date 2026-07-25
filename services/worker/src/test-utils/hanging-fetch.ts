/**
 * Shared `fetch` test double for unbounded-fetch / timeout regression tests
 * (SCRUM-2975 and sibling fixes in jobs/*Fetcher.ts).
 *
 * Simulates a stalled upstream: the returned mock never resolves on its own,
 * but DOES honour `init.signal` the way real fetch does — rejecting with the
 * signal's abort reason once the signal fires (whether that signal comes
 * from `AbortSignal.timeout()` or a manual `AbortController`). This is what
 * lets a test prove a timeout actually bounds a call without waiting for a
 * real network hang or mocking a real socket.
 *
 * If `init.signal` is undefined, the returned promise never settles at
 * all — which is deliberate: it reproduces the pre-fix bug (no signal wired
 * = genuinely hangs forever) so a test asserting on elapsed time will fail
 * loudly (timeout) rather than silently passing.
 */
import { vi } from 'vitest';

export function makeHangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal wired — hangs forever (the bug)
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  });
}
