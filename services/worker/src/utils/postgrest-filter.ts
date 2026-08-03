/**
 * PostgREST request-line limits and the safe way to build an `.in()` filter.
 *
 * These constants and `chunkForInFilter` used to live in `jobs/anchor-batching.ts`
 * next to the Bitcoin batch caps. They are a wire-shape concern with no
 * anchoring semantics, every non-`jobs` consumer had to justify a
 * `utils/ -> jobs/` import to reach them, and a domain test that factory-mocks
 * `anchor-batching.js` would silently blank the helper for every module in its
 * import graph. One neutral home instead.
 */

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
 * Max values per `.in()` filter.
 *
 * Prefer `chunkForInFilter` over reading this directly — it removes the choice
 * of size from the call site entirely, which is the mistake that twice reached
 * production. Never chunk an `.in()` filter by `POSTGREST_ROW_LIMIT`: that
 * conflates how many rows come back with how wide the URL may be, and is what
 * silently killed public-record anchoring for 70+ hours on 2026-07-29.
 */
export const POSTGREST_IN_FILTER_CHUNK = 200;

/**
 * Encoded length of one query-string component on the wire.
 *
 * Measured with `URLSearchParams`, which is what postgrest-js uses to serialize
 * a filter (`url.searchParams.append(column, …)`). That is
 * application/x-www-form-urlencoded, NOT `encodeURIComponent`: `(`/`)`/`'`/`!`/`~`
 * cost 3 bytes here and 1 there, and a space costs 1 here (`+`) and 3 there.
 * Measuring with the wrong encoder is how a "guaranteed" chunk goes over budget.
 */
export function wireLength(text: string): number {
  return new URLSearchParams([['', text]]).toString().length - 1;
}

/**
 * postgrest-js double-quotes any value containing `,`, `(` or `)` before
 * joining them (`PostgrestFilterBuilder.in`). Those quotes are on the request
 * line, so they are on the budget — and they are why a docket number or a URL
 * with parentheses can cost several times a UUID.
 */
export function inFilterValueWireLength(value: string): number {
  return wireLength(/[,()]/.test(value) ? `"${value}"` : value);
}

/** Encoded cost of the `in.()` wrapper itself. */
const IN_FILTER_ENVELOPE_BYTES = wireLength('in.()');

/** Encoded cost of the separator between two values (`,` -> `%2C`). */
const IN_FILTER_SEPARATOR_BYTES = wireLength(',');

/**
 * An empty chunk pre-charges one separator, which its first value then refunds
 * by paying the same `SEPARATOR + value` price as every other value. After n
 * values the running total is `ENVELOPE - SEP + n(SEP + v)` =
 * `ENVELOPE + (n-1)SEP + Σv`, i.e. exactly the wire cost, with one uniform
 * per-value price instead of a first-value special case.
 */
const EMPTY_CHUNK_BYTES = IN_FILTER_ENVELOPE_BYTES - IN_FILTER_SEPARATOR_BYTES;

