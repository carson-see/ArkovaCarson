/**
 * Safe Web Storage helpers — SCRUM-3167 review batch round 2 (R8).
 *
 * `mfaPolicy.ts` and `mfaCapabilityCooldown.ts` each hand-rolled the same
 * try/catch-and-swallow pattern around `localStorage`/`sessionStorage`
 * access. Real browsers throw from these calls in private browsing,
 * storage-disabled, or quota-exceeded conditions — and in THIS repo's own
 * vitest environment, the global `localStorage` is a non-functional Node
 * built-in stub that throws on every call (see `mfaPolicy.ts`'s module
 * doc comment), so this guard is exercised on every local test run, not
 * just a theoretical edge case. Takes the `Storage` instance explicitly
 * (never reaches for `localStorage`/`sessionStorage` itself) so callers
 * stay testable with a plain in-memory fake.
 */

export function readItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeItem(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage unavailable — the caller's in-memory state (if any) still
    // gates behaviour for the rest of this page load; only cross-reload
    // persistence is lost.
  }
}

export function removeItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // ignore — nothing to clean up if storage never accepted the write
  }
}
