/**
 * The oracle for PostgREST `.in()` filter width, for tests.
 *
 * Mirrors `PostgrestFilterBuilder.in`: double-quote any value containing `,`,
 * `(` or `)`, join with `,`, wrap in `in.(…)`, then hand the whole thing to
 * `URLSearchParams`. Computed all-at-once here while the production helper
 * (`utils/postgrest-filter.ts`) accumulates per value, so the two remain
 * independent derivations of the same spec rather than the same code twice.
 *
 * Deliberately NOT `encodeURIComponent`. That is a different encoder — it
 * leaves `(`/`)` unescaped and encodes a space as `%20` rather than `+` — and
 * measuring with it under-counts a reserved-character value roughly threefold,
 * which is exactly how a chunk went over budget while reporting itself safe.
 * Every test that asserts a filter fits the budget must use THIS function.
 */
export function encodedInFilterBytesFor(values: string[]): number {
  const cleaned = values.map((v) => (/[,()]/.test(v) ? `"${v}"` : v)).join(',');
  return new URLSearchParams([['id', `in.(${cleaned})`]]).toString().length - 'id='.length;
}
