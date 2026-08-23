/**
 * Surrogate-safe UTF-16 truncation.
 *
 * Born from the 2026-08-17 poison-record incident
 * (docs/staging/fullsoak-2026-08/prod-repair-poison-record-2026-08-17.md):
 * `String.prototype.slice` cuts at UTF-16 CODE-UNIT boundaries, so a cut that
 * lands inside a surrogate pair leaves a lone high surrogate at the end of
 * the string. A lone surrogate cannot be encoded as UTF-8 and is rejected by
 * PostgREST as request-body JSON (`PGRST102 "Empty or invalid json"`) — one
 * such string in `anchors.description` poisoned the head of the public-record
 * anchoring queue for 16 days.
 *
 * Guarantees: the result is (a) at most `maxUnits` UTF-16 units, and (b)
 * well-formed UTF-16 — it survives UTF-8 encoding and JSON serialization.
 *
 * Approach, in order:
 *   1. Plain code-unit slice (what callers did before, unchanged semantics).
 *   2. Drop a trailing high surrogate left by the cut. This is the whole fix
 *      for strings that were well-formed on the way in — which everything
 *      read out of Postgres is, since neither UTF-8 columns nor jsonb can
 *      carry lone surrogates. Dropping beats `toWellFormed()`'s U+FFFD
 *      substitution here: no replacement character appears in user-visible
 *      descriptions/filenames.
 *   3. `String.prototype.toWellFormed()` (ES2024; Node >= 20, our engines
 *      floor is 20.14) as a final invariant guard for inputs that were
 *      ALREADY malformed — feature-detected so the helper stays correct (for
 *      the truncation-poison class) on runtimes without it.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

type MaybeWellFormable = string & { toWellFormed?: () => string };

export function truncateUtf16Safe(input: string, maxUnits: number): string {
  let out = input.length > maxUnits ? input.slice(0, maxUnits) : input;

  // charCodeAt on an empty string is NaN — both comparisons are then false.
  const lastUnit = out.charCodeAt(out.length - 1);
  if (lastUnit >= HIGH_SURROGATE_START && lastUnit <= HIGH_SURROGATE_END) {
    out = out.slice(0, -1);
  }

  const toWellFormed = (out as MaybeWellFormable).toWellFormed;
  return typeof toWellFormed === 'function' ? toWellFormed.call(out) : out;
}