/** One `.in()` call's worth of filter values, guaranteed inside the URL budget. */
export interface InFilterChunk {
  /** The values for this chunk. */
  readonly values: string[];
  /** Offset of this chunk in the source array — use for `chunkStart` logging. */
  readonly start: number;
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
 *  - **Bytes, not just count.** The 200-value cap is calibrated for UUIDs;
 *    `source_id` / `public_id` / 64-char fingerprints are not, so chunks close
 *    on whichever limit binds first (measured by `inFilterValueWireLength`).
 *
 * Caveat: a single value larger than the whole budget cannot be split, so it is
 * emitted alone rather than dropped or padded into a chunk. Whether the
 * resulting request failure is visible is the CALLER's error policy — this
 * function executes nothing. See `assertNotAllChunksFailed`.
 */
export function chunkForInFilter(values: readonly string[]): InFilterChunk[] {
  const chunks: InFilterChunk[] = [];
  let current: string[] = [];
  let start = 0;
  let bytes = EMPTY_CHUNK_BYTES;

  for (let i = 0; i < values.length; i += 1) {
    const cost = IN_FILTER_SEPARATOR_BYTES + inFilterValueWireLength(values[i]);

    // `current.length > 0`: a lone over-budget value has nowhere else to go, so
    // it starts (and ends) its own chunk rather than being discarded.
    if (
      current.length > 0 &&
      (current.length >= POSTGREST_IN_FILTER_CHUNK ||
        bytes + cost > POSTGREST_URL_FILTER_BUDGET_BYTES)
    ) {
      chunks.push({ values: current, start });
      current = [];
      start = i;
      bytes = EMPTY_CHUNK_BYTES;
    }

    bytes += cost;
    current.push(values[i]);
  }

  if (current.length > 0) chunks.push({ values: current, start });

  return chunks;
}

/**
 * Why a paged scan stopped.
 *
 * `complete` is the ONLY value that means "these are all the rows". Both others
 * mean the scan gave up early, and a caller that presents those rows as a full
 * set is making a claim it did not verify.
 */
export type PageScanStatus = 'complete' | 'row_budget_exceeded' | 'page_budget_exhausted';

export interface PageScan<T> {
  readonly rows: T[];
  readonly status: PageScanStatus;
}

/** A page read failed. Carries the offset so the caller can log where. */
export class PageScanError extends Error {
  constructor(
    readonly offset: number,
    readonly pgCode: string | null,
  ) {
    super(`postgrest page scan failed at offset ${offset}`);
    this.name = 'PageScanError';
  }
}

/**
 * Read every row a filter matches, one page at a time. The ONLY supported way
 * to scan an unbounded result set over PostgREST.
 *
 * Same argument as `chunkForInFilter`, on the other half of the same
 * `db-max-rows` ambiguity. That helper exists because call sites kept picking
 * the wrong `.in()` width; this one exists because they keep picking the wrong
 * termination condition, and it is the more dangerous mistake of the two —
 * a too-wide filter 400s loudly, while a scan that stops early returns a
 * plausible short answer at HTTP 200.
 *
 * Three rules, none of which a call site can now opt out of:
 *
 *  - **An empty page is the only end-of-data signal.** A SHORT page is not.
 *    PostgREST's `db-max-rows` is a server setting this code cannot see, and it
 *    may be lower than `POSTGREST_ROW_LIMIT`. `if (page.length < requested)
 *    break` then stops after the first page and reports a 5,000-row result set
 *    as 500 rows — the exact shape of the audit-sampling defect fixed in
 *    `api/v1/auditBatchVerify.ts`. The cost of the rule is one extra request
 *    per scan; the cost of breaking it is a wrong answer that looks right.
 *  - **Advance by rows RETURNED, never by the width requested.** Advancing by
 *    the requested width skips every row a short page withheld.
 *  - **A hard page ceiling.** The other two exits depend on the server
 *    behaving; this one does not. Exhausting it yields
 *    `page_budget_exhausted`, never a complete read — the loop cannot hang.
 *
 * Executes nothing itself: the caller supplies `fetchPage` and keeps ownership
 * of the query, exactly as `chunkForInFilter` leaves the `.in()` call at the
 * call site. Throws `PageScanError` on a failed page rather than swallowing it.
 */
export async function scanAllPages<T>(
  fetchPage: (
    offset: number,
    limit: number,
  ) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>,
  { maxRows, maxPages }: { maxRows: number; maxPages: number },
): Promise<PageScan<T>> {
  const rows: T[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await fetchPage(offset, POSTGREST_ROW_LIMIT);
    if (error) throw new PageScanError(offset, error.code ?? null);

    const batch = data ?? [];
    if (batch.length === 0) return { rows, status: 'complete' };

    for (const row of batch) rows.push(row);
    offset += batch.length;

    if (rows.length > maxRows) return { rows, status: 'row_budget_exceeded' };
  }

  return { rows, status: 'page_budget_exhausted' };
}

/**
 * Refuse to report an all-chunks-failed read as an empty result.
 *
 * A chunked `.in()` loop that logs each failure and continues returns `[]` when
 * EVERY chunk 400s — indistinguishable downstream from "the table has no
 * matching rows". That silent-success path is what hid a 70-hour production
 * outage, and it is easy to omit at a new call site precisely because its
 * absence looks like nothing at all.
 *
 * Callers that must NOT throw (e.g. a revert running inside another failure
 * path, where a secondary throw would mask the real error) should skip this and
 * return counts for their caller to escalate — an explicit opt-out rather than
 * an invisible omission.
 */
export function assertNotAllChunksFailed(
  label: string,
  attemptedChunks: number,
  failedChunks: number,
  detail: string,
): void {
  if (attemptedChunks > 0 && failedChunks === attemptedChunks) {
    throw new Error(
      `${label}: all ${failedChunks} chunk(s) failed for ${detail}; refusing to report an empty result set as success`,
    );
  }
}
