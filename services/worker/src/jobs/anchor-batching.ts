/**
 * Shared Bitcoin anchoring batch limits.
 *
 * One Bitcoin transaction commits one Merkle root, so the cap is about
 * operational payload size, not OP_RETURN capacity per leaf. Keep all pipeline
 * anchoring jobs on the same contract so throughput cannot drift by subsystem.
 */

export const MAX_ANCHORS_PER_BITCOIN_TX = 10_000;
export const MIN_ANCHORS_PER_BITCOIN_TX = 100;

/** Max rows PostgREST returns in one response. Governs pagination, NOT filter width. */
export const POSTGREST_ROW_LIMIT = 1_000;

/**
 * Byte budget for a single URL-encoded query-string filter value.
 *
 * PostgREST sits behind a proxy that rejects oversized request lines with
 * 400 Bad Request. 8 KiB is comfortably under the usual 16 KiB ceiling.
 */
export const POSTGREST_URL_FILTER_BUDGET_BYTES = 8_192;

/**
 * Max ids per `.in('id', chunk)` filter.
 *
 * A UUID costs 39 bytes in the encoded `in.(...)` list (36 + a `%2C`
 * separator), so this stays inside POSTGREST_URL_FILTER_BUDGET_BYTES with
 * headroom for the rest of the request line.
 *
 * Do NOT chunk id filters by POSTGREST_ROW_LIMIT — that conflates two unrelated
 * limits (how many rows come back vs. how wide the URL may be) and is exactly
 * what silently killed public-record anchoring for 70+ hours on 2026-07-29.
 *
 * Prefer `chunkForInFilter` over reading this constant directly: it removes the
 * choice of size from the call site entirely, which is the mistake that
 * recurred (see that function's docstring).
 */
export const POSTGREST_IN_FILTER_CHUNK = 200;

/**
 * Encoded length of one query-string component on the wire.
 *
 * Measured with `URLSearchParams`, which is what postgrest-js actually uses to
 * serialize a filter (`url.searchParams.append(column, …)`). That is
 * application/x-www-form-urlencoded, NOT `encodeURIComponent`: `(`/`)`/`'`/`!`/`~`
 * cost 3 bytes here and 1 there, and a space costs 1 here (`+`) and 3 there.
 * Measuring with the wrong encoder is how a "guaranteed" chunk goes over budget.
 */
function wireLength(text: string): number {
  return new URLSearchParams([['', text]]).toString().length - 1;
}

/**
 * postgrest-js double-quotes any value containing `,`, `(` or `)` before
 * joining them (`PostgrestFilterBuilder.in`). Those quotes are on the request
 * line, so they are on the budget — and they are why a docket number or a URL
 * with parentheses can cost several times a UUID.
 */
function inFilterValueWireLength(value: string): number {
  return wireLength(/[,()]/.test(value) ? `"${value}"` : value);
}

/** Encoded cost of the `in.()` wrapper itself. */
const IN_FILTER_ENVELOPE_BYTES = wireLength('in.()');

/** Encoded cost of the separator between two values (`,` → `%2C`). */
const IN_FILTER_SEPARATOR_BYTES = wireLength(',');

/** One `.in()` call's worth of filter values, guaranteed inside the URL budget. */
export interface InFilterChunk {
  /** The values for this chunk. Never wider than the budget (see caveat below). */
  readonly values: string[];
  /** Offset of this chunk in the source array — use for `chunkStart` logging. */
  readonly start: number;
  /** 0-based ordinal of this chunk. */
  readonly index: number;
  /** Total number of chunks produced for this call. */
  readonly total: number;
}

/**
 * Split filter values into `.in()`-safe chunks. The ONLY supported way to build
 * a PostgREST `.in()` filter over a caller-sized list.
 *
 * Why this shape:
 *
 *  - **No size parameter.** Both production defects in this class were a call
 *    site picking the wrong constant — there were two plausible ones in scope
 *    (`POSTGREST_ROW_LIMIT`, `POSTGREST_IN_FILTER_CHUNK`) and a hand-rolled
 *    `for (i += SIZE)` loop to put it in. Removing the knob removes the
 *    mistake; a new call site cannot opt into the wrong width because there is
 *    nothing to opt into.
 *  - **`string[]`, not generic `T[]`.** Chunking a list of ROWS and mapping to
 *    ids afterwards hides the actual filter width from the only code that can
 *    measure it. Requiring the projection first (`rows.map(r => r.id)`) means
 *    the values chunked are exactly the values sent.
 *  - **Bytes, not just count, measured with the REAL serializer.** The
 *    200-value cap is calibrated for UUIDs; `source_id` / `public_id` /
 *    64-char fingerprints are not UUIDs, so the chunk closes on whichever of
 *    the two limits binds first. The byte figure comes from `URLSearchParams`
 *    (what postgrest-js uses) and includes the double quotes postgrest-js adds
 *    around values containing `,`, `(` or `)` — measuring with
 *    `encodeURIComponent` instead under-counts such a value by ~3x and would
 *    let a "guaranteed" chunk sail past the budget.
 *
 * Caveat: a single value larger than the whole budget cannot be split. It is
 * emitted alone so the request fails loudly at the call site rather than being
 * silently dropped — the silent-empty result is what hid the 70-hour outage.
 */
export function chunkForInFilter(values: readonly string[]): InFilterChunk[] {
  const chunks: Array<{ values: string[]; start: number }> = [];
  let current: string[] = [];
  let start = 0;
  let bytes = IN_FILTER_ENVELOPE_BYTES;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const valueBytes = inFilterValueWireLength(value);
    const cost = current.length === 0 ? valueBytes : valueBytes + IN_FILTER_SEPARATOR_BYTES;
    const wouldOverflow =
      current.length >= POSTGREST_IN_FILTER_CHUNK ||
      bytes + cost > POSTGREST_URL_FILTER_BUDGET_BYTES;

    // `current.length > 0` guard: a lone over-budget value has nowhere else to
    // go, so it starts (and ends) its own chunk rather than being discarded.
    if (current.length > 0 && wouldOverflow) {
      chunks.push({ values: current, start });
      current = [];
      start = i;
      bytes = IN_FILTER_ENVELOPE_BYTES + valueBytes;
    } else {
      bytes += cost;
    }

    current.push(value);
  }

  if (current.length > 0) chunks.push({ values: current, start });

  return chunks.map((chunk, index) => ({ ...chunk, index, total: chunks.length }));
}

export function resolveAnchorBatchSize(rawValue?: number | string | null): number {
  const parsed =
    typeof rawValue === 'number'
      ? rawValue
      : Number.parseInt(String(rawValue ?? MAX_ANCHORS_PER_BITCOIN_TX), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MAX_ANCHORS_PER_BITCOIN_TX;
  }

  return Math.min(
    Math.max(Math.floor(parsed), MIN_ANCHORS_PER_BITCOIN_TX),
    MAX_ANCHORS_PER_BITCOIN_TX,
  );
}
