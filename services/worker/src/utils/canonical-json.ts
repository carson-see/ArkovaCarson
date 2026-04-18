/**
 * Canonical JSON — deterministic serialisation with sorted keys.
 *
 * Two entry points:
 *   - `deepSortKeys(value)` returns a recursively key-sorted copy of the
 *     input. Callers usually pair this with `JSON.stringify` (e.g. for
 *     SHA-256 hashing in `extraction-manifest.ts`).
 *   - `canonicaliseJson(value)` returns the canonical string directly —
 *     what you want when you're about to sign the bytes (e.g. proof
 *     bundles, JWS payloads). Skips `undefined` values the same way
 *     `JSON.stringify` does.
 *
 * Both treat primitives, arrays, and plain objects. `Date`, `Map`, `Set`,
 * etc. are out of scope — if those ever need canonical handling, convert
 * them to plain values before calling.
 */

export function deepSortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicaliseJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicaliseJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicaliseJson(v)}`)
    .join(',')}}`;
}
