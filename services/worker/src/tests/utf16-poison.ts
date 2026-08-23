/**
 * Test helpers for the surrogate-split truncation class (2026-08-17 poison
 * record, PR #2266). A bare `.slice(0, N)` on UTF-16 text can cut inside a
 * surrogate pair; the lone high surrogate survives `.trim()`/whitespace
 * collapsing, cannot encode as UTF-8, and makes the enclosing PostgREST
 * request body invalid JSON (PGRST102).
 *
 * `poisonAt(cap)` builds a string longer than `cap` whose unit at index
 * `cap - 1` is a HIGH surrogate, so `input.slice(0, cap)` ends exactly on a
 * split pair. Surrogate-pair parity: with a prefix of `p` single-unit chars
 * followed by astral pairs, high surrogates sit at indices `p, p+2, ...` —
 * so `p = (cap - 1) % 2` puts one at `cap - 1` for any cap.
 */

/** String of length `> cap` whose `.slice(0, cap)` ends on a split surrogate pair. */
export function poisonAt(cap: number): string {
  const prefix = 'x'.repeat((cap - 1) % 2);
  const pairs = '\u{1F600}'.repeat(cap); // 😀 = 😀, 2 units each
  const out = prefix + pairs;
  const last = out.charCodeAt(cap - 1);
  // Self-check so a parity bug here can never silently green a suite.
  if (last < 0xd800 || last > 0xdbff) {
    throw new Error(`poisonAt(${cap}): unit ${cap - 1} is not a high surrogate`);
  }
  return out;
}

/** Well-formed UTF-16: no unpaired surrogate anywhere. */
export function isWellFormedUtf16(s: string): boolean {
  const maybe = s as string & { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === 'function') return maybe.isWellFormed();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Walk any JSON-ish value and return the paths of every ill-formed string —
 * i.e. every string that would poison a PostgREST request body.
 */
export function illFormedStringPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return isWellFormedUtf16(value) ? [] : [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => illFormedStringPaths(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      illFormedStringPaths(v, `${path}.${k}`),
    );
  }
  return [];
}
